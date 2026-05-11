import type { HandlerCallback } from "./components";
import type { Entity, Room, World } from "./environment";
import type { Memory } from "./memory";
import type { ControlMessage } from "./messaging";
import type { ModelTypeName } from "./model";
import type { PipelineHookPhase } from "./pipeline-hooks";
import type { Content, JsonValue, UUID } from "./primitives";
import type { IAgentRuntime } from "./runtime";

/**
 * Standard event types across all platforms
 */
export enum EventType {
	// World events
	WORLD_JOINED = "WORLD_JOINED",
	WORLD_CONNECTED = "WORLD_CONNECTED",
	WORLD_LEFT = "WORLD_LEFT",

	// Entity events
	ENTITY_JOINED = "ENTITY_JOINED",
	ENTITY_LEFT = "ENTITY_LEFT",
	ENTITY_UPDATED = "ENTITY_UPDATED",

	// Room events
	ROOM_JOINED = "ROOM_JOINED",
	ROOM_LEFT = "ROOM_LEFT",

	// Message events
	MESSAGE_RECEIVED = "MESSAGE_RECEIVED",
	MESSAGE_SENT = "MESSAGE_SENT",
	MESSAGE_DELETED = "MESSAGE_DELETED",

	// Channel events
	CHANNEL_CLEARED = "CHANNEL_CLEARED",

	// Voice events
	VOICE_MESSAGE_RECEIVED = "VOICE_MESSAGE_RECEIVED",
	VOICE_MESSAGE_SENT = "VOICE_MESSAGE_SENT",

	// Interaction events
	REACTION_RECEIVED = "REACTION_RECEIVED",
	POST_GENERATED = "POST_GENERATED",
	INTERACTION_RECEIVED = "INTERACTION_RECEIVED",

	// Run events
	RUN_STARTED = "RUN_STARTED",
	RUN_ENDED = "RUN_ENDED",
	RUN_TIMEOUT = "RUN_TIMEOUT",

	// Action events
	ACTION_STARTED = "ACTION_STARTED",
	ACTION_COMPLETED = "ACTION_COMPLETED",

	// Evaluator events
	EVALUATOR_STARTED = "EVALUATOR_STARTED",
	EVALUATOR_COMPLETED = "EVALUATOR_COMPLETED",

	// Model events
	MODEL_USED = "MODEL_USED",

	// Embedding events
	EMBEDDING_GENERATION_REQUESTED = "EMBEDDING_GENERATION_REQUESTED",
	EMBEDDING_GENERATION_COMPLETED = "EMBEDDING_GENERATION_COMPLETED",
	EMBEDDING_GENERATION_FAILED = "EMBEDDING_GENERATION_FAILED",

	// Control events
	CONTROL_MESSAGE = "CONTROL_MESSAGE",

	// Form events
	FORM_FIELD_CONFIRMED = "FORM_FIELD_CONFIRMED",
	FORM_FIELD_CANCELLED = "FORM_FIELD_CANCELLED",

	// Hook system events - command lifecycle
	HOOK_COMMAND_NEW = "HOOK_COMMAND_NEW",
	HOOK_COMMAND_RESET = "HOOK_COMMAND_RESET",
	HOOK_COMMAND_STOP = "HOOK_COMMAND_STOP",

	// Hook system events - session lifecycle
	HOOK_SESSION_START = "HOOK_SESSION_START",
	HOOK_SESSION_END = "HOOK_SESSION_END",

	// Hook system events - agent lifecycle
	HOOK_AGENT_BASIC_CAPABILITIES = "HOOK_AGENT_BASIC_CAPABILITIES",
	HOOK_AGENT_START = "HOOK_AGENT_START",
	HOOK_AGENT_END = "HOOK_AGENT_END",

	// Hook system events - gateway lifecycle
	HOOK_GATEWAY_START = "HOOK_GATEWAY_START",
	HOOK_GATEWAY_STOP = "HOOK_GATEWAY_STOP",

	// Hook system events - compaction
	HOOK_COMPACTION_BEFORE = "HOOK_COMPACTION_BEFORE",
	HOOK_COMPACTION_AFTER = "HOOK_COMPACTION_AFTER",

	// Hook system events - tool execution
	HOOK_TOOL_BEFORE = "HOOK_TOOL_BEFORE",
	HOOK_TOOL_AFTER = "HOOK_TOOL_AFTER",
	HOOK_TOOL_PERSIST = "HOOK_TOOL_PERSIST",

