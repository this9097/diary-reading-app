const CACHE = 'rb-cache-v14';
const CORE = ['./index.html', './app.js', './manifest.json'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
  );
  self.clients.claim();
});

// network-first for HTML/JS so updates aren't blocked by stale cache; cache-first for everything else
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  const isCore = e.request.mode === 'navigate' || CORE.some(p => url.pathname.endsWith(p.replace('./', '')));
  if (isCore) {
    e.respondWith(
      fetch(e.request).then(res => {
        caches.open(CACHE).then(c => c.put(e.request, res.clone()));
        return res;
      }).catch(() => caches.match(e.request))
    );
  } else {
    e.respondWith(
      caches.match(e.request).then(cached => cached || fetch(e.request))
    );
  }
});
