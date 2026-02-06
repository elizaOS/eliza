import type { UUID } from "@elizaos/core";

/**
 * Parsed components of a session key.
 * Otto session keys follow patterns like:
 * - "agent:mybot:dm:user123"
 * - "agent:mybot:subagent:uuid"
 * - "agent:mybot:group:channelId"
 */
export interface ParsedSessionKey {
  agentId: string;
  keyType: "dm" | "subagent" | "group" | "channel" | "unknown";
  identifier: string;
  parentKey?: string;
}

/**
 * Delivery context for message routing.
 * Captures the channel and target information for message delivery.
 */
export interface DeliveryContext {
  channel?: string;
  accountId?: string;
  to?: string;
  threadId?: string | number;
  groupId?: string;
  groupChannel?: string;
  groupSpace?: string;
}

/**
 * Outcome of a subagent run.
 */
export interface SubagentRunOutcome {
  status: "ok" | "error" | "timeout" | "unknown";
  error?: string;
}

/**
 * Record tracking a subagent run's lifecycle.
 */
export interface SubagentRunRecord {
  /** Unique run identifier */
  runId: string;
  /** The subagent's session key / room identifier */
  childSessionKey: string;
  /** The parent session that spawned this subagent */
  requesterSessionKey: string;
  /** Delivery context for announcing results */
  requesterOrigin?: DeliveryContext;
  /** Human-readable display key for the requester */
  requesterDisplayKey: string;
  /** The task description given to the subagent */
  task: string;
  /** Cleanup behavior after completion */
  cleanup: "delete" | "keep";
  /** Optional label for identification */
  label?: string;
  /** When the run was registered */
  createdAt: number;
  /** When execution actually started */
  startedAt?: number;
  /** When execution ended */
  endedAt?: number;
  /** Final outcome */
  outcome?: SubagentRunOutcome;
  /** When to archive/delete this record */
  archiveAtMs?: number;
  /** Whether cleanup has completed */
  cleanupCompletedAt?: number;
  /** Whether cleanup is in progress */
  cleanupHandled?: boolean;
  /** Eliza room ID associated with this subagent */
  roomId?: UUID;
  /** Eliza world ID for context */
  worldId?: UUID;
}

/**
 * Parameters for spawning a subagent.
 */
export interface SpawnSubagentParams {
  /** The task to execute */
  task: string;
  /** Optional label for identification */
  label?: string;
  /** Target agent ID (defaults to current agent) */
  agentId?: string;
  /** Model override (e.g., "anthropic/claude-3-sonnet") */
  model?: string;
  /** Thinking level override */
  thinking?: string;
  /** Timeout in seconds (0 = no timeout) */
  runTimeoutSeconds?: number;
  /** Cleanup behavior after completion */
  cleanup?: "delete" | "keep";
}

/**
 * Result of spawning a subagent.
 */
export interface SpawnSubagentResult {
  status: "accepted" | "forbidden" | "error";
  childSessionKey?: string;
  childRoomId?: UUID;
  runId?: string;
  modelApplied?: boolean;
  warning?: string;
  error?: string;
}

/**
 * Parameters for sending a message to another agent/session.
 */
export interface SendToAgentParams {
  /** Target session key or room ID */
  sessionKey?: string;
  /** Target by label (alternative to sessionKey) */
  label?: string;
  /** Target agent ID (when using label) */
  agentId?: string;
  /** The message to send */
  message: string;
  /** Timeout in seconds */
  timeoutSeconds?: number;
}

/**
 * Result of sending a message to another agent.
 */
export interface SendToAgentResult {
  status: "ok" | "accepted" | "timeout" | "forbidden" | "error";
  runId: string;
  sessionKey?: string;
  reply?: string;
  delivery?: { status: string; mode: string };
  error?: string;
}

/**
 * Agent-to-agent communication policy.
 */
export interface AgentToAgentPolicy {
  enabled: boolean;
  allowRules: Array<{
    source: string | "*";
    target: string | "*";
  }>;
  isAllowed(sourceAgentId: string, targetAgentId: string): boolean;
}

/**
 * Configuration for subagent behavior.
 * Stored in Character.settings.subagents or world metadata.
 */
export interface SubagentConfig {
  /** Allow subagent spawning */
  enabled?: boolean;
  /** Default model for subagents */
  model?: string;
  /** Default thinking level */
  thinking?: string;
  /** Timeout in seconds */
  timeoutSeconds?: number;
  /** Allowed agent IDs for cross-agent spawning (* = all) */
  allowAgents?: string[];
  /** Minutes before archiving completed subagent records */
  archiveAfterMinutes?: number;
}

/**
 * Event types emitted by the subagent system.
 */
export const SubagentEventType = {
  /** Subagent spawn requested */
  SPAWN_REQUESTED: "SUBAGENT_SPAWN_REQUESTED",
  /** Subagent run started */
  RUN_STARTED: "SUBAGENT_RUN_STARTED",
  /** Subagent run completed */
  RUN_COMPLETED: "SUBAGENT_RUN_COMPLETED",
  /** Subagent run failed */
  RUN_FAILED: "SUBAGENT_RUN_FAILED",
  /** Subagent run timed out */
  RUN_TIMEOUT: "SUBAGENT_RUN_TIMEOUT",
  /** Subagent announcement sent */
  ANNOUNCE_SENT: "SUBAGENT_ANNOUNCE_SENT",
  /** Agent-to-agent message sent */
  A2A_MESSAGE_SENT: "A2A_MESSAGE_SENT",
  /** Agent-to-agent message received */
  A2A_MESSAGE_RECEIVED: "A2A_MESSAGE_RECEIVED",
} as const;

export type SubagentEventType =
  (typeof SubagentEventType)[keyof typeof SubagentEventType];

/**
 * Payload for subagent events.
 */
export interface SubagentEventPayload {
  runId: string;
  childSessionKey?: string;
  childRoomId?: UUID;
  requesterSessionKey?: string;
  requesterRoomId?: UUID;
  task?: string;
  label?: string;
  status?: string;
  outcome?: SubagentRunOutcome;
  error?: string;
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
}

/**
 * Metadata stored on a room to track subagent context.
 */
export interface SubagentRoomMetadata {
  /** Indicates this room is for a subagent */
  isSubagent: true;
  /** The subagent's session key */
  sessionKey: string;
  /** Parent room that spawned this subagent */
  parentRoomId?: UUID;
  /** Parent session key */
  parentSessionKey?: string;
  /** The task this subagent is executing */
  task?: string;
  /** Label for identification */
  label?: string;
  /** When the subagent was spawned */
  spawnedAt: number;
  /** Cleanup behavior */
  cleanup: "delete" | "keep";
}
