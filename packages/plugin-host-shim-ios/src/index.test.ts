import { afterEach, describe, expect, it, mock } from "bun:test";
import { getHostShim, resetHostShim } from "@elizaos/plugin-host-shim";
import { installIosShim, resetIosShimForTests } from "./index";

interface FakeWindow {
  webkit?: {
    messageHandlers?: {
      elizaosBridge?: { postMessage: ReturnType<typeof mock> };
    };
  };
  __elizaosIosDeliver?: (data: unknown) => void;
}

function installFakeWindow(postMessage = mock(() => {})): FakeWindow {
  const fakeWindow: FakeWindow = {
    webkit: {
      messageHandlers: {
        elizaosBridge: { postMessage },
      },
    },
  };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: fakeWindow,
  });
  return fakeWindow;
}

describe("installIosShim", () => {
  afterEach(() => {
    resetIosShimForTests();
    resetHostShim();
    Reflect.deleteProperty(globalThis, "window");
  });

  it("throws when the WKWebView bridge is missing", () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {},
    });

    expect(() => installIosShim()).toThrow(
      "window.webkit.messageHandlers.elizaosBridge missing",
    );
  });

  it("posts request envelopes and resolves matching delivered responses", async () => {
    const fakeWindow = installFakeWindow();
    const shim = installIosShim();

    const request = shim.request("provider.foo", { ok: true });

    expect(
      fakeWindow.webkit?.messageHandlers?.elizaosBridge?.postMessage,
    ).toHaveBeenCalledWith({
      kind: "request",
      id: 1,
      method: "provider.foo",
      params: { ok: true },
    });

    fakeWindow.__elizaosIosDeliver?.({
      kind: "response",
      id: 1,
      ok: true,
      payload: { value: 7 },
    });

    await expect(request).resolves.toEqual({ value: 7 });
  });

  it("rejects error responses and ignores malformed or unknown deliveries", async () => {
    const fakeWindow = installFakeWindow();
    const shim = installIosShim();
    const request = shim.request("provider.fail", null);

    for (const delivery of [
      null,
      "not an object",
      { kind: "response", id: "1", ok: true, payload: "ignored" },
      { kind: "response", id: 999, ok: true, payload: "ignored" },
      { kind: "event", event: 12, data: "ignored" },
    ]) {
      fakeWindow.__elizaosIosDeliver?.(delivery);
    }
    fakeWindow.__elizaosIosDeliver?.({
      kind: "response",
      id: 1,
      ok: false,
      error: "denied",
    });

    await expect(request).rejects.toThrow("denied");
  });

  it("ignores malformed matching responses without settling pending requests", async () => {
    const fakeWindow = installFakeWindow();
    const shim = installIosShim();
    const request = shim.request("provider.wait", null);

    for (const delivery of [
      { kind: "response", id: 1 },
      { kind: "response", id: 1, ok: "true" },
      { kind: "response", id: Number.NaN, ok: true },
      { kind: "response", id: 1, ok: false, error: { message: "bad" } },
    ]) {
      fakeWindow.__elizaosIosDeliver?.(delivery);
    }
    fakeWindow.__elizaosIosDeliver?.({
      kind: "response",
      id: 1,
      ok: true,
      payload: "settled",
    });

    await expect(request).resolves.toBe("settled");
  });

  it("keeps concurrent requests correlated when responses arrive out of order", async () => {
    const fakeWindow = installFakeWindow();
    const shim = installIosShim();

    const first = shim.request("provider.first", null);
    const second = shim.request("provider.second", null);

    const postMessage =
      fakeWindow.webkit?.messageHandlers?.elizaosBridge?.postMessage;
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

    fakeWindow.__elizaosIosDeliver?.({
      kind: "response",
      id: 2,
      ok: true,
      payload: "second",
    });
    fakeWindow.__elizaosIosDeliver?.({
      kind: "response",
      id: 1,
      ok: true,
      payload: "first",
    });

    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
  });

  it("uses default success and error payload semantics", async () => {
    const fakeWindow = installFakeWindow();
    const shim = installIosShim();

    const success = shim.request("provider.empty", null);
    fakeWindow.__elizaosIosDeliver?.({
      kind: "response",
      id: 1,
      ok: true,
    });
    await expect(success).resolves.toBeNull();

    const failure = shim.request("provider.error", null);
    fakeWindow.__elizaosIosDeliver?.({
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
    installFakeWindow(postMessage);
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

  it("rejects requests that never receive an iOS bridge response", async () => {
    installFakeWindow();
    const shim = installIosShim({ requestTimeoutMs: 1 });

    await expect(shim.request("provider.never", null)).rejects.toThrow(
      "iOS bridge request timed out: provider.never",
    );
  });

  it("delivers events to subscribers and stops after unsubscribe", () => {
    const fakeWindow = installFakeWindow();
    const shim = installIosShim();
    const handler = mock(() => {});
    const secondHandler = mock(() => {});

    const unsubscribe = shim.on("plugin.event", handler);
    shim.on("plugin.event", secondHandler);
    fakeWindow.__elizaosIosDeliver?.({
      kind: "event",
      event: "plugin.event",
      data: { count: 1 },
    });
    fakeWindow.__elizaosIosDeliver?.({
      kind: "event",
      event: "plugin.event",
    });
    unsubscribe();
    fakeWindow.__elizaosIosDeliver?.({
      kind: "event",
      event: "plugin.event",
      data: { count: 2 },
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ count: 1 });
    expect(secondHandler).toHaveBeenCalledTimes(2);
    expect(secondHandler).toHaveBeenLastCalledWith({ count: 2 });
  });

  it("is idempotent and installs the same host shim once", () => {
    installFakeWindow();
    const first = installIosShim();
    const firstDeliver = window.__elizaosIosDeliver;
    const second = installIosShim();

    expect(second).toBe(first);
    expect(getHostShim()).toBe(first);
    expect(window.__elizaosIosDeliver).toBe(firstDeliver);
  });

  it("encodes plugin and asset path segments and rejects unsafe relative paths", () => {
    installFakeWindow();
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
