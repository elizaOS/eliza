/**
 * Exercises the Electrobun preload entry on the real module. Covers RPC
 * install, listener add/remove (empty, single, many, missing), apiBaseUpdate
 * boot-config branches, and renderer evaluate/rect handlers including invalid
 * params. Window is installed before the side-effect import because the
 * preload reads `window` at evaluation time.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type BrowserTabsRendererImpl,
  setBrowserTabsRendererImpl,
} from "./browser-tabs-renderer-registry.ts";
import {
  ELECTROBUN_BOOT_CONFIG_STORE_KEY,
  type ElectrobunBootConfig,
} from "./electrobun-boot-config.ts";

type RpcMessageListener = (payload: unknown) => void;

type ElizaElectrobunRpc = {
  request: Record<string, (params: unknown) => Promise<unknown>>;
  onMessage: (messageName: string, listener: RpcMessageListener) => void;
  offMessage: (messageName: string, listener: RpcMessageListener) => void;
};

type ElectrobunHandlers = {
  receiveMessageFromBun: (message: unknown) => void;
  receiveInternalMessageFromBun: (message: unknown) => void;
};

type OutgoingPacket = {
  type?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
  success?: unknown;
  payload?: unknown;
  error?: unknown;
};

type EventListener = (event: unknown) => void;

type PreloadWindow = {
  addEventListener: (
    type: string,
    listener: EventListener,
    options?: unknown,
  ) => void;
  __electrobun?: ElectrobunHandlers;
  __electrobunBunBridge: {
    postMessage: (raw: string) => void;
  };
  __ELIZA_ELECTROBUN_RPC__?: ElizaElectrobunRpc;
  __ELIZA_DESKTOP_EXTERNAL_API_BASE__?: string;
  __ELIZAOS_APP_BOOT_CONFIG__?: ElectrobunBootConfig;
  __ELIZA_APP_BOOT_CONFIG__?: ElectrobunBootConfig;
  [ELECTROBUN_BOOT_CONFIG_STORE_KEY]?: { current: ElectrobunBootConfig };
  fetch?: typeof fetch;
  [key: string]: unknown;
};

const originalConsole = {
  log: console.log,
  info: console.info,
  warn: console.warn,
  error: console.error,
};

const outgoing: OutgoingPacket[] = [];
const windowListeners = new Map<string, Set<EventListener>>();
let host: PreloadWindow;
let rpc: ElizaElectrobunRpc;

function isPacket(value: unknown): value is OutgoingPacket {
  return typeof value === "object" && value !== null;
}

function installPreloadHost(): PreloadWindow {
  const next: PreloadWindow = {
    addEventListener(type, listener) {
      const set = windowListeners.get(type) ?? new Set<EventListener>();
      set.add(listener);
      windowListeners.set(type, set);
    },
    __electrobunBunBridge: {
      postMessage(raw: string) {
        const parsed: unknown = JSON.parse(raw);
        if (!isPacket(parsed)) {
          return;
        }
        outgoing.push(parsed);
        if (parsed.type === "request" && typeof parsed.id === "number") {
          const requestId = parsed.id;
          queueMicrotask(() => {
            next.__electrobun?.receiveMessageFromBun({
              type: "response",
              id: requestId,
              success: true,
              payload: { echoedMethod: parsed.method },
            });
          });
        }
      },
    },
  };
  (globalThis as unknown as { window?: PreloadWindow }).window = next;
  return next;
}

async function waitForOutgoing(
  predicate: (packet: OutgoingPacket) => boolean,
): Promise<OutgoingPacket> {
  const deadline = Date.now() + 2000;
  for (;;) {
    const match = outgoing.find(predicate);
    if (match) {
      return match;
    }
    if (Date.now() >= deadline) {
      throw new Error("timed out waiting for an outgoing Electrobun packet");
    }
    await new Promise<void>((resolve) => {
      queueMicrotask(resolve);
    });
  }
}

function dispatchIncoming(message: unknown): void {
  const bun = host.__electrobun;
  if (!bun) {
    throw new Error("preload did not install window.__electrobun");
  }
  bun.receiveMessageFromBun(message);
}

function makeTabsImpl(label: string): BrowserTabsRendererImpl {
  return {
    evaluate: async (id, script, timeoutMs) => ({
      ok: true,
      result: { label, id, script, timeoutMs },
    }),
    getTabRect: async (id) => {
      if (id === "missing") {
        return null;
      }
      return { x: 1, y: 2, width: 3, height: 4 };
    },
  };
}

beforeAll(async () => {
  host = installPreloadHost();
  await import("./electrobun-preload.ts");
  const installed = host.__ELIZA_ELECTROBUN_RPC__;
  if (!installed) {
    throw new Error("preload did not install window.__ELIZA_ELECTROBUN_RPC__");
  }
  rpc = installed;
});

afterAll(() => {
  console.log = originalConsole.log;
  console.info = originalConsole.info;
  console.warn = originalConsole.warn;
  console.error = originalConsole.error;
  delete (globalThis as unknown as { window?: PreloadWindow }).window;
});

describe("electrobun-preload", () => {
  it("installs the public RPC bridge on window", () => {
    expect(typeof rpc.request).toBe("function");
    expect(typeof rpc.onMessage).toBe("function");
    expect(typeof rpc.offMessage).toBe("function");
  });

  it("stubs __electrobun and lets Electroview own receiveMessageFromBun", () => {
    expect(typeof host.__electrobun?.receiveMessageFromBun).toBe("function");
    expect(typeof host.__electrobun?.receiveInternalMessageFromBun).toBe(
      "function",
    );
  });

  it("dispatches nothing when the listener queue is empty", () => {
    expect(() =>
      dispatchIncoming({
        type: "message",
        id: "empty-queue",
        payload: { n: 1 },
      }),
    ).not.toThrow();
  });

  it("delivers a payload to a single listener", () => {
    const seen: unknown[] = [];
    const listener: RpcMessageListener = (payload) => {
      seen.push(payload);
    };
    rpc.onMessage("single", listener);
    dispatchIncoming({ type: "message", id: "single", payload: { ok: true } });
    expect(seen).toEqual([{ ok: true }]);
    rpc.offMessage("single", listener);
  });

  it("delivers to every listener in insertion order", () => {
    const order: string[] = [];
    const first: RpcMessageListener = () => {
      order.push("first");
    };
    const second: RpcMessageListener = () => {
      order.push("second");
    };
    rpc.onMessage("ordered", first);
    rpc.onMessage("ordered", second);
    dispatchIncoming({ type: "message", id: "ordered", payload: null });
    expect(order).toEqual(["first", "second"]);
    rpc.offMessage("ordered", first);
    rpc.offMessage("ordered", second);
  });

  it("removing one of two listeners leaves the remaining listener", () => {
    const seen: string[] = [];
    const keep: RpcMessageListener = () => {
      seen.push("keep");
    };
    const drop: RpcMessageListener = () => {
      seen.push("drop");
    };
    rpc.onMessage("partial-remove", keep);
    rpc.onMessage("partial-remove", drop);
    rpc.offMessage("partial-remove", drop);
    dispatchIncoming({
      type: "message",
      id: "partial-remove",
      payload: {},
    });
    expect(seen).toEqual(["keep"]);
    rpc.offMessage("partial-remove", keep);
  });

  it("removing the last listener restores the empty-queue no-op", () => {
    const listener: RpcMessageListener = () => {
      throw new Error("removed listener must not run");
    };
    rpc.onMessage("last", listener);
    rpc.offMessage("last", listener);
    expect(() =>
      dispatchIncoming({ type: "message", id: "last", payload: 1 }),
    ).not.toThrow();
  });

  it("removing a missing listener is a no-op", () => {
    const listener: RpcMessageListener = () => {};
    expect(() => rpc.offMessage("never-registered", listener)).not.toThrow();
    expect(() => rpc.offMessage("never-registered", listener)).not.toThrow();
  });

  it("ignores a non-string incoming message name", () => {
    const seen: unknown[] = [];
    const listener: RpcMessageListener = (payload) => {
      seen.push(payload);
    };
    rpc.onMessage("42", listener);
    dispatchIncoming({ type: "message", id: 42, payload: { bad: true } });
    expect(seen).toEqual([]);
    rpc.offMessage("42", listener);
  });

  it("isolates a throwing listener from a sibling on the same channel", () => {
    const seen: string[] = [];
    const boom: RpcMessageListener = () => {
      throw new Error("listener boom");
    };
    const sibling: RpcMessageListener = () => {
      seen.push("sibling");
    };
    rpc.onMessage("boom", boom);
    rpc.onMessage("boom", sibling);
    expect(() =>
      dispatchIncoming({ type: "message", id: "boom", payload: {} }),
    ).not.toThrow();
    expect(seen).toEqual(["sibling"]);
    rpc.offMessage("boom", boom);
    rpc.offMessage("boom", sibling);
  });

  it("apiBaseUpdate writes a trimmed external base and tokenized boot config", () => {
    host.__ELIZAOS_APP_BOOT_CONFIG__ = { branding: { name: "Eliza" } };
    dispatchIncoming({
      type: "message",
      id: "apiBaseUpdate",
      payload: {
        base: "http://127.0.0.1:31337",
        token: "tok",
        externalApiBase: "  https://ext.example/path  ",
      },
    });
    expect(host.__ELIZA_DESKTOP_EXTERNAL_API_BASE__).toBe(
      "https://ext.example/path",
    );
    expect(host.__ELIZAOS_APP_BOOT_CONFIG__).toEqual({
      branding: { name: "Eliza" },
      apiBase: "http://127.0.0.1:31337",
      apiToken: "tok",
    });
    expect(host.__ELIZA_APP_BOOT_CONFIG__).toBe(
      host.__ELIZAOS_APP_BOOT_CONFIG__,
    );
    expect(host[ELECTROBUN_BOOT_CONFIG_STORE_KEY]?.current).toBe(
      host.__ELIZAOS_APP_BOOT_CONFIG__,
    );
  });

  it("apiBaseUpdate deletes the external base when the value is blank or missing", () => {
    host.__ELIZA_DESKTOP_EXTERNAL_API_BASE__ = "https://stale.example";
    dispatchIncoming({
      type: "message",
      id: "apiBaseUpdate",
      payload: {
        base: "http://127.0.0.1:1",
        externalApiBase: "   ",
      },
    });
    expect(host.__ELIZA_DESKTOP_EXTERNAL_API_BASE__).toBeUndefined();

    host.__ELIZA_DESKTOP_EXTERNAL_API_BASE__ = "https://stale.example";
    dispatchIncoming({
      type: "message",
      id: "apiBaseUpdate",
      payload: { base: "http://127.0.0.1:2" },
    });
    expect(host.__ELIZA_DESKTOP_EXTERNAL_API_BASE__).toBeUndefined();
  });

  it("apiBaseUpdate omits apiToken when the token is absent or empty", () => {
    host.__ELIZAOS_APP_BOOT_CONFIG__ = { apiBase: "http://old" };
    dispatchIncoming({
      type: "message",
      id: "apiBaseUpdate",
      payload: { base: "http://127.0.0.1:3", token: "" },
    });
    expect(host.__ELIZAOS_APP_BOOT_CONFIG__).toEqual({
      apiBase: "http://127.0.0.1:3",
    });
    expect(host.__ELIZAOS_APP_BOOT_CONFIG__).not.toHaveProperty("apiToken");
  });

  it("evaluate RPC uses the unmounted fallback when no tabs impl is attached", async () => {
    setBrowserTabsRendererImpl(null);
    const before = outgoing.length;
    dispatchIncoming({
      type: "request",
      id: 9001,
      method: "browserWorkspaceRendererEvaluate",
      params: { id: "tab-1", script: "1+1", timeoutMs: 1000 },
    });
    const response = await waitForOutgoing(
      (packet) =>
        packet.type === "response" &&
        packet.id === 9001 &&
        outgoing.indexOf(packet) >= before,
    );
    expect(response.success).toBe(true);
    expect(response.payload).toEqual({
      ok: false,
      error: "BrowserWorkspaceView is not mounted — cannot evaluate tab tab-1",
    });
  });

  it("evaluate RPC forwards to an attached tabs impl", async () => {
    setBrowserTabsRendererImpl(makeTabsImpl("live"));
    dispatchIncoming({
      type: "request",
      id: 9002,
      method: "browserWorkspaceRendererEvaluate",
      params: { id: "t1", script: "2+2", timeoutMs: 250 },
    });
    const response = await waitForOutgoing(
      (packet) => packet.type === "response" && packet.id === 9002,
    );
    expect(response.success).toBe(true);
    expect(response.payload).toEqual({
      ok: true,
      result: { label: "live", id: "t1", script: "2+2", timeoutMs: 250 },
    });
    setBrowserTabsRendererImpl(null);
  });

  it("evaluate RPC rejects a non-object params payload", async () => {
    dispatchIncoming({
      type: "request",
      id: 9003,
      method: "browserWorkspaceRendererEvaluate",
      params: null,
    });
    const response = await waitForOutgoing(
      (packet) => packet.type === "response" && packet.id === 9003,
    );
    expect(response.success).toBe(false);
    expect(response.error).toBe("Electrobun RPC params must be an object");
  });

  it("evaluate RPC rejects a missing string id and a non-finite timeout", async () => {
    dispatchIncoming({
      type: "request",
      id: 9004,
      method: "browserWorkspaceRendererEvaluate",
      params: { id: 1, script: "s", timeoutMs: 1 },
    });
    const missingId = await waitForOutgoing(
      (packet) => packet.type === "response" && packet.id === 9004,
    );
    expect(missingId.success).toBe(false);
    expect(missingId.error).toBe('Electrobun RPC param "id" must be a string');

    dispatchIncoming({
      type: "request",
      id: 9005,
      method: "browserWorkspaceRendererEvaluate",
      params: { id: "t", script: "s", timeoutMs: Number.NaN },
    });
    const badTimeout = await waitForOutgoing(
      (packet) => packet.type === "response" && packet.id === 9005,
    );
    expect(badTimeout.success).toBe(false);
    expect(badTimeout.error).toBe(
      'Electrobun RPC param "timeoutMs" must be a finite number',
    );
  });

  it("getTabRect RPC returns null when unmounted and the attached rect when present", async () => {
    setBrowserTabsRendererImpl(null);
    dispatchIncoming({
      type: "request",
      id: 9006,
      method: "browserWorkspaceRendererGetTabRect",
      params: { id: "tab" },
    });
    const unmounted = await waitForOutgoing(
      (packet) => packet.type === "response" && packet.id === 9006,
    );
    expect(unmounted.success).toBe(true);
    expect(unmounted.payload).toBeNull();

    setBrowserTabsRendererImpl(makeTabsImpl("rect"));
    dispatchIncoming({
      type: "request",
      id: 9007,
      method: "browserWorkspaceRendererGetTabRect",
      params: { id: "present" },
    });
    const present = await waitForOutgoing(
      (packet) => packet.type === "response" && packet.id === 9007,
    );
    expect(present.payload).toEqual({ x: 1, y: 2, width: 3, height: 4 });

    dispatchIncoming({
      type: "request",
      id: 9008,
      method: "browserWorkspaceRendererGetTabRect",
      params: { id: "missing" },
    });
    const missing = await waitForOutgoing(
      (packet) => packet.type === "response" && packet.id === 9008,
    );
    expect(missing.payload).toBeNull();
    setBrowserTabsRendererImpl(null);
  });

  it("getTabRect RPC rejects a missing string id", async () => {
    dispatchIncoming({
      type: "request",
      id: 9009,
      method: "browserWorkspaceRendererGetTabRect",
      params: {},
    });
    const response = await waitForOutgoing(
      (packet) => packet.type === "response" && packet.id === 9009,
    );
    expect(response.success).toBe(false);
    expect(response.error).toBe('Electrobun RPC param "id" must be a string');
  });

  it("outgoing request proxy resolves through the bun bridge auto-response", async () => {
    await expect(rpc.request.ping({ n: 1 })).resolves.toEqual({
      echoedMethod: "ping",
    });
  });

  it("mirrors console values, including objects that cannot be JSON.stringified", async () => {
    const before = outgoing.length;
    const circular: { self?: unknown } = {};
    circular.self = circular;
    console.log("preload-log", circular);
    const diagnostic = await waitForOutgoing(
      (packet) =>
        packet.type === "request" &&
        packet.method === "rendererReportDiagnostic" &&
        outgoing.indexOf(packet) >= before,
    );
    const params = diagnostic.params;
    expect(params).toMatchObject({
      level: "log",
      source: "console",
    });
    if (
      typeof params !== "object" ||
      params === null ||
      !("message" in params)
    ) {
      throw new Error("rendererReportDiagnostic params missing message");
    }
    expect(String(params.message)).toContain("preload-log");
    expect(String(params.message)).toContain("[object Object]");
  });

  it("resource and window error listeners report diagnostics", async () => {
    const errorListeners = windowListeners.get("error");
    if (!errorListeners || errorListeners.size === 0) {
      throw new Error("preload did not register a capturing error listener");
    }
    const before = outgoing.length;
    for (const listener of errorListeners) {
      listener({
        target: { src: "https://cdn.example/app.js", tagName: "SCRIPT" },
      });
    }
    const resource = await waitForOutgoing(
      (packet) =>
        packet.type === "request" &&
        packet.method === "rendererReportDiagnostic" &&
        outgoing.indexOf(packet) >= before,
    );
    expect(resource.params).toMatchObject({
      level: "error",
      source: "resource",
      message: "Failed to load resource",
    });

    const afterResource = outgoing.length;
    for (const listener of errorListeners) {
      listener({
        message: "boom",
        filename: "main.js",
        lineno: 4,
        colno: 2,
      });
    }
    const windowError = await waitForOutgoing(
      (packet) =>
        packet.type === "request" &&
        packet.method === "rendererReportDiagnostic" &&
        outgoing.indexOf(packet) >= afterResource,
    );
    expect(windowError.params).toMatchObject({
      level: "error",
      source: "window.onerror",
      message: "boom",
    });
  });

  it("unhandledrejection listener reports the summarized reason", async () => {
    const listeners = windowListeners.get("unhandledrejection");
    if (!listeners || listeners.size === 0) {
      throw new Error(
        "preload did not register an unhandledrejection listener",
      );
    }
    const before = outgoing.length;
    const reason = new Error("rejected");
    for (const listener of listeners) {
      listener({ reason });
    }
    const diagnostic = await waitForOutgoing(
      (packet) =>
        packet.type === "request" &&
        packet.method === "rendererReportDiagnostic" &&
        outgoing.indexOf(packet) >= before,
    );
    expect(diagnostic.params).toMatchObject({
      level: "error",
      source: "unhandledrejection",
      message: "Unhandled promise rejection",
      details: {
        name: "Error",
        message: "rejected",
      },
    });
  });
});
