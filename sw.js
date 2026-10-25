// Makes the site installable and lets it open offline.
// Never touches /api/ calls. Pages and data try the internet first,
// so new deploys show up right away; the saved copy is only a fallback.
const CACHE = 'oob-v3';

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.all(['/', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png'].map(u => c.add(u).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  e.respondWith(
    fetch(req)
      .then(r => { if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(req.mode === 'navigate' ? '/' : req, copy)); } return r; })
      .catch(() => caches.match(req.mode === 'navigate' ? '/' : req))
  );
});
