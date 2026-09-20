/**
 * Covers WebSocket fan-out backpressure and liveness in the API event hub. The
 * fan-out case runs a real `ws` server and two real `ws` clients over loopback,
 * one of which stops reading its socket: the server-side send buffer for it
 * must stay bounded, it must be terminated and unregistered, and the healthy
 * client must still receive every message. The buffer thresholds and the
 * ping/pong sweep are exercised deterministically against scripted sockets,
 * the sweep under fake timers.
 */
import { once } from "node:events";
import type { Socket } from "node:net";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import {
  createApiEventHub,
  createEventSocketLivenessSweep,
  EVENT_SOCKET_BACKPRESSURE_GRACE_MS,
  EVENT_SOCKET_BACKPRESSURE_HARD_LIMIT_BYTES,
  EVENT_SOCKET_BACKPRESSURE_SOFT_LIMIT_BYTES,
  type EventSocket,
  type LivenessSocket,
} from "./event-hub.ts";

const BROADCASTS = 2000;
const CHUNK_BYTES = 30 * 1024;

async function waitFor(
  predicate: () => boolean,
  description: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${description}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

function listeningPort(server: WebSocketServer): number {
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("WebSocket server is not bound to a TCP port");
  }
  return address.port;
}

/** Connects a client and resolves with both ends once the handshake completes. */
async function connectPair(
  server: WebSocketServer,
  port: number,
): Promise<{ client: WebSocket; serverSide: WebSocket; raw: Socket }> {
  const client = new WebSocket(`ws://127.0.0.1:${port}`);
  let raw: Socket | null = null;
  client.on("upgrade", (response) => {
    raw = response.socket;
  });
  const [[serverSide]] = await Promise.all([
    once(server, "connection") as Promise<[WebSocket]>,
    once(client, "open"),
  ]);
  if (!raw) throw new Error("client never saw the upgrade response");
  return { client, serverSide, raw };
}

interface ScriptedSocket extends EventSocket, LivenessSocket {
  readyState: number;
  bufferedAmount: number;
  sent: string[];
  ping: Mock<() => void>;
  terminate: Mock<() => void>;
  emit(event: "pong" | "close"): void;
}

function scriptedSocket(bufferedAmount = 0): ScriptedSocket {
  const listeners: Record<string, Array<() => void>> = {};
  const socket: ScriptedSocket = {
    readyState: 1,
    bufferedAmount,
    sent: [],
    send(message: string) {
      socket.sent.push(message);
    },
    ping: vi.fn<() => void>(),
    terminate: vi.fn<() => void>(() => {
      socket.readyState = 3;
    }),
    on(event: "pong" | "close", listener: () => void) {
      const registered = listeners[event] ?? [];
      registered.push(listener);
      listeners[event] = registered;
      return socket;
    },
    emit(event) {
      for (const listener of listeners[event] ?? []) listener();
    },
  };
  return socket;
}

