/**
 * Buffers versioned server events and targets serialized payloads to connected
 * WebSocket clients. HTTP composition supplies connection ownership maps while
 * route and runtime code consume this small event boundary.
 *
 * Fan-out is bounded per peer: a socket whose send buffer is above the soft
 * limit is skipped, and it is terminated once it stays there for the grace
 * period or crosses the hard limit. A reconnecting client catches up through
 * the replay buffer, so skipping is loss-free for buffered events. The
 * liveness sweep pings every tracked socket on an interval and terminates the
 * ones that did not answer, which covers peers that stall without traffic.
 */
import { logger } from "@elizaos/core";
import type { StreamEventEnvelope } from "./server-types.ts";

export interface EventSocket {
  readonly readyState: number;
  /** Bytes queued on the transport that the peer has not yet acknowledged. */
  readonly bufferedAmount: number;
  send(message: string): void;
  /** Destroy the transport immediately without a close handshake. */
  terminate(): void;
}

export interface EventHubState {
  eventBuffer: StreamEventEnvelope[];
  nextEventId: number;
}

export interface ApiEventHub {
  broadcast(payload: unknown): void;
  publish(
    event: Omit<StreamEventEnvelope, "eventId" | "version" | "bufferSeq">,
  ): void;
  sendToClient(clientId: string, payload: unknown): number;
  sendToConversation(conversationId: string, payload: unknown): number;
}

/** Queued bytes above which the hub stops handing a peer new messages. */
export const EVENT_SOCKET_BACKPRESSURE_SOFT_LIMIT_BYTES = 4 * 1024 * 1024;
/** Queued bytes above which a peer is terminated on sight. */
export const EVENT_SOCKET_BACKPRESSURE_HARD_LIMIT_BYTES = 16 * 1024 * 1024;
/** How long a peer may stay above the soft limit before it is terminated. */
export const EVENT_SOCKET_BACKPRESSURE_GRACE_MS = 10_000;

export interface EventSocketBackpressure {
  softLimitBytes: number;
  hardLimitBytes: number;
  graceMs: number;
}

export function createApiEventHub<Socket extends EventSocket>(options: {
  state: EventHubState;
  clients: Set<Socket>;
  clientIds: WeakMap<Socket, string>;
  activeConversations: WeakMap<Socket, string>;
  reportSendError(error: unknown): void;
  /** A host may queue delivery for current admission; counts mean accepted sends. */
  sendMessage?(socket: Socket, message: string): void;
  maxBufferedEvents?: number;
  backpressure?: Partial<EventSocketBackpressure>;
  /** Clock used for the grace period; injectable for deterministic tests. */
  now?: () => number;
}): ApiEventHub {
  const limits: EventSocketBackpressure = {
    softLimitBytes:
      options.backpressure?.softLimitBytes ??
      EVENT_SOCKET_BACKPRESSURE_SOFT_LIMIT_BYTES,
    hardLimitBytes:
      options.backpressure?.hardLimitBytes ??
      EVENT_SOCKET_BACKPRESSURE_HARD_LIMIT_BYTES,
    graceMs:
      options.backpressure?.graceMs ?? EVENT_SOCKET_BACKPRESSURE_GRACE_MS,
  };
  const now = options.now ?? Date.now;
  // First moment each peer was observed above the soft limit; cleared as soon
  // as it drains back under it.
  const stalledSince = new WeakMap<Socket, number>();

  const dropClient = (
    client: Socket,
    reason: "hard-limit" | "grace-expired",
    bufferedAmount: number,
  ): void => {
    options.clients.delete(client);
    stalledSince.delete(client);
    logger.warn(
      {
        clientId: options.clientIds.get(client),
        reason,
        bufferedAmount,
        softLimitBytes: limits.softLimitBytes,
        hardLimitBytes: limits.hardLimitBytes,
        graceMs: limits.graceMs,
      },
      "[event-hub] terminating WebSocket client that stopped draining its send buffer",
    );
    try {
      client.terminate();
    } catch (error) {
      // error-policy:J6 best-effort teardown — the peer is already out of the
      // hub; a transport that fails to terminate is reported, not fatal.
      options.reportSendError(error);
    }
  };

  /** True when the peer may receive a message right now. */
  const admit = (client: Socket): boolean => {
    const bufferedAmount = client.bufferedAmount;
    if (bufferedAmount > limits.hardLimitBytes) {
      dropClient(client, "hard-limit", bufferedAmount);
      return false;
    }
    if (bufferedAmount > limits.softLimitBytes) {
      const at = now();
      const since = stalledSince.get(client);
      if (since === undefined) {
        stalledSince.set(client, at);
      } else if (at - since >= limits.graceMs) {
        dropClient(client, "grace-expired", bufferedAmount);
      }
      return false;
    }
    stalledSince.delete(client);
    return true;
  };

  const sendWhere = (
    payload: unknown,
    include: (socket: Socket) => boolean,
  ): number => {
    const message = JSON.stringify(payload);
    let delivered = 0;
    for (const client of [...options.clients]) {
      if (client.readyState !== 1 || !include(client)) continue;
      if (!admit(client)) continue;
      try {
        if (options.sendMessage) options.sendMessage(client, message);
        else client.send(message);
        delivered += 1;
      } catch (error) {
        options.reportSendError(error);
      }
    }
    return delivered;
  };

  return {
    broadcast(payload) {
      sendWhere(payload, () => true);
    },
    publish(event) {
      const sequence = options.state.nextEventId;
      const envelope: StreamEventEnvelope = {
        ...event,
        eventId: `evt-${sequence}`,
        bufferSeq: sequence,
        version: 1,
      };
      options.state.nextEventId += 1;
      options.state.eventBuffer.push(envelope);
      const maxBufferedEvents = options.maxBufferedEvents ?? 1_500;
      if (options.state.eventBuffer.length > maxBufferedEvents) {
        options.state.eventBuffer.splice(
          0,
          options.state.eventBuffer.length - maxBufferedEvents,
        );
      }
      sendWhere(envelope, () => true);
    },
    sendToClient(clientId, payload) {
      return sendWhere(
        payload,
        (client) => options.clientIds.get(client) === clientId,
      );
    },
    sendToConversation(conversationId, payload) {
      return sendWhere(
        payload,
        (client) => options.activeConversations.get(client) === conversationId,
      );
    },
  };
}

