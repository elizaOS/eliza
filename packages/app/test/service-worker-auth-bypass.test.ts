/**
 * Service-worker auth navigation guard (#15741). The tests evaluate the real
 * `sw.js` file inside a minimal worker-like VM so the fetch handler can be
 * exercised without a browser install.
 *
 * Contract for /login + OAuth-callback (?code= / ?token=) requests:
 *  - navigations ARE responded to (respondWith called synchronously), but as
 *    a pure network passthrough that consumes `event.preloadResponse` —
 *    leaving the preload unconsumed cancels the browser's parallel fetch and
 *    logs a "navigation preload request was cancelled" warning on the
 *    sign-in golden path;
 *  - when no preload was started (resolves undefined, or the property is
 *    absent on older engines) the ORIGINAL request goes straight to fetch(),
 *    preserving credentials/redirect semantics;
 *  - nothing is ever read from or written to any cache on this path;
 *  - non-navigation auth-param requests stay fully bypassed (no respondWith).
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
  _respondWithCalls: number;
};

type Harness = {
  dispatchFetch: (event: FetchEventLike) => void;
  /** Names of caches the worker opened/created (auth path must open none). */
  cacheNames: () => string[];
  /** URLs cached across every cache the worker opened. */
  cachedUrls: () => string[];
  /** Requests the worker passed to fetch(). */
  fetchedRequests: () => RequestLike[];
};

function loadServiceWorker(): Harness {
  const listeners = new Map<string, ((event: unknown) => void)[]>();

  /** In-memory Cache — enough surface for the strategies sw.js uses. */
  class FakeCache {
    entries = new Map<string, Response>();
    async match(request: RequestLike | string) {
      const key = typeof request === "string" ? request : request.url;
      return this.entries.get(key) ?? null;
    }
    async put(request: RequestLike | string, response: Response) {
      const key = typeof request === "string" ? request : request.url;
      this.entries.set(key, response);
    }
    async keys() {
      return [...this.entries.keys()].map((url) => ({ url }));
    }
    async delete(request: RequestLike | string) {
      const key = typeof request === "string" ? request : request.url;
      return this.entries.delete(key);
    }
  }

  const cacheStore = new Map<string, FakeCache>();
  const fetchedRequests: RequestLike[] = [];

  const self = {
    location: { origin: "https://app.example.test" },
    registration: {},
    addEventListener(type: string, listener: (event: unknown) => void) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    skipWaiting: () => Promise.resolve(),
    clients: {
      claim: () => Promise.resolve(),
      matchAll: () => Promise.resolve([]),
    },
  };

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
      fetchedRequests.push(request);
      return new Response("network-body", { status: 200 });
    },
  });

  const script = readFileSync(path.resolve(here, "../public/sw.js"), "utf8");
  vm.runInContext(script, context, { filename: "sw.js" });

  return {
    dispatchFetch(event) {
      for (const listener of listeners.get("fetch") ?? []) listener(event);
    },
    cacheNames: () => [...cacheStore.keys()],
    cachedUrls: () =>
      [...cacheStore.values()].flatMap((cache) => [...cache.entries.keys()]),
    fetchedRequests: () => fetchedRequests,
  };
}

function makeFetchEvent(
  pathname: string,
  opts?: { mode?: string; preloadResponse?: Promise<Response | undefined> },
): FetchEventLike {
  const request: RequestLike = {
    method: "GET",
    mode: opts?.mode ?? "navigate",
    url: `https://app.example.test${pathname}`,
    clone: () => request,
  };
  const event: FetchEventLike = {
    request,
    respondWith(value) {
      event._responded = value;
      event._respondWithCalls += 1;
    },
    _respondWithCalls: 0,
  };
  if (opts && "preloadResponse" in opts) {
    event.preloadResponse = opts.preloadResponse;
  }
  return event;
}

const AUTH_PATHS = ["/login", "/login?code=one-time", "/chat?token=handoff"];

