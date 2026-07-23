/**
 * In-process runtime coverage for the real `public/sw.js`: the module is
 * imported directly (not vm-evaluated) under stubbed service-worker globals, so
 * the coverage gate observes the production file while the tests drive every
 * registered handler — lifecycle cache cleanup + navigation-preload enable, all
 * four fetch strategies, the auth-navigation network passthrough (#15741), the
 * page message commands, and the push/notificationclick adapters.
 *
 * The companion `service-worker-auth-bypass.test.ts` proves the same contract
 * inside real Chromium; this harness pins the handler logic branch-by-branch.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

type Handler = (event: unknown) => void;

const handlers = new Map<string, Handler>();

/** Insertion-ordered Cache Storage double; order matters for trimCache. */
class FakeCache {
  store = new Map<string, Response>();

  async match(
    request: { url: string } | string,
  ): Promise<Response | undefined> {
    const url = typeof request === "string" ? request : request.url;
    const hit = this.store.get(url);
    return hit?.clone();
  }

  async put(
    request: { url: string } | string,
    response: Response,
  ): Promise<void> {
    const url = typeof request === "string" ? request : request.url;
    // Re-put refreshes insertion order, matching Cache Storage semantics.
    this.store.delete(url);
    this.store.set(url, response);
  }

  async keys(): Promise<Array<{ url: string }>> {
    return [...this.store.keys()].map((url) => ({ url }));
  }

  async delete(request: { url: string } | string): Promise<boolean> {
    const url = typeof request === "string" ? request : request.url;
    return this.store.delete(url);
  }
}

class FakeCacheStorage {
  caches = new Map<string, FakeCache>();

  async open(name: string): Promise<FakeCache> {
    let cache = this.caches.get(name);
    if (!cache) {
      cache = new FakeCache();
      this.caches.set(name, cache);
    }
    return cache;
  }

  async keys(): Promise<string[]> {
    return [...this.caches.keys()];
  }

  async delete(name: string): Promise<boolean> {
    return this.caches.delete(name);
  }
}

interface FakeRequestInit {
  method?: string;
  mode?: string;
}

class FakeRequest {
  method: string;
  mode: string;
  url: string;

  constructor(url: string, init: FakeRequestInit = {}) {
    this.url = url;
    this.method = init.method ?? "GET";
    this.mode = init.mode ?? "no-cors";
  }

  clone(): FakeRequest {
    return new FakeRequest(this.url, { method: this.method, mode: this.mode });
  }
}

interface FetchEventLike {
  request: FakeRequest;
  preloadResponse?: Promise<Response | undefined>;
  respondWith: (value: Promise<Response> | Response) => void;
  waitUntil: (value: Promise<unknown>) => void;
  responded: Promise<Response> | Response | null;
  respondWithCalls: number;
  pending: Promise<unknown>[];
}

function makeFetchEvent(
  request: FakeRequest,
  preloadResponse?: Promise<Response | undefined>,
): FetchEventLike {
  const event: FetchEventLike = {
    request,
    respondWith(value) {
      this.respondWithCalls += 1;
      this.responded = value;
    },
    waitUntil(value) {
      this.pending.push(value);
    },
    responded: null,
    respondWithCalls: 0,
    pending: [],
  };
  if (preloadResponse) event.preloadResponse = preloadResponse;
  return event;
}

async function dispatchFetch(
  request: FakeRequest,
  preloadResponse?: Promise<Response | undefined>,
): Promise<FetchEventLike> {
  const handler = handlers.get("fetch");
  if (!handler) throw new Error("fetch handler not registered");
  const event = makeFetchEvent(request, preloadResponse);
  handler(event);
  return event;
}

const ORIGIN = "https://app.test";
const cacheStorage = new FakeCacheStorage();
const fetchMock = vi.fn();
const skipWaiting = vi.fn(async () => {});
const preloadEnable = vi.fn(async () => {});
const clientsClaim = vi.fn(async () => {});
const showNotification = vi.fn(async () => {});
const postedMessages: unknown[] = [];
const matchAll = vi.fn(async () => [
  { postMessage: (m: unknown) => postedMessages.push(m) },
]);

