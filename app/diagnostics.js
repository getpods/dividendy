const LABELS = Object.freeze({
  unrecognized_record: 'Nezařazený záznam (nezapočítán)',
  ambiguous_date_fields: 'Rozdílná datumová pole (datum ověřit)',
  unsupported_section: 'Nepodporovaná sekce (nezapočítána)',
  invalid_record: 'Neplatný nebo neúplný záznam',
  malformed_record: 'Záznam neodpovídá formátu',
  ambiguous_tax_match: 'Daň nelze bezpečně přiřadit',
  unmatched_tax: 'Nepřiřazená daň k prověření',
  tax_sign_requires_review: 'Znaménko daně vyžaduje ověření',
  suspected_duplicate_transaction: 'Možná duplicita (záznam zachován)',
  duplicate_file_path: 'Soubor již byl zpracován',
  duplicate_file_content: 'Stejný obsah souboru již byl zpracován',
});

function escapeHtml(input) {
  return String(input ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

function diagnosticGroups(diagnostics) {
  const groups = new Map();
  for (const diagnostic of diagnostics) {
    const type = String(diagnostic.issue_type || 'validation');
    const message = String(diagnostic.message || 'Kontrola vyžaduje pozornost.');
    const key = `${type}\0${message}`;
    if (!groups.has(key)) groups.set(key, { type, message, rows: [] });
    groups.get(key).rows.push(diagnostic);
  }
  return [...groups.values()];
}

function renderDiagnostics(diagnostics, { includeRaw = false } = {}) {
  if (!diagnostics.length) return '<p>Bez diagnostických nálezů.</p>';
  const groups = diagnosticGroups(diagnostics);
  return `<ul class="diagnostic-groups">${groups.map(group => {
    const label = LABELS[group.type] || `Vyžaduje kontrolu (${group.type})`;
    const rowList = group.rows.map(row => `<li>Řádek ${escapeHtml(row.source_row || '—')}: ${escapeHtml(group.message)}${includeRaw && row.raw_amount ? ` <code>${escapeHtml(row.raw_amount)}</code>` : ''}${includeRaw && row.raw_description ? ` — ${escapeHtml(row.raw_description)}` : ''}</li>`).join('');
    const count = group.rows.length;
    const noun = count === 1 ? 'záznam' : count >= 2 && count <= 4 ? 'záznamy' : 'záznamů';
    return `<li><details><summary>${escapeHtml(label)} — ${count} ${noun}</summary><ul>${rowList}</ul></details></li>`;
  }).join('')}</ul>`;
}

module.exports = { diagnosticGroups, renderDiagnostics };