/** Interval between liveness pings; a peer has one interval to answer. */
export const EVENT_SOCKET_LIVENESS_INTERVAL_MS = 30_000;

export interface LivenessSocket {
  readonly readyState: number;
  ping(): void;
  terminate(): void;
  on(event: "pong", listener: () => void): unknown;
  on(event: "close", listener: () => void): unknown;
}

export interface EventSocketLivenessSweep<Socket extends LivenessSocket> {
  /** Start pinging `socket`; tracking ends when it closes or is terminated. */
  track(socket: Socket): void;
  /** Number of sockets currently tracked. */
  readonly size: number;
  /** Clear the interval and forget every socket without touching them. */
  stop(): void;
}

/**
 * Periodic ping/pong sweep over tracked sockets. Each tick terminates every
 * open socket that has not answered the previous tick's ping, then pings the
 * rest. The interval is unref'd so it never holds the process open; `stop`
 * must still be called on dispose so tests and shutdown do not leak it.
 */
export function createEventSocketLivenessSweep<
  Socket extends LivenessSocket,
>(options: {
  clientIds: WeakMap<Socket, string>;
  intervalMs?: number;
}): EventSocketLivenessSweep<Socket> {
  const intervalMs = options.intervalMs ?? EVENT_SOCKET_LIVENESS_INTERVAL_MS;
  const tracked = new Set<Socket>();
  const answered = new WeakSet<Socket>();

  const sweep = (): void => {
    for (const socket of [...tracked]) {
      if (socket.readyState !== 1) {
        if (socket.readyState === 3) tracked.delete(socket);
        continue;
      }
      if (!answered.has(socket)) {
        tracked.delete(socket);
        logger.warn(
          { clientId: options.clientIds.get(socket), intervalMs },
          "[event-hub] terminating WebSocket client that did not answer a ping",
        );
        socket.terminate();
        continue;
      }
      answered.delete(socket);
      socket.ping();
    }
  };

  const timer = setInterval(sweep, intervalMs);
  timer.unref?.();

  return {
    track(socket) {
      tracked.add(socket);
      answered.add(socket);
      socket.on("pong", () => {
        answered.add(socket);
      });
      socket.on("close", () => {
        tracked.delete(socket);
      });
    },
    get size() {
      return tracked.size;
    },
    stop() {
      clearInterval(timer);
      tracked.clear();
    },
  };
}