const fakePush = {
  parsePushData: vi.fn(() => ({ kind: "chat" })),
  buildNotification: vi.fn(() => ({ title: "Eliza", options: { body: "hi" } })),
  badgeCountFromPayload: vi.fn(() => 3),
  dispatchToVisibleClients: vi.fn(async () => false),
  applyBadge: vi.fn(async () => {}),
  resolveClickTarget: vi.fn(() => "/chat/c1"),
  focusOrOpen: vi.fn(async () => {}),
  clearBadge: vi.fn(async () => {}),
};

const savedGlobals = new Map<string, PropertyDescriptor | undefined>();

// Some runtime globals (navigator under Node) are getter-only, so plain
// assignment throws; define/restore via property descriptors instead.
function setGlobal(key: string, value: unknown): void {
  if (!savedGlobals.has(key)) {
    savedGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  }
  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value,
  });
}

beforeAll(async () => {
  setGlobal("self", globalThis);
  setGlobal("location", { origin: ORIGIN });
  setGlobal("caches", cacheStorage);
  setGlobal("fetch", fetchMock);
  setGlobal("skipWaiting", skipWaiting);
  setGlobal("registration", {
    navigationPreload: { enable: preloadEnable },
    showNotification,
  });
  setGlobal("clients", { claim: clientsClaim, matchAll });
  setGlobal("navigator", {});
  // The real /sw-push.js attaches self.__elizaPush; the stub wires the same
  // contract so the push/notificationclick adapters can be driven.
  setGlobal("importScripts", () => {
    setGlobal("__elizaPush", fakePush);
  });
  setGlobal("addEventListener", (type: string, handler: Handler) => {
    handlers.set(type, handler);
  });

  await import("../public/sw.js");
});

afterAll(() => {
  for (const [key, descriptor] of savedGlobals) {
    if (descriptor === undefined) {
      delete (globalThis as unknown as Record<string, unknown>)[key];
    } else {
      Object.defineProperty(globalThis, key, descriptor);
    }
  }
});

describe("lifecycle", () => {
  it("install skips waiting immediately", () => {
    const pending: Promise<unknown>[] = [];
    handlers.get("install")?.({
      waitUntil: (p: Promise<unknown>) => pending.push(p),
    });
    expect(skipWaiting).toHaveBeenCalledTimes(1);
    expect(pending).toHaveLength(1);
  });

  it("activate drops unknown caches, enables navigation preload, claims clients", async () => {
    await (await cacheStorage.open("elizaos-views-v0")).put(
      new FakeRequest(`${ORIGIN}/stale`),
      new Response("old"),
    );
    await cacheStorage.open("elizaos-views-v1");

    const pending: Promise<unknown>[] = [];
    handlers.get("activate")?.({
      waitUntil: (p: Promise<unknown>) => pending.push(p),
    });
    await Promise.all(pending);

    expect(await cacheStorage.keys()).not.toContain("elizaos-views-v0");
    expect(await cacheStorage.keys()).toContain("elizaos-views-v1");
    expect(preloadEnable).toHaveBeenCalledTimes(1);
    expect(clientsClaim).toHaveBeenCalledTimes(1);
  });
});

describe("fetch routing guards", () => {
  it("ignores non-GET, unparseable, and cross-origin requests", async () => {
    const post = await dispatchFetch(
      new FakeRequest(`${ORIGIN}/login`, { method: "POST" }),
    );
    expect(post.respondWithCalls).toBe(0);

    const bad = await dispatchFetch(new FakeRequest("::not-a-url::"));
    expect(bad.respondWithCalls).toBe(0);

    const cross = await dispatchFetch(
      new FakeRequest("https://other.test/login"),
    );
    expect(cross.respondWithCalls).toBe(0);
  });
});

