const CACHE = 'nirve-v2';
const ASSETS = ['/'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Never intercept API calls, auth, or external services
  if (
    url.hostname.includes('supabase.co') ||
    url.hostname.includes('groq.com') ||
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/auth/') ||
    e.request.method !== 'GET'
  ) {
    return; // Let browser handle normally
  }

  // For same-origin GET requests only
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});
