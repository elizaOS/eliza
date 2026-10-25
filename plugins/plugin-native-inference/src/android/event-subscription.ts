/**
 * Live agent-event feed over the private Android IPC (`events_subscribe`).
 *
 * The port-free Android app has no WebSocket, so the `agent_event` envelopes
 * the API server broadcasts to WS clients (for example the ephemeral
 * `voice-transcript` stream: speech-start | partial | final | error) need
 * their own path across the app <-> agent socket. One subscription is one
 * long-lived connection:
 *
 *   in:  {"id","method":"events_subscribe","payload":{"streams":[..],"headers":{"Authorization":"Bearer .."}}}
 *   out: {"id","event":"subscribed","streams":[..]}            once, first
 *        {"id","event":"agent_event","data":<envelope>}        per matching event
 *        {"id","event":"keepalive"}                            every EVENT_KEEPALIVE_MS
 *        {"id","event":"error","error":".."}                   terminal refusal, then close
 *
 * `<envelope>` is the WS `agent_event` shape: {type:"agent_event",version:1,
 * eventId,ts,runId,seq,stream,sessionKey?,agentId?,roomId?,payload}. Streams in
 * the ephemeral set carry `ephemeral:true` and an `eph-<n>` id, as on WS.
 *
 * Delivery contract:
 * - Live only. Nothing is buffered for replay: a subscriber sees events
 *   emitted after its `subscribed` frame and nothing earlier, and an
 *   `eventId` here is never a replay cursor (no `bufferSeq`).
 * - Exact-match stream filter, required. Unfiltered feeds are refused.
 * - Bounded. Each frame is capped at EVENT_FRAME_BYTE_LIMIT. An oversized or
 *   unserializable event ends the feed with an explicit error; the queued
 *   bytes on the transport are capped at EVENT_QUEUE_BYTE_LIMIT, past which
 *   the subscriber is disconnected. A client that sees the feed end
 *   resubscribes; there is no gap recovery by design.
 * - No content logging. Event payloads (transcript text) are never written to
 *   any log here; only counts are observable.
 */
import type {
  PrivateConnection,
  PrivateSubscribeFrame,
} from "./private-ipc.ts";

/** Largest single event frame written to a subscriber. */
export const EVENT_FRAME_BYTE_LIMIT = 256 * 1024;
/** Queued, unread bytes after which a slow subscriber is disconnected. */
export const EVENT_QUEUE_BYTE_LIMIT = 1024 * 1024;
/** Keepalive cadence so the app can detect a stalled or vanished agent. */
export const EVENT_KEEPALIVE_MS = 15_000;
/**
 * Fallback when the agent module does not export its ephemeral stream set.
 * Kept in sync with `EPHEMERAL_AGENT_EVENT_STREAMS` in `@elizaos/agent`.
 */
export const DEFAULT_EPHEMERAL_AGENT_EVENT_STREAMS: ReadonlySet<string> =
  new Set(["voice-transcript"]);

/** One AgentEventService bus event (structural; see `@elizaos/core`). */
export interface AgentEventBusEvent {
  runId: string;
  seq: number;
  stream: string;
  ts: number;
  data: Record<string, unknown>;
  sessionKey?: string;
  agentId?: string;
  roomId?: string;
}

/** The slice of AgentEventService a subscription uses. */
export interface AgentEventBus {
  subscribe(listener: (event: AgentEventBusEvent) => void): () => void;
}

const AGENT_EVENT_SERVICE_TYPES = ["agent_event", "AGENT_EVENT"] as const;

/** Resolve the runtime's AgentEventService, or null when it is not loaded. */
export function resolveAgentEventBus(runtime: {
  getService(serviceType: string): unknown;
}): AgentEventBus | null {
  for (const serviceType of AGENT_EVENT_SERVICE_TYPES) {
    const service = runtime.getService?.(serviceType);
    if (service && typeof (service as AgentEventBus).subscribe === "function") {
      return service as AgentEventBus;
    }
  }
  return null;
}

function headerValue(
  headers: Record<string, string> | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name && typeof value === "string") return value;
  }
  return undefined;
}