describe("auth navigation passthrough (#15741)", () => {
  it("serves the consumed preload response for /login navigations, touching no cache", async () => {
    const preloaded = new Response("login shell", { status: 200 });
    fetchMock.mockClear();
    const event = await dispatchFetch(
      new FakeRequest(`${ORIGIN}/login`, { mode: "navigate" }),
      Promise.resolve(preloaded),
    );
    expect(event.respondWithCalls).toBe(1);
    await expect(event.responded).resolves.toBe(preloaded);
    expect(fetchMock).not.toHaveBeenCalled();
    // No cache gained a /login entry in either direction.
    for (const cache of cacheStorage.caches.values()) {
      expect(cache.store.has(`${ORIGIN}/login`)).toBe(false);
    }
  });

  it("fetches the ORIGINAL request when no preload was started (resolves undefined)", async () => {
    const network = new Response("net", { status: 200 });
    fetchMock.mockResolvedValueOnce(network);
    const request = new FakeRequest(`${ORIGIN}/chat?code=one-time`, {
      mode: "navigate",
    });
    const event = await dispatchFetch(request, Promise.resolve(undefined));
    await expect(event.responded).resolves.toBe(network);
    // Passthrough must hand fetch the original object, not a clone.
    expect(fetchMock).toHaveBeenCalledWith(request);
  });

  it("falls back to a direct fetch when the preload rejects", async () => {
    const network = new Response("net", { status: 200 });
    fetchMock.mockResolvedValueOnce(network);
    const event = await dispatchFetch(
      new FakeRequest(`${ORIGIN}/cb?token=t1`, { mode: "navigate" }),
      Promise.reject(new Error("preload aborted")),
    );
    await expect(event.responded).resolves.toBe(network);
  });

  it("handles engines that expose no preloadResponse property at all", async () => {
    const network = new Response("net", { status: 200 });
    fetchMock.mockResolvedValueOnce(network);
    const event = await dispatchFetch(
      new FakeRequest(`${ORIGIN}/login`, { mode: "navigate" }),
    );
    await expect(event.responded).resolves.toBe(network);
  });

  it("passes non-navigation auth-param requests straight to the network, untouched by caches", async () => {
    const network = new Response("api", { status: 200 });
    fetchMock.mockClear();
    fetchMock.mockResolvedValueOnce(network);
    const request = new FakeRequest(`${ORIGIN}/api/session?token=abc`);
    const event = await dispatchFetch(request);
    expect(event.respondWithCalls).toBe(1);
    await expect(event.responded).resolves.toBe(network);
    expect(fetchMock).toHaveBeenCalledWith(request);
  });
});

describe("view bundle stale-while-revalidate", () => {
  const bundleUrl = `${ORIGIN}/api/views/v1/bundle.js`;

  it("cold cache: serves the network response and caches it", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("bundle-1", { status: 200, headers: { etag: '"e1"' } }),
    );
    const event = await dispatchFetch(new FakeRequest(bundleUrl));
    const response = await event.responded;
    expect(await response?.text()).toBe("bundle-1");
    const cache = await cacheStorage.open("elizaos-views-v1");
    expect(cache.store.has(bundleUrl)).toBe(true);
  });

  it("warm cache: serves stale immediately and notifies clients on an etag change", async () => {
    postedMessages.length = 0;
    fetchMock.mockResolvedValueOnce(
      new Response("bundle-2", { status: 200, headers: { etag: '"e2"' } }),
    );
    const event = await dispatchFetch(new FakeRequest(bundleUrl));
    const response = await event.responded;
    expect(await response?.text()).toBe("bundle-1");
    await Promise.all(event.pending);
    await vi.waitFor(() => {
      expect(postedMessages).toContainEqual({
        type: "sw:view-updated",
        viewId: "v1",
      });
    });
  });

  it("offline with a cached copy serves the cache; without one serves 503", async () => {
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    const warm = await dispatchFetch(new FakeRequest(bundleUrl));
    expect(await (await warm.responded)?.text()).toBe("bundle-2");

    fetchMock.mockRejectedValueOnce(new Error("offline"));
    const cold = await dispatchFetch(
      new FakeRequest(`${ORIGIN}/api/views/v-none/bundle.js`),
    );
    expect((await cold.responded)?.status).toBe(503);
  });
});

