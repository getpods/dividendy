// Exact base-10 addition using BigInt. No amount is parsed as Number.
function parts(value) {
  const text = String(value);
  if (!/^-?\d+(?:\.\d+)?$/.test(text)) throw new Error('Neplatný desetinný řetězec');
  const negative = text.startsWith('-');
  const unsigned = negative ? text.slice(1) : text;
  const [whole, fraction = ''] = unsigned.split('.');
  return { negative, whole, fraction };
}

function addDecimalStrings(values) {
  const parsed = values.map(parts);
  const scale = parsed.reduce((max, item) => Math.max(max, item.fraction.length), 0);
  let total = 0n;
  for (const item of parsed) {
    const magnitude = BigInt(item.whole + item.fraction.padEnd(scale, '0'));
    total += item.negative ? -magnitude : magnitude;
  }
  const negative = total < 0n;
  let digits = (negative ? -total : total).toString().padStart(scale + 1, '0');
  if (scale) {
    const whole = digits.slice(0, -scale);
    const fraction = digits.slice(-scale).replace(/0+$/, '');
    digits = fraction ? `${whole}.${fraction}` : whole;
  }
  return `${negative && total !== 0n ? '-' : ''}${digits}`;
}

module.exports = { addDecimalStrings };
