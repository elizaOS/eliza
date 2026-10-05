/**
 * Behavior tests for SessionClient over a fake WebSocket: asserts the
 * constructed ingress URL (with `?token=`), listener wiring, and how
 * open/close/error/message events drive connection state and input relay.
 */

import { describe, expect, it, vi } from "vitest";
import { type InputEvent, SessionClient } from "./session-client";

// Minimal fake WebSocket: records the constructed URL, captures listeners, and
// lets the test drive open/close/error/message events synchronously.
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  url: string;
  sent: string[] = [];
  closed = false;
  private listeners = new Map<string, Set<(ev: unknown) => void>>();

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  addEventListener(type: string, handler: (ev: unknown) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)?.add(handler);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
  emit(type: string, ev: unknown = {}): void {
    for (const handler of this.listeners.get(type) ?? []) handler(ev);
  }
}

function makeClient() {
  FakeWebSocket.instances = [];
  const factory = vi.fn((url: string) => new FakeWebSocket(url) as never);
  const client = new SessionClient(factory);
  return { client, factory };
}

describe("SessionClient lifecycle", () => {
  it("appends ?token= to the ingress URL and emits connecting then open", () => {
    const { client } = makeClient();
    const states: string[] = [];
    client.on("state", (s) => states.push(s));

    client.connect("wss://relay.example/input", "tok-1");
    expect(states).toEqual(["connecting"]);
    expect(client.getState()).toBe("connecting");

    const socket = FakeWebSocket.instances[0];
    expect(new URL(socket.url).searchParams.get("token")).toBe("tok-1");

    socket.emit("open");
    expect(states).toEqual(["connecting", "open"]);
    expect(client.getState()).toBe("open");
  });

  it("drops sendInput before the socket is open and sends JSON once open", () => {
    const { client } = makeClient();
    const event: InputEvent = {
      type: "mouse-click",
      x: 5,
      y: 6,
      button: "left",
    };

    client.connect("wss://relay.example/input", "tok-1");
    const socket = FakeWebSocket.instances[0];

    // Not open yet -> dropped.
    client.sendInput(event);
    expect(socket.sent).toEqual([]);

    socket.emit("open");
    client.sendInput(event);
    expect(socket.sent).toEqual([JSON.stringify(event)]);
  });

  it("transitions to closed on close() and closes the underlying socket", () => {
    const { client } = makeClient();
    const states: string[] = [];
    client.on("state", (s) => states.push(s));

    client.connect("wss://relay.example/input", "tok-1");
    const socket = FakeWebSocket.instances[0];
    socket.emit("open");

    client.close();
    expect(socket.closed).toBe(true);
    expect(client.getState()).toBe("closed");
    expect(states).toEqual(["connecting", "open", "closed"]);
  });

  it("emits a remote close event as a closed state transition", () => {
    const { client } = makeClient();
    const states: string[] = [];
    client.on("state", (s) => states.push(s));

    client.connect("wss://relay.example/input", "tok-1");
    const socket = FakeWebSocket.instances[0];
    socket.emit("open");
    socket.emit("close", { code: 1000, wasClean: true });

    expect(client.getState()).toBe("closed");
    expect(states).toEqual(["connecting", "open", "closed"]);
  });

  it("notifies error listeners on a socket error event", () => {
    const { client } = makeClient();
    const errors: Error[] = [];
    client.on("error", (e) => errors.push(e));

    client.connect("wss://relay.example/input", "tok-1");
    FakeWebSocket.instances[0].emit("error");

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(Error);
  });

  it("forwards inbound messages to message listeners", () => {
    const { client } = makeClient();
    const messages: unknown[] = [];
    client.on("message", (m) => messages.push(m));

    client.connect("wss://relay.example/input", "tok-1");
    const socket = FakeWebSocket.instances[0];
    socket.emit("open");
    socket.emit("message", { data: "hello" });

    expect(messages).toEqual(["hello"]);
  });

  it("ignores a second connect while already connecting/open", () => {
    const { client, factory } = makeClient();
    client.connect("wss://relay.example/input", "tok-1");
    client.connect("wss://relay.example/input", "tok-2");
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("throws when the ingress URL is not absolute", () => {
    const { client } = makeClient();
    expect(() => client.connect("not-a-url", "tok-1")).toThrow();
  });
});