describe("hero cache-first with max-age", () => {
  const heroUrl = `${ORIGIN}/api/views/v1/hero`;

  it("caches the first fetch and serves fresh hits from cache", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("hero", {
        status: 200,
        headers: { date: new Date().toUTCString() },
      }),
    );
    const miss = await dispatchFetch(new FakeRequest(heroUrl));
    expect(await (await miss.responded)?.text()).toBe("hero");

    fetchMock.mockClear();
    const hit = await dispatchFetch(new FakeRequest(heroUrl));
    expect(await (await hit.responded)?.text()).toBe("hero");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refetches an expired hero", async () => {
    const cache = await cacheStorage.open("elizaos-views-v1");
    await cache.put(
      new FakeRequest(heroUrl),
      new Response("stale-hero", {
        status: 200,
        headers: {
          date: new Date(Date.now() - 25 * 60 * 60 * 1000).toUTCString(),
        },
      }),
    );
    fetchMock.mockResolvedValueOnce(
      new Response("fresh-hero", { status: 200 }),
    );
    const event = await dispatchFetch(new FakeRequest(heroUrl));
    expect(await (await event.responded)?.text()).toBe("fresh-hero");
  });
});

describe("immutable assets", () => {
  it("serves cache-first, caches misses, and bounds the cache to its MRU window", async () => {
    fetchMock.mockResolvedValueOnce(new Response("chunk", { status: 200 }));
    const miss = await dispatchFetch(
      new FakeRequest(`${ORIGIN}/assets/entry-abc123.js`),
    );
    expect(await (await miss.responded)?.text()).toBe("chunk");

    fetchMock.mockClear();
    const hit = await dispatchFetch(
      new FakeRequest(`${ORIGIN}/assets/entry-abc123.js`),
    );
    expect(await (await hit.responded)?.text()).toBe("chunk");
    expect(fetchMock).not.toHaveBeenCalled();

    // Overfill past the 220-entry cap; the oldest keys must be evicted.
    const assets = await cacheStorage.open("elizaos-assets-v1");
    for (let i = 0; i < 224; i += 1) {
      await assets.put(
        new FakeRequest(`${ORIGIN}/assets/seed-${i}.js`),
        new Response("s"),
      );
    }
    fetchMock.mockResolvedValueOnce(new Response("tip", { status: 200 }));
    const tip = await dispatchFetch(
      new FakeRequest(`${ORIGIN}/assets/tip-fff.js`),
    );
    await tip.responded;
    expect(assets.store.size).toBe(220);
    expect(assets.store.has(`${ORIGIN}/assets/tip-fff.js`)).toBe(true);
    expect(assets.store.has(`${ORIGIN}/assets/entry-abc123.js`)).toBe(false);
  });

  it("degrades to 503 when the network is down and nothing is cached", async () => {
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    const event = await dispatchFetch(
      new FakeRequest(`${ORIGIN}/assets/missing-000.css`),
    );
    expect((await event.responded)?.status).toBe(503);
  });
});

