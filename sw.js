// ElectraLab service worker. Bump CACHE_VERSION whenever you push site updates.
const CACHE_VERSION = 'electralab-v1';

const PRECACHE = [
  './', 'index.html', 'Docs.html', 'SLD_Builder.html', 'PLC_Foundation.html',
  'Advanced.html', 'contact_boss.html', 'manifest.webmanifest', 'pwa.js',
  'icon-192.png', 'icon-512.png', 'favicon.svg', 'favicon.ico',
  'favicon-48x48.png', 'apple-touch-icon.png'
];

self.addEventListener('install', event => {
  // add one by one so a single missing file never breaks the install
  event.waitUntil(
    caches.open(CACHE_VERSION).then(cache =>
      Promise.all(PRECACHE.map(url => cache.add(url).catch(() => {})))
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);

  // Only handle same-origin GETs. Electra AI / Cloudflare worker / CDN calls pass straight through.
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  // Pages: network first (always fresh when online), cached copy when offline
  if (req.mode === 'navigate' || req.destination === 'document') {
    event.respondWith(
      fetch(req)
        .then(res => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE_VERSION).then(c => c.put(req, copy));
          }
          return res;
        })
        .catch(() =>
          caches.match(req, { ignoreSearch: true })
            .then(hit => hit || caches.match('index.html'))
        )
    );
    return;
  }

  // Everything else (icons, scripts, images): instant from cache, refresh in background
  event.respondWith(
    caches.open(CACHE_VERSION).then(async cache => {
      const cached = await cache.match(req, { ignoreSearch: true });
      const network = fetch(req)
        .then(res => {
          if (res && res.ok && res.type === 'basic') cache.put(req, res.clone());
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
