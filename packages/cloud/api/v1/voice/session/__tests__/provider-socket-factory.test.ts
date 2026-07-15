/**
 * Unit coverage for the Workers outbound provider-socket factories and the
 * DeferredWorkerSocket buffering proxy (transport boundary for the merged
 * Deepgram Flux + Cartesia adapters). The Workers `fetch(...).webSocket`
 * upgrade is faked so the tests assert the buffer/bind/close/fail-open state
 * machine and the URL rewrites deterministically, with no live provider.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";

import {
  createWorkerCartesiaFactory,
  createWorkerDeepgramFluxFactory,
  isWorkerOutboundWsAvailable,
} from "../lib/provider-socket-factory";

interface FakeWorkerSocket {
  accepted: boolean;
  sent: Array<string | ArrayBuffer | ArrayBufferView>;
  closed: Array<{ code?: number; reason?: string }>;
  listeners: Array<[string, (event: unknown) => void]>;
  accept(): void;
  send(data: string | ArrayBuffer | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (event: unknown) => void): void;
  removeEventListener(type: string, listener: (event: unknown) => void): void;
}

function makeFakeWorkerSocket(): FakeWorkerSocket {
  const socket: FakeWorkerSocket = {
    accepted: false,
    sent: [],
    closed: [],
    listeners: [],
    accept() {
      this.accepted = true;
    },
    send(data) {
      this.sent.push(data);
    },
    close(code, reason) {
      this.closed.push({ code, reason });
    },
    addEventListener(type, listener) {
      this.listeners.push([type, listener]);
    },
    removeEventListener(type, listener) {
      const idx = this.listeners.findIndex(
        ([t, l]) => t === type && l === listener,
      );
      if (idx !== -1) this.listeners.splice(idx, 1);
    },
  };
  return socket;
}

// Records the URL + headers each outbound upgrade was invoked with, and lets a
// test resolve/reject the upgrade to drive the deferred-socket state machine.
interface UpgradeCapture {
  httpUrl: string;
  headers: Record<string, string>;
  resolve: (socket: FakeWorkerSocket | null) => void;
  reject: (error: unknown) => void;
}

const upgrades: UpgradeCapture[] = [];

// We cannot mock the internal `openWorkerSocket`; instead we stub global fetch
// which the module calls. The module rewrites wss->https and reads
// `response.webSocket`.
const originalFetch = globalThis.fetch;

function stubFetch(): void {
  globalThis.fetch = ((httpUrl: string, init?: RequestInit) => {
    return new Promise((resolve, reject) => {
      upgrades.push({
        httpUrl,
        headers: (init?.headers ?? {}) as Record<string, string>,
        resolve: (socket) =>
          resolve({ status: socket ? 101 : 502, webSocket: socket } as never),
        reject,
      });
    });
  }) as unknown as typeof fetch;
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  upgrades.length = 0;
  mock.restore();
});

describe("isWorkerOutboundWsAvailable", () => {
  test("reflects presence of the Workers WebSocketPair global", () => {
    const had = "WebSocketPair" in globalThis;
    if (!had) {
      (globalThis as unknown as { WebSocketPair?: unknown }).WebSocketPair =
        class {};
      expect(isWorkerOutboundWsAvailable()).toBe(true);
      delete (globalThis as unknown as { WebSocketPair?: unknown })
        .WebSocketPair;
      expect(isWorkerOutboundWsAvailable()).toBe(false);
    } else {
      expect(isWorkerOutboundWsAvailable()).toBe(true);
    }
  });
});

describe("createWorkerDeepgramFluxFactory", () => {
  test("strips the channels param and maps wss:// to https:// for the upgrade", async () => {
    stubFetch();
    const factory = createWorkerDeepgramFluxFactory();
    const _socket = factory({
      url: "wss://api.deepgram.com/v1/listen?encoding=linear16&channels=1&model=flux",
      headers: { Authorization: "Token dg" },
    }) as unknown as {
      addEventListener(t: string, l: (e: unknown) => void): void;
      send(d: string): void;
    };

    await flush();
    expect(upgrades.length).toBe(1);
    const upgrade = upgrades[0];
    expect(upgrade.httpUrl.startsWith("https://")).toBe(true);
    // channels stripped; the mono-inferring params preserved.
    expect(upgrade.httpUrl).not.toContain("channels=");
    expect(upgrade.httpUrl).toContain("encoding=linear16");
    expect(upgrade.headers.Authorization).toBe("Token dg");
    expect(upgrade.headers.Upgrade).toBe("websocket");
  });

  test("buffers sends before bind, then flushes and synthesizes open on bind", async () => {
    stubFetch();
    const factory = createWorkerDeepgramFluxFactory();
    const proxy = factory({
      url: "wss://api.deepgram.com/v1/listen?encoding=linear16",
      headers: {},
    }) as unknown as {
      readyState: number;
      addEventListener(t: string, l: (e: unknown) => void): void;
      send(d: string | ArrayBuffer | ArrayBufferView): void;
    };

    // Proxy reports OPEN immediately so the adapter does not drop early frames.
    expect(proxy.readyState).toBe(1);

    let opened = false;
    proxy.addEventListener("open", () => {
      opened = true;
    });
    proxy.send("frame-1");
    proxy.send("frame-2");

    await flush();
    const real = makeFakeWorkerSocket();
    upgrades[0].resolve(real);
    await flush();

    expect(real.accepted).toBe(true);
    expect(real.sent).toEqual(["frame-1", "frame-2"]);
    expect(opened).toBe(true);
    // Post-bind sends pass straight through.
    proxy.send("frame-3");
    expect(real.sent).toEqual(["frame-1", "frame-2", "frame-3"]);
  });

  test("close before bind drops buffered audio and closes the real socket on bind", async () => {
    stubFetch();
    const factory = createWorkerDeepgramFluxFactory();
    const proxy = factory({
      url: "wss://api.deepgram.com/v1/listen?encoding=linear16",
      headers: {},
    }) as unknown as {
      send(d: string): void;
      close(code?: number, reason?: string): void;
    };

    proxy.send("buffered");
    proxy.close(1000, "client done");
    // A send after close must never reach the provider.
    proxy.send("post-close");

    await flush();
    const real = makeFakeWorkerSocket();
    upgrades[0].resolve(real);
    await flush();

    expect(real.sent).toEqual([]);
    expect(real.closed).toEqual([{ code: 1000, reason: "client done" }]);
  });

  test("fail-open surfaces error + close(1006) when the upgrade yields no socket", async () => {
    stubFetch();
    const factory = createWorkerDeepgramFluxFactory();
    const proxy = factory({
      url: "wss://api.deepgram.com/v1/listen?encoding=linear16",
      headers: {},
    }) as unknown as {
      addEventListener(t: string, l: (e: unknown) => void): void;
    };

    const errors: unknown[] = [];
    const closes: Array<{ code?: number; wasClean?: boolean }> = [];
    proxy.addEventListener("error", (e) => errors.push(e));
    proxy.addEventListener("close", (e) =>
      closes.push(e as { code?: number; wasClean?: boolean }),
    );

    await flush();
    upgrades[0].resolve(null); // response.webSocket missing -> fail open
    await flush();

    expect(errors.length).toBe(1);
    expect(closes.length).toBe(1);
    expect(closes[0].code).toBe(1006);
    expect(closes[0].wasClean).toBe(false);
  });

  test("fail-open also fires when fetch itself rejects", async () => {
    stubFetch();
    const factory = createWorkerDeepgramFluxFactory();
    const proxy = factory({
      url: "wss://api.deepgram.com/v1/listen?encoding=linear16",
      headers: {},
    }) as unknown as {
      addEventListener(t: string, l: (e: unknown) => void): void;
    };
    const errors: unknown[] = [];
    proxy.addEventListener("error", (e) => errors.push(e));

    await flush();
    upgrades[0].reject(new Error("network down"));
    await flush();

    expect(errors.length).toBe(1);
  });

  test("addEventListener/removeEventListener are honored pre-bind", async () => {
    stubFetch();
    const factory = createWorkerDeepgramFluxFactory();
    const proxy = factory({
      url: "wss://api.deepgram.com/v1/listen?encoding=linear16",
      headers: {},
    }) as unknown as {
      addEventListener(t: string, l: (e: unknown) => void): void;
      removeEventListener(t: string, l: (e: unknown) => void): void;
    };

    const onMessage = () => undefined;
    proxy.addEventListener("message", onMessage);
    proxy.removeEventListener("message", onMessage);

    await flush();
    const real = makeFakeWorkerSocket();
    upgrades[0].resolve(real);
    await flush();

    // The removed listener was never re-attached to the real socket.
    expect(real.listeners.some(([t]) => t === "message")).toBe(false);
  });

  test("leaves a malformed URL untouched (channels-strip is best-effort)", async () => {
    stubFetch();
    const factory = createWorkerDeepgramFluxFactory();
    factory({
      url: "not-a-valid-url",
      headers: {},
    });
    await flush();
    // wss/ws rewrite is a plain string replace; a non-ws URL passes through.
    expect(upgrades[0].httpUrl).toBe("not-a-valid-url");
  });
});

describe("createWorkerCartesiaFactory", () => {
  test("opens the outbound upgrade with the given url + headers", async () => {
    stubFetch();
    const factory = createWorkerCartesiaFactory();
    const proxy = factory("wss://api.cartesia.ai/tts/websocket", {
      headers: { "X-API-Key": "cartesia" },
    }) as unknown as {
      send(d: string): void;
    };

    await flush();
    expect(upgrades.length).toBe(1);
    expect(upgrades[0].httpUrl).toBe("https://api.cartesia.ai/tts/websocket");
    expect(upgrades[0].headers["X-API-Key"]).toBe("cartesia");

    proxy.send("phrase");
    await flush();
    const real = makeFakeWorkerSocket();
    upgrades[0].resolve(real);
    await flush();
    expect(real.sent).toEqual(["phrase"]);
  });

  test("maps ws:// (insecure) to http:// for the upgrade", async () => {
    stubFetch();
    const factory = createWorkerCartesiaFactory();
    factory("ws://localhost:9999/tts", { headers: {} });
    await flush();
    expect(upgrades[0].httpUrl).toBe("http://localhost:9999/tts");
  });
});