	// Hook system events - message lifecycle (supplements MESSAGE_*)
	HOOK_MESSAGE_SENDING = "HOOK_MESSAGE_SENDING",

	/** Per-invocation timing for `registerPipelineHook` handlers (telemetry / dashboards). */
	PIPELINE_HOOK_METRIC = "PIPELINE_HOOK_METRIC",
}

/**
 * Platform-specific event type prefix
 */
export enum PlatformPrefix {
	DISCORD = "DISCORD",
	TELEGRAM = "TELEGRAM",
	X = "X",
}

/**
 * Base payload interface for all events
 */
export interface EventPayload {
	runtime: IAgentRuntime;
	source?: string;
	onComplete?: () => void;
}

/**
 * Payload for world-related events
 */
export interface WorldPayload extends EventPayload {
	world: World;
	rooms: Room[];
	entities: Entity[];
}

/**
 * Payload for entity-related events
 */
export interface EntityPayload extends EventPayload {
	entityId: UUID;
	worldId?: UUID;
	roomId?: UUID;
	metadata?: {
		originalId: string;
		username: string;
		displayName?: string;
		type?: string;
	};
}

/**
 * Payload for reaction-related events
 */
export interface MessagePayload extends EventPayload {
	message: Memory;
	callback?: HandlerCallback;
}

/**
 * Payload for channel cleared events
 */
export interface ChannelClearedPayload extends EventPayload {
	roomId: UUID;
}

/**
 * Payload for events that are invoked without a message
 */
export interface InvokePayload extends EventPayload {
	worldId: UUID;
	roomId: UUID;
	userId?: UUID;
	source?: string;
	callback?: HandlerCallback;
}

/**
 * Run event payload type
 */
export interface RunEventPayload extends EventPayload {
	runId: UUID;
	messageId: UUID;
	roomId: UUID;
	entityId: UUID;
	startTime: number | bigint;
	status: "started" | "completed" | "timeout";
	endTime?: number | bigint;
	duration?: number | bigint;
	error?: string | Error;
}

/**
 * Action event payload type
 */
export interface ActionEventPayload extends EventPayload {
	roomId: UUID;
	world: UUID;
	content: Content;
	messageId?: UUID;
}

/**
 * Evaluator event payload type
 */
export interface EvaluatorEventPayload extends EventPayload {
	evaluatorId: UUID;
	evaluatorName: string;
	startTime?: number | bigint;
	completed?: boolean;
	error?: Error;
}

/**
 * Model event payload type
 */
export interface ModelEventPayload extends EventPayload {
	type: ModelTypeName;
	tokens?: {
		prompt: number;
		completion: number;
		total: number;
		cacheReadInputTokens?: number;
		cacheCreationInputTokens?: number;
		cachedInputTokens?: number;
	};
}

/**
 * Payload for embedding generation events
 */
export interface EmbeddingGenerationPayload extends EventPayload {
	memory: Memory;
	priority?: "high" | "normal" | "low";
	embedding?: number[];
	error?: Error | string;
	runId?: UUID;
	retryCount?: number;
	maxRetries?: number;
}

/**
 * Payload for control message events
 */
export interface ControlMessagePayload extends EventPayload {
	message: ControlMessage;
}

export interface FormFieldEventPayload extends EventPayload {
	sessionId: string;
	entityId: UUID;
	field: string;
	value?: JsonValue;
	externalData?: JsonValue;
	reason?: string;
}

// ============================================================================
// Hook System Event Payloads
// ============================================================================

/**
 * Base payload for all hook events.
 * Hooks can push messages to the `messages` array to send responses back to users.
 */
export interface HookEventPayload extends EventPayload {
	/** Session key this hook event relates to */
	sessionKey: string;
	/** Messages to send back to the user (hooks can push to this array) */
	messages: string[];
	/** Timestamp when the event occurred */
	timestamp: Date;
	/** Additional context specific to the event */
	context: Record<string, unknown>;
}

/**
 * Payload for command hook events (HOOK_COMMAND_NEW, HOOK_COMMAND_RESET, HOOK_COMMAND_STOP)
 */
