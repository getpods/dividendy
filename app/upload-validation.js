const path = require('node:path');

const MAX_BYTES = 5 * 1024 * 1024;

function safeOriginalName(name) {
  const normalized = String(name || '').replace(/\\/g, '/');
  const base = path.posix.basename(normalized).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 200);
  return base || 'import.csv';
}

function validateCsvBuffer(buffer, originalName) {
  const safeName = safeOriginalName(originalName);
  if (!safeName.toLowerCase().endsWith('.csv')) throw new Error('Vyberte soubor CSV.');
  if (!Buffer.isBuffer(buffer) || buffer.length === 0 || buffer.length > MAX_BYTES || buffer.includes(0)) {
    throw new Error('Soubor je prázdný, příliš velký nebo nemá platný textový obsah.');
  }
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
  catch { throw new Error('Soubor není platné UTF-8 CSV.'); }
  if (!text.trim()) throw new Error('CSV soubor je prázdný.');
  return { safeName, text };
}

module.exports = { MAX_BYTES, safeOriginalName, validateCsvBuffer };
