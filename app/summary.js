const { addDecimalStrings } = require('./decimal');

function exactSummary(rows) {
  const groups = new Map();
  for (const row of rows) {
    const year = row.event_date.slice(0, 4);
    const key = `${year}\0${row.broker}\0${row.currency}`;
    if (!groups.has(key)) groups.set(key, { year, broker: row.broker, currency: row.currency, gross: [], tax: [], net: [], adjustments: [], reviewGross: [], reviewTax: [], reviewNet: [], reviewAdjustments: [] });
    const group = groups.get(key);
    group.gross.push(row.gross_dividend); group.tax.push(row.withholding_tax); group.net.push(row.net_dividend);
    group.adjustments.push(row.tax_adjustment_amount);
    if (row.review_status) {
      group.reviewGross.push(row.gross_dividend); group.reviewTax.push(row.withholding_tax); group.reviewNet.push(row.net_dividend);
      group.reviewAdjustments.push(row.tax_adjustment_amount);
    }
  }
  return [...groups.values()].map(group => ({
    year: group.year,
    broker: group.broker,
    currency: group.currency,
    gross_dividend: addDecimalStrings(group.gross),
    withholding_tax: addDecimalStrings(group.tax),
    net_dividend: addDecimalStrings(group.net),
    tax_adjustment_amount: addDecimalStrings(group.adjustments),
    needs_review_gross: addDecimalStrings(group.reviewGross),
    needs_review_tax: addDecimalStrings(group.reviewTax),
    needs_review_net: addDecimalStrings(group.reviewNet),
    needs_review_tax_adjustment: addDecimalStrings(group.reviewAdjustments),
  })).sort((a, b) => a.year.localeCompare(b.year) || a.broker.localeCompare(b.broker) || a.currency.localeCompare(b.currency));
}

function exactSummaryAllBrokers(rows) {
  const groups = new Map();
  for (const row of rows) {
    const year = row.event_date.slice(0, 4);
    const key = `${year}\0${row.currency}`;
    if (!groups.has(key)) groups.set(key, { year, currency: row.currency, gross: [], tax: [], net: [], adjustments: [], reviewNet: [] });
    const group = groups.get(key);
    group.gross.push(row.gross_dividend);
    group.tax.push(row.withholding_tax);
    group.net.push(row.net_dividend);
    group.adjustments.push(row.tax_adjustment_amount);
    if (row.review_status) group.reviewNet.push(row.net_dividend);
  }
  return [...groups.values()].map(group => ({
    year: group.year,
    broker: 'Celkem — všichni brokeři',
    currency: group.currency,
    gross_dividend: addDecimalStrings(group.gross),
    withholding_tax: addDecimalStrings(group.tax),
    net_dividend: addDecimalStrings(group.net),
    tax_adjustment_amount: addDecimalStrings(group.adjustments),
    needs_review_net: addDecimalStrings(group.reviewNet),
  })).sort((a, b) => a.year.localeCompare(b.year) || a.currency.localeCompare(b.currency));
}

function exactSummaryByIssuerDomicile(rows) {
  const groups = new Map();
  for (const row of rows) {
    const year = row.event_date.slice(0, 4);
    const country = row.issuer_domicile_country || '';
    const countryName = row.issuer_domicile_name || '';
    const key = `${year}\0${country}\0${row.currency}`;
    if (!groups.has(key)) groups.set(key, { year, country, countryName, currency: row.currency, gross: [], net: [], sources: new Set() });
    const group = groups.get(key);
    group.gross.push(row.gross_dividend);
    group.net.push(row.net_dividend);
    group.sources.add(row.issuer_domicile_source || 'unknown');
  }
  return [...groups.values()].map(group => ({
    year: group.year,
    country: group.country,
    country_name: group.countryName,
    currency: group.currency,
    gross_dividend: addDecimalStrings(group.gross),
    net_dividend: addDecimalStrings(group.net),
    domicile_sources: [...group.sources].sort().join(';'),
  })).sort((a, b) => a.year.localeCompare(b.year) || a.country.localeCompare(b.country) || a.currency.localeCompare(b.currency));
}

module.exports = { exactSummary, exactSummaryAllBrokers, exactSummaryByIssuerDomicile };