describe("app shell network-first", () => {
  it("consumes the preload, caches OK responses, and falls back to cache offline", async () => {
    const preloaded = new Response("shell", { status: 200 });
    fetchMock.mockClear();
    const preload = await dispatchFetch(
      new FakeRequest(`${ORIGIN}/chat`, { mode: "navigate" }),
      Promise.resolve(preloaded),
    );
    expect(await preload.responded).toBe(preloaded);
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockRejectedValueOnce(new Error("offline"));
    const offline = await dispatchFetch(
      new FakeRequest(`${ORIGIN}/chat`, { mode: "navigate" }),
    );
    expect(await (await offline.responded)?.text()).toBe("shell");

    fetchMock.mockRejectedValueOnce(new Error("offline"));
    const cold = await dispatchFetch(
      new FakeRequest(`${ORIGIN}/never-seen`, { mode: "navigate" }),
    );
    expect((await cold.responded)?.status).toBe(503);
  });
});

describe("page message commands", () => {
  async function dispatchMessage(data: unknown): Promise<Promise<unknown>[]> {
    const pending: Promise<unknown>[] = [];
    handlers.get("message")?.({
      data,
      waitUntil: (p: Promise<unknown>) => pending.push(p),
    });
    await Promise.all(pending);
    return pending;
  }

  it("evicts one view's bundle + hero and leaves other views intact", async () => {
    const cache = await cacheStorage.open("elizaos-views-v1");
    await cache.put(
      new FakeRequest(`${ORIGIN}/api/views/v9/bundle.js`),
      new Response("b"),
    );
    await cache.put(
      new FakeRequest(`${ORIGIN}/api/views/v9/hero`),
      new Response("h"),
    );

    await dispatchMessage({ type: "sw:evict-view", viewId: "v9" });
    expect(cache.store.has(`${ORIGIN}/api/views/v9/bundle.js`)).toBe(false);
    expect(cache.store.has(`${ORIGIN}/api/views/v9/hero`)).toBe(false);
    expect(cache.store.has(`${ORIGIN}/api/views/v1/bundle.js`)).toBe(true);
  });

  it("evicts the whole views cache, ignores malformed commands, and clears the badge", async () => {
    await dispatchMessage({ type: "sw:evict-all-views" });
    expect(await cacheStorage.keys()).not.toContain("elizaos-views-v1");

    await dispatchMessage(null);
    await dispatchMessage({ type: "sw:evict-view", viewId: 42 });

    fakePush.clearBadge.mockClear();
    await dispatchMessage({ type: "sw:clear-badge" });
    expect(fakePush.clearBadge).toHaveBeenCalledTimes(1);
  });
});

describe("push adapters", () => {
  it("shows an OS notification when no visible client took the payload", async () => {
    fakePush.dispatchToVisibleClients.mockResolvedValueOnce(false);
    const pending: Promise<unknown>[] = [];
    handlers.get("push")?.({
      data: "raw",
      waitUntil: (p: Promise<unknown>) => pending.push(p),
    });
    await Promise.all(pending);
    expect(showNotification).toHaveBeenCalledWith("Eliza", { body: "hi" });
    expect(fakePush.applyBadge).toHaveBeenCalled();
  });

  it("suppresses the OS notification when a visible client rendered it in-app", async () => {
    showNotification.mockClear();
    fakePush.dispatchToVisibleClients.mockResolvedValueOnce(true);
    const pending: Promise<unknown>[] = [];
    handlers.get("push")?.({
      data: "raw",
      waitUntil: (p: Promise<unknown>) => pending.push(p),
    });
    await Promise.all(pending);
    expect(showNotification).not.toHaveBeenCalled();
  });

  it("notificationclick closes, routes via focusOrOpen, and clears the badge", async () => {
    const close = vi.fn();
    fakePush.clearBadge.mockClear();
    const pending: Promise<unknown>[] = [];
    handlers.get("notificationclick")?.({
      notification: { close, data: { conversationId: "c1" } },
      waitUntil: (p: Promise<unknown>) => pending.push(p),
    });
    await Promise.all(pending);
    expect(close).toHaveBeenCalledTimes(1);
    expect(fakePush.focusOrOpen).toHaveBeenCalledWith(
      expect.anything(),
      "/chat/c1",
      ORIGIN,
    );
    expect(fakePush.clearBadge).toHaveBeenCalledTimes(1);
  });
});
