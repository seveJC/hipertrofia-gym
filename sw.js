const CACHE_NAME = 'hipertrofia-v3';
const ASSETS = ['./', './index.html', './styles.css', './app.js', './manifest.json'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Network-first para los ficheros de la app: siempre intenta traer la versión
// más reciente; sin conexión, sirve la copia en caché (para poder seguir
// registrando entrenos offline). Las llamadas a GitHub (copia de seguridad,
// fichero semilla) no pasan por la caché: un PUT no se puede cachear y una
// respuesta vieja de la API daría un sha desfasado.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then(async (cache) => {
            await cache.put(req, copy);
            // Los ficheros llevan ?v=N para saltarse cachés: al guardar una
            // versión, se borran las anteriores del mismo fichero.
            const keys = await cache.keys();
            await Promise.all(keys
              .filter((k) => {
                const ku = new URL(k.url);
                return ku.pathname === url.pathname && ku.search !== url.search;
              })
              .map((k) => cache.delete(k)));
          });
        }
        return res;
      })
      .catch(() => caches.match(req))
  );
});
