
(() => {
  'use strict';

  const allowed = [
    'input',
    'textarea',
    'select',
    '[contenteditable="true"]',
    '.selectable-text'
  ].join(',');

  const isAllowed = el =>
    el instanceof Element && !!el.closest(allowed);

  const style = document.createElement('style');
  style.textContent = `
    html, body, body *:not(input):not(textarea):not(select):not([contenteditable="true"]):not(.selectable-text) {
      -webkit-user-select: none !important;
      user-select: none !important;
    }
  `;
  document.head.appendChild(style);

  function clearPageSelection() {
    const selection = window.getSelection();
    const active = document.activeElement;

    if (selection && selection.rangeCount && !isAllowed(active)) {
      selection.removeAllRanges();
    }
  }

  ['copy', 'cut', 'selectstart'].forEach(type => {
    document.addEventListener(type, event => {
      if (!isAllowed(event.target)) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    }, true);
  });

  document.addEventListener('keydown', event => {
    if (isAllowed(event.target)) return;

    if ((event.ctrlKey || event.metaKey) &&
        ['a', 'c', 'x'].includes(event.key.toLowerCase())) {
      event.preventDefault();
      event.stopImmediatePropagation();
      clearPageSelection();
    }
  }, true);

  document.addEventListener('selectionchange', clearPageSelection);
})();
