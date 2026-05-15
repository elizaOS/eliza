/**
 * @elizaos/capacitor-agent — Agent lifecycle management for Capacitor.
 *
 * Provides a cross-platform interface for starting, stopping, and
 * communicating with the embedded Eliza agent.
 *
 * - Electrobun desktop: RPC to the main-process AgentManager
 * - Android: Capacitor IPC to the Agent plugin; the native plugin owns the
 *   app-local tokenized loopback hop into ElizaAgentService
 * - Web: HTTP calls to the configured API server
 * - iOS: HTTP for remote/cloud endpoints; local foreground requests use
 *   ElizaBunRuntime IPC when available, with the WebView ITTP kernel retained
 *   only as a development compatibility path
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
   * Android local accepts loopback only as a native-service identity; WebView
   * requests should still go through Capacitor Agent.request. iOS local should
   * prefer `eliza-local-agent://ipc` and must not open a local TCP listener.
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
   * app-owned local backend. Android forwards over native code to its
   * tokenized app-local service; iOS forwards through full-Bun IPC or the
   * foreground ITTP compatibility handler. Callers should treat unsupported
   * body types as non-bridgeable instead of falling back to WebView loopback
   * fetches.
   */
  request?(options: AgentRequestOptions): Promise<AgentRequestResult>;
}
