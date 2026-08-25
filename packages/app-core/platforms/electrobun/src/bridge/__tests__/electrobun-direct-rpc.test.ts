/**
 * Exercises the Electrobun renderer direct-RPC preload against a real
 * window, the real browser-tab registry, and the real boot-config writer.
 * `electrobun/view` is a native binding, so Electroview is the only stub —
 * handlers, listeners, request instrumentation, and the log/fetch/XHR mirror
 * run in the module under test.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { setBrowserTabsRendererImpl } from "../browser-tabs-renderer-registry.ts";
import {
  ELECTROBUN_BOOT_CONFIG_STORE_KEY,
  type ElectrobunBootConfigWindow,
} from "../electrobun-boot-config.ts";

type RpcListener = (payload: unknown) => void;
type RpcBridge = {
  request: Record<string, (params?: unknown) => Promise<unknown>>;
  onMessage: (name: string, listener: RpcListener) => void;
  offMessage: (name: string, listener: RpcListener) => void;
};

type DiagnosticReport = {
  level: string;
  source: string;
  message: string;
  details?: unknown;
};

type TestWindow = ElectrobunBootConfigWindow & {
  __electrobun?: {
    receiveMessageFromBun: (m: unknown) => void;
    receiveInternalMessageFromBun: (m: unknown) => void;
  };
  __ELIZA_ELECTROBUN_RPC__?: RpcBridge;
  __ELIZA_DESKTOP_EXTERNAL_API_BASE__?: string;
  __ELIZA_ELECTROBUN_LOG_MIRROR__?: boolean;
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  addEventListener: (
    type: string,
    listener: (event: unknown) => void,
    options?: unknown,
  ) => void;
  emit: (type: string, event: unknown) => void;
};

type XhrListener = (this: FakeXMLHttpRequest) => void;

class FakeXMLHttpRequest {
  status = 0;
  private readonly listeners = new Map<string, XhrListener[]>();

  addEventListener(
    type: string,
    listener: XhrListener,
    _options?: { once?: boolean },
  ): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  open(_method: string, _url: string | URL, ..._rest: unknown[]): void {}

  send(..._args: unknown[]): void {}

  emit(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener.call(this);
    }
  }
}

const harness = vi.hoisted(() => {
  type RendererHandler = (params: unknown) => Promise<unknown>;
  const diagnostics: unknown[] = [];
  const bunRequest: Record<string, unknown> = {
    version: 1,
  };
  const state = {
    maxRequestTime: 0,
    constructed: 0,
    rendererRequests: {} as Record<string, RendererHandler>,
    wildcardMessage: undefined as
      | ((messageName: unknown, payload: unknown) => void)
      | undefined,
    bunRequest,
    diagnostics,
    reportDiagnosticShouldFail: false,
    fetchImpl: async (
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ): Promise<Response> =>
      new Response("ok", { status: 200, statusText: "OK" }),
  };
  bunRequest.rendererReportDiagnostic = async (params: unknown) => {
    if (state.reportDiagnosticShouldFail) {
      throw new Error("diagnostic transport failed");
    }
    diagnostics.push(params);
  };
  bunRequest.echo = async (params: unknown) => params;
  bunRequest.fail = async () => {
    throw new Error("native fail");
  };
  bunRequest.failNonError = async () => {
    throw "string-fail";
  };
  return state;
});

vi.mock("electrobun/view", () => {
  class Electroview {
    static defineRPC(config: {
      maxRequestTime: number;
      handlers: {
        requests: Record<string, (params: unknown) => Promise<unknown>>;
        messages: Record<
          string,
          (messageName: unknown, payload: unknown) => void
        >;
      };
    }) {
      harness.maxRequestTime = config.maxRequestTime;
      harness.rendererRequests = config.handlers.requests;
      harness.wildcardMessage = config.handlers.messages["*"];
      return {
        request: harness.bunRequest,
        setTransport: (_transport: unknown) => {},
      };
    }

    constructor(_opts: { rpc: unknown }) {
      harness.constructed += 1;
    }
  }
  return { Electroview };
});

const originalConsole = {
  log: console.log,
  info: console.info,
  warn: console.warn,
  error: console.error,
};
const originalXhr = globalThis.XMLHttpRequest;

function makeWindow(): TestWindow {
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  const w: TestWindow = {
    addEventListener(type, listener) {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    },
    emit(type, event) {
      for (const listener of listeners.get(type) ?? []) {
        listener(event);
      }
    },
    fetch: (input: RequestInfo | URL, init?: RequestInit) =>
      harness.fetchImpl(input, init),
  };
  return w;
}

function rpc(): RpcBridge {
  const bridge = (globalThis as unknown as { window?: TestWindow }).window
    ?.__ELIZA_ELECTROBUN_RPC__;
  if (!bridge) {
    throw new Error("preload did not install window.__ELIZA_ELECTROBUN_RPC__");
  }
  return bridge;
}

function asDiagnostic(value: unknown): DiagnosticReport {
  if (!value || typeof value !== "object") {
    throw new Error(`expected diagnostic object, got ${String(value)}`);
  }
  const record = value as Record<string, unknown>;
  if (typeof record.level !== "string" || typeof record.source !== "string") {
    throw new Error("diagnostic is missing level or source");
  }
  if (typeof record.message !== "string") {
    throw new Error("diagnostic is missing message");
  }
  return {
    level: record.level,
    source: record.source,
    message: record.message,
    details: record.details,
  };
}

beforeAll(async () => {
  const w = makeWindow();
  (globalThis as unknown as { window?: TestWindow }).window = w;
  vi.stubGlobal("window", w);
  vi.stubGlobal("XMLHttpRequest", FakeXMLHttpRequest);
  await import("../electrobun-direct-rpc.ts");
});

afterEach(() => {
  harness.diagnostics.length = 0;
  harness.reportDiagnosticShouldFail = false;
  harness.fetchImpl = async () =>
    new Response("ok", { status: 200, statusText: "OK" });
  setBrowserTabsRendererImpl(null);
  const w = (globalThis as unknown as { window?: TestWindow }).window;
  if (w) {
    Reflect.deleteProperty(w, "__ELIZA_DESKTOP_EXTERNAL_API_BASE__");
    Reflect.deleteProperty(w, "__ELIZAOS_APP_BOOT_CONFIG__");
    Reflect.deleteProperty(w, "__ELIZA_APP_BOOT_CONFIG__");
    Reflect.deleteProperty(w, ELECTROBUN_BOOT_CONFIG_STORE_KEY);
  }
});

afterAll(() => {
  console.log = originalConsole.log;
  console.info = originalConsole.info;
  console.warn = originalConsole.warn;
  console.error = originalConsole.error;
  if (originalXhr) {
    vi.stubGlobal("XMLHttpRequest", originalXhr);
  } else {
    Reflect.deleteProperty(globalThis, "XMLHttpRequest");
  }
});

describe("electrobun-direct-rpc preload", () => {
  it("installs the public RPC bridge and constructs Electroview with a 600s timeout", () => {
    const bridge = rpc();
    expect(typeof bridge.request).toBe("object");
    expect(typeof bridge.onMessage).toBe("function");
    expect(typeof bridge.offMessage).toBe("function");
    expect(harness.constructed).toBeGreaterThanOrEqual(1);
    expect(harness.maxRequestTime).toBe(600_000);
    expect(
      typeof harness.rendererRequests.browserWorkspaceRendererEvaluate,
    ).toBe("function");
    expect(
      typeof harness.rendererRequests.browserWorkspaceRendererGetTabRect,
    ).toBe("function");
    expect(typeof harness.wildcardMessage).toBe("function");
  });

  it("rejects evaluate params that are not a record", async () => {
    const evaluate = harness.rendererRequests.browserWorkspaceRendererEvaluate;
    await expect(evaluate(undefined)).rejects.toThrow(
      "Electrobun RPC params must be an object",
    );
    await expect(evaluate(null)).rejects.toThrow(
      "Electrobun RPC params must be an object",
    );
    await expect(evaluate("tab")).rejects.toThrow(
      "Electrobun RPC params must be an object",
    );
    await expect(evaluate(1)).rejects.toThrow(
      "Electrobun RPC params must be an object",
    );
  });

  it("rejects evaluate params with missing or non-finite fields, including array records", async () => {
    const evaluate = harness.rendererRequests.browserWorkspaceRendererEvaluate;
    await expect(evaluate({})).rejects.toThrow(
      'Electrobun RPC param "id" must be a string',
    );
    await expect(
      evaluate({ id: 1, script: "1", timeoutMs: 1 }),
    ).rejects.toThrow('Electrobun RPC param "id" must be a string');
    await expect(
      evaluate({ id: "t", script: 1, timeoutMs: 1 }),
    ).rejects.toThrow('Electrobun RPC param "script" must be a string');
    await expect(
      evaluate({ id: "t", script: "1", timeoutMs: "1" }),
    ).rejects.toThrow(
      'Electrobun RPC param "timeoutMs" must be a finite number',
    );
    await expect(
      evaluate({ id: "t", script: "1", timeoutMs: Number.NaN }),
    ).rejects.toThrow(
      'Electrobun RPC param "timeoutMs" must be a finite number',
    );
    await expect(
      evaluate({ id: "t", script: "1", timeoutMs: Number.POSITIVE_INFINITY }),
    ).rejects.toThrow(
      'Electrobun RPC param "timeoutMs" must be a finite number',
    );
    await expect(
      evaluate(Object.assign(["id"], { script: "1", timeoutMs: 1 })),
    ).rejects.toThrow('Electrobun RPC param "id" must be a string');
  });

  it("forwards evaluate to the real registry, including empty id and zero timeout", async () => {
    const calls: Array<{
      id: string;
      script: string;
      timeoutMs: number;
    }> = [];
    setBrowserTabsRendererImpl({
      evaluate: async (id, script, timeoutMs) => {
        calls.push({ id, script, timeoutMs });
        return { ok: true, result: { id, script, timeoutMs } };
      },
      getTabRect: async () => null,
    });

    const result =
      await harness.rendererRequests.browserWorkspaceRendererEvaluate({
        id: "",
        script: "return 1",
        timeoutMs: 0,
      });
    expect(result).toEqual({
      ok: true,
      result: { id: "", script: "return 1", timeoutMs: 0 },
    });
    expect(calls).toEqual([{ id: "", script: "return 1", timeoutMs: 0 }]);
  });

  it("returns the not-attached evaluate error when no tab impl is registered", async () => {
    const result =
      await harness.rendererRequests.browserWorkspaceRendererEvaluate({
        id: "tab-9",
        script: "1+1",
        timeoutMs: 50,
      });
    expect(result).toEqual({
      ok: false,
      error: "BrowserWorkspaceView is not mounted — cannot evaluate tab tab-9",
    });
  });

  it("rejects getTabRect params that are not an object with a string id", async () => {
    const getTabRect =
      harness.rendererRequests.browserWorkspaceRendererGetTabRect;
    await expect(getTabRect(undefined)).rejects.toThrow(
      "Electrobun RPC params must be an object",
    );
    await expect(getTabRect({ id: 12 })).rejects.toThrow(
      'Electrobun RPC param "id" must be a string',
    );
  });

  it("forwards getTabRect to the registry and returns null when unattached", async () => {
    const unattached =
      await harness.rendererRequests.browserWorkspaceRendererGetTabRect({
        id: "missing",
      });
    expect(unattached).toBeNull();

    const seen: string[] = [];
    setBrowserTabsRendererImpl({
      evaluate: async () => ({ ok: false, error: "unused" }),
      getTabRect: async (id) => {
        seen.push(id);
        return { x: 1, y: 2, width: 3, height: 4 };
      },
    });
    const rect =
      await harness.rendererRequests.browserWorkspaceRendererGetTabRect({
        id: "tab-a",
      });
    expect(seen).toEqual(["tab-a"]);
    expect(rect).toEqual({ x: 1, y: 2, width: 3, height: 4 });
  });

  it("ignores non-string wildcard message names and an empty listener set", () => {
    expect(harness.wildcardMessage).toBeTypeOf("function");
    harness.wildcardMessage?.(1, { ok: true });
    harness.wildcardMessage?.(undefined, { ok: true });
    expect(() => {
      harness.wildcardMessage?.("nobody-home", { n: 1 });
    }).not.toThrow();
    expect(harness.diagnostics).toEqual([]);
  });

  it("delivers to a single listener and insertion-ordered multiples; Set-dedupes the same function", () => {
    const received: unknown[] = [];
    const first: RpcListener = (payload) => {
      received.push(["first", payload]);
    };
    const second: RpcListener = (payload) => {
      received.push(["second", payload]);
    };
    rpc().onMessage("queue", first);
    rpc().onMessage("queue", first);
    rpc().onMessage("queue", second);
    harness.wildcardMessage?.("queue", { n: 1 });
    expect(received).toEqual([
      ["first", { n: 1 }],
      ["second", { n: 1 }],
    ]);
    rpc().offMessage("queue", first);
    rpc().offMessage("queue", second);
  });

  it("does not throw when removing a missing listener or message, then is a no-op after the last removal", () => {
    const listener: RpcListener = () => {
      throw new Error("should not run");
    };
    expect(() => {
      rpc().offMessage("never-registered", listener);
    }).not.toThrow();

    rpc().onMessage("last-one", listener);
    rpc().offMessage("last-one", listener);
    rpc().offMessage("last-one", listener);
    expect(() => {
      harness.wildcardMessage?.("last-one", { n: 1 });
    }).not.toThrow();
  });

  it("keeps dispatching later listeners when one throws", () => {
    const received: string[] = [];
    const boom: RpcListener = () => {
      received.push("boom");
      throw new Error("listener boom");
    };
    const later: RpcListener = () => {
      received.push("later");
    };
    rpc().onMessage("iso", boom);
    rpc().onMessage("iso", later);
    harness.wildcardMessage?.("iso", { ok: true });
    expect(received).toEqual(["boom", "later"]);
    rpc().offMessage("iso", boom);
    rpc().offMessage("iso", later);
  });

  it("propagates apiBaseUpdate into boot config and the trimmed external API base", () => {
    const w = (globalThis as unknown as { window?: TestWindow }).window;
    if (!w) {
      throw new Error("test window missing");
    }
    harness.wildcardMessage?.("apiBaseUpdate", {
      base: "http://127.0.0.1:31337",
      token: "secret",
      externalApiBase: "  https://ext.example/  ",
    });
    expect(w.__ELIZA_DESKTOP_EXTERNAL_API_BASE__).toBe("https://ext.example/");
    expect(w.__ELIZAOS_APP_BOOT_CONFIG__).toEqual({
      apiBase: "http://127.0.0.1:31337",
      apiToken: "secret",
    });
    expect(w[ELECTROBUN_BOOT_CONFIG_STORE_KEY]?.current).toEqual({
      apiBase: "http://127.0.0.1:31337",
      apiToken: "secret",
    });
  });

  it("clears a blank or non-string external API base and omits a falsy token", () => {
    const w = (globalThis as unknown as { window?: TestWindow }).window;
    if (!w) {
      throw new Error("test window missing");
    }
    w.__ELIZA_DESKTOP_EXTERNAL_API_BASE__ = "https://stale.example";
    harness.wildcardMessage?.("apiBaseUpdate", {
      base: "http://127.0.0.1:8",
      token: "keep-me",
      externalApiBase: "https://seed.example",
    });
    harness.wildcardMessage?.("apiBaseUpdate", {
      base: "http://127.0.0.1:9",
      token: "",
      externalApiBase: "   ",
    });
    expect(w.__ELIZA_DESKTOP_EXTERNAL_API_BASE__).toBeUndefined();
    expect(w.__ELIZAOS_APP_BOOT_CONFIG__).toEqual({
      apiBase: "http://127.0.0.1:9",
      apiToken: "keep-me",
    });

    harness.wildcardMessage?.("apiBaseUpdate", {
      base: "http://127.0.0.1:10",
      externalApiBase: null,
    });
    expect(w.__ELIZA_DESKTOP_EXTERNAL_API_BASE__).toBeUndefined();
    expect(w.__ELIZAOS_APP_BOOT_CONFIG__?.apiBase).toBe("http://127.0.0.1:10");
  });

  it("passes non-function request properties through and does not diagnose a successful call", async () => {
    expect(rpc().request.version).toBe(1);
    expect(rpc().request.missing).toBeUndefined();
    await expect(rpc().request.echo({ ok: true })).resolves.toEqual({
      ok: true,
    });
    expect(harness.diagnostics).toEqual([]);
  });

  it("reports a failed instrumented request as an Error summary and rethrows", async () => {
    await expect(rpc().request.fail({})).rejects.toThrow("native fail");
    expect(harness.diagnostics).toHaveLength(1);
    const report = asDiagnostic(harness.diagnostics[0]);
    expect(report).toMatchObject({
      level: "error",
      source: "rpc",
      message: "Electrobun RPC request failed: fail",
    });
    expect(report.details).toEqual({
      name: "Error",
      message: "native fail",
      stack: expect.any(String),
    });
  });

  it("reports a non-Error throw as-is and does not mask it when diagnostics fail", async () => {
    await expect(rpc().request.failNonError({})).rejects.toBe("string-fail");
    expect(asDiagnostic(harness.diagnostics[0]).details).toBe("string-fail");

    harness.diagnostics.length = 0;
    harness.reportDiagnosticShouldFail = true;
    await expect(rpc().request.fail({})).rejects.toThrow("native fail");
    expect(harness.diagnostics).toEqual([]);
  });

  it("mirrors console methods, stringifying values and falling back when JSON.stringify throws", () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;
    console.log("plain", { a: 1 }, circular);
    expect(harness.diagnostics).toHaveLength(1);
    const report = asDiagnostic(harness.diagnostics[0]);
    expect(report.level).toBe("log");
    expect(report.source).toBe("console");
    expect(report.message).toBe('plain {"a":1} [object Object]');
  });

  it("classifies window errors as resource failures or onerror, and summarizes rejections", () => {
    const w = (globalThis as unknown as { window?: TestWindow }).window;
    if (!w) {
      throw new Error("test window missing");
    }
    w.emit("error", {
      target: { src: "https://cdn.example/app.js", tagName: "SCRIPT" },
      message: "ignored for resource",
    });
    expect(asDiagnostic(harness.diagnostics[0])).toEqual({
      level: "error",
      source: "resource",
      message: "Failed to load resource",
      details: {
        tagName: "SCRIPT",
        src: "https://cdn.example/app.js",
        href: undefined,
      },
    });

    harness.diagnostics.length = 0;
    w.emit("error", {
      target: null,
      message: "",
      filename: "main.js",
      lineno: 4,
      colno: 2,
    });
    expect(asDiagnostic(harness.diagnostics[0])).toEqual({
      level: "error",
      source: "window.onerror",
      message: "Unhandled window error",
      details: { filename: "main.js", lineno: 4, colno: 2 },
    });

    harness.diagnostics.length = 0;
    w.emit("unhandledrejection", { reason: new Error("nope") });
    const rejection = asDiagnostic(harness.diagnostics[0]);
    expect(rejection.source).toBe("unhandledrejection");
    expect(rejection.message).toBe("Unhandled promise rejection");
    expect(rejection.details).toEqual({
      name: "Error",
      message: "nope",
      stack: expect.any(String),
    });
  });

  it("diagnoses failed fetch by status class, method, and URL shape, and rethrows transport errors", async () => {
    const w = (globalThis as unknown as { window?: TestWindow }).window;
    if (!w?.fetch) {
      throw new Error("window.fetch missing");
    }

    harness.fetchImpl = async () =>
      new Response("ok", { status: 200, statusText: "OK" });
    await expect(w.fetch("http://127.0.0.1/ok")).resolves.toMatchObject({
      ok: true,
    });
    expect(harness.diagnostics).toEqual([]);

    harness.fetchImpl = async () =>
      new Response("missing", { status: 404, statusText: "Not Found" });
    await w.fetch("http://127.0.0.1/missing", { method: "POST" });
    expect(asDiagnostic(harness.diagnostics[0])).toMatchObject({
      level: "warn",
      source: "fetch",
      message: "HTTP 404 Not Found",
      details: {
        url: "http://127.0.0.1/missing",
        method: "POST",
      },
    });

    harness.diagnostics.length = 0;
    harness.fetchImpl = async () =>
      new Response("down", { status: 503, statusText: "Unavailable" });
    await w.fetch(new Request("http://127.0.0.1/down", { method: "PUT" }));
    expect(asDiagnostic(harness.diagnostics[0])).toMatchObject({
      level: "error",
      source: "fetch",
      message: "HTTP 503 Unavailable",
      details: {
        url: "http://127.0.0.1/down",
        method: "PUT",
      },
    });

    harness.diagnostics.length = 0;
    harness.fetchImpl = async () => {
      throw new Error("socket");
    };
    await expect(w.fetch(new URL("http://127.0.0.1/throw"))).rejects.toThrow(
      "socket",
    );
    expect(asDiagnostic(harness.diagnostics[0])).toMatchObject({
      level: "error",
      source: "fetch",
      message: "Fetch failed",
      details: {
        url: "http://127.0.0.1/throw",
        method: "GET",
      },
    });
  });

  it("diagnoses XHR failures on loadend and error, and ignores send without open", () => {
    const opened = new FakeXMLHttpRequest();
    opened.open("GET", "http://127.0.0.1/ok");
    opened.status = 204;
    opened.send();
    opened.emit("loadend");
    expect(harness.diagnostics).toEqual([]);

    const clientError = new FakeXMLHttpRequest();
    clientError.open("POST", new URL("http://127.0.0.1/nope"));
    clientError.status = 404;
    clientError.send();
    clientError.emit("loadend");
    expect(asDiagnostic(harness.diagnostics[0])).toMatchObject({
      level: "warn",
      source: "xhr",
      message: "HTTP 404",
      details: {
        url: "http://127.0.0.1/nope",
        method: "POST",
      },
    });

    harness.diagnostics.length = 0;
    const serverError = new FakeXMLHttpRequest();
    serverError.open("GET", "http://127.0.0.1/boom");
    serverError.status = 500;
    serverError.send();
    serverError.emit("loadend");
    expect(asDiagnostic(harness.diagnostics[0]).level).toBe("error");

    harness.diagnostics.length = 0;
    const failed = new FakeXMLHttpRequest();
    failed.open("GET", "http://127.0.0.1/err");
    failed.send();
    failed.emit("error");
    expect(asDiagnostic(harness.diagnostics[0])).toMatchObject({
      level: "error",
      source: "xhr",
      message: "XMLHttpRequest failed",
      details: {
        url: "http://127.0.0.1/err",
        method: "GET",
      },
    });

    harness.diagnostics.length = 0;
    const neverOpened = new FakeXMLHttpRequest();
    neverOpened.status = 500;
    neverOpened.send();
    neverOpened.emit("loadend");
    expect(harness.diagnostics).toEqual([]);
  });

  it("does not wrap console twice when the preload is imported again", async () => {
    vi.resetModules();
    await import("../electrobun-direct-rpc.ts");
    harness.diagnostics.length = 0;
    console.info("once");
    const consoleReports = harness.diagnostics.filter((item) => {
      if (!item || typeof item !== "object" || !("source" in item)) {
        return false;
      }
      return (item as { source: unknown }).source === "console";
    });
    expect(consoleReports).toHaveLength(1);
    expect(asDiagnostic(consoleReports[0]).message).toBe("once");
  });
});
