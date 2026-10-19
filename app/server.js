const crypto = require('node:crypto');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const express = require('express');
const multer = require('multer');
const { exactSummary, exactSummaryAllBrokers, exactSummaryByIssuerDomicile } = require('./summary');
const { csvCell } = require('./csv');
const { reviewSummary } = require('./review-status');
const { renderDiagnostics } = require('./diagnostics');
const { displayTransactions } = require('./display-transactions');
const { MAX_BYTES, safeOriginalName, validateCsvBuffer } = require('./upload-validation');

const ROOT = path.resolve(__dirname, '..');
const portText = process.env.DIVIDENDY_PORT || '3000';
const PORT = /^\d{1,5}$/.test(portText) ? Number(portText) : NaN;
if (!Number.isInteger(PORT) || PORT < 1024 || PORT > 65535) throw new Error('DIVIDENDY_PORT musí být mezi 1024 a 65535.');
const HOST = '127.0.0.1';
const MAX_SESSION_IMPORTS = 50;
const MAX_SESSION_BYTES = 100 * 1024 * 1024;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const app = express();
const sessions = new Map();
const previews = new Map();
const imports = new Map();
const transactions = new Map();
const diagnosticsByImport = new Map();
const importHashes = new Map();
const instrumentDomiciles = new Map();
const instrumentTypes = new Map();
const regionNames = new Intl.DisplayNames(['cs'], { type: 'region' });
const INSTRUMENT_TYPES = Object.freeze({
  ordinary_share: 'Běžná akcie',
  fund: 'ETF / fond',
  other: 'Jiný typ',
});
const NON_COUNTRY_PREFIXES = new Set(['EU', 'EZ', 'UN', 'XA', 'XB', 'XC', 'XD', 'XS']);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES, files: 1, fields: 4 } });

app.disable('x-powered-by');
function localHttpAddress(value, isAuthority = false) {
  try {
    const url = new URL(isAuthority ? `http://${value}` : value);
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (url.protocol !== 'http:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
    if (!LOOPBACK_HOSTS.has(hostname)) return null;
    return { hostname, port: url.port || '80' };
  } catch {
    return null;
  }
}
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'self'; style-src 'self'; form-action 'self'; frame-ancestors 'none'",
    'Cache-Control': 'no-store',
  });
  if (!localHttpAddress(req.headers.host || '', true)) return res.status(403).send('Pouze lokální přístup.');
  next();
});
app.use(express.urlencoded({ extended: false, limit: '2mb', parameterLimit: 20000 }));
app.use('/static', express.static(path.join(__dirname, 'public'), { fallthrough: false, index: false }));

