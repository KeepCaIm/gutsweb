// Network-only service worker: satisfies PWA installability without caching
// the large wasm/pck bundle.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
