/**
 * Unit tests for the browser `GatewayWeb` bridge implementation, covering
 * connect/hello handshake, RPC send, and malformed/dropped inbound frames.
 * The harness stubs `WebSocket` with an in-process `FakeWebSocket` — no real
 * socket or gateway server is involved.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GatewayWeb } from "./web";

type Listener = (event: unknown) => void;

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static deferClose = false;
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;

  readyState = FakeWebSocket.CONNECTING;
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, Listener[]>();
  private deferredClose: { code: number; reason: string } | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(eventName: string, listener: Listener): void {
    const listeners = this.listeners.get(eventName) ?? [];
    listeners.push(listener);
    this.listeners.set(eventName, listeners);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code = 1000, reason = "closed"): void {
    this.readyState = FakeWebSocket.CLOSED;
    if (FakeWebSocket.deferClose) {
      this.deferredClose = { code, reason };
      return;
    }
    this.emit("close", { code, reason });
  }

  // Fires a close() that was deferred above, simulating a stale socket's
  // "close" event arriving after a replacement connection has already begun.
  flushClose(): void {
    if (this.deferredClose) {
      const close = this.deferredClose;
      this.deferredClose = null;
      this.emit("close", close);
    }
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit("open", {});
  }

  message(data: unknown): void {
    this.emit("message", { data });
  }

  error(error: unknown): void {
    this.emit("error", error);
  }

  private emit(eventName: string, event: unknown): void {
    this.listeners.get(eventName)?.forEach((listener) => {
      listener(event);
    });
  }
}

function parseSent(
  socket: FakeWebSocket,
  index: number,
): Record<string, unknown> {
  return JSON.parse(socket.sent[index] ?? "{}") as Record<string, unknown>;
}

describe("GatewayWeb", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    FakeWebSocket.deferClose = false;
    Object.assign(FakeWebSocket, {
      CONNECTING: 0,
      OPEN: 1,
      CLOSED: 3,
    });
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("crypto", {
      randomUUID: vi.fn(() => "00000000-0000-4000-8000-000000000001"),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each(["", "https://example.test", "javascript:alert(1)", "not a url"])(
    "rejects invalid gateway URL %s before opening a socket",
    async (url) => {
      await expect(new GatewayWeb().connect({ url })).rejects.toThrow(
        /WebSocket URL|ws: or wss:/,
      );
      expect(FakeWebSocket.instances).toHaveLength(0);
    },
  );

  it("sends a connect frame and resolves from a valid hello response", async () => {
    const gateway = new GatewayWeb();
    const states: unknown[] = [];
    await gateway.addListener("stateChange", (event) => {
      states.push(event);
    });

    const connected = gateway.connect({
      url: "wss://gateway.example/socket",
      clientName: "tester",
      role: "viewer",
      scopes: ["chat.read"],
      token: "secret-token",
    });
    const socket = FakeWebSocket.instances[0];
    socket.open();
    const connectFrame = parseSent(socket, 0);
    expect(connectFrame).toMatchObject({
      type: "req",
      id: "00000000-0000-4000-8000-000000000001",
      method: "connect",
    });

    socket.message(
      JSON.stringify({
        type: "res",
        id: connectFrame.id,
        ok: true,
        payload: {
          protocol: 3,
          auth: { role: "viewer", scopes: ["chat.read"] },
          features: { methods: ["chat.send"], events: ["chat.delta"] },
        },
      }),
    );

    await expect(connected).resolves.toMatchObject({
      connected: true,
      protocol: 3,
      methods: ["chat.send"],
      events: ["chat.delta"],
      role: "viewer",
      scopes: ["chat.read"],
    });
    expect(states).toEqual([{ state: "connecting" }, { state: "connected" }]);
  });

  it("ignores malformed inbound frames and emits valid gateway events", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const gateway = new GatewayWeb();
    const events: unknown[] = [];
    await gateway.addListener("gatewayEvent", (event) => {
      events.push(event);
    });
    const connected = gateway.connect({ url: "ws://localhost:1234" });
    const socket = FakeWebSocket.instances[0];
    socket.open();
    const connectFrame = parseSent(socket, 0);
    socket.message(
      JSON.stringify({
        type: "res",
        id: connectFrame.id,
        ok: true,
        payload: {},
      }),
    );
    await connected;

    warn.mockClear();
    socket.message("not json");
    socket.message(JSON.stringify({ type: "event", event: "", payload: {} }));
    socket.message(
      JSON.stringify({
        type: "event",
        event: "chat.delta",
        payload: { n: 1 },
        seq: 1,
      }),
    );

    // Valid events still surface — we do not fabricate anything for the bad ones.
    expect(events).toEqual([
      { event: "chat.delta", payload: { n: 1 }, seq: 1 },
    ]);
    // ...but the two dropped frames must be observable, not silent idle state.
    const warnings = warn.mock.calls.map((c) => String(c[0]));
    expect(warnings.some((m) => m.includes("unparseable frame"))).toBe(true);
    expect(
      warnings.some((m) => m.includes("missing/invalid `event` name")),
    ).toBe(true);
  });

  it.each([
    {
      label: "unparseable payload",
      raw: "not json",
      needle: "unparseable frame",
    },
    { label: "non-object frame", raw: "42", needle: "non-object frame" },
    {
      label: "missing type",
      raw: JSON.stringify({ event: "chat.delta" }),
      needle: "missing/invalid `type`",
    },
    {
      label: "unhandled type",
      raw: JSON.stringify({ type: "mystery" }),
      needle: "unhandled type",
    },
    {
      label: "res without id",
      raw: JSON.stringify({ type: "res", ok: true }),
      needle: "res` frame with missing/invalid `id`",
    },
    {
      label: "res for unknown id",
      raw: JSON.stringify({ type: "res", id: "nope", ok: true }),
      needle: "unknown request id",
    },
  ])(
    "reports dropped inbound frame ($label) instead of swallowing it",
    async ({ raw, needle }) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const gateway = new GatewayWeb();
      const events: unknown[] = [];
      await gateway.addListener("gatewayEvent", (event) => {
        events.push(event);
      });
      const connected = gateway.connect({ url: "ws://localhost:1234" });
      const socket = FakeWebSocket.instances[0];
      socket.open();
      const connectFrame = parseSent(socket, 0);
      socket.message(
        JSON.stringify({
          type: "res",
          id: connectFrame.id,
          ok: true,
          payload: {},
        }),
      );
      await connected;

      warn.mockClear();
      socket.message(raw);

      expect(events).toEqual([]);
      const warnings = warn.mock.calls.map((c) => String(c[0]));
      expect(warnings.some((m) => m.includes(needle))).toBe(true);
    },
  );

  it.each(["", " spaces ", "../escape", "1bad"])(
    "rejects invalid RPC method %s before sending",
    async (method) => {
      const gateway = new GatewayWeb();
      const connected = gateway.connect({ url: "ws://localhost:1234" });
      const socket = FakeWebSocket.instances[0];
      socket.open();
      const connectFrame = parseSent(socket, 0);
      socket.message(
        JSON.stringify({
          type: "res",
          id: connectFrame.id,
          ok: true,
          payload: {},
        }),
      );
      await connected;

      await expect(gateway.send({ method })).rejects.toThrow(/method/);
      expect(socket.sent).toHaveLength(1);
    },
  );

  it("returns NOT_CONNECTED for valid RPC methods when disconnected", async () => {
    await expect(
      new GatewayWeb().send({ method: "chat.send" }),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: "NOT_CONNECTED",
        message: "Not connected to gateway",
      },
    });
  });

  it("ignores a stale close event from a socket replaced by a newer connect()", async () => {
    const gateway = new GatewayWeb();
    const states: unknown[] = [];
    await gateway.addListener("stateChange", (event) => {
      states.push(event);
    });

    const first = gateway.connect({ url: "ws://localhost:1234/first" });
    const firstSocket = FakeWebSocket.instances[0];
    firstSocket.open();
    firstSocket.message(
      JSON.stringify({
        type: "res",
        id: parseSent(firstSocket, 0).id,
        ok: true,
        payload: {},
      }),
    );
    await first;

    const firstReply = gateway.send({ method: "chat.send" });
    const firstReplyRejected = expect(firstReply).rejects.toThrow(
      "Connection replaced",
    );

    // The first socket's close() is called (by the second connect()) but its
    // "close" event doesn't fire until after the replacement is already open
    // and connected -- reproducing the real out-of-order delivery this guards
    // against, not just a same-tick call.
    FakeWebSocket.deferClose = true;
    const second = gateway.connect({ url: "ws://localhost:1234/second" });
    await firstReplyRejected;
    const secondSocket = FakeWebSocket.instances[1];
    secondSocket.open();
    secondSocket.message(
      JSON.stringify({
        type: "res",
        id: parseSent(secondSocket, 0).id,
        ok: true,
        payload: {},
      }),
    );
    await expect(second).resolves.toMatchObject({ connected: true });

    states.length = 0;
    firstSocket.flushClose();

    // The stale close must not tear down the active (second) connection: no
    // "reconnecting"/"disconnected" state change, and no spurious third
    // socket created by scheduleReconnect().
    expect(states).toEqual([]);
    expect(FakeWebSocket.instances).toHaveLength(2);

    // The second connection's own pending/reply plumbing must still work --
    // the stale close must not have nulled out `this.ws` or rejected requests
    // in flight on it.
    const reply = gateway.send({ method: "chat.send" });
    secondSocket.message(
      JSON.stringify({
        type: "res",
        id: parseSent(secondSocket, 1).id,
        ok: true,
        payload: {},
      }),
    );
    await expect(reply).resolves.toMatchObject({ ok: true });

    await gateway.disconnect();
  });

  it("settles a superseded handshake and ignores every stale socket event", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const gateway = new GatewayWeb();
    const events: unknown[] = [];
    await gateway.addListener("gatewayEvent", (event) => {
      events.push(event);
    });

    FakeWebSocket.deferClose = true;
    const first = gateway.connect({ url: "ws://localhost:1234/first" });
    const firstRejected = expect(first).rejects.toThrow("Connection replaced");
    const firstSocket = FakeWebSocket.instances[0];

    const second = gateway.connect({ url: "ws://localhost:1234/second" });
    await firstRejected;
    const secondSocket = FakeWebSocket.instances[1];

    firstSocket.open();
    firstSocket.message(
      JSON.stringify({
        type: "event",
        event: "chat.delta",
        payload: { stale: true },
        seq: 1,
      }),
    );
    firstSocket.error(new Error("stale socket error"));

    expect(firstSocket.sent).toEqual([]);
    expect(secondSocket.sent).toEqual([]);
    expect(events).toEqual([]);
    expect(warn).not.toHaveBeenCalled();

    secondSocket.open();
    secondSocket.message(
      JSON.stringify({
        type: "res",
        id: parseSent(secondSocket, 0).id,
        ok: true,
        payload: {},
      }),
    );
    await expect(second).resolves.toMatchObject({ connected: true });

    await gateway.disconnect();
  });

  it("cancels a queued automatic reconnect when connect() is called explicitly", async () => {
    vi.useFakeTimers();
    const gateway = new GatewayWeb();
    const first = gateway.connect({ url: "ws://localhost:1234/first" });
    const firstSocket = FakeWebSocket.instances[0];
    firstSocket.open();
    firstSocket.message(
      JSON.stringify({
        type: "res",
        id: parseSent(firstSocket, 0).id,
        ok: true,
        payload: {},
      }),
    );
    await first;

    firstSocket.close(1006, "network lost");
    const second = gateway.connect({ url: "ws://localhost:1234/second" });
    const secondSocket = FakeWebSocket.instances[1];
    secondSocket.open();
    secondSocket.message(
      JSON.stringify({
        type: "res",
        id: parseSent(secondSocket, 0).id,
        ok: true,
        payload: {},
      }),
    );
    await second;
    await vi.advanceTimersByTimeAsync(800);

    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(await gateway.isConnected()).toEqual({ connected: true });

    await gateway.disconnect();
  });

  it("rejects an in-progress handshake when disconnected before open", async () => {
    const gateway = new GatewayWeb();
    const connecting = gateway.connect({ url: "ws://localhost:1234" });
    const rejected = expect(connecting).rejects.toThrow("Client disconnect");

    await gateway.disconnect();

    await rejected;
    expect(await gateway.isConnected()).toEqual({ connected: false });
  });
});