function escapeHtml(input) {
  return String(input ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}
function getSession(req, res) {
  if (req.dividendSession) return req.dividendSession;
  const cookie = String(req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('dividendy_sid='));
  let id = cookie ? cookie.slice('dividendy_sid='.length) : '';
  if (!sessions.has(id)) {
    id = crypto.randomBytes(24).toString('hex');
    sessions.set(id, { csrf: crypto.randomBytes(24).toString('hex') });
    res.setHeader('Set-Cookie', `dividendy_sid=${id}; HttpOnly; SameSite=Strict; Path=/`);
  }
  req.dividendSession = { id, ...sessions.get(id) };
  return req.dividendSession;
}
function checkPost(req, res, next) {
  const session = getSession(req, res);
  // A session-bound secret is required on every state-changing form. Origin
  // is deliberately not required because local browsers and VM forwarding
  // can report a different loopback alias than the Host header.
  if (req.body?.csrf !== session.csrf) return res.status(403).send('Bezpečnostní formulář vypršel nebo se změnila relace. Načtěte stránku znovu.');
  next();
}
function page(req, res, title, body) {
  const session = getSession(req, res);
  res.type('html').send(`<!doctype html><html lang="cs"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#102a24"><title>${escapeHtml(title)} – Dividendový přehled</title><link rel="stylesheet" href="/static/app.css"><script src="/static/app.js" defer></script></head><body><header class="site-header"><a class="brand" href="/"><span class="brand-mark" aria-hidden="true">D</span><span>Dividendový přehled<small>Soukromé finance, lokálně</small></span></a><nav aria-label="Hlavní navigace"><a href="/">Přehled</a><a href="/guide">Návod</a><a class="nav-export" href="/export.csv"><span aria-hidden="true">↓</span> Export CSV</a></nav></header><main><p class="eyebrow">LOKÁLNÍ PŘEHLED <span>·</span> DATA ZŮSTÁVAJÍ U VÁS</p><h1>${escapeHtml(title)}</h1>${body}</main><footer><span class="footer-dot" aria-hidden="true"></span> Lokální nástroj. Neprovádí český daňový výpočet ani neposuzuje započitatelnost zahraniční daně.</footer></body></html>`);
}
function renderError(message) { return `<p class="alert">${escapeHtml(message)}</p>`; }
function isZeroDecimal(value) { return /^-?0+(?:\.0*)?$/.test(String(value)); }
function selectedRows(query = {}) {
  return [...transactions.values()].filter(row => {
    if (/^\d{4}$/.test(String(query.year || '')) && !row.event_date.startsWith(query.year)) return false;
    if (['DEGIRO', 'IBKR'].includes(query.broker) && row.broker !== query.broker) return false;
    if (/^[A-Z]{3}$/.test(String(query.currency || '')) && row.currency !== query.currency) return false;
    return true;
  }).sort((a, b) => b.event_date.localeCompare(a.event_date) || a.id.localeCompare(b.id));
}
function instrumentKeyFor(row) {
  const isin = String(row.isin || '').trim().toUpperCase();
  const title = String(row.symbol_or_product || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('cs-CZ');
  const source = row.source_records?.[0] || {};
  const identity = isin
    ? `isin:${isin}`
    : title
      ? `name:${row.broker || ''}:${title}`
      : `source:${row.broker || ''}:${source.source_file || row.source_file || ''}:${source.source_row || row.source_rows || crypto.randomUUID()}`;
  return crypto.createHash('sha256').update(identity).digest('hex');
}
function countryName(code) {
  if (!/^[A-Z]{2}$/.test(String(code)) || NON_COUNTRY_PREFIXES.has(code)) return '';
  try {
    const name = regionNames.of(code);
    return name && name !== code ? name : '';
  } catch {
    return '';
  }
}
function domicileSourceLabel(source) {
  const labels = {
    user_confirmed: 'ručně potvrzeno',
    isin_prefix_iso6166: 'prefix ISIN; běžná akcie potvrzena uživatelem',
    unknown: 'nezjištěno',
  };
  return String(source || '').split(';').filter(Boolean).map(item => labels[item] || item).join(', ');
}
function isinPrefixDomicile(isin) {
  const value = String(isin || '').trim().toUpperCase();
  if (!/^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(value)) return null;
  const expanded = [...value].map(char => /[A-Z]/.test(char) ? String(char.charCodeAt(0) - 55) : char).join('');
  let sum = 0;
  let double = false;
  for (let index = expanded.length - 1; index >= 0; index -= 1) {
    let digit = Number(expanded[index]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  if (sum % 10 !== 0) return null;
  const code = value.slice(0, 2);
  const name = countryName(code);
  return name ? { code, name } : null;
}
function withIssuerDomicile(row) {
  const domicile = instrumentDomiciles.get(row.instrument_key);
  return {
    ...row,
    issuer_domicile_country: domicile?.country_code || '',
    issuer_domicile_name: domicile?.country_name || '',
    issuer_domicile_source: domicile?.source || '',
  };
}
function runBridge(broker, csvInput) {
  return new Promise((resolve, reject) => {
    const python = process.env.DIVIDENDY_PYTHON || 'python3';
    const child = spawn(python, [path.join(ROOT, 'python', 'bridge.py')], {
      cwd: ROOT, shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    });
    let stdout = ''; let stderr = ''; let settled = false;
    const fail = (message = 'Parser soubor nedokázal zpracovat. Zkontrolujte profil a formát CSV.') => {
      if (!settled) { settled = true; reject(new Error(message)); }
    };
    const timer = setTimeout(() => { child.kill('SIGKILL'); fail(); }, 20000);
    child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); if (stdout.length > 12 * 1024 * 1024) { child.kill('SIGKILL'); fail(); } });
    child.stderr.on('data', chunk => { if (stderr.length < 2048) stderr += chunk.toString('utf8').slice(0, 2048 - stderr.length); });
    child.on('error', fail);
    child.on('close', code => {
      clearTimeout(timer);
      if (settled) return;
      if (code !== 0) {
        const dependencyError = /ModuleNotFoundError|No module named/.test(stderr);
        return fail(dependencyError
          ? 'Ve výchozím Pythonu chybí pandas. Nainstalujte systémový balíček python3-pandas a aplikaci spusťte znovu.'
          : undefined);
      }
      try { const payload = JSON.parse(stdout); settled = true; resolve(payload); } catch { fail(); }
    });
    child.stdin.end(JSON.stringify({ contract_version: 2, broker, source_name: csvInput.name, csv_text: csvInput.text }));
  });
}
function checkRuntimeRequirements() {
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (!Number.isInteger(nodeMajor) || nodeMajor < 20) {
    return Promise.reject(new Error('Aplikace vyžaduje Node.js 20 nebo novější. Nainstalujte podporovanou verzi Node.js a ověřte ji příkazem node --version.'));
  }

  const python = process.env.DIVIDENDY_PYTHON || 'python3';
  const probe = [
    'import sys',
    'if sys.version_info < (3, 10):',
    ' print("PYTHON_TOO_OLD")',
    ' sys.exit(11)',
    'try:',
    ' import pandas as pd',
    'except ModuleNotFoundError:',
    ' print("MISSING_PANDAS")',
    ' sys.exit(10)',
    'except Exception:',
    ' print("PANDAS_UNAVAILABLE")',
    ' sys.exit(12)',
    'print("OK|" + pd.__version__)',
  ].join('\n');

  return new Promise((resolve, reject) => {
    execFile(python, ['-c', probe], { timeout: 10000, encoding: 'utf8', windowsHide: true }, (error, stdout = '') => {
      const result = stdout.trim();
      if (!error && result.startsWith('OK|')) return resolve(result.slice(3));
      if (error?.code === 'ENOENT') {
        return reject(new Error(`Nelze spustit Python příkaz „${python}“. Nainstalujte Python 3 a ověřte jej příkazem python3 --version.`));
      }
      if (result === 'MISSING_PANDAS') {
        return reject(new Error(`Ve výchozím Pythonu (${python}) chybí pandas. Na Debianu jej nainstalujte příkazem sudo apt install python3-pandas.`));
      }
      if (result === 'PYTHON_TOO_OLD') {
        return reject(new Error(`Aplikace vyžaduje Python 3.10 nebo novější (${python}). Ověřte verzi příkazem python3 --version.`));
      }
      if (result === 'PANDAS_UNAVAILABLE') {
        return reject(new Error(`Python (${python}) nedokáže načíst pandas. Ověřte instalaci příkazem python3 -c 'import pandas; print(pandas.__version__)'.`));
      }
      return reject(new Error(`Kontrola Pythonu (${python}) selhala. Ověřte příkazy python3 --version a python3 -c 'import pandas; print(pandas.__version__)'.`));
    });
  });
}
function normalizeBridgeRecords(records, originalName) {
  return records.map(record => ({ ...record, source_file: originalName }));
}
function pageRows(rows) {
  const shownRows = displayTransactions(rows.map(withIssuerDomicile));
  return `<div class="table-wrap"><table><thead><tr><th>Datum</th><th>Broker</th><th>Cenný papír / popis</th><th>Domicil emitenta</th><th>Měna</th><th>Hrubá dividenda</th><th>Daň z dividendy</th><th>Neověřený daňový pohyb</th><th>Čistá dividenda</th><th>Kontrola</th></tr></thead><tbody>${shownRows.map(row => {
    const dateCell = row.display_candidate
      ? `${escapeHtml(row.event_date)}<br><span class="small">Kandidátní seskupení: ${row.display_source_rows.map(source => source.id ? `<a href="/transactions/${encodeURIComponent(source.id)}">řádek ${escapeHtml(source.source_rows || '—')}</a>` : `řádek ${escapeHtml(source.source_rows || '—')}`).join(' + ')}</span>`
      : row.id ? `<a href="/transactions/${encodeURIComponent(row.id)}">${escapeHtml(row.event_date)}</a>` : escapeHtml(row.event_date);
    const domicile = row.issuer_domicile_country ? `${escapeHtml(row.issuer_domicile_name)} (${escapeHtml(row.issuer_domicile_country)})<br><span class="small">${escapeHtml(domicileSourceLabel(row.issuer_domicile_source))}</span>` : 'Neurčen';
    return `<tr><td>${dateCell}</td><td>${escapeHtml(row.broker)}</td><td>${escapeHtml(row.symbol_or_product)}</td><td>${domicile}</td><td>${escapeHtml(row.currency)}</td><td>${escapeHtml(row.gross_dividend)}</td><td>${escapeHtml(row.withholding_tax)}</td><td>${isZeroDecimal(row.tax_adjustment_amount) ? '—' : escapeHtml(row.tax_adjustment_amount)}</td><td>${escapeHtml(row.net_dividend)}</td><td>${row.review_status ? `<span class="badge">${escapeHtml(reviewSummary(row.review_status))}</span>` : 'Bez upozornění'}</td></tr>`;
  }).join('')}</tbody></table></div>`;
}
function renderInstrumentDomiciles(session, formValues = null) {
  const instruments = new Map();
  for (const row of transactions.values()) {
    if (!instruments.has(row.instrument_key)) instruments.set(row.instrument_key, row);
  }
  if (!instruments.size) return '<p>Po importu se zde objeví seznam titulů, u kterých lze domicil potvrdit.</p>';
  const rows = [...instruments.entries()].sort(([, a], [, b]) => a.symbol_or_product.localeCompare(b.symbol_or_product, 'cs'));
  return `<p class="small">Výchozí typ je „Běžná akcie“. U platného ISINu se domicil doplní automaticky a pole země je uzamčené. U ETF / fondu a jiného typu lze domicil zadat ručně. Použij „Jiný typ“ například pro ADR/GDR a dluhopisy, jejichž ISIN prefix nelze bezpečně chápat jako domicil podkladové firmy. Domicil emitenta není země zdroje příjmu. Všechny změny se uloží společně a zůstávají v paměti do ukončení aplikace.</p><form class="domicile-bulk-form" method="post" action="/instruments/domiciles" data-bulk-domiciles><input type="hidden" name="csrf" value="${session.csrf}"><div class="table-wrap"><table><thead><tr><th>Titul</th><th>ISIN</th><th>Typ cenného papíru</th><th>Domicil emitenta</th><th>Země (ručně)</th></tr></thead><tbody>${rows.map(([key, row]) => {
    const domicile = instrumentDomiciles.get(key);
    const type = formValues?.[`security_type_${key}`] || instrumentTypes.get(key) || 'ordinary_share';
    const suggestion = isinPrefixDomicile(row.isin);
    const domicileText = domicile
      ? `${domicile.country_name} (${domicile.country_code}) · ${domicile.source === 'isin_prefix_iso6166' ? 'odvozeno z ISINu' : 'ručně potvrzeno'}`
      : type === 'ordinary_share' && suggestion ? `${suggestion.name} (${suggestion.code})` : type === 'ordinary_share' ? 'ISIN neposkytuje použitelný návrh' : 'Neurčený domicil';
    const countryInput = formValues && Object.hasOwn(formValues, `country_code_${key}`)
      ? String(formValues[`country_code_${key}`] || '')
      : domicile?.source === 'user_confirmed' ? domicile.country_code : '';
    const inputDisabled = type === 'ordinary_share' && domicile?.source !== 'user_confirmed';
    const removing = formValues?.[`remove_${key}`] === '1';
    const invalidCode = countryInput && !countryName(countryInput.trim().toUpperCase());
    return `<tr data-instrument-key="${key}" data-has-manual-domicile="${domicile?.source === 'user_confirmed' ? 'true' : 'false'}"><td>${escapeHtml(row.symbol_or_product || 'Neznámý titul')}</td><td>${escapeHtml(row.isin || 'Neznámý')}</td><td><label class="table-control"><span class="visually-hidden">Typ cenného papíru pro ${escapeHtml(row.symbol_or_product || 'titul')}</span><select name="security_type_${key}" data-security-type>${Object.entries(INSTRUMENT_TYPES).map(([value, label]) => `<option value="${value}" ${type === value ? 'selected' : ''}>${escapeHtml(label)}</option>`).join('')}</select></label></td><td data-domicile-status>${escapeHtml(domicileText)}</td><td><label class="table-control"><span class="visually-hidden">Ruční kód země pro ${escapeHtml(row.symbol_or_product || 'titul')}</span><input name="country_code_${key}" data-country-code maxlength="2" pattern="[A-Za-z]{2}" placeholder="US / DE" value="${escapeHtml(countryInput)}" ${inputDisabled ? 'disabled' : ''} ${invalidCode ? 'aria-invalid="true"' : ''}></label><input type="hidden" name="remove_${key}" data-remove-field value="${removing ? '1' : ''}"><button class="button-quiet remove-domicile" type="button" data-remove-domicile aria-label="Odebrat domicil pro ${escapeHtml(row.symbol_or_product || 'titul')}">Vymazat</button></td></tr>`;
  }).join('')}</tbody></table></div><p class="small" data-bulk-feedback aria-live="polite"></p><button type="submit">Uložit všechny změny domicilů</button></form>`;
}

app.get('/', (req, res) => {
  const session = getSession(req, res);
  const rows = selectedRows(req.query);
  const summaries = exactSummary(rows);
  const allBrokerTotals = exactSummaryAllBrokers(selectedRows({ ...req.query, broker: '' }));
  const domicileSummaries = exactSummaryByIssuerDomicile(selectedRows({ ...req.query, broker: '' }).map(withIssuerDomicile));
  const recentImports = [...imports.values()].sort((a, b) => b.imported_at.localeCompare(a.imported_at)).slice(0, 50);
  const summaryLines = [];
  for (const total of allBrokerTotals) {
    const matching = summaries.filter(s => s.year === total.year && s.currency === total.currency);
    for (const summary of matching) summaryLines.push({ ...summary, total: false });
    summaryLines.push({ ...total, total: true });
  }
  const hasUnverifiedTaxMovement = summaryLines.some(s => !isZeroDecimal(s.tax_adjustment_amount));
  const adjustmentColumn = hasUnverifiedTaxMovement ? '<th>Neověřený daňový pohyb</th>' : '';
  const summaryHtml = summaryLines.length ? `<p class="small summary-note">Součtové řádky zahrnují všechny brokery a jsou oddělené podle roku a měny. Daň z dividendy je částka vykázaná brokerem; nejde o výpočet české daně ani posouzení zápočtu. Neověřený daňový pohyb zachycuje kladné položky IBKR, u kterých není potvrzeno, zda jde o vratku či opravu; nezapočítává se do čisté dividendy. Tento sloupec se zobrazí jen tehdy, když taková položka existuje. Měny se nesčítají ani nepřevádějí.</p><div class="table-wrap"><table><thead><tr><th>Rok</th><th>Broker</th><th>Měna</th><th>Hrubá dividenda</th><th>Daň z dividendy</th>${adjustmentColumn}<th>Čistá dividenda</th><th>Z toho vyžaduje kontrolu (netto)</th></tr></thead><tbody>${summaryLines.map(s => `<tr class="${s.total ? 'summary-total' : ''}"><td>${escapeHtml(s.year)}</td><td>${escapeHtml(s.broker)}</td><td>${escapeHtml(s.currency)}</td><td>${escapeHtml(s.gross_dividend)}</td><td>${escapeHtml(s.withholding_tax)}</td>${hasUnverifiedTaxMovement ? `<td>${isZeroDecimal(s.tax_adjustment_amount) ? '—' : escapeHtml(s.tax_adjustment_amount)}</td>` : ''}<td>${escapeHtml(s.net_dividend)}</td><td>${escapeHtml(s.needs_review_net)}</td></tr>`).join('')}</tbody></table></div>` : '<p>Zatím nejsou importované transakce.</p>';
  const domicileSummaryHtml = domicileSummaries.length ? `<h3>Dividendy podle domicilu emitenta</h3><p class="small summary-note">Zahrnuje všechny brokery a odděluje měny. Domicil neznamená zemi zdroje příjmu ani daňový režim. Neurčené tituly jsou uvedeny zvlášť.</p><div class="table-wrap"><table><thead><tr><th>Rok</th><th>Domicil emitenta</th><th>Původ údaje</th><th>Měna</th><th>Hrubá dividenda</th><th>Čistá dividenda</th></tr></thead><tbody>${domicileSummaries.map(s => `<tr><td>${escapeHtml(s.year)}</td><td>${escapeHtml(s.country ? `${s.country_name} (${s.country})` : 'Neurčený domicil')}</td><td>${escapeHtml(domicileSourceLabel(s.domicile_sources))}</td><td>${escapeHtml(s.currency)}</td><td>${escapeHtml(s.gross_dividend)}</td><td>${escapeHtml(s.net_dividend)}</td></tr>`).join('')}</tbody></table></div>` : '';
  const error = req.query.error ? renderError(req.query.error) : '';
  const filter = `<form method="get" class="filters"><label>Rok <input name="year" inputmode="numeric" pattern="[0-9]{4}" value="${escapeHtml(req.query.year || '')}"></label><label>Broker <select name="broker"><option value="">Všichni</option>${['DEGIRO','IBKR'].map(b => `<option ${req.query.broker === b ? 'selected' : ''}>${b}</option>`).join('')}</select></label><label>Měna <input name="currency" maxlength="3" value="${escapeHtml(req.query.currency || '')}"></label><button>Filtrovat</button></form>`;
  const form = `<section class="card"><h2>Import výpisu CSV</h2><p>Soubor se zpracuje pouze v paměti a zůstane dostupný do ukončení aplikace.</p><form action="/preview" method="post" enctype="multipart/form-data"><input type="hidden" name="csrf" value="${session.csrf}"><label>Broker <select name="broker" required><option value="DEGIRO">DEGIRO</option><option value="IBKR">IBKR</option></select></label><label>CSV soubor <input type="file" name="file" accept=".csv,text/csv" required></label><button>Nahrát a zkontrolovat</button></form><p class="small">Limit 5 MiB. Po restartu aplikace se data vymažou.</p></section>`;
  const importHtml = recentImports.length ? `<ul class="imports">${recentImports.map(file => `<li><a href="/imports/${encodeURIComponent(file.id)}">${escapeHtml(file.original_name)}</a> — ${file.broker}, ${escapeHtml(file.imported_at)}, ${escapeHtml(file.validation_status)}</li>`).join('')}</ul>` : '<p>Žádné importy v této relaci.</p>';
  const domicileNotice = {
    automatic: 'Domicil byl doplněn z prefixu platného ISINu po potvrzení typu běžná akcie.',
    manual: 'Ruční domicil emitenta byl uložen.',
    cleared: 'Domicil emitenta byl odebrán.',
    'no-suggestion': 'Z prefixu tohoto ISINu nelze domicil bezpečně navrhnout. Zadej jej ručně, pokud ho znáš.',
    'type-saved': 'Typ cenného papíru byl uložen; domicil tohoto typu je potřeba doplnit ručně.',
    'bulk-saved': 'Všechny typy cenných papírů a domicily byly uloženy společně.',
  }[req.query.domicile];
  const notice = req.query.deleted === '1' ? '<p class="notice">Import a jeho transakce byly odstraněny z paměti.</p>' : domicileNotice ? `<p class="notice">${escapeHtml(domicileNotice)}</p>` : '';
  page(req, res, 'Přehled dividend', `${notice}${error}${form}<section><h2>Souhrny</h2>${filter}${summaryHtml}${domicileSummaryHtml}</section><section><h2>Domicily emitentů</h2>${renderInstrumentDomiciles(session)}</section><section><h2>Transakce (${rows.length})</h2>${pageRows(rows)}</section><section><h2>Importované soubory v této relaci</h2>${importHtml}</section>`);
});

app.post('/preview', upload.single('file'), checkPost, async (req, res) => {
  try {
    const broker = req.body.broker;
    const file = req.file;
    if (!['DEGIRO', 'IBKR'].includes(broker)) throw new Error('Vyberte podporovaného brokera.');
    if (!file) throw new Error('Vyberte soubor CSV.');
    const sessionBytes = [...imports.values()].reduce((total, item) => total + item.byte_size, 0);
    if (imports.size >= MAX_SESSION_IMPORTS || sessionBytes + file.size > MAX_SESSION_BYTES) {
      throw new Error('Relace dosáhla limitu 50 importů nebo 100 MiB. Odeberte nepotřebné importy a zkuste to znovu.');
    }
    const validated = validateCsvBuffer(file.buffer, file.originalname);
    const id = crypto.randomUUID();
    const sha256 = crypto.createHash('sha256').update(file.buffer).digest('hex');
    const duplicateId = importHashes.get(`${broker}:${sha256}`);
    const duplicate = duplicateId ? imports.get(duplicateId) : null;
    if (duplicate) {
      return page(req, res, 'Soubor již existuje', `${renderError('Tento soubor stejného obsahu a brokera už byl importován v této relaci.') }<p><a href="/imports/${encodeURIComponent(duplicate.id)}">Otevřít původní import</a> (${escapeHtml(duplicate.original_name)}).</p><p>Automaticky se znovu nezapočítal.</p>`);
    }
    const parsed = await runBridge(broker, { name: validated.safeName, text: validated.text });
    const transactions = parsed.transactions.map(t => ({ ...t, source_records: normalizeBridgeRecords(t.source_records || [], validated.safeName) }));
    const diagnostics = (parsed.diagnostics || []).map(d => ({ ...d, source_file: validated.safeName }));
    const token = crypto.randomBytes(24).toString('hex');
    previews.set(token, { id, broker, originalName: validated.safeName, sha256, byteSize: file.size, transactions, diagnostics, createdAt: Date.now() });
    const session = getSession(req, res);
    const issues = diagnostics.length ? `<h3>Nálezy (${diagnostics.length})</h3>${renderDiagnostics(diagnostics, { includeRaw: true })}` : '<p>Validace nenašla diagnostické položky.</p>';
    const txTable = transactions.length ? pageRows(transactions.map(t => ({ ...t, id: '', event_date: t.date }))) : '<p>Parser nenašel žádné použitelné dividendové položky.</p>';
    const confirm = transactions.length || diagnostics.length ? `<form method="post" action="/confirm/${token}"><input type="hidden" name="csrf" value="${session.csrf}"><p>Potvrzením se rozpoznané položky a diagnostika ponechají jen v paměti do ukončení aplikace. CSV se neukládá.</p><button>Potvrdit import do této relace</button></form>` : '<p class="alert">Import nelze potvrdit, protože nebyla nalezena žádná položka ani diagnostika.</p>';
    page(req, res, 'Náhled importu', `<p><b>${escapeHtml(broker)}</b> · ${escapeHtml(validated.safeName)} · ${file.size} bajtů · SHA-256 ${sha256}</p><p>Rozpoznané položky: ${transactions.length}</p>${issues}${txTable}${confirm}<p><a href="/">Zrušit</a></p>`);
  } catch (error) {
    const message = error instanceof multer.MulterError ? 'Soubor překročil povolený limit nebo počet souborů.' : error.message || 'Soubor nelze zpracovat.';
    page(req, res, 'Import se nezdařil', `${renderError(message)}<a href="/">Zpět</a>`);
  }
});

app.post('/confirm/:token', checkPost, (req, res) => {
  const item = previews.get(req.params.token);
  if (!item || Date.now() - item.createdAt > 15 * 60 * 1000) return page(req, res, 'Náhled vypršel', `${renderError('Nahrajte soubor znovu.')}<a href="/">Zpět</a>`);
  const hashKey = `${item.broker}:${item.sha256}`;
  if (importHashes.has(hashKey)) {
    previews.delete(req.params.token);
    return page(req, res, 'Duplicitní import', `${renderError('Stejný obsah již byl importován.')}<a href="/">Zpět</a>`);
  }
  const importedAt = new Date().toISOString();
  imports.set(item.id, {
    id: item.id, original_name: item.originalName, sha256: item.sha256, broker: item.broker,
    imported_at: importedAt, validation_status: item.diagnostics.length ? 'needs_review' : 'validated',
    byte_size: item.byteSize,
  });
  importHashes.set(hashKey, item.id);
  diagnosticsByImport.set(item.id, item.diagnostics.map(d => ({
    source_row: String(d.source_row || ''), issue_type: d.issue_type || 'validation',
    message: d.message || 'Kontrola vyžaduje pozornost.',
  })));
  for (const transaction of item.transactions) {
    const id = crypto.randomUUID();
    transactions.set(id, {
      id, import_id: item.id, event_date: transaction.date, broker: transaction.broker,
      instrument_key: instrumentKeyFor(transaction),
      currency: transaction.currency, symbol_or_product: transaction.symbol_or_product || '', isin: transaction.isin || '',
      gross_dividend: transaction.gross_dividend, withholding_tax: transaction.withholding_tax,
      withholding_tax_signed: transaction.withholding_tax_signed || '0', tax_adjustment_amount: transaction.tax_adjustment_amount || '0',
      tax_sign_status: transaction.tax_sign_status || '', net_dividend: transaction.net_dividend,
      source_rows: transaction.source_rows || '', source_records_json: JSON.stringify(transaction.source_records || []),
      review_status: transaction.review_status || '',
    });
  }
  previews.delete(req.params.token);
  res.redirect('/imports/' + encodeURIComponent(item.id));
});

app.post('/instruments/domiciles', checkPost, (req, res) => {
  const instruments = new Map();
  for (const row of transactions.values()) {
    if (!instruments.has(row.instrument_key)) instruments.set(row.instrument_key, row);
  }
  const staged = [];
  const errors = [];
  for (const [key, row] of instruments) {
    const currentType = instrumentTypes.get(key) || 'ordinary_share';
    const typeValue = req.body[`security_type_${key}`];
    const securityType = typeValue === undefined ? currentType : String(typeValue);
    if (!/^[a-f0-9]{64}$/.test(key) || !Object.hasOwn(INSTRUMENT_TYPES, securityType)) {
      errors.push(row.symbol_or_product || 'Neznámý titul');
      continue;
    }
    const remove = req.body[`remove_${key}`] === '1';
    const code = String(req.body[`country_code_${key}`] || '').trim().toUpperCase();
    if (code && !countryName(code)) {
      errors.push(`${row.symbol_or_product || 'Neznámý titul'} — neplatný kód země`);
      continue;
    }
    let domicile = null;
    if (!remove && code) {
      domicile = {
        country_code: code, country_name: countryName(code), source: 'user_confirmed',
        source_reference: 'Ruční potvrzení uživatelem', security_type: securityType,
      };
    } else if (!remove && securityType === 'ordinary_share') {
      const suggestion = isinPrefixDomicile(row.isin);
      if (suggestion) {
        domicile = {
          country_code: suggestion.code, country_name: suggestion.name,
          source: 'isin_prefix_iso6166',
          source_reference: 'ISO 6166:2021; prefix země emitenta u nedluhového cenného papíru',
          source_url: 'https://committee.iso.org/sites/tc68/home/articles/content-left-area/articles/what-is-isin.html',
          security_type: securityType,
        };
      }
    }
    staged.push({ key, securityType, domicile });
  }
  if (errors.length) {
    return page(req, res, 'Změny nebyly uloženy', `${renderError(`Uložení se neprovedlo, protože ${errors.length} položek obsahuje neplatný typ nebo kód země. Žádná změna se neuložila.`)}<section><h2>Opravte formulář</h2>${renderInstrumentDomiciles(getSession(req, res), req.body)}</section><p><a href="/">Zpět na přehled</a></p>`);
  }
  for (const item of staged) {
    instrumentTypes.set(item.key, item.securityType);
    if (item.domicile) instrumentDomiciles.set(item.key, item.domicile);
    else instrumentDomiciles.delete(item.key);
  }
  res.redirect('/?domicile=bulk-saved');
});

app.post('/instruments/:key/domicile', checkPost, (req, res) => {
  const key = String(req.params.key || '');
  const firstTransaction = [...transactions.values()].find(row => row.instrument_key === key);
  if (!/^[a-f0-9]{64}$/.test(key) || !firstTransaction) return res.status(404).send('Titul nebyl nalezen.');
  const securityType = String(req.body.security_type || 'ordinary_share');
  if (!Object.hasOwn(INSTRUMENT_TYPES, securityType)) return res.status(400).send('Neznámý typ cenného papíru.');
  instrumentTypes.set(key, securityType);
  const code = String(req.body.country_code || '').trim().toUpperCase();
  const returnTo = req.body.return_to === '/' ? '/' : `/transactions/${encodeURIComponent(firstTransaction.id)}`;
  if (req.body.action === 'remove') {
    instrumentDomiciles.delete(key);
    return res.redirect(`${returnTo}?domicile=cleared`);
  }
  if (code) {
    const name = countryName(code);
    if (!name) {
      return page(req, res, 'Domicil emitenta', `${renderError('Zadejte platný dvoupísmenný kód země (ISO 3166-1 alpha-2), například US nebo DE.') }<p>Typ cenného papíru byl uložen. Oprav kód na hlavní stránce nebo v detailu titulu.</p><p><a href="${escapeHtml(returnTo)}">Zpět na titul</a></p>`);
    }
    instrumentDomiciles.set(key, {
      country_code: code, country_name: name, source: 'user_confirmed',
      source_reference: 'Ruční potvrzení uživatelem', security_type: securityType,
    });
    return res.redirect(`${returnTo}?domicile=manual`);
  }
  if (securityType === 'ordinary_share') {
    const suggestion = isinPrefixDomicile(firstTransaction.isin);
    if (!suggestion) {
      instrumentDomiciles.delete(key);
      return res.redirect(`${returnTo}?domicile=no-suggestion`);
    }
    instrumentDomiciles.set(key, {
      country_code: suggestion.code, country_name: suggestion.name,
      source: 'isin_prefix_iso6166',
      source_reference: 'ISO 6166:2021; prefix země emitenta u nedluhového cenného papíru',
      source_url: 'https://committee.iso.org/sites/tc68/home/articles/content-left-area/articles/what-is-isin.html',
      security_type: securityType,
    });
    return res.redirect(`${returnTo}?domicile=automatic`);
  }
  instrumentDomiciles.delete(key);
  res.redirect(`${returnTo}?domicile=type-saved`);
});

app.get('/transactions/:id', (req, res) => {
  const row = transactions.get(req.params.id);
  if (!row) return res.status(404).send('Položka nebyla nalezena.');
  const item = imports.get(row.import_id);
  const sources = JSON.parse(row.source_records_json);
  const domicile = instrumentDomiciles.get(row.instrument_key);
  const securityType = instrumentTypes.get(row.instrument_key) || 'ordinary_share';
  const suggestion = isinPrefixDomicile(row.isin);
  const session = getSession(req, res);
  const noticeText = {
    automatic: 'Domicil byl automaticky doplněn z platného prefixu ISIN po potvrzení typu „Běžná akcie“.',
    manual: 'Ruční domicil emitenta byl uložen.',
    cleared: 'Domicil emitenta byl odebrán.',
    'no-suggestion': 'Pro tento ISIN nelze podle prefixu bezpečně navrhnout domicil. Zadej jej ručně, pokud ho znáš.',
    'type-saved': 'Typ cenného papíru byl uložen; pro tento typ nebyl domicil automaticky odvozen.',
  }[req.query.domicile];
  const notice = noticeText ? `<p class="notice">${escapeHtml(noticeText)}</p>` : '';
  const domicileLabel = domicile ? `${domicile.country_name} (${domicile.country_code}) — ${domicile.source === 'isin_prefix_iso6166' ? 'odvozeno z ISINu, typ běžné akcie potvrzen' : 'ručně potvrzeno uživatelem'}` : 'Neurčený';
  const domicileForm = `<section class="card"><h2>Domicil emitenta</h2><p>ISIN může určit právní domicil u běžné akcie. U ADR/GDR, fondů a dluhopisů se prefix nepoužije jako domicil. Nejde o zemi zdroje příjmu.</p><p>Aktuální stav: <b>${escapeHtml(domicileLabel)}</b>${suggestion && !domicile ? ` · Prefix ISIN nabízí návrh ${escapeHtml(suggestion.name)} (${escapeHtml(suggestion.code)}), zatím nepoužitý.` : ''}</p><form method="post" action="/instruments/${encodeURIComponent(row.instrument_key)}/domicile"><input type="hidden" name="csrf" value="${session.csrf}"><label>Typ cenného papíru<select name="security_type">${Object.entries(INSTRUMENT_TYPES).map(([value, label]) => `<option value="${value}" ${securityType === value ? 'selected' : ''}>${escapeHtml(label)}</option>`).join('')}</select></label><label>Ruční domicil — kód země<input name="country_code" maxlength="2" pattern="[A-Za-z]{2}" placeholder="např. US nebo DE" value="${escapeHtml(domicile?.source === 'user_confirmed' ? domicile.country_code : '')}"></label><button name="action" value="save">Uložit / odvodit u běžné akcie</button><button class="button-quiet" name="action" value="remove" formnovalidate>Odebrat domicil</button></form><p class="small">Pokud vybereš běžnou akcii a necháš ruční kód prázdný, použije se ověřený prefix platného ISINu. U ostatních typů zadej zemi ručně. Změnu lze kdykoli provést na hlavní stránce.</p></section>`;
  page(req, res, 'Detail položky', `${notice}<dl><dt>Datum</dt><dd>${escapeHtml(row.event_date)}</dd><dt>Broker</dt><dd>${escapeHtml(row.broker)}</dd><dt>Popis</dt><dd>${escapeHtml(row.symbol_or_product)}</dd><dt>ISIN</dt><dd>${escapeHtml(row.isin || 'Neznámý')}</dd><dt>Typ cenného papíru</dt><dd>${escapeHtml(INSTRUMENT_TYPES[securityType] || INSTRUMENT_TYPES.other)}</dd><dt>Domicil emitenta</dt><dd>${escapeHtml(domicileLabel)}</dd><dt>Hrubá dividenda</dt><dd>${escapeHtml(row.gross_dividend)} ${escapeHtml(row.currency)}</dd><dt>Daň z dividendy</dt><dd>${escapeHtml(row.withholding_tax)} ${escapeHtml(row.currency)} (původní znaménko ${escapeHtml(row.withholding_tax_signed)})</dd><dt>Neověřený daňový pohyb</dt><dd>${isZeroDecimal(row.tax_adjustment_amount) ? '—' : `${escapeHtml(row.tax_adjustment_amount)} ${escapeHtml(row.currency)}`} ${escapeHtml(row.tax_sign_status)}<br><span class="small">Kladná položka IBKR, kterou nelze bez dalšího potvrdit jako vratku nebo opravu. Není započtena do čisté dividendy.</span></dd><dt>Čistá dividenda</dt><dd>${escapeHtml(row.net_dividend)} ${escapeHtml(row.currency)}</dd><dt>Kontrola</dt><dd>${escapeHtml(reviewSummary(row.review_status))}</dd></dl>${domicileForm}<h2>Zdrojové řádky</h2><ul>${sources.map(s => `<li>${escapeHtml(s.source_file)} · řádek ${escapeHtml(s.source_row)} · ${escapeHtml(s.raw_date)} · ${escapeHtml(s.raw_amount)} ${escapeHtml(s.raw_currency)} · ${escapeHtml(s.raw_description)}</li>`).join('')}</ul><p>Import: <a href="/imports/${encodeURIComponent(item.id)}">${escapeHtml(item.original_name)}</a></p><a href="/">Zpět na přehled</a>`);
});

app.get('/imports/:id', (req, res) => {
  const item = imports.get(req.params.id);
  if (!item) return res.status(404).send('Import nebyl nalezen.');
  const diagnostics = diagnosticsByImport.get(item.id) || [];
  const rows = [...transactions.values()].filter(row => row.import_id === item.id).sort((a, b) => a.event_date.localeCompare(b.event_date) || a.id.localeCompare(b.id));
  const diagnosticHtml = renderDiagnostics(diagnostics);
  page(req, res, 'Importovaný soubor', `<dl><dt>Název</dt><dd>${escapeHtml(item.original_name)}</dd><dt>Broker</dt><dd>${escapeHtml(item.broker)}</dd><dt>SHA-256</dt><dd><code>${item.sha256}</code></dd><dt>Validace</dt><dd>${escapeHtml(item.validation_status)}</dd><dt>Importováno</dt><dd>${escapeHtml(item.imported_at)}</dd><dt>Velikost</dt><dd>${item.byte_size} bajtů</dd></dl><p>Import i jeho diagnostika jsou pouze v paměti této relace. Původní CSV se neukládá.</p><h2>Diagnostika</h2>${diagnosticHtml}<h2>Položky (${rows.length})</h2>${pageRows(rows)}<p><a href="/imports/${encodeURIComponent(item.id)}/delete">Odebrat tento import z relace…</a></p><a href="/">Zpět na přehled</a>`);
});

app.get('/imports/:id/delete', (req, res) => {
  const item = imports.get(req.params.id);
  if (!item) return res.status(404).send('Import nebyl nalezen.');
  const session = getSession(req, res);
  const form = `<form method="post" action="/imports/${encodeURIComponent(item.id)}/delete"><input type="hidden" name="csrf" value="${session.csrf}"><button>Odebrat import z paměti</button></form>`;
  page(req, res, 'Potvrdit odebrání importu', `<p>Odeberou se import <b>${escapeHtml(item.original_name)}</b> (${escapeHtml(item.broker)}), jeho transakce, diagnostika a ochrana před opakováním v této relaci.</p>${form}<p><a href="/imports/${encodeURIComponent(item.id)}">Zrušit</a></p>`);
});

app.post('/imports/:id/delete', checkPost, (req, res) => {
  const item = imports.get(req.params.id);
  if (!item) return res.status(404).send('Import nebyl nalezen.');
  imports.delete(item.id);
  importHashes.delete(`${item.broker}:${item.sha256}`);
  diagnosticsByImport.delete(item.id);
  const removedInstrumentKeys = new Set();
  for (const [id, row] of transactions) {
    if (row.import_id === item.id) {
      transactions.delete(id);
      removedInstrumentKeys.add(row.instrument_key);
    }
  }
  for (const key of removedInstrumentKeys) {
    if (![...transactions.values()].some(row => row.instrument_key === key)) {
      instrumentDomiciles.delete(key);
      instrumentTypes.delete(key);
    }
  }
  res.redirect('/?deleted=1');
});

app.get('/export.csv', (req, res) => {
  const rows = displayTransactions(selectedRows(req.query));
  const header = ['datum','broker','měna','hrubá_dividenda','daň_z_dividendy','daň_z_dividendy_původní_znaménko','neověřený_daňový_pohyb','čistá_dividenda','popis','ISIN','typ_cenného_papíru','domicil_emitenta','domicil_emitenta_kód','původ_domicilu','zdroj_pravidla_domicilu','stav_kontroly','poznámka_seskupení','zdrojový_soubor','zdrojové_řádky'];
  const lines = [header.map(csvCell).join(';'), ...rows.map(row => {
    const source = JSON.parse(row.source_records_json);
    const domicile = instrumentDomiciles.get(row.instrument_key);
    const securityType = instrumentTypes.get(row.instrument_key) || 'ordinary_share';
    const groupingNote = row.display_candidate ? 'Kandidátní seskupení; párování není potvrzeno' : '';
    const sourceRowsText = String(row.source_rows || '').split(',').map(value => value.trim()).filter(Boolean).join(' + ');
    const domicileOrigin = domicile?.source === 'isin_prefix_iso6166' ? 'prefix ISIN; běžná akcie potvrzena uživatelem' : domicile ? 'ručně potvrzeno uživatelem' : '';
    return [row.event_date,row.broker,row.currency,row.gross_dividend,row.withholding_tax,row.withholding_tax_signed,row.tax_adjustment_amount,row.net_dividend,row.symbol_or_product,row.isin,INSTRUMENT_TYPES[securityType] || INSTRUMENT_TYPES.other,domicile?.country_name || '',domicile?.country_code || '',domicileOrigin,domicile?.source_reference || '',row.review_status,groupingNote,source[0]?.source_file || '',sourceRowsText].map(csvCell).join(';');
  })];
  res.set('Content-Disposition', 'attachment; filename="dividendy.csv"').type('text/csv; charset=utf-8').send('\ufeff' + lines.join('\r\n'));
});

app.get('/guide', (req, res) => page(req, res, 'Návod', `<h2>Požadavky a spuštění</h2><p>Potřebujete Node.js 20+ s npm a Python 3.10+ s pandas v příkazu <code>python3</code>. Pythonová část má jedinou přímou závislost: pandas. Na Debianu lze pandas nainstalovat příkazem <code>sudo apt install python3 python3-pandas</code>; Node balíčky nainstalujte v kořeni projektu příkazem <code>npm ci</code>. Návod pro čistou instalaci je v souboru <code>docs/user-guide-cs.md</code>. Příkaz <code>npm start</code> závislosti sám neinstaluje a při startu ověří jejich dostupnost. Po startu otevřete <code>http://127.0.0.1:3000</code>. Server naslouchá pouze na loopback rozhraní. Zastavíte jej <code>Ctrl+C</code>.</p><h2>Import</h2><p>Vyberte CSV export DEGIRO nebo IBKR a zkontrolujte náhled. Potvrzené importy i výsledky zůstávají pouze v paměti do ukončení aplikace. Původní CSV se neukládá. Po restartu aplikace začíná prázdná relace; exportujte si výsledky před ukončením.</p><h2>Domicil emitenta</h2><p>Na hlavní stránce výchozí typ „Běžná akcie“ používá automatický návrh z platného prefixu ISINu; pole země je uzamčené. ETF / fond a „Jiný typ“ mají ruční kód země. Změny všech titulů potvrdíte jedním tlačítkem a při neplatném kódu se neuloží žádná z nich. U ADR/GDR a dluhopisů prefix ISINu nelze bezpečně použít jako domicil podkladové firmy. Domicil emitenta není země zdroje dividendy. Nastavení je pouze v paměti a po restartu se smaže.</p><h2>Částky a daně</h2><p>Aplikace zobrazuje částky vykázané parserem. Kladná položka sekce IBKR Withholding Tax se zobrazuje jako neověřený daňový pohyb; není potvrzené, zda jde o vratku nebo opravu, a do čisté dividendy se nezapočítává. Nejde o výpočet české daňové povinnosti ani potvrzení zápočtu.</p><h2>Soukromí</h2><p>CSV se zpracovává z paměti požadavku a Pythonu se předává přes standardní vstup. Aplikace nevytváří databázi, uložené importy ani zálohy. Výpisy neopouštějí tento počítač.</p>`));

app.use((error, req, res, next) => {
  // Deliberately do not log request data, parser output, or error messages.
  if (!res.headersSent) {
    const message = error instanceof multer.MulterError
      ? 'Soubor překročil limit 5 MiB nebo byl překročen povolený počet souborů.'
      : 'Požadavek nelze zpracovat. Zkontrolujte CSV a zkuste to znovu.';
    res.status(400).send(message);
  }
});

if (require.main === module) {
  checkRuntimeRequirements().then(() => {
    const server = app.listen(PORT, HOST, () => { /* no financial or request data in logs */ });
    function cleanup() {
      previews.clear();
      imports.clear();
      transactions.clear();
      diagnosticsByImport.clear();
      importHashes.clear();
      instrumentDomiciles.clear();
      instrumentTypes.clear();
      sessions.clear();
      server.close(() => process.exit(0));
    }
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
    const previewCleanup = setInterval(() => {
      for (const [token, item] of previews) {
        if (Date.now() - item.createdAt > 15 * 60 * 1000) {
          previews.delete(token);
        }
      }
    }, 60 * 1000);
    previewCleanup.unref();
  }).catch(error => {
    // This preflight checks only local runtime dependencies and never reads uploaded data.
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { app, exactSummary, csvCell, HOST, checkRuntimeRequirements };
