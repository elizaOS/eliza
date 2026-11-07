/**
 * App-side client for the live agent-event feed over the private Android IPC
 * (`Agent.subscribeEvents` → `agentEvent`). This is the port-free substitute
 * for the WS `agent_event` broadcast, e.g. ephemeral `voice-transcript`
 * events (speech-start | partial | final | error).
 *
 * Contract:
 * - Live only. A subscription sees events emitted after it is acknowledged;
 *   nothing is replayed. When the feed ends with an error the caller should
 *   resubscribe and treat any in-progress turn as unknown.
 * - Filtered. Only envelopes whose `stream` was requested are delivered.
 * - Never logs envelopes: ephemeral payloads (transcript text) stay in memory.
 */
import type {
  AgentEventEnvelope,
  AgentEventFeedEvent,
  AgentPlugin,
  AgentPluginListenerHandle,
} from "./definitions.js";

export interface AgentEventHandlers {
  /** One matching `agent_event` envelope, in agent emission order. */
  onEvent(envelope: AgentEventEnvelope): void;
  /** The agent skipped `count` (cumulative) events larger than its frame cap. */
  onDropped?(count: number): void;
  /** Terminal. `error` is undefined only after `close()`. Called exactly once. */
  onEnd?(error?: string): void;
}

export interface AgentEventSubscription {
  readonly subscriptionId: string;
  /** Settles once with the terminal error (undefined after `close()`). */
  readonly ended: Promise<string | undefined>;
  /** End the feed. Idempotent. */
  close(): Promise<void>;
}

type FeedPlugin = Pick<
  AgentPlugin,
  "subscribeEvents" | "unsubscribeEvents" | "addListener"
>;

/** True when this platform's Agent plugin exposes the IPC event feed. */
export function supportsAgentEvents(agent: Partial<FeedPlugin>): boolean {
  return (
    typeof agent.subscribeEvents === "function" &&
    typeof agent.unsubscribeEvents === "function" &&
    typeof agent.addListener === "function"
  );
}

function newSubscriptionId(): string {
  const cryptoRef = globalThis.crypto;
  if (cryptoRef?.randomUUID) return cryptoRef.randomUUID();
  const bytes = new Uint8Array(16);
  cryptoRef.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function isEnvelope(value: unknown): value is AgentEventEnvelope {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    v.type === "agent_event" &&
    typeof v.stream === "string" &&
    typeof v.eventId === "string" &&
    !!v.payload &&
    typeof v.payload === "object"
  );
}

/**
 * Subscribe to live agent events by stream name. Rejects when the platform
 * has no IPC feed (check `supportsAgentEvents` first) or the native side
 * refuses the request (then `onEnd` is not called); afterwards every outcome,
 * including an agent-side refusal such as `Unauthorized`, arrives through
 * `handlers`.
 */
export async function subscribeAgentEvents(
  agent: FeedPlugin,
  options: { streams: string[]; signal?: AbortSignal },
  handlers: AgentEventHandlers,
): Promise<AgentEventSubscription> {
  if (!supportsAgentEvents(agent)) {
    throw new Error("Agent event feed is unavailable on this platform");
  }
  const subscribe = agent.subscribeEvents as NonNullable<
    FeedPlugin["subscribeEvents"]
  >;
  const unsubscribe = agent.unsubscribeEvents as NonNullable<
    FeedPlugin["unsubscribeEvents"]
  >;
  const addListener = agent.addListener as (
    eventName: "agentEvent",
    listener: (event: AgentEventFeedEvent) => void,
  ) => Promise<AgentPluginListenerHandle> | AgentPluginListenerHandle;
  options.signal?.throwIfAborted();
  const streams = new Set(options.streams);
  const subscriptionId = newSubscriptionId();
  let finished = false;
  let closing = false;
  let closePromise: Promise<void> | undefined;
  let settleStart!: () => void;
  const started = new Promise<void>((resolve) => {
    settleStart = resolve;
  });
  let listener: AgentPluginListenerHandle | undefined;
  let resolveEnded!: (error: string | undefined) => void;
  const ended = new Promise<string | undefined>((resolve) => {
    resolveEnded = resolve;
  });
  const guard = (fn: () => void) => {
    try {
      fn();
    } catch {
      // A throwing handler must not wedge the feed or the bridge.
    }
  };
  const detach = () => {
    const current = listener;
    listener = undefined;
    if (current) void current.remove().catch(() => {});
  };
  const finish = (error: string | undefined) => {
    if (finished) return;
    finished = true;
    options.signal?.removeEventListener("abort", onAbort);
    detach();
    guard(() => handlers.onEnd?.(error));
    resolveEnded(error);
  };
  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    if (finished) return Promise.resolve();
    closing = true;
    closePromise = (async () => {
      // Cancellation cannot overtake native registration and leave a new feed
      // behind after unsubscribe already reported that the id was absent.
      await started;
      try {
        await unsubscribe({ subscriptionId });
        finish(undefined);
      } catch (error) {
        finish("Agent event unsubscribe failed; native cleanup is unconfirmed");
        throw error;
      }
    })();
    return closePromise;
  };
  const onAbort = () => {
    // close reports the failure through onEnd/ended; an AbortSignal listener
    // cannot return a promise to its caller.
    void close().catch(() => {});
  };
  // Listen before subscribing: the caller-chosen id matches events that the
  // native side emits before `subscribeEvents` resolves.
  listener = await addListener("agentEvent", (event) => {
    if (finished || !event || event.subscriptionId !== subscriptionId) return;
    switch (event.type) {
      case "event":
        if (
          !closing &&
          isEnvelope(event.event) &&
          streams.has(event.event.stream)
        ) {
          const envelope = event.event;
          guard(() => handlers.onEvent(envelope));
        }
        return;
      case "dropped":
        if (typeof event.count === "number") {
          const count = event.count;
          guard(() => handlers.onDropped?.(count));
        }
        return;
      case "end":
        finish(
          typeof event.error === "string"
            ? event.error
            : closing
              ? undefined
              : "Agent event feed ended",
        );
        return;
      default:
        return;
    }
  });
  options.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    options.signal?.throwIfAborted();
    const ack = await subscribe({ streams: [...streams], subscriptionId });
    if (ack?.subscriptionId !== subscriptionId) {
      throw new Error("Agent event subscription identity changed");
    }
  } catch (error) {
    // Refused before the feed started: the caller gets the rejection and
    // `onEnd` is not called.
    options.signal?.removeEventListener("abort", onAbort);
    finished = true;
    detach();
    resolveEnded(error instanceof Error ? error.message : String(error));
    void unsubscribe({ subscriptionId }).catch(() => {});
    throw error;
  } finally {
    settleStart();
  }
  if (options.signal?.aborted) await close();
  return { subscriptionId, ended, close };
}
