import { describe, expect, it, vi } from "vitest";
import {
  TunnelToMobileClient,
  type WebSocketInstanceLike,
  type WebSocketLike,
} from "./tunnel-to-mobile-client";

/**
 * Minimal fake WebSocket that records sent frames and lets the test
 * trigger lifecycle events synchronously. Mirrors the shape of the
 * browser `WebSocket` interface used by the client.
 */
class FakeSocket {
  public readyState = 0;
  public sent: string[] = [];
  private readonly listeners = new Map<
    string,
    Array<(event: unknown) => void>
  >();
  constructor(public readonly url: string) {}
  addEventListener(type: string, listener: (event: unknown) => void): void {
    const bucket = this.listeners.get(type) ?? [];
    bucket.push(listener);
    this.listeners.set(type, bucket);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
    this.fire("close", { code: 1000, reason: "" });
  }
  fire(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
  open(): void {
    this.readyState = 1;
    this.fire("open", undefined);
  }
}

function makeCtor(): {
  ctor: WebSocketLike;
  instances: FakeSocket[];
} {
  const instances: FakeSocket[] = [];
  const ctor = function (this: FakeSocket, url: string) {
    const socket = new FakeSocket(url);
    instances.push(socket);
    return socket as unknown as WebSocketInstanceLike;
  } as unknown as WebSocketLike;
  return { ctor, instances };
}

function requireInstance(instances: FakeSocket[], index = 0): FakeSocket {
  const socket = instances[index];
  if (!socket) {
    throw new Error(`Expected fake socket instance ${index}`);
  }
  return socket;
}

describe("TunnelToMobileClient", () => {
  it("dials the relay URL with deviceId and pairing token", () => {
    const { ctor, instances } = makeCtor();
    const client = TunnelToMobileClient.start({
      relayUrl: "wss://relay.example.test/v1",
      remoteDeviceId: "phone-1",
      pairingToken: "tok-abc",
      onFrame: () => {},
      webSocketCtor: ctor,
    });
    expect(instances).toHaveLength(1);
    const url = new URL(requireInstance(instances).url);
    expect(url.searchParams.get("deviceId")).toBe("phone-1");
    expect(url.searchParams.get("token")).toBe("tok-abc");
    client.stop();
  });

  it("emits state transitions and sends a register frame on open", () => {
    const states: string[] = [];
    const { ctor, instances } = makeCtor();
    const client = TunnelToMobileClient.start({
      relayUrl: "wss://relay.example.test/v1",
      remoteDeviceId: "phone-2",
      onFrame: () => {},
      onStateChange: (s) => states.push(s),
      webSocketCtor: ctor,
    });
    expect(states).toContain("connecting");
    const socket = requireInstance(instances);
    socket.open();
    expect(states).toContain("connected");
    expect(socket.sent).toHaveLength(1);
    const sentFrame = socket.sent[0];
    if (!sentFrame) throw new Error("Expected registration frame");
    const frame = JSON.parse(sentFrame);
    expect(frame).toMatchObject({
      type: "tunnel.register",
      role: "mac-client",
      remoteDeviceId: "phone-2",
    });
    client.stop();
  });

  it("delivers parsed frames to the onFrame handler and tolerates bad JSON", () => {
    const onFrame = vi.fn();
    const { ctor, instances } = makeCtor();
    const client = TunnelToMobileClient.start({
      relayUrl: "wss://relay.example.test/v1",
      remoteDeviceId: "phone-3",
      onFrame,
      webSocketCtor: ctor,
    });
    const socket = requireInstance(instances);
    socket.open();
    socket.fire("message", { data: '{"type":"hello"}' });
    socket.fire("message", { data: "not json" });
    expect(onFrame).toHaveBeenCalledTimes(1);
    expect(onFrame.mock.calls[0]?.[0]).toEqual({ type: "hello" });
    client.stop();
  });

  it("rejects construction without a WebSocket implementation", () => {
    const previous = (globalThis as { WebSocket?: unknown }).WebSocket;
    (globalThis as { WebSocket?: unknown }).WebSocket = undefined;
    try {
      expect(
        () =>
          new TunnelToMobileClient({
            relayUrl: "wss://relay.example.test/v1",
            remoteDeviceId: "phone-4",
            onFrame: () => {},
          }),
      ).toThrow(/requires a WebSocket implementation/);
    } finally {
      (globalThis as { WebSocket?: unknown }).WebSocket = previous;
    }
  });
});
