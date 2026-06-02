import { afterEach, describe, expect, it, mock } from "bun:test";
import { getHostShim, resetHostShim } from "./index";
import { installWebShim, resetWebShimForTests } from "./web";

type MessageListener = (event: {
  data: unknown;
  origin: string;
  source: unknown;
}) => void;

interface FakeWindow {
  addEventListener: ReturnType<typeof mock>;
  removeEventListener: ReturnType<typeof mock>;
  listeners: Set<MessageListener>;
  location: { href: string };
  parent: { postMessage: ReturnType<typeof mock> };
}

function installFakeWindow(): FakeWindow {
  const listeners = new Set<MessageListener>();
  const fakeWindow: FakeWindow = {
    addEventListener: mock((type: string, listener: MessageListener) => {
      if (type === "message") listeners.add(listener);
    }),
    removeEventListener: mock((type: string, listener: MessageListener) => {
      if (type === "message") listeners.delete(listener);
    }),
    listeners,
    location: { href: "https://agent.test/views/frame.html" },
    parent: {
      postMessage: mock(() => {}),
    },
  };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: fakeWindow,
  });
  return fakeWindow;
}

function deliver(
  fakeWindow: FakeWindow,
  data: unknown,
  origin = "https://host.test",
  source: unknown = fakeWindow.parent,
) {
  for (const listener of fakeWindow.listeners) {
    listener({ data, origin, source });
  }
}

