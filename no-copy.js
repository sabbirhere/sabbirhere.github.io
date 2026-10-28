
(() => {
  'use strict';

  const allowed = [
    'input',
    'textarea',
    'select',
    '[contenteditable="true"]',
    '.selectable-text'
  ].join(',');

  const isAllowed = target =>
    target instanceof Element && !!target.closest(allowed);

  const style = document.createElement('style');
  style.textContent = `
    html, body, body * {
      -webkit-user-select: none !important;
      user-select: none !important;
      -webkit-touch-callout: none;
    }

    input, textarea, select,
    [contenteditable="true"],
    .selectable-text {
      -webkit-user-select: text !important;
      user-select: text !important;
      -webkit-touch-callout: default;
    }
  `;
  document.head.appendChild(style);

  for (const type of ['copy', 'cut', 'selectstart']) {
    document.addEventListener(type, event => {
      if (!isAllowed(event.target)) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    }, true);
  }

  document.addEventListener('keydown', event => {
    if (isAllowed(event.target)) return;

    if ((event.ctrlKey || event.metaKey) &&
        ['c', 'x', 'a'].includes(event.key.toLowerCase())) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);
})();