describe("event hub backpressure", () => {
  const openServers: WebSocketServer[] = [];
  const openClients: WebSocket[] = [];

  afterEach(async () => {
    vi.useRealTimers();
    for (const client of openClients.splice(0)) client.terminate();
    for (const server of openServers.splice(0)) {
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("bounds the send buffer of a client that stops reading, terminates and unregisters it, and still delivers everything to a healthy client", async () => {
    const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    openServers.push(server);
    await once(server, "listening");
    const port = listeningPort(server);

    const clients = new Set<WebSocket>();
    const clientIds = new WeakMap<WebSocket, string>();
    server.on("connection", (socket) => {
      clients.add(socket);
      clientIds.set(socket, `client-${clients.size}`);
      socket.on("close", () => clients.delete(socket));
    });

    let clock = 0;
    const sendErrors: unknown[] = [];
    const hub = createApiEventHub({
      state: { eventBuffer: [], nextEventId: 1 },
      clients,
      clientIds,
      activeConversations: new WeakMap(),
      reportSendError: (error) => sendErrors.push(error),
      now: () => clock,
    });

    const stalled = await connectPair(server, port);
    openClients.push(stalled.client);
    stalled.raw.pause();

    const healthy = await connectPair(server, port);
    openClients.push(healthy.client);
    let healthyReceived = 0;
    healthy.client.on("message", () => {
      healthyReceived += 1;
    });
    expect(clients.size).toBe(2);

    const chunk = "x".repeat(CHUNK_BYTES);
    let maxStalledBuffered = 0;
    let maxHealthyBuffered = 0;
    for (let seq = 0; seq < BROADCASTS; seq += 1) {
      hub.broadcast({ type: "stream-chunk", seq, chunk });
      maxStalledBuffered = Math.max(
        maxStalledBuffered,
        stalled.serverSide.bufferedAmount,
      );
      maxHealthyBuffered = Math.max(
        maxHealthyBuffered,
        healthy.serverSide.bufferedAmount,
      );
      clock += 100;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    // The stalled peer may be handed at most one message past the soft cap
    // before the hub stops sending to it; the hard cap is never approached.
    expect(maxStalledBuffered).toBeLessThan(
      EVENT_SOCKET_BACKPRESSURE_SOFT_LIMIT_BYTES + 2 * CHUNK_BYTES,
    );
    expect(maxStalledBuffered).toBeLessThan(
      EVENT_SOCKET_BACKPRESSURE_HARD_LIMIT_BYTES,
    );
    expect(maxHealthyBuffered).toBeLessThan(
      EVENT_SOCKET_BACKPRESSURE_SOFT_LIMIT_BYTES,
    );
    expect(clients.has(stalled.serverSide)).toBe(false);
    await waitFor(
      () => stalled.serverSide.readyState === WebSocket.CLOSED,
      "the stalled server socket to close",
    );
    await waitFor(
      () => healthyReceived === BROADCASTS,
      `the healthy client to receive ${BROADCASTS} messages (got ${healthyReceived})`,
    );
    expect(clients.has(healthy.serverSide)).toBe(true);
    expect(healthy.serverSide.readyState).toBe(WebSocket.OPEN);
    expect(sendErrors).toEqual([]);
  });

  it("skips a peer above the soft cap, terminates it after the grace period, and terminates a peer above the hard cap at once", () => {
    let clock = 1_000;
    const draining = scriptedSocket(0);
    const slow = scriptedSocket(EVENT_SOCKET_BACKPRESSURE_SOFT_LIMIT_BYTES + 1);
    const frozen = scriptedSocket(
      EVENT_SOCKET_BACKPRESSURE_HARD_LIMIT_BYTES + 1,
    );
    const clients = new Set<ScriptedSocket>([draining, slow, frozen]);
    const hub = createApiEventHub({
      state: { eventBuffer: [], nextEventId: 1 },
      clients,
      clientIds: new WeakMap(),
      activeConversations: new WeakMap(),
      reportSendError: (error) => {
        throw error;
      },
      now: () => clock,
    });

    hub.broadcast({ type: "first" });
    expect(draining.sent).toHaveLength(1);
    expect(slow.sent).toHaveLength(0);
    expect(slow.terminate).not.toHaveBeenCalled();
    expect(frozen.sent).toHaveLength(0);
    expect(frozen.terminate).toHaveBeenCalledTimes(1);
    expect(clients.has(frozen)).toBe(false);

    clock += EVENT_SOCKET_BACKPRESSURE_GRACE_MS - 1;
    hub.broadcast({ type: "second" });
    expect(slow.sent).toHaveLength(0);
    expect(slow.terminate).not.toHaveBeenCalled();
    expect(clients.has(slow)).toBe(true);

    clock += 1;
    hub.broadcast({ type: "third" });
    expect(slow.terminate).toHaveBeenCalledTimes(1);
    expect(clients.has(slow)).toBe(false);
    expect(draining.sent).toHaveLength(3);
    expect(draining.terminate).not.toHaveBeenCalled();
  });

  it("forgives a peer that drains back under the soft cap within the grace period", () => {
    let clock = 0;
    const socket = scriptedSocket(
      EVENT_SOCKET_BACKPRESSURE_SOFT_LIMIT_BYTES + 1,
    );
    const clients = new Set<ScriptedSocket>([socket]);
    const hub = createApiEventHub({
      state: { eventBuffer: [], nextEventId: 1 },
      clients,
      clientIds: new WeakMap(),
      activeConversations: new WeakMap(),
      reportSendError: (error) => {
        throw error;
      },
      now: () => clock,
    });

    expect(hub.sendToClient("nobody", { type: "ignored" })).toBe(0);
    hub.broadcast({ type: "skipped" });
    expect(socket.sent).toHaveLength(0);

    socket.bufferedAmount = 0;
    clock += EVENT_SOCKET_BACKPRESSURE_GRACE_MS - 1;
    hub.broadcast({ type: "delivered" });
    expect(socket.sent).toHaveLength(1);

    socket.bufferedAmount = EVENT_SOCKET_BACKPRESSURE_SOFT_LIMIT_BYTES + 1;
    clock += EVENT_SOCKET_BACKPRESSURE_GRACE_MS;
    hub.broadcast({ type: "skipped-again" });
    expect(socket.sent).toHaveLength(1);
    expect(socket.terminate).not.toHaveBeenCalled();
    expect(clients.has(socket)).toBe(true);
  });

  it("pings tracked sockets every interval and terminates peers that did not answer", () => {
    vi.useFakeTimers();
    const sweep = createEventSocketLivenessSweep<ScriptedSocket>({
      intervalMs: 30_000,
      clientIds: new WeakMap(),
    });
    const responsive = scriptedSocket();
    const silent = scriptedSocket();
    const closed = scriptedSocket();
    sweep.track(responsive);
    sweep.track(silent);
    sweep.track(closed);
    expect(sweep.size).toBe(3);

    closed.readyState = 3;
    closed.emit("close");
    expect(sweep.size).toBe(2);

    vi.advanceTimersByTime(30_000);
    expect(responsive.ping).toHaveBeenCalledTimes(1);
    expect(silent.ping).toHaveBeenCalledTimes(1);
    expect(closed.ping).not.toHaveBeenCalled();
    expect(silent.terminate).not.toHaveBeenCalled();

    responsive.emit("pong");
    vi.advanceTimersByTime(30_000);
    expect(silent.terminate).toHaveBeenCalledTimes(1);
    expect(responsive.terminate).not.toHaveBeenCalled();
    expect(responsive.ping).toHaveBeenCalledTimes(2);
    expect(sweep.size).toBe(1);

    sweep.stop();
    vi.advanceTimersByTime(90_000);
    expect(responsive.ping).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});
