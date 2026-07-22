/* Funkified — Service Worker
   - Caches the app shell so the PWA loads offline.
   - Network-first for same-origin GETs (so deploys land fast), with a
     3.5s timeout that falls back to cache on slow links.
   - Passes through POSTs and external endpoints without touching them.
   - Supports skipWaiting on demand.
*/
const VERSION = 'funkified-v44-2026-07-22-finish-queue';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap'
];

const PASSTHROUGH_HOSTS = [
  'script.google.com',
  'script.googleusercontent.com',
  'drive.google.com',
  'googleusercontent.com',
  'nominatim.openstreetmap.org'
];

self.addEventListener('install', event => {
  // Activate this SW as soon as install completes — combined with
  // clients.claim() on activate, this means deploys propagate without
  // needing the user to clear cache or close tabs.
  event.waitUntil(
    caches.open(VERSION).then(cache => {
      const sameOrigin = APP_SHELL.filter(u => !/^https?:/i.test(u));
      const crossOrigin = APP_SHELL.filter(u => /^https?:/i.test(u));
      return Promise.all([
        // Shell files must all land — if any fails, let install fail so
        // the previous (working) cache survives instead of a broken one.
        cache.addAll(sameOrigin),
        // Fonts are best-effort: a CDN hiccup shouldn't block the install.
        ...crossOrigin.map(u => cache.add(u).catch(() => {}))
      ]);
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== VERSION).map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);

  // Never intercept non-GET. Apps Script POSTs must go straight to the network
  // so the client-side drain / idempotency layer stays in charge.
  if (req.method !== 'GET') return;

  // Passthrough for third-party endpoints we don't want to cache.
  if (PASSTHROUGH_HOSTS.some(h => url.hostname.endsWith(h))) return;

  // Network-first strategy for same-origin + allowlisted GETs.
  // Kick the fetch off once: it both feeds the race below and keeps
  // refreshing the cache even when the cached copy wins on a slow link.
  const networkFetch = fetch(req).then(res => {
    // Cache successful basic responses for next offline session.
    if (res && res.status === 200 && (res.type === 'basic' || res.type === 'cors')) {
      const copy = res.clone();
      caches.open(VERSION).then(c => c.put(req, copy)).catch(() => {});
    }
    return res;
  });

  const TIMEOUT = Symbol('timeout');
  event.respondWith(
    Promise.race([
      networkFetch,
      new Promise(resolve => setTimeout(() => resolve(TIMEOUT), 3500))
    ]).then(winner => {
      if (winner !== TIMEOUT) return winner;
      // Slow network: serve the cached copy now; networkFetch above still
      // updates the cache when (if) the late response finally arrives.
      return caches.match(req).then(hit => hit || networkFetch);
    }).catch(() => caches.match(req).then(hit => {
      if (hit) return hit;
      // Only page navigations should fall back to the app shell —
      // returning HTML for a missed asset just corrupts that asset.
      return req.mode === 'navigate' ? caches.match('./index.html') : Response.error();
    }))
  );
});
