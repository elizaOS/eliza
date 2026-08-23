/**
 * Deterministic unit coverage for the workerd-safe undici compatibility stub.
 * Drives the real module with no mocks: Web API constructors alias the
 * runtime globals, fetch is a bound globalThis.fetch, advanced Agent/Pool
 * constructors throw, and dispatcher helpers are no-ops or fail-loud. The
 * stub has no queue, comparator, or capacity.
 */

import { describe, expect, test } from "vitest";
import * as stub from "./undici";
import undiciDefault, {
  Agent,
  BalancedPool,
  Blob,
  Client,
  CloseEvent,
  Dispatcher,
  EnvHttpProxyAgent,
  EventSource,
  File,
  FormData,
  fetch,
  getGlobalDispatcher,
  getGlobalOrigin,
  Headers,
  MessageEvent,
  MockAgent,
  MockPool,
  Pool,
  ProxyAgent,
  ReadableStream,
  Request,
  Response,
  RetryAgent,
  setGlobalDispatcher,
  setGlobalOrigin,
  TransformStream,
  URL,
  URLSearchParams,
  WebSocket,
  WritableStream,
} from "./undici";

const NOT_AVAILABLE =
  "undici advanced features (Agent / Pool / Dispatcher / interceptors) are not available on Cloudflare Workers — use the global `fetch` directly.";

const WEB_API_CTOR_NAMES = [
  "Request",
  "Response",
  "Headers",
  "FormData",
  "File",
  "Blob",
  "URL",
  "URLSearchParams",
  "WebSocket",
  "CloseEvent",
  "MessageEvent",
  "EventSource",
  "ReadableStream",
  "WritableStream",
  "TransformStream",
] as const;

const WEB_API_CTORS = {
  Request,
  Response,
  Headers,
  FormData,
  File,
  Blob,
  URL,
  URLSearchParams,
  WebSocket,
  CloseEvent,
  MessageEvent,
  EventSource,
  ReadableStream,
  WritableStream,
  TransformStream,
} as const;

const UNAVAILABLE_CTOR_NAMES = [
  "Agent",
  "Pool",
  "Dispatcher",
  "ProxyAgent",
  "MockAgent",
  "MockPool",
  "Client",
  "BalancedPool",
  "RetryAgent",
  "EnvHttpProxyAgent",
] as const;

const UNAVAILABLE_CTORS = {
  Agent,
  Pool,
  Dispatcher,
  ProxyAgent,
  MockAgent,
  MockPool,
  Client,
  BalancedPool,
  RetryAgent,
  EnvHttpProxyAgent,
} as const;

const NAMED_EXPORT_KEYS = [
  "fetch",
  ...WEB_API_CTOR_NAMES,
  ...UNAVAILABLE_CTOR_NAMES,
  "setGlobalDispatcher",
  "getGlobalDispatcher",
  "setGlobalOrigin",
  "getGlobalOrigin",
] as const;

const DEFAULT_EXPORT_KEYS = [
  "fetch",
  "Request",
  "Response",
  "Headers",
  "FormData",
  "File",
  "Blob",
  "URL",
  "URLSearchParams",
  "Agent",
  "Pool",
  "Dispatcher",
  "ProxyAgent",
  "MockAgent",
  "MockPool",
  "Client",
  "BalancedPool",
  "RetryAgent",
  "EnvHttpProxyAgent",
  "setGlobalDispatcher",
  "getGlobalDispatcher",
  "setGlobalOrigin",
  "getGlobalOrigin",
] as const;

function expectUnavailable(fn: () => unknown): void {
  expect(fn).toThrowError(NOT_AVAILABLE);
  try {
    fn();
    throw new Error("expected undici unavailable path to throw");
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(TypeError);
    expect((error as Error).message).toBe(NOT_AVAILABLE);
  }
}

