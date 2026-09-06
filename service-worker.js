const CACHE_NAME = 'motor-testing-pwa-v1';
const APP_SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './normEngine.js',
  './taskEngine.js',
  './manifest.json',
  './icon.svg',
  './data/task_guide.json',
  './data/norms_dictionary.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).catch((error) => {
      console.warn('Precache failed:', error);
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  if (request.method !== 'GET') {
    return;
  }

  event.respondWith(
    caches.match(request).then((cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse;
      }

      return fetch(request)
        .then((networkResponse) => {
          if (request.url.startsWith(self.location.origin)) {
            const cloned = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, cloned));
          }
          return networkResponse;
        })
        .catch(() => {
          if (request.mode === 'navigate') {
            return caches.match('./index.html');
          }

          return new Response('Offline mode', { status: 503, statusText: 'Offline' });
        });
    })
  );
});
