
(() => {
  'use strict';

  // Allow text selection inside form controls and explicitly
  // permitted text areas.
  const allowed = [
    'input',
    'textarea',
    'select',
    '[contenteditable="true"]',
    '.selectable-text'
  ].join(',');

  // Prevent selection of ordinary page text.
  const style = document.createElement('style');
  style.textContent = `
    body, body * {
      -webkit-user-select: none !important;
      user-select: none !important;
    }

    input, textarea, select,
    [contenteditable="true"],
    .selectable-text {
      -webkit-user-select: text !important;
      user-select: text !important;
    }
  `;
  (document.head || document.documentElement).appendChild(style);

  // Prevent copying or cutting ordinary page text.
  document.addEventListener('copy', event => {
    if (!event.target.closest(allowed)) {
      event.preventDefault();
    }
  }, true);

  document.addEventListener('cut', event => {
    if (!event.target.closest(allowed)) {
      event.preventDefault();
    }
  }, true);

  // Prevent selecting ordinary page text with the mouse.
  document.addEventListener('selectstart', event => {
    if (!event.target.closest(allowed)) {
      event.preventDefault();
    }
  }, true);

})();
