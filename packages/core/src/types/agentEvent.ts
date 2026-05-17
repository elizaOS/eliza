/**
 * Agent Event Types
 *
 * Defines types for agent event streaming - lifecycle events, tool usage,
 * assistant responses, errors, messages, actions, evaluators, memory, and
 * custom application events.
 *
 * These events enable real-time monitoring of agent activity and
 * can be used for debugging, analytics, and UI updates.
 */

import type { UUID } from "./primitives.ts";

/**
 * Standard event streams for agent activity
 */
export type AgentEventStream =
	| "lifecycle"
	| "tool"
	| "assistant"
	| "error"
	| "heartbeat"
	| "message"
	| "action"
	| "evaluator"
	| "provider"
	| "memory"
	| (string & {});

/**
 * Verbose levels for event filtering
 */
export type AgentVerboseLevel = "quiet" | "normal" | "verbose" | "debug";

/**
 * Payload for a single agent event
 */
export interface AgentEventPayload {
	/** Unique identifier for the agent run */
	runId: string;
	/** Monotonically increasing sequence number per run */
	seq: number;
	/** The event stream category */
	stream: AgentEventStream;
	/** Unix timestamp in milliseconds */
	ts: number;
	/** Event-specific data */
	data: Record<string, unknown>;
	/** Optional session key for routing */
	sessionKey?: string;
	/** Optional agent ID */
	agentId?: string;
	/** Optional room ID */
	roomId?: UUID;
}

/**
 * Context for an agent run - used to enrich events with session info
 */
export interface AgentRunContext {
	/** Session key for routing events to specific clients */
	sessionKey?: string;
	/** Verbose level for event filtering */
	verboseLevel?: AgentVerboseLevel;
	/** Whether this run is a heartbeat check */
	isHeartbeat?: boolean;
	/** Optional agent ID */
	agentId?: string;
	/** Optional room ID */
	roomId?: string;
}

/**
 * Heartbeat status types
 */
export type HeartbeatStatus =
	| "sent"
	| "ok-empty"
	| "ok-token"
	| "skipped"
	| "failed";

/**
 * Heartbeat indicator types for UI status display
 */
export type HeartbeatIndicatorType = "ok" | "alert" | "error";

/**
 * Payload for heartbeat events
 */
export interface HeartbeatEventPayload {
	/** Unix timestamp in milliseconds */
	ts: number;
	/** Heartbeat status */
	status: HeartbeatStatus;
	/** Target of the heartbeat (e.g., channel/user) */
	to?: string;
	/** Message preview */
	preview?: string;
	/** Duration in milliseconds */
	durationMs?: number;
	/** Whether the heartbeat included media */
	hasMedia?: boolean;
	/** Reason for status (e.g., failure reason) */
	reason?: string;
	/** The channel this heartbeat was sent to */
	channel?: string;
	/** Whether the message was silently suppressed */
	silent?: boolean;
	/** Indicator type for UI status display */
	indicatorType?: HeartbeatIndicatorType;
}

/**
 * Listener function for agent events
 */
export type AgentEventListener = (event: AgentEventPayload) => void;

/**
 * Listener function for heartbeat events
 */
export type HeartbeatEventListener = (event: HeartbeatEventPayload) => void;

/**
 * Event input without auto-generated fields (seq, ts)
 */
export type AgentEventInput = Omit<AgentEventPayload, "seq" | "ts">;

/**
 * Heartbeat input without auto-generated timestamp
 */
export type HeartbeatEventInput = Omit<HeartbeatEventPayload, "ts">;

/**
 * Lifecycle event data types
 */
export interface LifecycleEventData {
	type:
		| "run_start"
		| "run_end"
		| "step_start"
		| "step_end"
		| "context_loaded"
		| "action_start"
		| "action_end";
	stepName?: string;
	actionName?: string;
	duration?: number;
	success?: boolean;
	error?: string;
}

/**
 * Tool event data types
 */
