/* ElectraLab: smart "Install App" button */
(function () {
  'use strict';

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function () {});
    });
  }

  var btn = document.getElementById('installBtn');
  if (!btn) return;

  var ua = navigator.userAgent;
  var isStandalone =
    (window.matchMedia && matchMedia('(display-mode: standalone)').matches) ||
    navigator.standalone === true;
  var isIOS = /iphone|ipad|ipod/i.test(ua) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  var isInApp = /FBAN|FBAV|FB_IAB|Instagram|WhatsApp|Line\/|Messenger|Snapchat|TikTok|Telegram|; wv\)/i.test(ua);
  var isSafariDesktop = !isIOS && /safari/i.test(ua) && !/chrome|chromium|crios|fxios|edg|android/i.test(ua);

  // Already running as an installed app: nothing to show
  if (isStandalone) { btn.hidden = true; return; }

  var deferred = null;
  var sheet = null;

  function closeSheet() { if (sheet) { sheet.remove(); sheet = null; } }

  function showHelp(html) {
    closeSheet();
    sheet = document.createElement('div');
    sheet.className = 'install-sheet';
    sheet.setAttribute('role', 'dialog');
    sheet.innerHTML =
      '<div class="install-sheet-title">⚡ Install ElectraLab</div>' +
      '<div class="install-sheet-body">' + html + '</div>' +
      '<button type="button" class="install-sheet-close">Got it</button>';
    document.body.appendChild(sheet);
    sheet.querySelector('.install-sheet-close').addEventListener('click', closeSheet);
  }

  // Chrome / Edge / Samsung Internet / Opera (Android + desktop)
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferred = e;
    btn.hidden = false;
  });

  window.addEventListener('appinstalled', function () {
    deferred = null;
    btn.hidden = true;
    closeSheet();
  });

  btn.addEventListener('click', function () {
    if (deferred) {
      deferred.prompt();
      deferred.userChoice.then(function (choice) {
        deferred = null;
        if (choice && choice.outcome === 'accepted') btn.hidden = true;
      });
    } else if (isInApp) {
      showHelp('This in-app browser can\'t install apps.<br>Tap the <b>⋮</b> / <b>•••</b> menu and choose <b>Open in browser</b> (Chrome or Safari), then tap Install again.');
    } else if (isIOS) {
      showHelp('Tap the <b>Share</b> button (square with an arrow) in <b>Safari</b>, scroll down and choose <b>Add to Home Screen</b>.');
    } else if (isSafariDesktop) {
      showHelp('In Safari choose <b>File → Add to Dock</b>.');
    }
  });

  // Browsers that never fire beforeinstallprompt but can still install manually
  if (isInApp || isIOS || isSafariDesktop) btn.hidden = false;

  // Keep the browser / status-bar colour in step with the light/dark toggle
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta && window.MutationObserver) {
    var sync = function () {
      meta.setAttribute('content', document.body.classList.contains('light-theme') ? '#e0f2fe' : '#020617');
    };
    new MutationObserver(sync).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    sync();
  }
})();
