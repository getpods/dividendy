const LABELS = Object.freeze({
  ambiguous_tax_match: 'Daň nelze bezpečně přiřadit',
  unmatched_tax: 'Nepřiřazená daň k prověření',
  suspected_duplicate_transaction: 'Možná duplicita; záznam zůstal zachován',
  tax_adjustment_unverified: 'Daňová položka vyžaduje ověření',
  ambiguous_date_fields: 'Datumová pole se liší; datum ověřit',
  tax_with_zero_gross: 'Daň z dividendy při nulovém hrubém součtu; prověřit opravy',
  unconfirmed_degiro_group: 'Kandidátní seskupení DEGIRO; vazba není potvrzena',
});

function reviewLabels(status) {
  if (!status) return [];
  return String(status).split(';').filter(Boolean).map(code => LABELS[code] || `Vyžaduje kontrolu (${code})`);
}

function reviewSummary(status) {
  const labels = reviewLabels(status);
  return labels.length ? labels.join('; ') : 'Bez upozornění';
}

module.exports = { reviewLabels, reviewSummary };