export interface ToolEventData {
	type: "tool_call" | "tool_result" | "tool_error";
	toolName: string;
	input?: Record<string, unknown>;
	output?: Record<string, unknown>;
	duration?: number;
	error?: string;
}

/**
 * Assistant event data types
 */
export interface AssistantEventData {
	type: "message" | "thought" | "plan" | "reflection";
	content: string;
	role?: "assistant" | "user" | "system";
	tokens?: number;
}

/**
 * Error event data types
 */
export interface ErrorEventData {
	type: "error" | "warning";
	code?: string;
	message: string;
	stack?: string;
	recoverable?: boolean;
}

/**
 * Message event data types - for inbound/outbound messages
 */
export interface MessageEventData {
	type: "received" | "sent" | "queued" | "failed";
	/** Message ID */
	messageId?: UUID;
	/** Channel the message came from or was sent to */
	channel?: string;
	/** The user or target ID */
	userId?: UUID;
	/** Room ID where the message occurred */
	roomId?: UUID;
	/** Message content (may be truncated) */
	content?: string;
	/** Whether the message has attachments */
	hasAttachments?: boolean;
	/** Delivery timestamp */
	deliveredAt?: number;
	/** Failure reason if type is 'failed' */
	error?: string;
	/** Index signature for Record<string, unknown> compatibility */
	[key: string]: unknown;
}

/**
 * Action event data types - for action execution
 */
export interface ActionEventData {
	type: "start" | "complete" | "error" | "skipped";
	/** Action name */
	actionName: string;
	/** Action handler name (if different from actionName) */
	handler?: string;
	/** Input parameters to the action */
	input?: Record<string, unknown>;
	/** Output result from the action */
	output?: Record<string, unknown>;
	/** Duration in milliseconds */
	duration?: number;
	/** Whether the action succeeded */
	success?: boolean;
	/** Error message if failed */
	error?: string;
	/** Memory ID associated with this action */
	memoryId?: UUID;
	/** Index signature for Record<string, unknown> compatibility */
	[key: string]: unknown;
}

/**
 * Evaluator event data types - for evaluator execution
 */
export interface EvaluatorEventData {
	type: "start" | "complete" | "error" | "skipped";
	/** Evaluator name */
	evaluatorName: string;
	/** Whether the evaluator validation passed */
	validated?: boolean;
	/** Evaluation result/score */
	result?: unknown;
	/** Duration in milliseconds */
	duration?: number;
	/** Error message if failed */
	error?: string;
	/** Message ID being evaluated */
	messageId?: UUID;
	/** Index signature for Record<string, unknown> compatibility */
	[key: string]: unknown;
}

/**
 * Provider event data types - for provider data fetching
 */
export interface ProviderEventData {
	type: "start" | "complete" | "error" | "cached";
	/** Provider name */
	providerName: string;
	/** Data returned by the provider (may be truncated) */
	data?: unknown;
	/** Duration in milliseconds */
	duration?: number;
	/** Whether the result was served from cache */
	fromCache?: boolean;
	/** Error message if failed */
	error?: string;
	/** Token count if provider returns text */
	tokens?: number;
	/** Index signature for Record<string, unknown> compatibility */
	[key: string]: unknown;
}

/**
 * Memory event data types - for memory operations
 */
export interface MemoryEventData {
	type: "create" | "update" | "delete" | "search" | "retrieved";
	/** Memory ID */
	memoryId?: UUID;
	/** Memory table/collection name */
	tableName?: string;
	/** Room ID associated with the memory */
	roomId?: UUID;
	/** Number of memories affected or retrieved */
	count?: number;
	/** Whether the operation succeeded */
	success?: boolean;
	/** Duration in milliseconds */
	duration?: number;
	/** Error message if failed */
	error?: string;
	/** Content preview (truncated) */
	preview?: string;
	/** Index signature for Record<string, unknown> compatibility */
	[key: string]: unknown;
}