function secretsEqual(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/**
 * Subscriptions always require the per-boot bearer (`ELIZA_API_TOKEN`), like
 * the wake route: the socket is owner-only, and the token additionally binds
 * the feed to the app instance that started this agent.
 */
export function subscriptionAuthorized(
  headers: Record<string, string> | undefined,
  expectedToken: string | undefined,
): boolean {
  const expected = expectedToken?.trim();
  const authorization = headerValue(headers, "authorization");
  const presented = authorization?.toLowerCase().startsWith("bearer ")
    ? authorization.slice(7).trim()
    : null;
  return Boolean(expected && presented && secretsEqual(presented, expected));
}

let ipcEventCounter = 0;
let ephemeralEventCounter = 0;

/** Build the WS-shaped `agent_event` envelope for one bus event. */
export function buildIpcAgentEventEnvelope(
  event: AgentEventBusEvent,
  ephemeral: boolean,
): Record<string, unknown> {
  const eventId = ephemeral
    ? `eph-${++ephemeralEventCounter}`
    : `ipc-${++ipcEventCounter}`;
  return {
    type: "agent_event",
    version: 1,
    eventId,
    ts: event.ts,
    runId: event.runId,
    seq: event.seq,
    stream: event.stream,
    ...(event.sessionKey !== undefined ? { sessionKey: event.sessionKey } : {}),
    ...(event.agentId !== undefined ? { agentId: event.agentId } : {}),
    ...(event.roomId !== undefined ? { roomId: event.roomId } : {}),
    payload: event.data,
    ...(ephemeral ? { ephemeral: true } : {}),
  };
}

export interface ServeSubscriptionOptions {
  frame: PrivateSubscribeFrame;
  connection: PrivateConnection;
  /** Null when the runtime has no AgentEventService. */
  bus: AgentEventBus | null;
  /** The per-boot `ELIZA_API_TOKEN`; unset refuses every subscription. */
  expectedToken: string | undefined;
  ephemeralStreams?: ReadonlySet<string>;
  keepaliveMs?: number;
  frameByteLimit?: number;
  queueByteLimit?: number;
}

/**
 * Serve one subscription until the peer closes, the queue overflows, or the
 * server stops. Resolves in every case; the IPC server then ends the socket.
 */
export async function serveAgentEventSubscription(
  options: ServeSubscriptionOptions,
): Promise<void> {
  const { frame, connection } = options;
  const id =
    typeof frame.id === "string" || typeof frame.id === "number"
      ? frame.id
      : null;
  const ephemeralStreams =
    options.ephemeralStreams ?? DEFAULT_EPHEMERAL_AGENT_EVENT_STREAMS;
  const frameLimit = options.frameByteLimit ?? EVENT_FRAME_BYTE_LIMIT;
  const queueLimit = options.queueByteLimit ?? EVENT_QUEUE_BYTE_LIMIT;
  const refuse = (error: string) => {
    try {
      connection.writeLine(JSON.stringify({ id, event: "error", error }));
    } catch {
      // error-policy:J6 the peer is already gone; nothing to tell it.
    }
  };
  if (!subscriptionAuthorized(frame.payload.headers, options.expectedToken)) {
    refuse("Unauthorized");
    return;
  }
  const bus = options.bus;
  if (!bus) {
    refuse("Agent event service unavailable");
    return;
  }
  if (connection.aborted.aborted) return;
  const streams = new Set(frame.payload.streams);
  let open = true;
  let unsubscribe: (() => void) | null = null;
  let keepalive: ReturnType<typeof setInterval> | undefined;
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  const finish = () => {
    if (!open) return;
    open = false;
    clearInterval(keepalive);
    connection.aborted.removeEventListener("abort", finish);
    unsubscribe?.();
    unsubscribe = null;
    resolveDone();
  };
  /** Write one serialized frame within the queue bound; overflow disconnects. */
  const send = (line: string): void => {
    if (!open) return;
    if (connection.bufferedBytes + Buffer.byteLength(line) + 1 > queueLimit) {
      // A subscriber that stopped reading loses its feed, never agent memory.
      finish();
      connection.destroy();
      return;
    }
    try {
      connection.writeLine(line);
    } catch {
      finish();
    }
  };
  connection.aborted.addEventListener("abort", finish, { once: true });
  // Acknowledge, then attach in the same tick: bus delivery is synchronous,
  // so no event can fall between the two, and nothing earlier is replayed.
  send(JSON.stringify({ id, event: "subscribed", streams: [...streams] }));
  if (!open) return;
  unsubscribe = bus.subscribe((event) => {
    // A bus listener must never throw into the emitter or other listeners.
    try {
      if (!open || !event || !streams.has(event.stream)) return;
      let line = "";
      try {
        line = JSON.stringify({
          id,
          event: "agent_event",
          data: buildIpcAgentEventEnvelope(
            event,
            ephemeralStreams.has(event.stream),
          ),
        });
      } catch {
        // Unserializable payload: explicitly refuse this feed below.
      }
      if (!line || Buffer.byteLength(line) > frameLimit) {
        send(
          JSON.stringify({
            id,
            event: "error",
            error: line
              ? "Agent event exceeds frame limit; feed incomplete"
              : "Agent event cannot be serialized; feed incomplete",
          }),
        );
        finish();
        return;
      }
      send(line);
    } catch {
      // error-policy:J6 delivery is observational; the bus keeps running.
    }
  });
  keepalive = setInterval(
    () => send(JSON.stringify({ id, event: "keepalive" })),
    options.keepaliveMs ?? EVENT_KEEPALIVE_MS,
  );
  keepalive.unref?.();
  await done;
}
