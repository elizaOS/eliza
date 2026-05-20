/**
 * DAG Trace Bridge — Cross-package LLM call forwarding.
 *
 * This module provides a global callback that @feed/agents LLM clients
 * can call to forward their LLM call data into the DAG tracer running
 * in @feed/engine during a game tick.
 *
 * The bridge is installed by engine's installLLMInterceptor() and cleared
 * by uninstallLLMInterceptor(). When no game-tick trace is active, the
 * callback is null and agents skip it — zero overhead.
 */

export interface AgentLLMBridgeData {
  nodeId?: string;
  provider: string;
  model: string;
  promptType: string;
  format?: string;
  temperature?: number;
  maxTokens?: number;
  systemPrompt: string;
  userPrompt: string;
  rawResponse: string;
  parsedResponse?: unknown;
  inputTokens: number;
  outputTokens: number;
  totalTokens?: number;
  durationMs: number;
  success: boolean;
  error?: string;
}

export type AgentLLMBridgeCallback = (data: AgentLLMBridgeData) => void;

let agentLLMBridgeCallback: AgentLLMBridgeCallback | null = null;

/**
 * Set the agent LLM bridge callback.
 * Called by engine's installLLMInterceptor() to start capturing agent LLM calls.
 */
export function setAgentLLMBridge(cb: AgentLLMBridgeCallback | null): void {
  agentLLMBridgeCallback = cb;
}

/**
 * Get the current agent LLM bridge callback.
 * Called by agent LLM clients after each LLM call to forward data to the tracer.
 * Returns null when no game-tick trace is active.
 */
export function getAgentLLMBridge(): AgentLLMBridgeCallback | null {
  return agentLLMBridgeCallback;
}
