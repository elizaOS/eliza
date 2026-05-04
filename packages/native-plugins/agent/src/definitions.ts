/**
 * @elizaos/capacitor-agent — Agent lifecycle management for Capacitor.
 *
 * Provides a cross-platform interface for starting, stopping, and
 * communicating with the embedded Eliza agent.
 *
 * - Electrobun desktop: RPC to the main-process AgentManager
 * - iOS/Android/Web: HTTP calls to the API server
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

export interface AgentPlugin {
  /** Start the agent runtime. Resolves when it's ready. */
  start(): Promise<AgentStatus>;

  /** Stop the agent runtime. */
  stop(): Promise<{ ok: boolean }>;

  /** Get current agent status. */
  getStatus(): Promise<AgentStatus>;

  /** Send a chat message and get the response. */
  chat(options: { text: string }): Promise<ChatResult>;
}