describe("service worker auth navigation passthrough", () => {
  it.each(
    AUTH_PATHS,
  )("consumes the navigation preload response for %s (no second fetch, no cache)", async (pathname) => {
    const worker = loadServiceWorker();
    const preloaded = new Response("preloaded-auth-shell", { status: 200 });
    const event = makeFetchEvent(pathname, {
      preloadResponse: Promise.resolve(preloaded),
    });

    worker.dispatchFetch(event);

    // respondWith must have been called synchronously inside the handler —
    // the spec rejects an async respondWith after the dispatch turn ends.
    expect(event._respondWithCalls).toBe(1);

    const response = await event._responded;
    // The served response is the preload itself, not a copy or a re-fetch.
    expect(response).toBe(preloaded);
    expect(worker.fetchedRequests()).toHaveLength(0);
    // Pure passthrough: the auth path never opens or writes any cache.
    expect(worker.cacheNames()).toEqual([]);
    expect(worker.cachedUrls()).toEqual([]);
  });

  it.each(
    AUTH_PATHS,
  )("falls back to fetching the ORIGINAL request for %s when preload resolves undefined", async (pathname) => {
    const worker = loadServiceWorker();
    // Preload not started (disabled/unsupported): resolves undefined.
    const event = makeFetchEvent(pathname, {
      preloadResponse: Promise.resolve(undefined),
    });

    worker.dispatchFetch(event);
    expect(event._respondWithCalls).toBe(1);

    const response = await event._responded;
    expect(await response?.text()).toBe("network-body");
    // Exactly one network fetch, and it received the original request
    // object (not a clone/rewrite) so credentials/redirect are preserved.
    expect(worker.fetchedRequests()).toHaveLength(1);
    expect(worker.fetchedRequests()[0]).toBe(event.request);
    expect(worker.cacheNames()).toEqual([]);
  });

  it("falls back to fetch when the preloadResponse property is absent (older engines)", async () => {
    const worker = loadServiceWorker();
    const event = makeFetchEvent("/login"); // no preloadResponse at all

    worker.dispatchFetch(event);
    expect(event._respondWithCalls).toBe(1);

    const response = await event._responded;
    expect(await response?.text()).toBe("network-body");
    expect(worker.fetchedRequests()).toHaveLength(1);
    expect(worker.fetchedRequests()[0]).toBe(event.request);
  });

  it("falls back to a direct fetch when the preload rejects", async () => {
    const worker = loadServiceWorker();
    const event = makeFetchEvent("/login?code=one-time", {
      preloadResponse: Promise.reject(new Error("preload aborted")),
    });

    worker.dispatchFetch(event);
    expect(event._respondWithCalls).toBe(1);

    const response = await event._responded;
    expect(await response?.text()).toBe("network-body");
    expect(worker.fetchedRequests()).toHaveLength(1);
    expect(worker.fetchedRequests()[0]).toBe(event.request);
  });

  it.each([
    ["/api/session?token=handoff", "cors"],
    ["/api/oauth/exchange?code=one-time", "cors"],
    ["/login-banner.png?token=x", "no-cors"],
  ])("still fully bypasses non-navigation auth-param request %s (no respondWith)", (pathname, mode) => {
    const worker = loadServiceWorker();
    const event = makeFetchEvent(pathname, { mode });

    worker.dispatchFetch(event);

    // The browser never starts a preload for non-navigations, so a bare
    // bypass is behavior-identical to a direct browser fetch here.
    expect(event._respondWithCalls).toBe(0);
    expect(event._responded).toBeUndefined();
    expect(worker.fetchedRequests()).toHaveLength(0);
  });

  it("still intercepts ordinary app-shell navigations with the caching strategy", async () => {
    const worker = loadServiceWorker();
    const event = makeFetchEvent("/chat");

    worker.dispatchFetch(event);

    expect(event._respondWithCalls).toBe(1);
    const response = await event._responded;
    expect(await response?.clone().text()).toBe("network-body");
    // Unlike the auth path, the shell navigation IS cached (network-first).
    expect(worker.cachedUrls()).toContain("https://app.example.test/chat");
  });
});
