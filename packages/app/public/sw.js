/**
 * Service worker for elizaOS — offline caching for view bundles and hero images.
 *
 * Cache strategies:
 *  - /api/views/:id/bundle.js  → Stale-While-Revalidate (serve cache, update in background)
 *  - /api/views/:id/hero       → Cache-First with 24h max-age
 *  - /assets/<hashed>.{js,css} → Cache-First (immutable: the content hash is in
 *                                the filename, so a byte-changed asset gets a new
 *                                URL and can never be served stale)
 *  - App shell (index.html)    → Network-First with cache fallback + navigation
 *                                preload (browser fetches in parallel with SW
 *                                boot, so a cold nav doesn't wait on SW startup)
 *
 * Cache is version-keyed (VIEWS_CACHE_NAME, SHELL_CACHE_NAME, ASSETS_CACHE_NAME)
 * so bumping the version strings in a future deploy triggers automatic cleanup
 * of old caches in the `activate` handler.
 */

"use strict";

// Web Push handler logic (push/notificationclick shaping, deep-link routing,
// badge helpers) lives in a standalone, unit-tested module. importScripts runs
// it synchronously at SW startup and attaches `self.__elizaPush`. Guarded so a
// missing file (older deploy) degrades to "no push" rather than failing SW
// install for the whole app.
try {
  importScripts("/sw-push.js");
} catch (err) {
  // Push is a progressive enhancement — the SW's caching still works without it.
  // eslint-disable-next-line no-console
  console.warn("[SW] push module unavailable:", err && err.message);
}

const VIEWS_CACHE_NAME = "elizaos-views-v1";
// Bump the shell cache to evict any stale precached index/CSS in an installed
// iOS standalone PWA (Add-to-Home-Screen runs this SW). The network-first shell
// still updates on reload, but the version bump forces old caches to be dropped
// in `activate` so a re-open can't serve a pre-safe-area-fix shell from cache.
// v5: black launch baseline (theme-color + launch-bg -> #000000; the home
// background is the black field with the orange ember glow, and boot no
// longer paints orange). Bump drops any cached prior shell.
const SHELL_CACHE_NAME = "elizaos-shell-v5";
// Immutable runtime cache for Vite's content-hashed build output (/assets/*).
// The filename hash IS the cache key's freshness guarantee: any byte change
// produces a new filename, so cache-first can never serve a stale asset. This
// insulates a resumed iOS PWA from WKWebView's aggressive HTTP-cache eviction
// under memory pressure (which otherwise forces a multi-MB re-download of the
// same immutable bundle). Bump the version to purge the whole cache on deploy.
const ASSETS_CACHE_NAME = "elizaos-assets-v1";
const HERO_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 h
// Bound the immutable /assets/* cache so a long-lived install with many deploys
// can't grow it without limit. Content-hashed assets accumulate across builds;
// keep the most-recently-used window and evict the oldest beyond it. 220 entries
// comfortably covers one full eager+lazy graph (the develop dist ships ~765
// chunks total, but a single session only touches the entry + visited routes).
const ASSETS_CACHE_MAX_ENTRIES = 220;
const KNOWN_CACHES = [VIEWS_CACHE_NAME, SHELL_CACHE_NAME, ASSETS_CACHE_NAME];

const VIEW_BUNDLE_RE = /^\/api\/views\/[^/]+\/bundle\.js$/;
const VIEW_HERO_RE = /^\/api\/views\/[^/]+\/hero$/;
// Vite emits content-hashed static build output under /assets/. The hash makes
// these safe to treat as immutable (cache-first, never revalidate).
const IMMUTABLE_ASSET_RE = /^\/assets\/[^/]+\.(?:js|mjs|css|woff2?|json|wasm)$/;

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

self.addEventListener("install", (event) => {
  // Take over immediately — don't wait for existing tabs to close.
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Drop any caches from a prior SW version (including bumped ASSETS/SHELL).
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => !KNOWN_CACHES.includes(key))
          .map((key) => caches.delete(key)),
      );

      // Enable navigation preload: the browser fetches the navigation request
      // in parallel with SW startup, so a cold navigation no longer stalls
      // waiting for the worker to boot before the network fetch even begins.
      // Feature-detected — Safari shipped this in 16.4, older engines no-op.
      if (self.registration.navigationPreload) {
        try {
          await self.registration.navigationPreload.enable();
        } catch {
          // Non-fatal: fall back to plain network-first if enable() rejects.
        }
      }

      await self.clients.claim();
    })(),
  );
});

// ---------------------------------------------------------------------------
// Web Push (iOS 16.4+ installed PWA) — client-side foundation.
//
// The cloud sender lands separately; here the SW just renders an inbound push
// as a notification, syncs the app badge, and routes a click back to the right
// conversation. All shaping/routing logic is in `/sw-push.js` (`__elizaPush`),
// which is unit-tested; these listeners are thin adapters over it.
// ---------------------------------------------------------------------------

self.addEventListener("push", (event) => {
  const push = self.__elizaPush;
  if (!push) return; // module failed to load — nothing to render.

  const payload = push.parsePushData(event.data);
  const { title, options } = push.buildNotification(payload);
  const badgeCount = push.badgeCountFromPayload(payload);

  // Foreground suppression: if an app window is visible, hand the payload to
  // the page (in-app indicator) instead of buzzing an OS notification for a
  // reply the user is already reading. Only skip the notification when a
  // visible client actually took it — otherwise always show (userVisibleOnly).
  const origin = self.location && self.location.origin;
  event.waitUntil(
    Promise.all([
      push
        .dispatchToVisibleClients(self.clients, payload, origin)
        .then((deliveredInApp) => {
          if (deliveredInApp) return undefined;
          return self.registration.showNotification(title, options);
        }),
      push.applyBadge(self.navigator, badgeCount),
    ]),
  );
});

