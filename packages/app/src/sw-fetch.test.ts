/**
 * Contract tests for the service-worker `fetch` handler (`public/sw.js`),
 * focused on the auth/OAuth navigation branch (`/login`, `?code=`, `?token=`).
 *
 * `sw.js` is plain event-listener JS: it registers `self.addEventListener`
 * handlers at load time. We evaluate it against a stubbed `self` (capturing the
 * registered `fetch` listener) and stubbed `caches`/`fetch`, then dispatch
 * synthetic `FetchEvent`s — driving the real handler, not a re-implementation.
 *
 * The invariant under test: auth navigations must consume the browser's
 * navigation-preload fetch (so no "navigation preload request was cancelled"
 * warning / wasted round-trip) while still serving only uncached network
 * responses — the `caches` API must never be touched on this path.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ORIGIN = "https://app.example.com";

interface CapturedListeners {
  fetch?: (event: unknown) => void;
}

interface FetchEventStub {
  request: { url: string; method: string; mode: string };
  preloadResponse: Promise<unknown>;
  respondWith: ReturnType<typeof vi.fn>;
  responsePromise?: unknown;
}

// A `caches` stub whose every access records a hit, so a test can assert the
// auth branch never reaches the Cache Storage API (would mean a cached shell
// could be served on the sign-in golden path — the forbidden regression).
function makeCachesSpy() {
  const calls: string[] = [];
  const record = (name: string) => {
    calls.push(name);
  };
  // open() resolves to a functional Cache stub so a control (non-auth)
  // navigation can flow through networkFirst without an unhandled rejection;
  // every access still lands in `calls` for the "was Cache Storage touched?"
  // assertions the auth-branch tests rely on.
  const cache = {
    match: () => {
      record("cache.match");
      return Promise.resolve(undefined);
    },
    put: () => {
      record("cache.put");
      return Promise.resolve();
    },
  };
  const caches = {
    open: (...a: unknown[]) => {
      record(`open:${String(a[0])}`);
      return Promise.resolve(cache);
    },
    match: () => {
      record("match");
      return Promise.resolve(undefined);
    },
    keys: () => {
      record("keys");
      return Promise.resolve([]);
    },
    delete: () => {
      record("delete");
      return Promise.resolve(true);
    },
  };
  return { caches, calls };
}

function loadFetchListener(caches: unknown, fetchImpl: unknown) {
  const listeners: CapturedListeners = {};
  const self = {
    addEventListener: (type: string, handler: (event: unknown) => void) => {
      if (type === "fetch") listeners.fetch = handler;
    },
    location: { origin: ORIGIN },
    registration: { navigationPreload: undefined, showNotification: vi.fn() },
    clients: { matchAll: () => Promise.resolve([]), claim: () => {} },
    navigator: {},
    skipWaiting: () => Promise.resolve(),
    __elizaPush: undefined,
  };
  const src = readFileSync(join(__dirname, "..", "public", "sw.js"), "utf8");
  // importScripts is a no-op here: the push module is exercised separately in
  // sw-push.test.ts and is irrelevant to the fetch-routing logic under test.
  const importScripts = () => {};
  const console = { warn: () => {}, error: () => {}, log: () => {} };
  // eslint-disable-next-line no-new-func
  new Function("self", "caches", "fetch", "importScripts", "console", src)(
    self,
    caches,
    fetchImpl,
    importScripts,
    console,
  );
  if (!listeners.fetch)
    throw new Error("sw.js did not register a fetch listener");
  return listeners.fetch;
}

function makeNavEvent(url: string, preload: unknown): FetchEventStub {
  const event: FetchEventStub = {
    request: { url, method: "GET", mode: "navigate" },
    preloadResponse: Promise.resolve(preload),
    respondWith: vi.fn((p: unknown) => {
      event.responsePromise = p;
    }),
  };
  return event;
}

const AUTH_URLS = [
  `${ORIGIN}/login`,
  `${ORIGIN}/?code=abc123`,
  `${ORIGIN}/auth/callback?token=xyz`,
];

describe("sw.js fetch handler — auth navigation branch", () => {
  let caches: unknown;
  let cacheCalls: string[];
  let fetchImpl: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    const spy = makeCachesSpy();
    caches = spy.caches;
    cacheCalls = spy.calls;
    fetchImpl = vi.fn(() => Promise.resolve({ __from: "fetch" }));
  });

  it.each(
    AUTH_URLS,
  )("takes over the response to consume the preload for %s", async (url) => {
    const handler = loadFetchListener(caches, fetchImpl);
    const preload = { __from: "preload" };
    const event = makeNavEvent(url, preload);

    handler(event);

    // Regression guard: before the fix this branch returned without
    // respondWith, leaving event.preloadResponse unconsumed.
    expect(event.respondWith).toHaveBeenCalledTimes(1);
    await expect(event.responsePromise).resolves.toBe(preload);
    // The preload already carried the network response, so no direct fetch.
    expect(fetchImpl).not.toHaveBeenCalled();
    // Never touch Cache Storage on the auth path — no cached shell served.
    expect(cacheCalls).toEqual([]);
  });

  it("falls back to a live fetch when no preload was issued", async () => {
    const handler = loadFetchListener(caches, fetchImpl);
    const event = makeNavEvent(`${ORIGIN}/login`, undefined);

    handler(event);

    expect(event.respondWith).toHaveBeenCalledTimes(1);
    const resolved = await event.responsePromise;
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(resolved).toEqual({ __from: "fetch" });
    // Fallback is still an uncached network fetch — no Cache Storage access.
    expect(cacheCalls).toEqual([]);
  });

  it("falls back to a live fetch when the preload REJECTS (flaky-network sign-in must not fail)", async () => {
    const handler = loadFetchListener(caches, fetchImpl);
    const event: FetchEventStub = {
      request: { url: `${ORIGIN}/login`, method: "GET", mode: "navigate" },
      preloadResponse: Promise.reject(new Error("preload aborted")),
      respondWith: vi.fn((p: unknown) => {
        event.responsePromise = p;
      }),
    };

    handler(event);

    // The pre-takeover bypass let the browser fetch directly after a dead
    // preload; the takeover must be no more fragile than that.
    expect(event.respondWith).toHaveBeenCalledTimes(1);
    const resolved = await event.responsePromise;
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(resolved).toEqual({ __from: "fetch" });
    expect(cacheCalls).toEqual([]);
  });

  it("still routes a normal shell navigation through the cache (control)", () => {
    const handler = loadFetchListener(caches, fetchImpl);
    const event = makeNavEvent(`${ORIGIN}/dashboard`, undefined);

    handler(event);

    // A non-auth navigation is intercepted by networkFirst, which does consult
    // the shell cache — proving the auth carve-out above is branch-specific.
    expect(event.respondWith).toHaveBeenCalledTimes(1);
    expect(cacheCalls.some((c) => c.startsWith("open:"))).toBe(true);
  });
});
