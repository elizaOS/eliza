/**
 * Service worker for elizaOS — offline caching for view bundles and hero images.
 *
 * Cache strategies:
 *  - /api/views/:id/bundle.js  → Stale-While-Revalidate (serve cache, update in background)
 *  - /api/views/:id/hero       → Cache-First with 24h max-age
 *  - App shell (index.html)    → Network-First with cache fallback
 *
 * Cache is version-keyed (VIEWS_CACHE_NAME, SHELL_CACHE_NAME) so bumping the
 * version strings in a future deploy triggers automatic cleanup of old caches
 * in the `activate` handler.
 */

"use strict";

const VIEWS_CACHE_NAME = "elizaos-views-v1";
const SHELL_CACHE_NAME = "elizaos-shell-v1";
const HERO_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 h
const KNOWN_CACHES = [VIEWS_CACHE_NAME, SHELL_CACHE_NAME];

const VIEW_BUNDLE_RE = /^\/api\/views\/[^/]+\/bundle\.js$/;
const VIEW_HERO_RE = /^\/api\/views\/[^/]+\/hero$/;

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

self.addEventListener("install", (event) => {
  // Take over immediately — don't wait for existing tabs to close.
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => !KNOWN_CACHES.includes(key))
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

// ---------------------------------------------------------------------------
// Fetch interception
// ---------------------------------------------------------------------------

self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Only intercept same-origin GET requests. Skip non-GET and cross-origin.
  if (request.method !== "GET") return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }

  if (url.origin !== self.location.origin) return;

  const pathname = url.pathname;

  if (VIEW_BUNDLE_RE.test(pathname)) {
    event.respondWith(staleWhileRevalidate(request, VIEWS_CACHE_NAME));
    return;
  }

  if (VIEW_HERO_RE.test(pathname)) {
    event.respondWith(cacheFirst(request, VIEWS_CACHE_NAME, HERO_MAX_AGE_MS));
    return;
  }

  // App shell: only intercept navigation requests for index.html (not API calls
  // or static assets that the browser handles fine without SW involvement).
  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request, SHELL_CACHE_NAME));
    return;
  }
});

// ---------------------------------------------------------------------------
// Message handling — cache eviction commands from the page
// ---------------------------------------------------------------------------

self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || typeof data !== "object") return;

  if (data.type === "sw:evict-view") {
    const viewId = typeof data.viewId === "string" ? data.viewId : null;
    if (!viewId) return;
    event.waitUntil(evictViewBundle(viewId));
  }

  if (data.type === "sw:evict-all-views") {
    event.waitUntil(caches.delete(VIEWS_CACHE_NAME));
  }
});

// ---------------------------------------------------------------------------
// Strategy helpers
// ---------------------------------------------------------------------------

/**
 * Stale-While-Revalidate:
 * 1. Return the cached response immediately (if available).
 * 2. Always fetch from the network in the background.
 * 3. Update the cache if the network ETag differs from the cached one.
 * 4. Notify clients of the update so DynamicViewLoader can refresh.
 */
async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);

  const networkPromise = fetch(request.clone())
    .then(async (networkResponse) => {
      if (!networkResponse.ok) return networkResponse;

      const newEtag = networkResponse.headers.get("etag");
      const oldEtag = cached?.headers.get("etag") ?? null;

      if (!cached || newEtag !== oldEtag) {
        await cache.put(request, networkResponse.clone());

        if (cached && newEtag !== oldEtag) {
          // Bundle was updated — notify all clients so they can hot-reload.
          const viewId = extractViewId(request.url);
          notifyClients({ type: "sw:view-updated", viewId });
        }
      }

      return networkResponse;
    })
    .catch(() => cached ?? new Response("Offline", { status: 503 }));

  return cached ?? networkPromise;
}

/**
 * Cache-First with max-age eviction:
 * Serve from cache if present and fresh; otherwise fetch and cache.
 */
async function cacheFirst(request, cacheName, maxAgeMs) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);

  if (cached) {
    const dateHeader = cached.headers.get("date");
    if (dateHeader) {
      const age = Date.now() - new Date(dateHeader).getTime();
      if (age < maxAgeMs) return cached;
    } else {
      // No Date header — serve as-is and let it be replaced on next fetch.
      return cached;
    }
  }

  const networkResponse = await fetch(request.clone()).catch(
    () => new Response("Offline", { status: 503 }),
  );

  if (networkResponse.ok) {
    await cache.put(request, networkResponse.clone());
  }

  return networkResponse;
}

/**
 * Network-First with cache fallback:
 * Try the network; on failure serve the cached version; on total miss return 503.
 */
async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);

  try {
    const networkResponse = await fetch(request.clone());
    if (networkResponse.ok) {
      await cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch {
    const cached = await cache.match(request);
    return cached ?? new Response("Offline", { status: 503 });
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/** Extract the view ID from a bundle or hero URL. */
function extractViewId(url) {
  try {
    const pathname = new URL(url).pathname;
    const match = pathname.match(/^\/api\/views\/([^/]+)\//);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Evict both the bundle and hero for a given view ID from the views cache. */
async function evictViewBundle(viewId) {
  const cache = await caches.open(VIEWS_CACHE_NAME);
  const keys = await cache.keys();
  await Promise.all(
    keys
      .filter((req) => {
        try {
          return new URL(req.url).pathname.startsWith(
            `/api/views/${viewId}/`,
          );
        } catch {
          return false;
        }
      })
      .map((req) => cache.delete(req)),
  );
}

/** Broadcast a message to all controlled clients. */
async function notifyClients(message) {
  const clients = await self.clients.matchAll({ includeUncontrolled: false });
  for (const client of clients) {
    client.postMessage(message);
  }
}
