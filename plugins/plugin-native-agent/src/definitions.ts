/**
 * Shared TypeScript contract for the `Agent` Capacitor plugin, implemented
 * identically by the web fallback (`web.ts`) and the native iOS/Android
 * bridges. Defines the wire shape for lifecycle control (start/stop/status),
 * chat, the path-only HTTP proxy (`request`), and the streaming variant that
 * relays a response to the WebView incrementally via `agentStream*` events.
 */

export interface AgentStatus {
  state: "not_started" | "starting" | "running" | "stopped" | "error";
  agentName: string | null;
  port: number | null;
  startedAt: number | null;
  error: string | null;
}

export interface ChatResult {
  text: string;
  agentName: string;
}

export interface LocalAgentTokenResult {
  available: boolean;
  token: string | null;
}

export interface AgentStartOptions {
  /**
   * Optional API base for native shells that need an explicit endpoint.
   * Android local uses loopback; iOS local dev/sideload builds use the same
   * URL shape as a stable identity but route app requests through ITTP.
   */
  apiBase?: string;
  /** Runtime mode hint for native shells that cannot read WebView storage. */
  mode?: "remote-mac" | "cloud" | "cloud-hybrid" | "local" | string;
}

export interface AgentRequestOptions {
  method?: string;
  path: string;
  headers?: Record<string, string>;
  body?: string | null;
  timeoutMs?: number;
}

export interface AgentRequestResult {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
}

/** Handle returned by `addListener`; call `.remove()` to detach. */
export interface AgentPluginListenerHandle {
  remove: () => Promise<void>;
}

/** Acknowledgement of a started streaming request. */
export interface AgentStreamHandle {
  /** Correlates the `agentStream*` events for THIS request. */
  streamId: string;
}

/** First `agentStreamResponse` event — the response head, before any body. */
export interface AgentStreamResponseEvent {
  streamId: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
}

/** A body chunk as it arrives. `dataBase64` is the lossless raw bytes (base64)
 *  so SSE frames / binary survive the bridge; decode + enqueue verbatim. */
export interface AgentStreamChunkEvent {
  streamId: string;
  dataBase64: string;
}

/** Terminal event for a stream — `error` set only on failure. */
export interface AgentStreamCompleteEvent {
  streamId: string;
  error?: string | null;
}

/** WS-shaped `agent_event` envelope delivered over the private Android IPC. */
export interface AgentEventEnvelope {
  type: "agent_event";
  version: 1;
  /** `eph-<n>` for ephemeral streams, `ipc-<n>` otherwise. Never a replay cursor. */
  eventId: string;
  ts: number;
  runId: string;
  seq: number;
  stream: string;
  sessionKey?: string;
  agentId?: string;
  roomId?: string;
  payload: Record<string, unknown>;
  /** Set for live-only streams (e.g. `voice-transcript`): never persist or log. */
  ephemeral?: true;
}

export interface AgentEventSubscribeOptions {
  /** Exact-match stream filter, 1-16 names (`[a-z0-9][a-z0-9_.:-]{0,63}`). */
  streams: string[];
  /** Caller-chosen id (8-64 of `[A-Za-z0-9-]`) so events can be matched before the call resolves. */
  subscriptionId?: string;
}

/**
 * `agentEvent` Capacitor event. A feed reports `subscribed` once, then
 * `event` / `dropped` in order, then exactly one terminal `end` (`error` set
 * unless the caller unsubscribed). Live only: there is no replay after `end`.
 */
export type AgentEventFeedEvent =
  | { subscriptionId: string; type: "subscribed"; streams: string[] }
  | { subscriptionId: string; type: "event"; event: AgentEventEnvelope }
  | { subscriptionId: string; type: "dropped"; count: number }
  | { subscriptionId: string; type: "end"; error?: string };

export interface AgentPlugin {
  /** Start the agent runtime. Resolves when it's ready. */
  start(options?: AgentStartOptions): Promise<AgentStatus>;

  /** Stop the agent runtime. */
  stop(): Promise<{ ok: boolean }>;

  /** Get current agent status. */
  getStatus(): Promise<AgentStatus>;

  /** Send a chat message and get the response. */
  chat(options: { text: string }): Promise<ChatResult>;

  /** Read the per-boot bearer token for the bundled Android local agent. */
  getLocalAgentToken?(): Promise<LocalAgentTokenResult>;

  /**
   * Path-only request bridge for the bundled local agent.
   *
   * Native implementations must reject absolute URLs and route only to the
   * app-owned local backend. This is a transitional transport before the
   * backend route kernel can run over Binder/LocalSocket/WKURLSchemeHandler.
   * On iOS local dev/sideload builds this requires the WebView ITTP bridge to
   * be installed, so it is a foreground-only path.
   */
  request?(options: AgentRequestOptions): Promise<AgentRequestResult>;

  /**
   * STREAMING variant of {@link request}. Where `request` buffers the whole
   * response into one string (so SSE token frames arrive all at once — the chat
   * reply never streams on mobile), `requestStream` opens the same loopback
   * request and pushes the response incrementally via `agentStream*` events,
   * letting the WebView reconstruct a real streaming `Response`.
   *
   * Resolves with the `streamId` once the request is started; the head arrives
   * as `agentStreamResponse`, body bytes as `agentStreamChunk`, and the stream
   * ends with `agentStreamComplete`. Absent on platforms without a streaming
   * bridge — callers MUST fall back to {@link request}.
   */
  requestStream?(options: AgentRequestOptions): Promise<AgentStreamHandle>;

  /**
   * Live agent-event feed over the private Android IPC — the port-free
   * substitute for the WS `agent_event` broadcast (e.g. ephemeral
   * `voice-transcript` partials). Resolves with the `subscriptionId`; events
   * arrive as `agentEvent`. Absent where the platform has no IPC feed; use
   * `subscribeAgentEvents` from this package rather than calling it directly.
   */
  subscribeEvents?(
    options: AgentEventSubscribeOptions,
  ): Promise<{ subscriptionId: string }>;

  /** End a feed started by {@link subscribeEvents}; resolves `ok:false` if unknown. */
  unsubscribeEvents?(options: {
    subscriptionId: string;
  }): Promise<{ ok: boolean }>;

  addListener?(
    eventName: "agentEvent",
    listener: (event: AgentEventFeedEvent) => void,
  ): Promise<AgentPluginListenerHandle> | AgentPluginListenerHandle;
  addListener?(
    eventName: "agentStreamResponse",
    listener: (event: AgentStreamResponseEvent) => void,
  ): Promise<AgentPluginListenerHandle> | AgentPluginListenerHandle;
  addListener?(
    eventName: "agentStreamChunk",
    listener: (event: AgentStreamChunkEvent) => void,
  ): Promise<AgentPluginListenerHandle> | AgentPluginListenerHandle;
  addListener?(
    eventName: "agentStreamComplete",
    listener: (event: AgentStreamCompleteEvent) => void,
  ): Promise<AgentPluginListenerHandle> | AgentPluginListenerHandle;
}
