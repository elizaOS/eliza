/**
 * MCP (Model Context Protocol) Configuration Constants
 * Centralized configuration for MCP endpoints and SSE streaming
 */

/**
 * Request Timeout Configuration
 */
export const MCP_REQUEST_TIMEOUT = Number.parseInt(process.env.MCP_TIMEOUT || "60", 10);
export const SSE_MAX_DURATION = Number.parseInt(process.env.SSE_MAX_DURATION || "300", 10);

/**
 * SSE (Server-Sent Events) Configuration
 */
export const SSE_POLL_INTERVAL_MS = Number.parseInt(process.env.SSE_POLL_INTERVAL_MS || "500", 10);
export const SSE_HEARTBEAT_INTERVAL = Number.parseInt(
  process.env.SSE_HEARTBEAT_INTERVAL || "30",
  10,
); // Send heartbeat every N polls
export const SSE_CONNECTION_TIMEOUT_MS = SSE_MAX_DURATION * 1000; // 5 minutes default

/**
 * SSE Connection Limits and Backoff Configuration
 * SECURITY FIX: Prevent resource exhaustion attacks
 */
export const SSE_MAX_CONNECTIONS_PER_ORG = Number.parseInt(
  process.env.SSE_MAX_CONNECTIONS_PER_ORG || "10",
  10,
);
export const SSE_BACKOFF_INITIAL_MS = Number.parseInt(
  process.env.SSE_BACKOFF_INITIAL_MS || "500",
  10,
);
export const SSE_BACKOFF_MAX_MS = Number.parseInt(process.env.SSE_BACKOFF_MAX_MS || "5000", 10);
export const SSE_BACKOFF_MULTIPLIER = Number.parseFloat(
  process.env.SSE_BACKOFF_MULTIPLIER || "1.5",
);

/**
 * Credit Costs for MCP Operations (in USD)
 * These are micro-operations and should be very affordable
 */
export const MEMORY_SAVE_COST = 0.001; // $0.001 - Saving a memory
export const MEMORY_RETRIEVAL_COST_PER_ITEM = 0.0001; // $0.0001 per memory
export const MEMORY_RETRIEVAL_MAX_COST = 0.01; // $0.01 max
export const CONTEXT_RETRIEVAL_COST = 0.005; // $0.005 - Context retrieval
export const CONVERSATION_CREATE_COST = 0.01; // $0.01 - Create conversation
export const CONVERSATION_SEARCH_COST = 0.01; // $0.01 - Search conversations
export const CONVERSATION_CLONE_COST = 0.02; // $0.02 - Clone conversation
export const CONVERSATION_EXPORT_COST = 0.05; // $0.05 - Export conversation
export const CONTEXT_OPTIMIZATION_COST = 0.05; // $0.05 - Optimize context
export const MEMORY_ANALYSIS_COST = 0.1; // $0.10 - Analyze memories

/**
 * Agent and Chat Configuration (in USD)
 * Token-based pricing for actual AI usage
 */
export const AGENT_CHAT_MIN_COST = 0.001; // $0.001 minimum
export const AGENT_CHAT_INPUT_TOKEN_COST = 0.000001; // $0.000001 per input token
export const AGENT_CHAT_OUTPUT_TOKEN_COST = 0.000003; // $0.000003 per output token
export const CONVERSATION_SUMMARY_BASE_COST = 0.01; // $0.01 base
export const CONVERSATION_SUMMARY_MAX_COST = 0.1; // $0.10 max

/**
 * Supported MCP Event Types for SSE Streaming
 */
export const MCP_EVENT_TYPES = {
  AGENT: "agent",
  CREDITS: "credits",
  CONTAINER: "container",
} as const;

export type MCPEventType = (typeof MCP_EVENT_TYPES)[keyof typeof MCP_EVENT_TYPES];