self.addEventListener("notificationclick", (event) => {
  const push = self.__elizaPush;
  event.notification.close();
  if (!push) return;

  const data = event.notification.data;
  const targetPath = push.resolveClickTarget(data, self.location.origin);

  event.waitUntil(
    Promise.all([
      push.focusOrOpen(self.clients, targetPath, self.location.origin),
      // A tapped notification means the user is reading — clear the badge.
      push.clearBadge(self.navigator),
    ]),
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

  // Immutable content-hashed build assets: serve cache-first with no max-age
  // (the hash guarantees freshness) so a memory-pressure HTTP-cache eviction on
  // iOS can't force re-downloading the full bundle on resume.
  if (IMMUTABLE_ASSET_RE.test(pathname)) {
    event.respondWith(immutableAssetFirst(request, ASSETS_CACHE_NAME));
    return;
  }

  // Auth navigations are NEVER intercepted: the sign-in page and the OAuth
  // callback must always load the freshest shell from the network. A stale
  // cached shell can carry an outdated build — e.g. one baked with the wrong
  // Steward tenant — which makes the code exchange fail with 401, and caching a
  // one-time `?code=` callback URL risks replaying a consumed code. We take
  // over the response only to drain the already-issued navigation-preload fetch
  // (`event.preloadResponse`) — otherwise the browser logs "navigation preload
  // request was cancelled" and wastes that round-trip on the sign-in golden
  // path. The invariant above is preserved: both the preload and the fallback
  // are uncached network fetches, so no cached shell is ever served here.
  if (
    pathname === "/login" ||
    url.searchParams.has("code") ||
    url.searchParams.has("token")
  ) {
    event.respondWith(
      (async () => {
        try {
          const preloaded = await event.preloadResponse;
          if (preloaded) return preloaded;
        } catch (_err) {
          // error-policy:J4 a failed/aborted preload must not fail the sign-in
          // navigation — fall through to the same direct network fetch the
          // pre-takeover bypass delegated to the browser.
        }
        return fetch(request);
      })(),
    );
    return;
  }

  // App shell: only intercept navigation requests for index.html (not API calls
  // or static assets that the browser handles fine without SW involvement).
  // `event.preloadResponse` carries the browser's parallel navigation-preload
  // fetch (when enabled), so networkFirst can consume it instead of issuing a
  // second fetch — the cold-nav win.
  if (request.mode === "navigate") {
    event.respondWith(
      networkFirst(request, SHELL_CACHE_NAME, event.preloadResponse),
    );
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

  // The page asks the SW to clear the app badge when it comes to the
  // foreground / a conversation is opened (the page can't always call
  // clearAppBadge itself under all install modes; the SW owns the badge it set
  // on push receipt).
  if (data.type === "sw:clear-badge") {
    const push = self.__elizaPush;
    if (push) event.waitUntil(push.clearBadge(self.navigator));
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
 * Cache-First for immutable content-hashed assets:
 * The filename hash guarantees freshness, so a cache hit is always safe to
 * serve with no revalidation. On a miss, fetch + cache, then trim the cache to
 * its bounded MRU window so a long-lived install across many deploys can't grow
 * the asset cache without limit.
 */
async function immutableAssetFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;

  let networkResponse;
  try {
    networkResponse = await fetch(request.clone());
  } catch {
    return new Response("Offline", { status: 503 });
  }

  if (networkResponse.ok) {
    await cache.put(request, networkResponse.clone());
    // Bound the cache: evict oldest (insertion-order) entries beyond the cap.
    // Cache Storage preserves put() order, so keys()[0] is the least-recently
    // added; trimming from the front keeps the most recent window.
    await trimCache(cacheName, ASSETS_CACHE_MAX_ENTRIES);
  }

  return networkResponse;
}

/**
 * Network-First with cache fallback:
 * Prefer the navigation-preload response (parallel browser fetch) when present,
 * else fetch; cache any OK response; on network failure serve the cached shell;
 * on total miss return 503.
 */
async function networkFirst(request, cacheName, preloadResponsePromise) {
  const cache = await caches.open(cacheName);

  try {
    // Consume the browser's navigation-preload response if one was started;
    // otherwise fall back to a fresh fetch. `preloadResponse` resolves to
    // undefined when navigation preload is unsupported/disabled.
    const preloaded = preloadResponsePromise
      ? await preloadResponsePromise
      : undefined;
    const networkResponse = preloaded ?? (await fetch(request.clone()));
    if (networkResponse.ok) {
      await cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch {
    const cached = await cache.match(request);
    return cached ?? new Response("Offline", { status: 503 });
  }
}

/**
 * Trim a cache to at most `maxEntries`, deleting the oldest entries first.
 * Cache Storage `keys()` returns requests in insertion order, so slicing off
 * the front removes the least-recently-added assets.
 */
async function trimCache(cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  if (keys.length <= maxEntries) return;
  const excess = keys.slice(0, keys.length - maxEntries);
  await Promise.all(excess.map((key) => cache.delete(key)));
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
