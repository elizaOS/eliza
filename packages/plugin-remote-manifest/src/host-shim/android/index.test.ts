/**
 * Android host shim tests exercise JSON bridge request dispatch, response
 * delivery, event fanout, and reset behavior with a fake native bridge.
 */
import { afterEach, describe, expect, it, mock } from "bun:test";
import { getHostShim, resetHostShim } from "../index.js";
import { installAndroidShim, resetAndroidShimForTests } from "./index.js";

interface TestWindow {
  ElizaosAndroidBridge?: { postMessage: ReturnType<typeof mock> };
  __elizaosAndroidDeliver?: (json: string) => void;
}

function installTestWindow(postMessage = mock(() => {})): TestWindow {
  const testWindow: TestWindow = {
    ElizaosAndroidBridge: { postMessage },
  };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: testWindow,
  });
  return testWindow;
}

describe("installAndroidShim", () => {
  afterEach(() => {
    resetAndroidShimForTests();
    resetHostShim();
    Reflect.deleteProperty(globalThis, "window");
  });

  it("throws when the Android bridge is missing", () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {},
    });

    expect(() => installAndroidShim()).toThrow(
      "window.ElizaosAndroidBridge missing",
    );
  });

  it("posts request JSON and resolves matching delivered responses", async () => {
    const testWindow = installTestWindow();
    const shim = installAndroidShim();

    const request = shim.request("provider.foo", { ok: true });
    const posted = JSON.parse(
      String(testWindow.ElizaosAndroidBridge?.postMessage.mock.calls[0]?.[0]),
    );

    expect(posted).toEqual({
      kind: "request",
      id: 1,
      method: "provider.foo",
      params: { ok: true },
    });

    testWindow.__elizaosAndroidDeliver?.(
      JSON.stringify({
        kind: "response",
        id: 1,
        ok: true,
        payload: { value: 7 },
      }),
    );

    await expect(request).resolves.toEqual({ value: 7 });
  });

  it("rejects delivered error responses and ignores malformed or unknown deliveries", async () => {
    const testWindow = installTestWindow();
    const shim = installAndroidShim();
    const request = shim.request("provider.fail", null);

    testWindow.__elizaosAndroidDeliver?.("not json");
    testWindow.__elizaosAndroidDeliver?.(JSON.stringify(null));
    testWindow.__elizaosAndroidDeliver?.(
      JSON.stringify({
        kind: "response",
        id: "1",
        ok: true,
        payload: "ignored",
      }),
    );
    testWindow.__elizaosAndroidDeliver?.(
      JSON.stringify({ kind: "response", id: 1, payload: "missing-ok" }),
    );
    testWindow.__elizaosAndroidDeliver?.(
      JSON.stringify({
        kind: "response",
        id: 999,
        ok: true,
        payload: "ignored",
      }),
    );
    testWindow.__elizaosAndroidDeliver?.(
      JSON.stringify({ kind: "event", event: 12, data: "ignored" }),
    );
    testWindow.__elizaosAndroidDeliver?.(
      JSON.stringify({ kind: "response", id: 1, ok: false, error: "denied" }),
    );

    await expect(request).rejects.toThrow("denied");
  });

  it("ignores malformed matching responses without settling pending requests", async () => {
    const testWindow = installTestWindow();
    const shim = installAndroidShim();
    const request = shim.request("provider.wait", null);

    for (const delivery of [
      { kind: "response", id: 1 },
      { kind: "response", id: 1, ok: "true" },
      { kind: "response", id: Number.NaN, ok: true },
      { kind: "response", id: 1, ok: false, error: { message: "bad" } },
    ]) {
      testWindow.__elizaosAndroidDeliver?.(JSON.stringify(delivery));
    }
    testWindow.__elizaosAndroidDeliver?.(
      JSON.stringify({
        kind: "response",
        id: 1,
        ok: true,
        payload: "settled",
      }),
    );

    await expect(request).resolves.toBe("settled");
  });

  it("keeps concurrent requests correlated when responses arrive out of order", async () => {
    const testWindow = installTestWindow();
    const shim = installAndroidShim();

    const first = shim.request("provider.first", null);
    const second = shim.request("provider.second", null);
    const postMessage = testWindow.ElizaosAndroidBridge?.postMessage;

    expect(JSON.parse(String(postMessage?.mock.calls[0]?.[0]))).toEqual({
      kind: "request",
      id: 1,
      method: "provider.first",
      params: null,
    });
    expect(JSON.parse(String(postMessage?.mock.calls[1]?.[0]))).toEqual({
      kind: "request",
      id: 2,
      method: "provider.second",
      params: null,
    });

    testWindow.__elizaosAndroidDeliver?.(
      JSON.stringify({
        kind: "response",
        id: 2,
        ok: true,
        payload: "second",
      }),
    );
    testWindow.__elizaosAndroidDeliver?.(
      JSON.stringify({
        kind: "response",
        id: 1,
        ok: true,
        payload: "first",
      }),
    );

    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
  });

  it("uses default success and error payload semantics", async () => {
    const testWindow = installTestWindow();
    const shim = installAndroidShim();

    const success = shim.request("provider.empty", null);
    testWindow.__elizaosAndroidDeliver?.(
      JSON.stringify({
        kind: "response",
        id: 1,
        ok: true,
      }),
    );
    await expect(success).resolves.toBeNull();

    const failure = shim.request("provider.error", null);
    testWindow.__elizaosAndroidDeliver?.(
      JSON.stringify({
        kind: "response",
        id: 2,
        ok: false,
      }),
    );
    await expect(failure).rejects.toThrow("Android bridge error");
  });

  it("rejects immediately when bridge postMessage throws", async () => {
    const postMessage = mock(() => {});
    postMessage.mockImplementationOnce(() => {
      throw new Error("bridge down");
    });
    installTestWindow(postMessage);
    const shim = installAndroidShim();

    await expect(shim.request("provider.foo", null)).rejects.toThrow(
      "bridge down",
    );

    const retry = shim.request("provider.retry", null);
    const lastCall = postMessage.mock.calls[
      postMessage.mock.calls.length - 1
    ] as unknown as [string];
    const lastMessage = lastCall[0];
    expect(typeof lastMessage).toBe("string");
    expect(JSON.parse(String(lastMessage))).toEqual({
      kind: "request",
      id: 2,
      method: "provider.retry",
      params: null,
    });
    window.__elizaosAndroidDeliver?.(
      JSON.stringify({
        kind: "response",
        id: 2,
        ok: true,
        payload: "retried",
      }),
    );
    await expect(retry).resolves.toBe("retried");
  });

  it("rejects requests that never receive an Android bridge response", async () => {
    installTestWindow();
    const shim = installAndroidShim({ requestTimeoutMs: 1 });

    await expect(shim.request("provider.never", null)).rejects.toThrow(
      "Android bridge request timed out: provider.never",
    );
  });

  it("delivers events to subscribers and stops after unsubscribe", () => {
    const testWindow = installTestWindow();
    const shim = installAndroidShim();
    const handler = mock(() => {});
    const secondHandler = mock(() => {});

    const unsubscribe = shim.on("plugin.event", handler);
    shim.on("plugin.event", secondHandler);
    testWindow.__elizaosAndroidDeliver?.(
      JSON.stringify({
        kind: "event",
        event: "plugin.event",
        data: { count: 1 },
      }),
    );
    testWindow.__elizaosAndroidDeliver?.(
      JSON.stringify({
        kind: "event",
        event: "plugin.event",
      }),
    );
    unsubscribe();
    testWindow.__elizaosAndroidDeliver?.(
      JSON.stringify({
        kind: "event",
        event: "plugin.event",
        data: { count: 2 },
      }),
    );

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ count: 1 });
    expect(secondHandler).toHaveBeenCalledTimes(2);
    expect(secondHandler).toHaveBeenLastCalledWith({ count: 2 });
  });

  it("is idempotent and installs the same host shim once", () => {
    installTestWindow();
    const first = installAndroidShim();
    const firstDeliver = window.__elizaosAndroidDeliver;
    const second = installAndroidShim();

    expect(second).toBe(first);
    expect(getHostShim()).toBe(first);
    expect(window.__elizaosAndroidDeliver).toBe(firstDeliver);
  });

  it("encodes plugin and asset path segments and rejects unsafe relative paths", () => {
    installTestWindow();
    const shim = installAndroidShim();

    expect(
      shim.resolveViewUrl("plugin space", "assets/main file.js").href,
    ).toBe(
      "https://appassets.androidplatform.net/plugins/plugin%20space/assets/main%20file.js",
    );
    expect(shim.resolveViewUrl("plugin", String.raw`assets\main.js`).href).toBe(
      "https://appassets.androidplatform.net/plugins/plugin/assets/main.js",
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
