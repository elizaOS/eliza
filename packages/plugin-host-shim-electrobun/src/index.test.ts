import { afterEach, describe, expect, it, mock } from "bun:test";
import { getHostShim, resetHostShim } from "@elizaos/plugin-host-shim";
import { installElectrobunShim, resetElectrobunShimForTests } from "./index";

type Listener = (data: unknown) => void;

class FakeBridge {
  readonly listeners = new Map<string, Set<Listener>>();
  readonly postMessage = mock(() => {});

  addListener(event: string, handler: Listener): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(handler);
    return () => set?.delete(handler);
  }

  emit(event: string, data: unknown): void {
    for (const handler of this.listeners.get(event) ?? []) {
      handler(data);
    }
  }

  listenerCount(event: string): number {
    return this.listeners.get(event)?.size ?? 0;
  }
}

function installFakeBridge(bridge = new FakeBridge()): FakeBridge {
  globalThis.__elizaosElectrobunBridge = bridge;
  return bridge;
}

describe("installElectrobunShim", () => {
  afterEach(() => {
    resetElectrobunShimForTests();
    resetHostShim();
    Reflect.deleteProperty(globalThis, "__elizaosElectrobunBridge");
  });

  it("throws when the Electrobun bridge is missing", () => {
    Reflect.deleteProperty(globalThis, "__elizaosElectrobunBridge");

    expect(() => installElectrobunShim()).toThrow(
      "__elizaosElectrobunBridge missing",
    );
  });

  it("posts request envelopes and resolves matching bridge responses", async () => {
    const bridge = installFakeBridge();
    const shim = installElectrobunShim();

    const request = shim.request("provider.foo", { ok: true });

    expect(bridge.postMessage).toHaveBeenCalledWith({
      kind: "request",
      id: 1,
      method: "provider.foo",
      params: { ok: true },
    });
    bridge.emit("response", {
      kind: "response",
      id: 1,
      ok: true,
      payload: { value: 7 },
    });

    await expect(request).resolves.toEqual({ value: 7 });
  });

  it("rejects error responses and ignores malformed or unrelated bridge traffic", async () => {
    const bridge = installFakeBridge();
    const shim = installElectrobunShim();
    const request = shim.request("provider.fail", null);

    bridge.emit("response", "not an envelope");
    bridge.emit("response", { id: 1, ok: true, payload: "missing-kind" });
    bridge.emit("response", {
      kind: "response",
      id: Number.POSITIVE_INFINITY,
      ok: true,
      payload: "non-finite-id",
    });
    bridge.emit("response", {
      kind: "response",
      id: 1,
      ok: false,
      error: { message: "wrong-error-type" },
    });
    bridge.emit("response", {
      kind: "response",
      id: 999,
      ok: true,
      payload: "wrong-id",
    });
    bridge.emit("event", {
      kind: "response",
      id: 1,
      ok: true,
      payload: "wrong-channel",
    });
    bridge.emit("response", {
      kind: "response",
      id: 1,
      ok: false,
      error: "denied",
    });

    await expect(request).rejects.toThrow("denied");
  });

  it("keeps concurrent requests correlated when responses arrive out of order", async () => {
    const bridge = installFakeBridge();
    const shim = installElectrobunShim();

    const first = shim.request("provider.first", null);
    const second = shim.request("provider.second", null);

    bridge.emit("response", {
      kind: "response",
      id: 2,
      ok: true,
      payload: "second",
    });
    bridge.emit("response", {
      kind: "response",
      id: 1,
      ok: true,
      payload: "first",
    });

    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
  });

  it("uses default success and error payload semantics", async () => {
    const bridge = installFakeBridge();
    const shim = installElectrobunShim();

    const success = shim.request("provider.empty", null);
    bridge.emit("response", {
      kind: "response",
      id: 1,
      ok: true,
    });
    await expect(success).resolves.toBeNull();

    const failure = shim.request("provider.error", null);
    bridge.emit("response", {
      kind: "response",
      id: 2,
      ok: false,
    });
    await expect(failure).rejects.toThrow("Unknown bridge error");
  });

  it("rejects immediately when bridge postMessage throws", async () => {
    const bridge = installFakeBridge();
    bridge.postMessage.mockImplementationOnce(() => {
      throw new Error("bridge down");
    });
    const shim = installElectrobunShim();

    await expect(shim.request("provider.foo", null)).rejects.toThrow(
      "bridge down",
    );

    const retry = shim.request("provider.retry", null);
    expect(bridge.postMessage).toHaveBeenLastCalledWith({
      kind: "request",
      id: 2,
      method: "provider.retry",
      params: null,
    });
    bridge.emit("response", {
      kind: "response",
      id: 2,
      ok: true,
      payload: "retried",
    });
    await expect(retry).resolves.toBe("retried");
  });

  it("rejects requests that never receive a bridge response", async () => {
    installFakeBridge();
    const shim = installElectrobunShim({ requestTimeoutMs: 1 });

    await expect(shim.request("provider.never", null)).rejects.toThrow(
      "Electrobun bridge request timed out: provider.never",
    );
  });

  it("delivers events to subscribers and stops after unsubscribe", () => {
    const bridge = installFakeBridge();
    const shim = installElectrobunShim();
    const handler = mock(() => {});

    const unsubscribe = shim.on("plugin.event", handler);
    bridge.emit("event", {
      kind: "event",
      event: "plugin.event",
      data: { count: 1 },
    });
    bridge.emit("event", { event: "plugin.event", data: { count: 2 } });
    bridge.emit("event", { kind: "event", event: "plugin.event" });
    unsubscribe();
    bridge.emit("event", {
      kind: "event",
      event: "plugin.event",
      data: { count: 3 },
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ count: 1 });
  });

  it("is idempotent and does not register duplicate bridge listeners", () => {
    const bridge = installFakeBridge();
    const first = installElectrobunShim();
    const second = installElectrobunShim();

    expect(second).toBe(first);
    expect(getHostShim()).toBe(first);
    expect(bridge.listenerCount("response")).toBe(1);
    expect(bridge.listenerCount("event")).toBe(1);
  });

  it("reset removes bridge listeners and permits a clean reinstall", () => {
    const bridge = installFakeBridge();
    const first = installElectrobunShim();
    resetElectrobunShimForTests();

    expect(bridge.listenerCount("response")).toBe(0);
    expect(bridge.listenerCount("event")).toBe(0);

    const second = installElectrobunShim();
    expect(second).not.toBe(first);
    expect(bridge.listenerCount("response")).toBe(1);
    expect(bridge.listenerCount("event")).toBe(1);
  });

  it("encodes plugin and asset path segments and rejects unsafe relative paths", () => {
    installFakeBridge();
    const shim = installElectrobunShim();

    expect(
      shim.resolveViewUrl("plugin space", "assets/main file.js").href,
    ).toBe("views://plugin%20space/assets/main%20file.js");
    for (const unsafePath of [
      "",
      ".",
      "..",
      "../secret.js",
      "assets/../secret.js",
      "/absolute.js",
      "C:\\secret.js",
      String.raw`assets\..\secret.js`,
    ]) {
      expect(() => shim.resolveViewUrl("plugin", unsafePath)).toThrow(
        "Invalid view asset path",
      );
    }
  });
});
