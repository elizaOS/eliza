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
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;

  readyState = FakeWebSocket.CONNECTING;
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, Listener[]>();

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
    this.emit("close", { code, reason });
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit("open", {});
  }

  message(data: unknown): void {
    this.emit("message", { data });
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
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each([
    "",
    "https://example.test",
    "javascript:alert(1)",
    "not a url",
  ])("rejects invalid gateway URL %s before opening a socket", async (url) => {
    await expect(new GatewayWeb().connect({ url })).rejects.toThrow(
      /WebSocket URL|ws: or wss:/,
    );
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

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
  ])("reports dropped inbound frame ($label) instead of swallowing it", async ({
    raw,
    needle,
  }) => {
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
  });

  it.each([
    "",
    " spaces ",
    "../escape",
    "1bad",
  ])("rejects invalid RPC method %s before sending", async (method) => {
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
  });

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
});
