// Offline-first PWA cache. The deploy script injects a new build id
// (yy-MM-dd-HH-mm) so a new app build gets a fresh cache.
const CACHE_PREFIX = 'guts-';
const CACHE = CACHE_PREFIX + '26-11-12-20-47';
const INDEX = new URL('index.html', self.registration.scope).href;

// Cache API stores the decoded body but keeps Content-Encoding/Content-Length
// from the network response. Serving that back makes the browser decode twice.
function withoutContentEncoding(response) {
    if (!response.headers.has('content-encoding'))
        return response;

    const headers = new Headers(response.headers);
    headers.delete('content-encoding');
    headers.delete('content-length');
    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
    });
}

// Small app shell: the large wasm/pck files are cached on demand by fetch.
const SHELL = [
    './',
    'index.html',
    'manifest.json',
    'favicon.ico',
    'favicon.svg',
    'favicon-16x16.png',
    'favicon-32x32.png',
    'favicon-96x96.png',
    'icon-192.png',
    'icon-512.png',
    'icon-maskable-512.png',
    'splash.png',
    'godot.js',
    'godot.audio.worklet.js',
    'godot.audio.position.worklet.js',
    'twodog.sizes.json',
].map((path) => new URL(path, self.registration.scope).href);

self.addEventListener('install', (event) => {
    // Activate as soon as this build is installed, regardless of open clients.
    self.skipWaiting();
    event.waitUntil((async () => {
        const cache = await caches.open(CACHE);
        await Promise.all(SHELL.map(async (url) => {
            const response = await fetch(url, { cache: 'reload' });
            if (!response.ok)
                throw new Error(`Cannot cache ${url}: ${response.status}`);
            await cache.put(url, withoutContentEncoding(response));
        }));
    })());
});

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        await self.clients.claim();
        // The previous worker may have dropped shell entries while this cache
        // was being created (it treats every other cache as old).
        await restoreShell();
        // Keep the newest complete old bundle as the offline fallback.
        await cleanupOldCaches(false);
    })());
});

async function restoreShell() {
    const cache = await caches.open(CACHE);
    await Promise.all(SHELL.map(async (url) => {
        if (await cache.match(url))
            return;
        try {
            const response = await fetch(url, { cache: 'reload' });
            if (response.ok)
                await cache.put(url, withoutContentEncoding(response));
        } catch {
            // Activation must not fail because of one shell file.
        }
    }));
}

async function matchAny(request) {
    const cached = await caches.match(request);
    if (!cached)
        return undefined;

    return withoutContentEncoding(cached);
}

// Everything the engine needs to boot without network. The old cache may only
// be dropped once the new one has all of it.
const REQUIRED = [
    'godot.wasm',
    'godot.pck',
    '_framework/dotnet.boot.js',
    '_framework/dotnet.native.js',
    '_framework/GodotClient.web.wasm',
    '_framework/Guts.wasm',
    '_framework/System.Private.CoreLib.wasm',
].map((path) => new URL(path, self.registration.scope).href);

async function isComplete(cacheName) {
    const cache = await caches.open(cacheName);
    for (const url of REQUIRED) {
        if (!(await cache.match(url)))
            return false;
    }
    return true;
}

// Keeps at most one complete old bundle as an offline fallback. The fallback
// is dropped only when the page confirms its whole load came from this cache.
async function cleanupOldCaches(dropFallback) {
    const keys = (await caches.keys())
        .filter((key) => key.startsWith(CACHE_PREFIX) && key < CACHE)
        .sort()
        .reverse();

    let keepFallback = !dropFallback;
    for (const key of keys) {
        if (keepFallback && await isComplete(key)) {
            keepFallback = false;
            continue;
        }
        await caches.delete(key);
    }
}

async function putAndCleanup(request, response) {
    const cache = await caches.open(CACHE);
    await cache.put(request, withoutContentEncoding(response));
    await cleanupOldCaches(false);
}

self.addEventListener('message', (event) => {
    if (event.data?.type === 'GET_CACHE_VERSION' && event.ports?.[0]) {
        event.ports[0].postMessage({ type: 'CACHE_VERSION', cache: CACHE });
        return;
    }

    if (event.data?.type === 'SKIP_WAITING') {
        self.skipWaiting();
        return;
    }

    // The page sends every URL it loaded once the game is running. If all of
    // them are in this cache, the previous build is no longer needed.
    if (event.data?.type === 'CACHE_READY' && Array.isArray(event.data.urls)) {
        event.waitUntil((async () => {
            const cache = await caches.open(CACHE);
            for (const url of event.data.urls) {
                if (!(await cache.match(url)))
                    return;
            }
            await cleanupOldCaches(true);
        })());
    }
});

self.addEventListener('fetch', (event) => {
    const request = event.request;
    if (request.method !== 'GET')
        return;

    const url = new URL(request.url);
    if (url.origin !== self.location.origin)
        return;

    // The engine may request ranges on hosts that advertise them. A full 200
    // response is a valid answer and lets the whole file be cached; a 206 is
    // passed through without caching.
    if (request.headers.has('range')) {
        event.respondWith((async () => {
            const cache = await caches.open(CACHE);
            const cached = await cache.match(request.url);
            if (cached)
                return withoutContentEncoding(cached);

            try {
                const response = await fetch(request.url);
                if (response.status === 200 && response.type === 'basic')
                    event.waitUntil(putAndCleanup(request.url, response.clone()));
                return response;
            } catch (error) {
                const fallback = await matchAny(request.url);
                if (fallback)
                    return fallback;
                throw error;
            }
        })());
        return;
    }

    if (request.mode === 'navigate') {
        event.respondWith((async () => {
            try {
                const response = await fetch(request);
                if (response.ok) {
                    event.waitUntil(putAndCleanup(INDEX, response.clone()));
                    return response;
                }

                // A proxy/host error (502/503) is as good as offline here.
                const cached = (await matchAny(INDEX)) ||
                    (await matchAny('./'));
                return cached || response;
            } catch {
                return (await matchAny(INDEX)) ||
                    (await matchAny('./')) ||
                    Response.error();
            }
        })());
        return;
    }

    event.respondWith((async () => {
        const cache = await caches.open(CACHE);
        const cached = await cache.match(request);
        if (cached)
            return withoutContentEncoding(cached);

        try {
            const response = await fetch(request);
            if (response.ok && response.type === 'basic')
                event.waitUntil(putAndCleanup(request, response.clone()));
            return response;
        } catch (error) {
            // Network failed: an older build is better than nothing. It is not
            // copied into this cache, so the next online load fetches fresh.
            const fallback = await matchAny(request);
            if (fallback)
                return fallback;
            throw error;
        }
    })());
});