export interface HookCommandPayload extends HookEventPayload {
	/** The command action: "new", "reset", or "stop" */
	command: "new" | "reset" | "stop";
	/** ID of the sender who issued the command */
	senderId?: string;
	/** Source surface of the command (e.g., "telegram", "discord") */
	commandSource?: string;
	/** Session entry data */
	sessionEntry?: Record<string, unknown>;
	/** Previous session entry data (for reset) */
	previousSessionEntry?: Record<string, unknown>;
	/** Configuration at time of command */
	config?: Record<string, unknown>;
}

/**
 * File definition for agent basic-capabilities hooks
 */
export interface BasicCapabilitiesFile {
	/** File path relative to workspace */
	path: string;
	/** File content */
	content: string;
	/** File type (e.g., "soul", "boot", "tools") */
	type?: string;
	/** Whether this file is required */
	required?: boolean;
}

/**
 * Payload for agent basic-capabilities hook event (HOOK_AGENT_BASIC_CAPABILITIES)
 */
export interface HookAgentBasicCapabilitiesPayload extends HookEventPayload {
	/** Workspace directory path */
	workspaceDir: string;
	/** Files that will be injected. Hooks can modify this array. */
	"basic-capabilitiesFiles": BasicCapabilitiesFile[];
	/** Agent ID */
	agentId?: string;
	/** Session ID */
	sessionId?: string;
}

/**
 * Payload for agent start/end hook events (HOOK_AGENT_START, HOOK_AGENT_END)
 */
export interface HookAgentLifecyclePayload extends HookEventPayload {
	/** The initial prompt or message */
	prompt?: string;
	/** Messages in the conversation */
	conversationMessages?: unknown[];
	/** Whether the agent run completed successfully */
	success?: boolean;
	/** Error message if failed */
	error?: string;
	/** Duration of the agent run in milliseconds */
	durationMs?: number;
	/** System prompt to inject (for HOOK_AGENT_START result) */
	systemPrompt?: string;
	/** Context to prepend to conversation (for HOOK_AGENT_START result) */
	prependContext?: string;
}

/**
 * Payload for session hook events (HOOK_SESSION_START, HOOK_SESSION_END)
 */
export interface HookSessionPayload extends HookEventPayload {
	/** Channel ID for the session */
	channelId?: string;
	/** Account ID associated with the session */
	accountId?: string;
	/** Conversation ID */
	conversationId?: string;
}

/**
 * Payload for gateway hook events (HOOK_GATEWAY_START, HOOK_GATEWAY_STOP)
 */
export interface HookGatewayPayload extends HookEventPayload {
	/** Gateway port number */
	port?: number;
	/** Gateway host/bind address */
	host?: string;
	/** List of channels that were started */
	channels?: string[];
}

/**
 * Payload for compaction hook events (HOOK_COMPACTION_BEFORE, HOOK_COMPACTION_AFTER)
 */
export interface HookCompactionPayload extends HookEventPayload {
	/** Number of messages before compaction */
	messageCount: number;
	/** Estimated token count */
	tokenCount?: number;
	/** Number of messages compacted (for HOOK_COMPACTION_AFTER) */
	compactedCount?: number;
}

/**
 * Payload for tool hook events (HOOK_TOOL_BEFORE, HOOK_TOOL_AFTER, HOOK_TOOL_PERSIST)
 */
export interface HookToolPayload extends HookEventPayload {
	/** Name of the tool being invoked */
	toolName: string;
	/** Tool input arguments */
	toolArgs?: Record<string, unknown>;
	/** Tool execution result (for HOOK_TOOL_AFTER) */
	result?: unknown;
	/** Whether to skip this tool invocation (for HOOK_TOOL_BEFORE) */
	skip?: boolean;
	/** Modified arguments (for HOOK_TOOL_BEFORE) */
	modifiedArgs?: Record<string, unknown>;
	/** Modified result to persist (for HOOK_TOOL_PERSIST) */
	modifiedResult?: unknown;
}

/**
 * Payload for message sending hook event (HOOK_MESSAGE_SENDING)
 */
export interface HookMessageSendingPayload extends HookEventPayload {
	/** Recipient identifier */
	to: string;
	/** Message content */
	content: string;
	/** Message metadata */
	metadata?: Record<string, unknown>;
	/** Whether to cancel sending this message */
	cancel?: boolean;
	/** Modified content to send instead */
	modifiedContent?: string;
}

/**
 * Payload for pipeline hook timing events ({@link EventType.PIPELINE_HOOK_METRIC}).
 */
