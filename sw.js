/* Service Worker for Cardiac Nursing v20.1 (TWA / PWA Fast-Offline Support) */
const CACHE_NAME = 'cardiac-nursing-v20-cache-2';
const NETWORK_TIMEOUT_MS = 3500;
const CORE_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png'
];

function fetchWithTimeout(request, ms) {
  return new Promise((resolve, reject) => {
    const controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    const timer = setTimeout(() => {
      if (controller) {
        try { controller.abort(); } catch (e) {}
      }
      reject(new Error('Network timeout'));
    }, ms);

    const opts = controller ? { signal: controller.signal } : {};
    fetch(request, opts)
      .then((res) => {
        clearTimeout(timer);
        resolve(res);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(CORE_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Never intercept non-http(s) protocols (blob:, data:, tel:, etc.)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  // Same-origin app files: Network-first with 3.5s timeout -> instant Offline Cache fallback
  if (url.origin === self.location.origin) {
    event.respondWith(
      fetchWithTimeout(req, NETWORK_TIMEOUT_MS)
        .then((res) => {
          if (res && res.status === 200 && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() =>
          caches.match(req, { ignoreSearch: true }).then((cached) => {
            if (cached) return cached;
            if (req.mode === 'navigate') {
              return caches.match('./index.html') || caches.match('./');
            }
            return new Response('', { status: 504, statusText: 'Offline' });
          })
        )
    );
    return;
  }

  // Google Fonts: Cache-first with background refresh (instant offline handwriting fonts)
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(
      caches.match(req).then((cached) => {
        const netFetch = fetchWithTimeout(req, 5000).then((res) => {
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).catch(() => {});
          }
          return res;
        }).catch(() => cached);
        return cached || netFetch;
      })
    );
  }
});
