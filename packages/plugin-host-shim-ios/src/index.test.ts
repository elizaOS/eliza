import { afterEach, describe, expect, it, mock } from "bun:test";
import { getHostShim, resetHostShim } from "@elizaos/plugin-host-shim";
import { installIosShim, resetIosShimForTests } from "./index";

interface TestWindow {
  webkit?: {
    messageHandlers?: {
      elizaosBridge?: { postMessage?: ReturnType<typeof mock> | string };
    };
  };
  __elizaosIosDeliver?: (data: unknown) => void;
}

function installTestWindow(postMessage = mock(() => {})): TestWindow {
  const testWindow: TestWindow = {
    webkit: {
      messageHandlers: {
        elizaosBridge: { postMessage },
      },
    },
  };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: testWindow,
  });
  return testWindow;
}

describe("installIosShim", () => {
  afterEach(() => {
    resetIosShimForTests();
    resetHostShim();
    Reflect.deleteProperty(globalThis, "window");
  });

  it("throws when the WKWebView bridge is missing or malformed", () => {
    for (const value of [
      {},
      { webkit: {} },
      { webkit: { messageHandlers: {} } },
      { webkit: { messageHandlers: { elizaosBridge: {} } } },
      {
        webkit: {
          messageHandlers: { elizaosBridge: { postMessage: "not callable" } },
        },
      },
    ]) {
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value,
      });

      expect(() => installIosShim()).toThrow(
        "window.webkit.messageHandlers.elizaosBridge missing",
      );
      resetIosShimForTests();
      resetHostShim();
    }
  });

  it("posts request envelopes and resolves matching delivered responses", async () => {
    const testWindow = installTestWindow();
    const shim = installIosShim();

    const request = shim.request("provider.foo", { ok: true });

    const postMessage =
      testWindow.webkit?.messageHandlers?.elizaosBridge?.postMessage;
    if (typeof postMessage !== "function") {
      throw new Error("expected test bridge postMessage to be callable");
    }
    expect(postMessage).toHaveBeenCalledWith({
      kind: "request",
      id: 1,
      method: "provider.foo",
      params: { ok: true },
    });

    testWindow.__elizaosIosDeliver?.({
      kind: "response",
      id: 1,
      ok: true,
      payload: { value: 7 },
    });

    await expect(request).resolves.toEqual({ value: 7 });
  });

  it("rejects error responses and ignores malformed or unknown deliveries", async () => {
    const testWindow = installTestWindow();
    const shim = installIosShim();
    const request = shim.request("provider.fail", null);

    for (const delivery of [
      null,
      "not an object",
      { kind: "response", id: "1", ok: true, payload: "ignored" },
      { kind: "response", id: 999, ok: true, payload: "ignored" },
      { kind: "event", event: 12, data: "ignored" },
    ]) {
      testWindow.__elizaosIosDeliver?.(delivery);
    }
    testWindow.__elizaosIosDeliver?.({
      kind: "response",
      id: 1,
      ok: false,
      error: "denied",
    });

    await expect(request).rejects.toThrow("denied");
  });

  it("ignores malformed matching responses without settling pending requests", async () => {
    const testWindow = installTestWindow();
    const shim = installIosShim();
    const request = shim.request("provider.wait", null);

    for (const delivery of [
      { kind: "response", id: 1 },
      { kind: "response", id: 1, ok: "true" },
      { kind: "response", id: Number.NaN, ok: true },
      { kind: "response", id: 1, ok: false, error: { message: "bad" } },
    ]) {
      testWindow.__elizaosIosDeliver?.(delivery);
    }
    testWindow.__elizaosIosDeliver?.({
      kind: "response",
      id: 1,
      ok: true,
      payload: "settled",
    });

    await expect(request).resolves.toBe("settled");
  });

  it("keeps concurrent requests correlated when responses arrive out of order", async () => {
    const testWindow = installTestWindow();
    const shim = installIosShim();

    const first = shim.request("provider.first", null);
    const second = shim.request("provider.second", null);

    const postMessage =
      testWindow.webkit?.messageHandlers?.elizaosBridge?.postMessage;
    if (typeof postMessage !== "function") {
      throw new Error("expected test bridge postMessage to be callable");
    }
    expect(postMessage).toHaveBeenNthCalledWith(1, {
      kind: "request",
      id: 1,
      method: "provider.first",
      params: null,
    });
    expect(postMessage).toHaveBeenNthCalledWith(2, {
      kind: "request",
      id: 2,
      method: "provider.second",
      params: null,
    });

    testWindow.__elizaosIosDeliver?.({
      kind: "response",
      id: 2,
      ok: true,
      payload: "second",
    });
    testWindow.__elizaosIosDeliver?.({
      kind: "response",
      id: 1,
      ok: true,
      payload: "first",
    });

    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
  });

  it("uses default success and error payload semantics", async () => {
    const testWindow = installTestWindow();
    const shim = installIosShim();

    const success = shim.request("provider.empty", null);
    testWindow.__elizaosIosDeliver?.({
      kind: "response",
      id: 1,
      ok: true,
    });
    await expect(success).resolves.toBeNull();

    const failure = shim.request("provider.error", null);
    testWindow.__elizaosIosDeliver?.({
      kind: "response",
      id: 2,
      ok: false,
    });
    await expect(failure).rejects.toThrow("iOS bridge error");
  });

  it("rejects immediately when bridge postMessage throws", async () => {
    const postMessage = mock(() => {});
    postMessage.mockImplementationOnce(() => {
      throw new Error("bridge down");
    });
    installTestWindow(postMessage);
    const shim = installIosShim();

    await expect(shim.request("provider.foo", null)).rejects.toThrow(
      "bridge down",
    );

    const retry = shim.request("provider.retry", null);
    expect(postMessage).toHaveBeenLastCalledWith({
      kind: "request",
      id: 2,
      method: "provider.retry",
      params: null,
    });
    window.__elizaosIosDeliver?.({
      kind: "response",
      id: 2,
      ok: true,
      payload: "retried",
    });
    await expect(retry).resolves.toBe("retried");
  });

  it("rejects timed-out requests, ignores late delivery, and keeps later requests usable", async () => {
    const testWindow = installTestWindow();
    const shim = installIosShim({ requestTimeoutMs: 1 });

    await expect(shim.request("provider.never", null)).rejects.toThrow(
      "iOS bridge request timed out: provider.never",
    );

    testWindow.__elizaosIosDeliver?.({
      kind: "response",
      id: 1,
      ok: true,
      payload: "too late",
    });

    const later = shim.request("provider.later", null);
    testWindow.__elizaosIosDeliver?.({
      kind: "response",
      id: 2,
      ok: true,
      payload: "later",
    });

    await expect(later).resolves.toBe("later");
  });

  it("delivers events only to matching subscribers and stops after unsubscribe", () => {
    const testWindow = installTestWindow();
    const shim = installIosShim();
    const handler = mock(() => {});
    const secondHandler = mock(() => {});
    const otherEventHandler = mock(() => {});

    const unsubscribe = shim.on("plugin.event", handler);
    shim.on("plugin.event", secondHandler);
    shim.on("plugin.other", otherEventHandler);
    testWindow.__elizaosIosDeliver?.({
      kind: "event",
      event: "plugin.other",
      data: { ignored: true },
    });
    testWindow.__elizaosIosDeliver?.({
      kind: "event",
      event: "plugin.event",
      data: { count: 1 },
    });
    testWindow.__elizaosIosDeliver?.({
      kind: "event",
      event: "plugin.event",
    });
    unsubscribe();
    testWindow.__elizaosIosDeliver?.({
      kind: "event",
      event: "plugin.event",
      data: { count: 2 },
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ count: 1 });
    expect(secondHandler).toHaveBeenCalledTimes(2);
    expect(secondHandler).toHaveBeenLastCalledWith({ count: 2 });
    expect(otherEventHandler).toHaveBeenCalledTimes(1);
    expect(otherEventHandler).toHaveBeenCalledWith({ ignored: true });
  });

  it("is idempotent and keeps using the initially captured bridge", async () => {
    const firstPostMessage = mock(() => {});
    const testWindow = installTestWindow(firstPostMessage);
    const first = installIosShim({ requestTimeoutMs: 1000 });
    const firstDeliver = window.__elizaosIosDeliver;
    const secondPostMessage = mock(() => {});
    testWindow.webkit = {
      messageHandlers: {
        elizaosBridge: { postMessage: secondPostMessage },
      },
    };
    const second = installIosShim();

    expect(second).toBe(first);
    expect(getHostShim()).toBe(first);
    expect(window.__elizaosIosDeliver).toBe(firstDeliver);

    const request = second.request("provider.original", null);
    expect(firstPostMessage).toHaveBeenCalledWith({
      kind: "request",
      id: 1,
      method: "provider.original",
      params: null,
    });
    expect(secondPostMessage).not.toHaveBeenCalled();

    firstDeliver?.({
      kind: "response",
      id: 1,
      ok: true,
      payload: "original",
    });
    await expect(request).resolves.toBe("original");
  });

  it("encodes plugin and asset path segments and rejects unsafe relative paths", () => {
    installTestWindow();
    const shim = installIosShim();

    expect(
      shim.resolveViewUrl("plugin space", "assets/main file.js").href,
    ).toBe("app-resource://plugin/plugin%20space/assets/main%20file.js");
    expect(shim.resolveViewUrl("plugin", String.raw`assets\main.js`).href).toBe(
      "app-resource://plugin/plugin/assets/main.js",
    );

    for (const path of [
      "",
      ".",
      "..",
      "../secret.js",
      "assets/../secret.js",
      "/absolute.js",
      "C:\\secret.js",
      String.raw`assets\..\secret.js`,
    ]) {
      expect(() => shim.resolveViewUrl("plugin", path)).toThrow(
        "Invalid view asset path",
      );
    }
  });
});
