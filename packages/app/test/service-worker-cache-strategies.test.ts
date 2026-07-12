/**
 * Service-worker runtime-cache + navigation-preload contract. Evaluates the
 * real `sw.js` inside a minimal worker-like VM (same technique as
 * service-worker-auth-bypass.test.ts) so the fetch/activate handlers can be
 * exercised without a browser install.
 *
 * Covers the cold-start wins added for the installed iOS PWA:
 *  - navigation preload is enabled on activate (feature-detected)
 *  - a navigation consumes event.preloadResponse instead of a second fetch
 *  - immutable /assets/<hash>.{js,css,...} are served cache-first and cached
 *  - the immutable asset cache is bounded (oldest entries evicted past the cap)
 *  - unknown caches are purged on activate
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));

type RequestLike = {
  method: string;
  mode: string;
  url: string;
  clone: () => RequestLike;
};

type FetchEventLike = {
  request: RequestLike;
  preloadResponse?: Promise<Response | undefined>;
  respondWith: (value: Promise<Response> | Response) => void;
  _responded?: Promise<Response> | Response;
};

type ExtendableEventLike = {
  waitUntil: (p: Promise<unknown>) => void;
  _work: Promise<unknown>[];
};

/** In-memory Cache that preserves insertion order (like the real Cache API). */
class FakeCache {
  entries = new Map<string, Response>();
  async match(request: RequestLike | string) {
    const key = typeof request === "string" ? request : request.url;
    return this.entries.get(key) ?? null;
  }
  async put(request: RequestLike | string, response: Response) {
    const key = typeof request === "string" ? request : request.url;
    // Re-insertion must move to the end to mirror browser MRU ordering.
    this.entries.delete(key);
    this.entries.set(key, response);
  }
  async keys() {
    // Return request-like objects carrying the url, insertion-ordered.
    return [...this.entries.keys()].map((url) => ({ url }));
  }
  async delete(request: RequestLike | string) {
    const key = typeof request === "string" ? request : request.url;
    return this.entries.delete(key);
  }
}

type Harness = {
  dispatch: (type: string, event: unknown) => void;
  caches: Map<string, FakeCache>;
  navPreloadEnabled: () => boolean;
  fetchCalls: () => string[];
};

function loadServiceWorker(options?: {
  navigationPreload?: boolean;
  preexistingCaches?: string[];
  fetchImpl?: (url: string) => Response;
}): Harness {
  const {
    navigationPreload = true,
    preexistingCaches = [],
    fetchImpl,
  } = options ?? {};

  const listeners = new Map<string, ((event: unknown) => void)[]>();
  const cacheStore = new Map<string, FakeCache>();
  for (const name of preexistingCaches) cacheStore.set(name, new FakeCache());

  let navPreloadOn = false;
  const registration = navigationPreload
    ? {
        navigationPreload: {
          enable: async () => {
            navPreloadOn = true;
          },
        },
      }
    : {};

  const self = {
    location: { origin: "https://app.example.test" },
    registration,
    addEventListener(type: string, listener: (event: unknown) => void) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    skipWaiting: () => Promise.resolve(),
    clients: {
      claim: () => Promise.resolve(),
      matchAll: () => Promise.resolve([]),
    },
  };

  const fetchCalls: string[] = [];
  const context = vm.createContext({
    self,
    URL,
    Response,
    Promise,
    caches: {
      keys: async () => [...cacheStore.keys()],
      open: async (name: string) => {
        let cache = cacheStore.get(name);
        if (!cache) {
          cache = new FakeCache();
          cacheStore.set(name, cache);
        }
        return cache;
      },
      delete: async (name: string) => cacheStore.delete(name),
    },
    fetch: async (request: RequestLike) => {
      const url = typeof request === "string" ? request : request.url;
      fetchCalls.push(url);
      return fetchImpl
        ? fetchImpl(url)
        : new Response("network-body", { status: 200 });
    },
  });

  const script = readFileSync(path.resolve(here, "../public/sw.js"), "utf8");
  vm.runInContext(script, context, { filename: "sw.js" });

  return {
    dispatch(type, event) {
      for (const listener of listeners.get(type) ?? []) listener(event);
    },
    caches: cacheStore,
    navPreloadEnabled: () => navPreloadOn,
    fetchCalls: () => fetchCalls,
  };
}

function makeRequest(pathname: string, mode = "navigate"): RequestLike {
  const request: RequestLike = {
    method: "GET",
    mode,
    url: `https://app.example.test${pathname}`,
    clone: () => request,
  };
  return request;
}

function makeFetchEvent(
  pathname: string,
  opts?: { mode?: string; preloadResponse?: Promise<Response | undefined> },
): FetchEventLike {
  const event: FetchEventLike = {
    request: makeRequest(pathname, opts?.mode ?? "navigate"),
    preloadResponse: opts?.preloadResponse,
    respondWith(value) {
      event._responded = value;
    },
  };
  return event;
}