describe("undici Worker stub", () => {
  test("named exports are exactly the Web APIs, shared unavailable ctor, and dispatcher helpers", () => {
    // A module namespace object orders its own keys in code-unit order, not
    // source order, so compare as sorted sets rather than pinning the order.
    expect(
      Object.keys(stub)
        .filter((key) => key !== "default")
        .sort(),
    ).toEqual([...NAMED_EXPORT_KEYS].sort());
  });

  test("default export own keys are the subset listed on the default object, in source order", () => {
    expect(Object.keys(undiciDefault)).toEqual([...DEFAULT_EXPORT_KEYS]);
    expect(undiciDefault).toBe(stub.default);
  });

  test("default export omits stream and event constructors that exist only as named exports", () => {
    const record = undiciDefault as Record<string, unknown>;
    expect("WebSocket" in record).toBe(false);
    expect("CloseEvent" in record).toBe(false);
    expect("MessageEvent" in record).toBe(false);
    expect("EventSource" in record).toBe(false);
    expect("ReadableStream" in record).toBe(false);
    expect("WritableStream" in record).toBe(false);
    expect("TransformStream" in record).toBe(false);
  });

  test("does not expose queue, comparator, or capacity fields", () => {
    const named = stub as unknown as Record<string, unknown>;
    const record = undiciDefault as Record<string, unknown>;
    for (const target of [named, record]) {
      expect("queue" in target).toBe(false);
      expect("capacity" in target).toBe(false);
      expect("comparator" in target).toBe(false);
      expect(target.queue).toBeUndefined();
      expect(target.capacity).toBeUndefined();
      expect(target.comparator).toBeUndefined();
    }
  });

  test("deleting a missing queue key on the default export is a no-op", () => {
    const record = undiciDefault as Record<string, unknown>;
    const deleted = delete record.queue;
    expect(deleted).toBe(true);
    expect(Object.keys(undiciDefault)).toEqual([...DEFAULT_EXPORT_KEYS]);
    expect("queue" in record).toBe(false);
  });

  describe("fetch", () => {
    test("is globalThis.fetch bound to globalThis, not the unbound identity", () => {
      expect(typeof fetch).toBe("function");
      expect(fetch).not.toBe(globalThis.fetch);
      expect(fetch.name).toBe("bound fetch");
      expect(undiciDefault.fetch).toBe(fetch);
    });

    test("rejects an aborted Request without opening a network socket", async () => {
      const controller = new AbortController();
      controller.abort();
      const request = new Request("https://example.com/", {
        signal: controller.signal,
      });
      await expect(fetch(request)).rejects.toThrow();
    });

    test("rejects a single-element invalid URL the same way the runtime fetch does", async () => {
      await expect(fetch("not-a-url")).rejects.toBeInstanceOf(TypeError);
    });
  });

  describe("Web API constructor aliases", () => {
    test.each(WEB_API_CTOR_NAMES)(
      "%s is the same identity as the runtime global of the same name",
      (name) => {
        expect(WEB_API_CTORS[name]).toBe(
          globalThis[name as keyof typeof globalThis],
        );
      },
    );

    test("EventSource aliases globalThis.EventSource even when that global is absent", () => {
      // Node's vitest environment does not install EventSource; the stub still
      // re-exports the global slot rather than polyfilling a constructor.
      expect(EventSource).toBe(globalThis.EventSource);
      expect(EventSource).toBeUndefined();
      expect(typeof EventSource).toBe("undefined");
    });

    test("Request constructs a POST to a URL with query order preserved", () => {
      const request = new Request("https://example.com/path?b=2&a=1", {
        method: "POST",
      });
      expect(request).toBeInstanceOf(globalThis.Request);
      expect(request.method).toBe("POST");
      expect(request.url).toBe("https://example.com/path?b=2&a=1");
    });

    test("Response constructs with an empty body and a single status", () => {
      const response = new Response(null, { status: 204 });
      expect(response).toBeInstanceOf(globalThis.Response);
      expect(response.status).toBe(204);
      expect(response.body).toBeNull();
    });

    test("Headers empty, single, duplicate (tie), missing get, and missing delete", () => {
      const headers = new Headers();
      expect([...headers]).toEqual([]);
      expect(headers.get("x-missing")).toBeNull();
      headers.delete("x-missing");
      expect([...headers]).toEqual([]);

      headers.append("x-a", "one");
      expect(headers.get("x-a")).toBe("one");
      expect([...headers]).toEqual([["x-a", "one"]]);

      headers.append("x-a", "two");
      expect(headers.get("x-a")).toBe("one, two");

      headers.delete("x-a");
      expect(headers.get("x-a")).toBeNull();
      expect([...headers]).toEqual([]);
    });

    test("FormData empty, single, duplicate get/getAll, and missing delete", () => {
      const form = new FormData();
      expect([...form]).toEqual([]);
      expect(form.get("missing")).toBeNull();
      form.delete("missing");
      expect([...form]).toEqual([]);

      form.append("k", "first");
      expect(form.get("k")).toBe("first");
      form.append("k", "second");
      expect(form.get("k")).toBe("first");
      expect(form.getAll("k")).toEqual(["first", "second"]);

      form.delete("k");
      expect(form.get("k")).toBeNull();
      expect(form.getAll("k")).toEqual([]);
    });

    test("URL and URLSearchParams preserve insertion order, first-wins get, and missing delete", () => {
      expect(() => new URL("")).toThrow();
      const url = new URL("https://example.com/path?b=2&a=1&b=3");
      expect(url.hostname).toBe("example.com");
      expect(url.searchParams.get("b")).toBe("2");
      expect(url.searchParams.getAll("b")).toEqual(["2", "3"]);
      expect([...url.searchParams]).toEqual([
        ["b", "2"],
        ["a", "1"],
        ["b", "3"],
      ]);

      const empty = new URLSearchParams();
      expect([...empty]).toEqual([]);
      expect(empty.get("missing")).toBeNull();
      empty.delete("missing");
      expect([...empty]).toEqual([]);

      const single = new URLSearchParams("only=1");
      expect(single.get("only")).toBe("1");
      expect([...single]).toEqual([["only", "1"]]);
    });

    test("Blob and File hold the supplied bytes; File keeps the given name", async () => {
      const blob = new Blob(["hello"], { type: "text/plain" });
      expect(blob.size).toBe(5);
      // bun's Blob appends a charset to the recorded type; assert the media
      // type rather than the exact header value.
      expect(blob.type.startsWith("text/plain")).toBe(true);
      expect(await blob.text()).toBe("hello");

      const file = new File(["hello"], "note.txt", { type: "text/plain" });
      expect(file).toBeInstanceOf(globalThis.Blob);
      expect(file.name).toBe("note.txt");
      expect(file.size).toBe(5);
      expect(await file.text()).toBe("hello");
    });

    test("CloseEvent and MessageEvent construct with the supplied fields", () => {
      const close = new CloseEvent("close", { code: 1000, reason: "done" });
      expect(close.type).toBe("close");
      expect(close.code).toBe(1000);
      expect(close.reason).toBe("done");

      const message = new MessageEvent("message", { data: "payload" });
      expect(message.type).toBe("message");
      expect(message.data).toBe("payload");
    });

    test("empty ReadableStream, WritableStream, and TransformStream construct unlocked", () => {
      const readable = new ReadableStream();
      const writable = new WritableStream();
      const transform = new TransformStream();
      expect(readable.locked).toBe(false);
      expect(writable.locked).toBe(false);
      expect(transform.readable.locked).toBe(false);
      expect(transform.writable.locked).toBe(false);
    });
  });

  describe("unavailable Agent / Pool constructors", () => {
    test("all ten advanced constructors are the same WorkerUnavailableCtor", () => {
      for (const name of UNAVAILABLE_CTOR_NAMES) {
        expect(UNAVAILABLE_CTORS[name]).toBe(Agent);
        expect(typeof UNAVAILABLE_CTORS[name]).toBe("function");
      }
    });

    test.each(UNAVAILABLE_CTOR_NAMES)(
      "new %s() throws the unavailable Error",
      (name) => {
        const Ctor = UNAVAILABLE_CTORS[name] as new () => never;
        expectUnavailable(() => new Ctor());
      },
    );

    test.each(UNAVAILABLE_CTOR_NAMES)(
      "new %s('overflow') still throws — extra args are not capacity handling",
      (name) => {
        const Ctor = UNAVAILABLE_CTORS[name] as new (
          ...args: unknown[]
        ) => never;
        expectUnavailable(() => new Ctor("overflow"));
      },
    );

    test.each(UNAVAILABLE_CTOR_NAMES)(
      "%s cannot be invoked without new (class constructor TypeError, not the unavailable Error)",
      (name) => {
        const Ctor = UNAVAILABLE_CTORS[name] as unknown as () => void;
        expect(Ctor).toThrow(TypeError);
        try {
          Ctor();
          throw new Error(`expected ${name}() without new to throw`);
        } catch (error) {
          expect(error).toBeInstanceOf(TypeError);
          expect((error as Error).message).not.toBe(NOT_AVAILABLE);
        }
      },
    );

    test.each(UNAVAILABLE_CTOR_NAMES)(
      "repeated new %s() keeps throwing (no unlock, queue, or capacity)",
      (name) => {
        const Ctor = UNAVAILABLE_CTORS[name] as new () => never;
        expectUnavailable(() => new Ctor());
        expectUnavailable(() => new Ctor());
      },
    );

    test("default export constructors are the same identities as the named exports", () => {
      expect(undiciDefault.Agent).toBe(Agent);
      expect(undiciDefault.Pool).toBe(Pool);
      expect(undiciDefault.Dispatcher).toBe(Dispatcher);
      expect(undiciDefault.ProxyAgent).toBe(ProxyAgent);
      expect(undiciDefault.MockAgent).toBe(MockAgent);
      expect(undiciDefault.MockPool).toBe(MockPool);
      expect(undiciDefault.Client).toBe(Client);
      expect(undiciDefault.BalancedPool).toBe(BalancedPool);
      expect(undiciDefault.RetryAgent).toBe(RetryAgent);
      expect(undiciDefault.EnvHttpProxyAgent).toBe(EnvHttpProxyAgent);
    });
  });

  describe("dispatcher and origin helpers", () => {
    test("setGlobalDispatcher is a no-op that returns undefined, including extra args", () => {
      expect(typeof setGlobalDispatcher).toBe("function");
      expect(setGlobalDispatcher()).toBeUndefined();
      const withOverflow = setGlobalDispatcher as (
        ...args: unknown[]
      ) => unknown;
      expect(withOverflow("overflow")).toBeUndefined();
      expect(undiciDefault.setGlobalDispatcher).toBe(setGlobalDispatcher);
    });

    test("getGlobalDispatcher throws the unavailable Error, including extra args and repeats", () => {
      expect(typeof getGlobalDispatcher).toBe("function");
      expectUnavailable(getGlobalDispatcher);
      const withOverflow = getGlobalDispatcher as (
        ...args: unknown[]
      ) => unknown;
      expectUnavailable(() => withOverflow("overflow"));
      expectUnavailable(getGlobalDispatcher);
      expect(undiciDefault.getGlobalDispatcher).toBe(getGlobalDispatcher);
    });

    test("setGlobalDispatcher does not install a dispatcher getGlobalDispatcher can return", () => {
      setGlobalDispatcher();
      expectUnavailable(getGlobalDispatcher);
    });

    test("setGlobalOrigin is a no-op; getGlobalOrigin always returns undefined", () => {
      expect(typeof setGlobalOrigin).toBe("function");
      expect(typeof getGlobalOrigin).toBe("function");
      expect(getGlobalOrigin()).toBeUndefined();
      expect(setGlobalOrigin()).toBeUndefined();
      expect(getGlobalOrigin()).toBeUndefined();
      const setWithOverflow = setGlobalOrigin as (
        ...args: unknown[]
      ) => unknown;
      const getWithOverflow = getGlobalOrigin as (
        ...args: unknown[]
      ) => unknown;
      expect(setWithOverflow("https://example.com")).toBeUndefined();
      expect(getWithOverflow("overflow")).toBeUndefined();
      expect(undiciDefault.setGlobalOrigin).toBe(setGlobalOrigin);
      expect(undiciDefault.getGlobalOrigin).toBe(getGlobalOrigin);
    });
  });

  test("dynamic import resolves to the same module singleton", async () => {
    const again = await import("./undici");
    expect(again.fetch).toBe(fetch);
    expect(again.Agent).toBe(Agent);
    expect(again.default).toBe(undiciDefault);
    expect(again.getGlobalOrigin).toBe(getGlobalOrigin);
  });
});
