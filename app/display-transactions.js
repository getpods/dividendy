const { addDecimalStrings } = require('./decimal');

function decimalIsZero(value) {
  return addDecimalStrings([String(value)]) === '0';
}

function decimalIsPositive(value) {
  const normalized = addDecimalStrings([String(value)]);
  return normalized !== '0' && !normalized.startsWith('-');
}

function reviewCodes(value) {
  return String(value || '').split(';').filter(Boolean);
}

function sourceGroupKey(row) {
  const sourceFile = row.source_records?.[0]?.source_file || row.source_file || '';
  return [row.import_id || sourceFile, row.event_date, row.broker, row.currency,
    row.symbol_or_product, row.isin].join('\0');
}

// This is a display-only candidate grouping. It never changes parser output,
// persisted transactions, summaries, or exports, and is always visibly flagged.
function displayTransactions(rows) {
  const candidates = new Map();
  rows.forEach((row, index) => {
    if (row.broker !== 'DEGIRO' || !row.isin || !row.symbol_or_product) return;
    const key = sourceGroupKey(row);
    if (!candidates.has(key)) candidates.set(key, { gross: [], tax: [] });
    const group = candidates.get(key);
    const grossOnly = decimalIsPositive(row.gross_dividend) && decimalIsZero(row.withholding_tax);
    const taxOnly = decimalIsZero(row.gross_dividend) && !decimalIsZero(row.withholding_tax);
    if (grossOnly) group.gross.push(index);
    if (taxOnly) group.tax.push(index);
  });

  const merged = new Map();
  const consumed = new Set();
  for (const group of candidates.values()) {
    if (group.gross.length !== 1 || group.tax.length !== 1) continue;
    const grossIndex = group.gross[0];
    const taxIndex = group.tax[0];
    const grossRow = rows[grossIndex];
    const taxRow = rows[taxIndex];
    const codes = new Set([...reviewCodes(grossRow.review_status), ...reviewCodes(taxRow.review_status)]);
    if (!codes.has('ambiguous_date_fields') && !codes.has('unmatched_tax')) continue;

    const combined = {
      ...grossRow,
      gross_dividend: addDecimalStrings([grossRow.gross_dividend, taxRow.gross_dividend]),
      withholding_tax: addDecimalStrings([grossRow.withholding_tax, taxRow.withholding_tax]),
      withholding_tax_signed: addDecimalStrings([grossRow.withholding_tax_signed, taxRow.withholding_tax_signed]),
      tax_adjustment_amount: addDecimalStrings([grossRow.tax_adjustment_amount || '0', taxRow.tax_adjustment_amount || '0']),
      net_dividend: addDecimalStrings([grossRow.net_dividend, taxRow.net_dividend]),
      source_rows: [grossRow.source_rows, taxRow.source_rows].filter(Boolean).join(','),
      review_status: [...codes, 'unconfirmed_degiro_group'].join(';'),
      display_candidate: true,
      display_source_rows: [grossRow, taxRow],
    };
    merged.set(grossIndex, combined);
    consumed.add(grossIndex);
    consumed.add(taxIndex);
  }

  const output = [];
  rows.forEach((row, index) => {
    if (merged.has(index)) output.push(merged.get(index));
    else if (!consumed.has(index)) output.push(row);
  });
  return output;
}

module.exports = { displayTransactions };