function makeActivateEvent(): ExtendableEventLike {
  const work: Promise<unknown>[] = [];
  return {
    waitUntil(p) {
      work.push(p);
    },
    _work: work,
  };
}

describe("service worker navigation preload", () => {
  it("enables navigation preload on activate when supported", async () => {
    const worker = loadServiceWorker({ navigationPreload: true });
    const event = makeActivateEvent();
    worker.dispatch("activate", event);
    await Promise.all(event._work);
    expect(worker.navPreloadEnabled()).toBe(true);
  });

  it("does not throw on activate when navigation preload is unsupported", async () => {
    const worker = loadServiceWorker({ navigationPreload: false });
    const event = makeActivateEvent();
    worker.dispatch("activate", event);
    await expect(Promise.all(event._work)).resolves.toBeDefined();
  });

  it("purges unknown caches on activate but keeps known ones", async () => {
    const worker = loadServiceWorker({
      preexistingCaches: [
        "stale-cache-v0",
        "elizaos-shell-v5",
        "elizaos-shell-v6",
      ],
    });
    const event = makeActivateEvent();
    worker.dispatch("activate", event);
    await Promise.all(event._work);
    expect(worker.caches.has("stale-cache-v0")).toBe(false);
    expect(worker.caches.has("elizaos-shell-v5")).toBe(false);
    expect(worker.caches.has("elizaos-shell-v6")).toBe(true);
  });

  it("consumes the navigation preload response instead of issuing a second fetch", async () => {
    const worker = loadServiceWorker({ navigationPreload: true });
    const preloaded = new Response("preloaded-shell", { status: 200 });
    const event = makeFetchEvent("/chat", {
      preloadResponse: Promise.resolve(preloaded),
    });
    worker.dispatch("fetch", event);
    const response = await event._responded;
    expect(await response?.text()).toBe("preloaded-shell");
    // No direct fetch() call — the preload response satisfied the navigation.
    expect(worker.fetchCalls()).toHaveLength(0);
  });

  it("falls back to fetch when no preload response is present", async () => {
    const worker = loadServiceWorker({ navigationPreload: true });
    const event = makeFetchEvent("/chat");
    worker.dispatch("fetch", event);
    await event._responded;
    expect(worker.fetchCalls()).toContain("https://app.example.test/chat");
  });
});

describe("service worker immutable asset cache", () => {
  it("caches an immutable /assets/* response on first fetch and serves it from cache next time", async () => {
    let bodyCounter = 0;
    const worker = loadServiceWorker({
      fetchImpl: () =>
        new Response(`asset-body-${bodyCounter++}`, { status: 200 }),
    });
    const assetPath = "/assets/main-abc123.js";

    // First request: network miss → fetch + cache.
    const first = makeFetchEvent(assetPath, { mode: "cors" });
    worker.dispatch("fetch", first);
    const firstBody = await (await first._responded)?.text();
    expect(firstBody).toBe("asset-body-0");
    expect(worker.fetchCalls()).toHaveLength(1);

    // Second request: cache hit → no additional network fetch.
    const second = makeFetchEvent(assetPath, { mode: "cors" });
    worker.dispatch("fetch", second);
    const secondBody = await (await second._responded)?.text();
    expect(secondBody).toBe("asset-body-0");
    expect(worker.fetchCalls()).toHaveLength(1);
  });

  it("does not intercept non-hashed same-origin assets outside /assets/", async () => {
    const worker = loadServiceWorker();
    const event = makeFetchEvent("/favicon.ico", { mode: "no-cors" });
    worker.dispatch("fetch", event);
    // Non-navigation, non-view, non-/assets/ request must fall through
    // (respondWith never called).
    expect(event._responded).toBeUndefined();
  });

  it("bounds the immutable asset cache to its cap (oldest evicted first)", async () => {
    const worker = loadServiceWorker();
    // Cap is 220; push 225 distinct hashed assets, expect the 5 oldest gone.
    for (let i = 0; i < 225; i++) {
      const event = makeFetchEvent(`/assets/chunk-${i}.js`, { mode: "cors" });
      worker.dispatch("fetch", event);
      // Await settle so cache put + trim complete before the next iteration.
      // eslint-disable-next-line no-await-in-loop
      await event._responded;
    }
    const assetsCache = worker.caches.get("elizaos-assets-v1");
    expect(assetsCache).toBeDefined();
    const keys = [...(assetsCache as FakeCache).entries.keys()];
    expect(keys.length).toBe(220);
    // Oldest five (chunk-0..chunk-4) should have been evicted.
    expect(keys).not.toContain("https://app.example.test/assets/chunk-0.js");
    expect(keys).not.toContain("https://app.example.test/assets/chunk-4.js");
    // Newest must remain.
    expect(keys).toContain("https://app.example.test/assets/chunk-224.js");
  });
});