describe("installWebShim", () => {
  afterEach(() => {
    resetWebShimForTests();
    resetHostShim();
    Reflect.deleteProperty(globalThis, "window");
  });

  it("posts request envelopes and resolves matching parent responses", async () => {
    const fakeWindow = installFakeWindow();
    const shim = installWebShim({ parentOrigin: "https://host.test" });

    const request = shim.request("provider.foo", { ok: true });

    expect(fakeWindow.parent.postMessage).toHaveBeenCalledWith(
      {
        kind: "elizaos.shim.request",
        id: 1,
        method: "provider.foo",
        params: { ok: true },
      },
      "https://host.test",
    );
    deliver(fakeWindow, {
      kind: "elizaos.shim.response",
      id: 1,
      ok: true,
      payload: { value: 42 },
    });

    await expect(request).resolves.toEqual({ value: 42 });
  });

  it("rejects error responses and ignores mismatched origins or sources", async () => {
    const fakeWindow = installFakeWindow();
    const shim = installWebShim({ parentOrigin: "https://host.test" });
    const request = shim.request("provider.fail", null);

    deliver(
      fakeWindow,
      {
        kind: "elizaos.shim.response",
        id: 1,
        ok: true,
        payload: "wrong-origin",
      },
      "https://evil.test",
    );
    deliver(
      fakeWindow,
      {
        kind: "elizaos.shim.response",
        id: 1,
        ok: true,
        payload: "wrong-source",
      },
      "https://host.test",
      {},
    );
    deliver(fakeWindow, {
      kind: "elizaos.shim.response",
      id: 1,
      ok: false,
      error: "denied",
    });

    await expect(request).rejects.toThrow("denied");
  });

  it("ignores source-less messages even when origin matches", async () => {
    const fakeWindow = installFakeWindow();
    const shim = installWebShim({ parentOrigin: "https://host.test" });
    const handler = mock(() => {});
    const request = shim.request("provider.secure", null);
    shim.on("plugin.event", handler);

    deliver(
      fakeWindow,
      {
        kind: "elizaos.shim.response",
        id: 1,
        ok: true,
        payload: "source-null",
      },
      "https://host.test",
      null,
    );
    deliver(
      fakeWindow,
      {
        kind: "elizaos.shim.event",
        event: "plugin.event",
        data: "source-null",
      },
      "https://host.test",
      null,
    );
    deliver(fakeWindow, {
      kind: "elizaos.shim.response",
      id: 1,
      ok: true,
      payload: "accepted",
    });

    await expect(request).resolves.toBe("accepted");
    expect(handler).not.toHaveBeenCalled();
  });

  it("keeps concurrent requests correlated when responses arrive out of order", async () => {
    const fakeWindow = installFakeWindow();
    const shim = installWebShim({ parentOrigin: "https://host.test" });

    const first = shim.request("provider.first", null);
    const second = shim.request("provider.second", null);

    deliver(fakeWindow, {
      kind: "elizaos.shim.response",
      id: 2,
      ok: true,
      payload: "second",
    });
    deliver(fakeWindow, {
      kind: "elizaos.shim.response",
      id: 1,
      ok: true,
      payload: "first",
    });

    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
  });

  it("uses default success and error payload semantics", async () => {
    const fakeWindow = installFakeWindow();
    const shim = installWebShim({ parentOrigin: "https://host.test" });

    const success = shim.request("provider.empty", null);
    deliver(fakeWindow, {
      kind: "elizaos.shim.response",
      id: 1,
      ok: true,
    });
    await expect(success).resolves.toBeNull();

    const failure = shim.request("provider.error", null);
    deliver(fakeWindow, {
      kind: "elizaos.shim.response",
      id: 2,
      ok: false,
    });
    await expect(failure).rejects.toThrow("Unknown shim error");
  });

  it("rejects and cleans up when parent postMessage throws", async () => {
    const fakeWindow = installFakeWindow();
    const shim = installWebShim({ parentOrigin: "https://host.test" });
    fakeWindow.parent.postMessage.mockImplementationOnce(() => {
      throw new Error("bridge unavailable");
    });

    await expect(shim.request("provider.fail", null)).rejects.toThrow(
      "bridge unavailable",
    );

    const retry = shim.request("provider.retry", null);
    expect(fakeWindow.parent.postMessage).toHaveBeenLastCalledWith(
      {
        kind: "elizaos.shim.request",
        id: 2,
        method: "provider.retry",
        params: null,
      },
      "https://host.test",
    );
    deliver(fakeWindow, {
      kind: "elizaos.shim.response",
      id: 2,
      ok: true,
      payload: "retried",
    });
    await expect(retry).resolves.toBe("retried");
  });

  it("rejects requests that never receive a parent response", async () => {
    installFakeWindow();
    const shim = installWebShim({
      parentOrigin: "https://host.test",
      requestTimeoutMs: 1,
    });

    await expect(shim.request("provider.never", null)).rejects.toThrow(
      "Host shim request timed out: provider.never",
    );
  });

  it("ignores malformed response envelopes without settling pending requests", async () => {
    const fakeWindow = installFakeWindow();
    const shim = installWebShim({ parentOrigin: "https://host.test" });
    const request = shim.request("provider.wait", null);

    deliver(fakeWindow, {
      kind: "elizaos.shim.response",
      id: "1",
      ok: true,
      payload: "wrong-id-type",
    });
    deliver(fakeWindow, {
      kind: "elizaos.shim.response",
      id: 1,
      ok: "true",
      payload: "wrong-ok-type",
    });
    deliver(fakeWindow, {
      kind: "elizaos.shim.response",
      id: 1,
      ok: true,
      payload: "settled",
    });

    await expect(request).resolves.toBe("settled");
  });

  it("delivers events to subscribers and stops after unsubscribe", () => {
    const fakeWindow = installFakeWindow();
    const shim = installWebShim({ parentOrigin: "https://host.test" });
    const handler = mock(() => {});

    const unsubscribe = shim.on("plugin.event", handler);
    deliver(fakeWindow, {
      kind: "elizaos.shim.event",
      event: "plugin.event",
      data: { count: 1 },
    });
    unsubscribe();
    deliver(fakeWindow, {
      kind: "elizaos.shim.event",
      event: "plugin.event",
      data: { count: 2 },
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ count: 1 });
  });

  it("ignores malformed event envelopes but delivers explicit null payloads", () => {
    const fakeWindow = installFakeWindow();
    const shim = installWebShim({ parentOrigin: "https://host.test" });
    const handler = mock(() => {});

    shim.on("plugin.event", handler);
    deliver(fakeWindow, {
      kind: "elizaos.shim.event",
      event: 123,
      data: { count: 1 },
    });
    deliver(fakeWindow, {
      kind: "elizaos.shim.event",
      event: "plugin.event",
    });
    deliver(fakeWindow, {
      kind: "elizaos.shim.event",
      event: "plugin.event",
      data: null,
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(null);
  });

  it("is idempotent and does not register duplicate listeners", () => {
    const fakeWindow = installFakeWindow();
    const first = installWebShim({ parentOrigin: "https://host.test" });
    const second = installWebShim({ parentOrigin: "https://host.test" });

    expect(second).toBe(first);
    expect(getHostShim()).toBe(first);
    expect(fakeWindow.addEventListener).toHaveBeenCalledTimes(1);
    expect(fakeWindow.listeners.size).toBe(1);
  });

  it("reset removes the active listener and permits a clean reinstall", () => {
    const fakeWindow = installFakeWindow();
    const first = installWebShim({ parentOrigin: "https://host.test" });
    resetWebShimForTests();

    expect(fakeWindow.removeEventListener).toHaveBeenCalledTimes(1);
    expect(fakeWindow.listeners.size).toBe(0);

    const second = installWebShim({ parentOrigin: "https://host.test" });
    expect(second).not.toBe(first);
    expect(fakeWindow.addEventListener).toHaveBeenCalledTimes(2);
    expect(fakeWindow.listeners.size).toBe(1);
  });

  it("encodes plugin and asset path segments and rejects unsafe relative paths", () => {
    installFakeWindow();
    const shim = installWebShim({ viewsBasePath: "/api/views" });

    expect(
      shim.resolveViewUrl("plugin space", "assets/main file.js").href,
    ).toBe("https://agent.test/api/views/plugin%20space/assets/main%20file.js");
    for (const unsafePath of [
      "",
      ".",
      "..",
      "../secret.js",
      "assets/../secret.js",
      "assets//main.js",
      "assets/",
      "/absolute.js",
      "C:\\secret.js",
      "assets\\",
      "assets\\..\\secret.js",
    ]) {
      expect(() => shim.resolveViewUrl("plugin", unsafePath)).toThrow(
        "Invalid view asset path",
      );
    }
  });
});
