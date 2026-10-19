function csvCell(value) {
  let text = String(value ?? '');
  const plainDecimal = /^-?\d+(?:\.\d+)?$/.test(text);
  if (!plainDecimal && /^[\s]*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

module.exports = { csvCell };
