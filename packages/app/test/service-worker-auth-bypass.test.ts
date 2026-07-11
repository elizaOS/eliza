/**
 * Service-worker auth navigation guard. The test evaluates the real `sw.js`
 * file inside a minimal worker-like VM and verifies auth navigations use the
 * uncached preload/network passthrough instead of the app-shell cache path.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));

type FetchEventLike = {
  request: {
    method: string;
    mode: string;
    url: string;
    clone: () => FetchEventLike["request"];
  };
  respondWith: ReturnType<typeof vi.fn>;
};

function loadServiceWorker() {
  const listeners = new Map<string, ((event: unknown) => void)[]>();
  const self = {
    location: { origin: "https://app.example.test" },
    addEventListener(type: string, listener: (event: unknown) => void) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    skipWaiting: () => Promise.resolve(),
    clients: {
      claim: () => Promise.resolve(),
      matchAll: () => Promise.resolve([]),
    },
  };
  const cache = {
    match: () => Promise.resolve(null),
    put: () => Promise.resolve(),
    keys: () => Promise.resolve([]),
    delete: () => Promise.resolve(true),
  };
  const context = vm.createContext({
    self,
    URL,
    Response,
    caches: {
      keys: () => Promise.resolve([]),
      open: () => Promise.resolve(cache),
      delete: () => Promise.resolve(true),
    },
    fetch: () =>
      Promise.resolve(new Response("<html></html>", { status: 200 })),
    Promise,
  });
  const script = readFileSync(path.resolve(here, "../public/sw.js"), "utf8");
  vm.runInContext(script, context, { filename: "sw.js" });
  return {
    dispatchFetch(event: FetchEventLike) {
      for (const listener of listeners.get("fetch") ?? []) listener(event);
    },
  };
}

function navigation(pathname: string): FetchEventLike {
  const request = {
    method: "GET",
    mode: "navigate",
    url: `https://app.example.test${pathname}`,
    clone: () => request,
  };
  return { request, respondWith: vi.fn() };
}

describe("service worker auth navigation passthrough", () => {
  it.each([
    "/login",
    "/login?code=one-time",
    "/chat?token=handoff",
  ])("takes over %s only for uncached network passthrough", (pathname) => {
    const worker = loadServiceWorker();
    const event = navigation(pathname);

    worker.dispatchFetch(event);

    expect(event.respondWith).toHaveBeenCalledTimes(1);
  });

  it("still intercepts ordinary app-shell navigations", () => {
    const worker = loadServiceWorker();
    const event = navigation("/chat");

    worker.dispatchFetch(event);

    expect(event.respondWith).toHaveBeenCalledTimes(1);
  });
});
