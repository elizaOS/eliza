/**
 * Covers WebSocket fan-out backpressure and liveness in the API event hub. The
 * fan-out case runs a real `ws` server and two real `ws` clients over loopback,
 * one of which stops reading its socket: the server-side send buffer for it
 * must stay bounded by the soft limit plus one grace window of traffic, it
 * must be terminated and unregistered, and the healthy client must still
 * receive every message. The buffer thresholds, the no-gap guarantee for a
 * peer that survives a transient stall, and the ping/pong sweep are exercised
 * deterministically against scripted sockets, the sweep under fake timers.
 */
import { once } from "node:events";
import type { Socket } from "node:net";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import {
  createApiEventHub,
  createEventSocketBackpressureGuard,
  createEventSocketLivenessSweep,
  EVENT_SOCKET_BACKPRESSURE_GRACE_MS,
  EVENT_SOCKET_BACKPRESSURE_HARD_LIMIT_BYTES,
  EVENT_SOCKET_BACKPRESSURE_SOFT_LIMIT_BYTES,
  type EventSocket,
  type LivenessSocket,
} from "./event-hub.ts";

const BROADCASTS = 2000;
const CHUNK_BYTES = 30 * 1024;
/** Injected clock advance per broadcast in the real-socket case. */
const CLOCK_STEP_MS = 100;
/** JSON envelope plus WebSocket framing around one chunk, generously. */
const FRAME_OVERHEAD_BYTES = 1024;
/**
 * Frames a stalled peer can still be handed after crossing the soft limit:
 * the one that starts the stall clock, one per clock step until the grace
 * period elapses, plus the frame that pushed it over the limit in the first
 * place.
 */
const GRACE_WINDOW_FRAMES =
  EVENT_SOCKET_BACKPRESSURE_GRACE_MS / CLOCK_STEP_MS + 2;

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
      clock += CLOCK_STEP_MS;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    // The stalled peer keeps being sent every frame for one grace window after
    // it crosses the soft cap, then is terminated; its queue therefore grows
    // past the soft cap by at most that window's traffic and never approaches
    // the hard cap.
    expect(maxStalledBuffered).toBeGreaterThan(
      EVENT_SOCKET_BACKPRESSURE_SOFT_LIMIT_BYTES,
    );
    expect(maxStalledBuffered).toBeLessThan(
      EVENT_SOCKET_BACKPRESSURE_SOFT_LIMIT_BYTES +
        GRACE_WINDOW_FRAMES * (CHUNK_BYTES + FRAME_OVERHEAD_BYTES),
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

  it("keeps sending to a peer above the soft cap until the grace period expires and then terminates it, and terminates a peer above the hard cap at once", () => {
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
    expect(slow.sent).toHaveLength(1);
    expect(slow.terminate).not.toHaveBeenCalled();
    expect(frozen.sent).toHaveLength(0);
    expect(frozen.terminate).toHaveBeenCalledTimes(1);
    expect(clients.has(frozen)).toBe(false);

    clock += EVENT_SOCKET_BACKPRESSURE_GRACE_MS - 1;
    hub.broadcast({ type: "second" });
    expect(slow.sent).toHaveLength(2);
    expect(slow.terminate).not.toHaveBeenCalled();
    expect(clients.has(slow)).toBe(true);

    clock += 1;
    hub.broadcast({ type: "third" });
    expect(slow.sent).toHaveLength(2);
    expect(slow.terminate).toHaveBeenCalledTimes(1);
    expect(clients.has(slow)).toBe(false);
    expect(draining.sent).toHaveLength(3);
    expect(draining.terminate).not.toHaveBeenCalled();
  });

  it("delivers every frame to a peer that goes above the soft cap and drains back within the grace period", () => {
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
    hub.broadcast({ type: "over-soft-cap" });
    expect(socket.sent).toHaveLength(1);
    expect(socket.terminate).not.toHaveBeenCalled();

    socket.bufferedAmount = 0;
    clock += EVENT_SOCKET_BACKPRESSURE_GRACE_MS - 1;
    hub.broadcast({ type: "drained" });
    expect(socket.sent).toHaveLength(2);

    // Draining reset the stall clock, so re-crossing the soft cap long after
    // the first stall starts a fresh grace period instead of expiring one.
    socket.bufferedAmount = EVENT_SOCKET_BACKPRESSURE_SOFT_LIMIT_BYTES + 1;
    clock += EVENT_SOCKET_BACKPRESSURE_GRACE_MS;
    hub.broadcast({ type: "over-soft-cap-again" });
    expect(socket.sent).toHaveLength(3);
    expect(socket.terminate).not.toHaveBeenCalled();
    expect(clients.has(socket)).toBe(true);

    clock += EVENT_SOCKET_BACKPRESSURE_GRACE_MS - 1;
    hub.broadcast({ type: "still-within-grace" });
    expect(socket.sent).toHaveLength(4);
    expect(socket.terminate).not.toHaveBeenCalled();
    expect(clients.has(socket)).toBe(true);
    expect(socket.sent.map((frame) => JSON.parse(frame).type)).toEqual([
      "over-soft-cap",
      "drained",
      "over-soft-cap-again",
      "still-within-grace",
    ]);
  });

  it("never resumes a peer terminated for grace expiry, even after it drains", () => {
    let clock = 0;
    const socket = scriptedSocket(
      EVENT_SOCKET_BACKPRESSURE_SOFT_LIMIT_BYTES + 1,
    );
    const clients = new Set<ScriptedSocket>([socket]);
    const clientIds = new WeakMap<ScriptedSocket, string>([
      [socket, "client-1"],
    ]);
    const activeConversations = new WeakMap<ScriptedSocket, string>([
      [socket, "conversation-1"],
    ]);
    const hub = createApiEventHub({
      state: { eventBuffer: [], nextEventId: 1 },
      clients,
      clientIds,
      activeConversations,
      reportSendError: (error) => {
        throw error;
      },
      now: () => clock,
    });

    expect(hub.sendToClient("client-1", { type: "before" })).toBe(1);
    clock += EVENT_SOCKET_BACKPRESSURE_GRACE_MS;
    expect(hub.sendToClient("client-1", { type: "expiry" })).toBe(0);
    expect(socket.terminate).toHaveBeenCalledTimes(1);
    expect(clients.has(socket)).toBe(false);

    socket.bufferedAmount = 0;
    clock += EVENT_SOCKET_BACKPRESSURE_GRACE_MS;
    hub.broadcast({ type: "after-broadcast" });
    expect(hub.sendToClient("client-1", { type: "after-client" })).toBe(0);
    expect(
      hub.sendToConversation("conversation-1", { type: "after-conversation" }),
    ).toBe(0);
    expect(socket.sent).toHaveLength(1);
    expect(socket.terminate).toHaveBeenCalledTimes(1);
    expect(clients.has(socket)).toBe(false);
  });

  it("counts frames queued outside the transport toward the same hard limit", () => {
    const socket = scriptedSocket(1024);
    const clients = new Set<ScriptedSocket>([socket]);
    const admissionQueueBytes =
      EVENT_SOCKET_BACKPRESSURE_HARD_LIMIT_BYTES - socket.bufferedAmount + 1;
    const guard = createEventSocketBackpressureGuard({
      clients,
      clientIds: new WeakMap([[socket, "client-1"]]),
      reportSendError: (error) => {
        throw error;
      },
      getBufferedAmount: (candidate) =>
        candidate.bufferedAmount + admissionQueueBytes,
    });

    expect(guard.admit(socket)).toBe(false);
    expect(socket.terminate).toHaveBeenCalledTimes(1);
    expect(clients.has(socket)).toBe(false);
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
