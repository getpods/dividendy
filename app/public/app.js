'use strict';

document.addEventListener('DOMContentLoaded', () => {
  const form = document.querySelector('[data-bulk-domiciles]');
  if (!form) return;

  const feedback = form.querySelector('[data-bulk-feedback]');
  const updateRow = row => {
    const type = row.querySelector('[data-security-type]');
    const country = row.querySelector('[data-country-code]');
    const remove = row.querySelector('[data-remove-field]');
    const ordinary = type.value === 'ordinary_share';
    const hasManualDomicile = row.dataset.hasManualDomicile === 'true';
    country.disabled = ordinary && !hasManualDomicile;
    if (remove.value === '1') row.dataset.removing = 'true';
    else delete row.dataset.removing;
  };

  form.querySelectorAll('tbody tr').forEach(row => {
    const type = row.querySelector('[data-security-type]');
    const country = row.querySelector('[data-country-code]');
    const remove = row.querySelector('[data-remove-field]');
    type.addEventListener('change', () => {
      remove.value = '';
      updateRow(row);
      if (feedback) feedback.textContent = type.value === 'ordinary_share'
        ? 'U běžné akcie se domicil určí z platného ISINu; bez použitelného ISINu zůstane neurčený.'
        : 'U ETF / fondu a jiného typu zadejte kód země emitenta ručně.';
    });
    country.addEventListener('input', () => { remove.value = ''; updateRow(row); });
    row.querySelector('[data-remove-domicile]').addEventListener('click', () => {
      country.value = '';
      remove.value = '1';
      updateRow(row);
      if (feedback) feedback.textContent = 'Domicil této položky bude odebrán při společném uložení.';
    });
    updateRow(row);
  });
});
