/**
 * @elizaos/capacitor-agent — Agent lifecycle management for Capacitor.
 *
 * Provides a cross-platform interface for starting, stopping, and
 * communicating with the embedded Eliza agent.
 *
 * - Electrobun desktop: RPC to the main-process AgentManager
 * - Android/Web: HTTP calls to the API server or bundled loopback agent
 * - iOS: HTTP for remote/cloud endpoints; local dev/sideload routes through
 *   the WebView ITTP kernel until the native route-kernel bridge lands
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
   */
  request?(options: AgentRequestOptions): Promise<AgentRequestResult>;
}