export interface PipelineHookMetricPayload extends EventPayload {
	phase: PipelineHookPhase;
	hookId: string;
	durationMs: number;
	roomId: UUID;
	/** True when duration meets `PIPELINE_HOOK_WARN_MS` (see `pipeline-hooks.ts`). */
	slow: boolean;
	/** Set when the hook handler threw (runtime still continued). */
	error?: string;
}

/**
 * Maps event types to their corresponding payload types
 */
export interface EventPayloadMap {
	[EventType.WORLD_JOINED]: WorldPayload;
	[EventType.WORLD_CONNECTED]: WorldPayload;
	[EventType.WORLD_LEFT]: WorldPayload;
	[EventType.ENTITY_JOINED]: EntityPayload;
	[EventType.ENTITY_LEFT]: EntityPayload;
	[EventType.ENTITY_UPDATED]: EntityPayload;
	[EventType.MESSAGE_RECEIVED]: MessagePayload;
	[EventType.MESSAGE_SENT]: MessagePayload;
	[EventType.MESSAGE_DELETED]: MessagePayload;
	[EventType.VOICE_MESSAGE_RECEIVED]: MessagePayload;
	[EventType.VOICE_MESSAGE_SENT]: MessagePayload;
	[EventType.CHANNEL_CLEARED]: ChannelClearedPayload;
	[EventType.REACTION_RECEIVED]: MessagePayload;
	[EventType.POST_GENERATED]: InvokePayload;
	[EventType.INTERACTION_RECEIVED]: MessagePayload;
	[EventType.RUN_STARTED]: RunEventPayload;
	[EventType.RUN_ENDED]: RunEventPayload;
	[EventType.RUN_TIMEOUT]: RunEventPayload;
	[EventType.ACTION_STARTED]: ActionEventPayload;
	[EventType.ACTION_COMPLETED]: ActionEventPayload;
	[EventType.EVALUATOR_STARTED]: EvaluatorEventPayload;
	[EventType.EVALUATOR_COMPLETED]: EvaluatorEventPayload;
	[EventType.MODEL_USED]: ModelEventPayload;
	[EventType.EMBEDDING_GENERATION_REQUESTED]: EmbeddingGenerationPayload;
	[EventType.EMBEDDING_GENERATION_COMPLETED]: EmbeddingGenerationPayload;
	[EventType.EMBEDDING_GENERATION_FAILED]: EmbeddingGenerationPayload;
	[EventType.CONTROL_MESSAGE]: ControlMessagePayload;
	[EventType.FORM_FIELD_CONFIRMED]: FormFieldEventPayload;
	[EventType.FORM_FIELD_CANCELLED]: FormFieldEventPayload;
	// Hook system event payloads
	[EventType.HOOK_COMMAND_NEW]: HookCommandPayload;
	[EventType.HOOK_COMMAND_RESET]: HookCommandPayload;
	[EventType.HOOK_COMMAND_STOP]: HookCommandPayload;
	[EventType.HOOK_SESSION_START]: HookSessionPayload;
	[EventType.HOOK_SESSION_END]: HookSessionPayload;
	[EventType.HOOK_AGENT_BASIC_CAPABILITIES]: HookAgentBasicCapabilitiesPayload;
	[EventType.HOOK_AGENT_START]: HookAgentLifecyclePayload;
	[EventType.HOOK_AGENT_END]: HookAgentLifecyclePayload;
	[EventType.HOOK_GATEWAY_START]: HookGatewayPayload;
	[EventType.HOOK_GATEWAY_STOP]: HookGatewayPayload;
	[EventType.HOOK_COMPACTION_BEFORE]: HookCompactionPayload;
	[EventType.HOOK_COMPACTION_AFTER]: HookCompactionPayload;
	[EventType.HOOK_TOOL_BEFORE]: HookToolPayload;
	[EventType.HOOK_TOOL_AFTER]: HookToolPayload;
	[EventType.HOOK_TOOL_PERSIST]: HookToolPayload;
	[EventType.HOOK_MESSAGE_SENDING]: HookMessageSendingPayload;
	[EventType.PIPELINE_HOOK_METRIC]: PipelineHookMetricPayload;
}

/**
 * Event handler function type
 */
export type EventHandler<T extends keyof EventPayloadMap> = (
	payload: EventPayloadMap[T],
) => Promise<void>;
