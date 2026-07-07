/**
 * Runtime event system: the `EventType` enum and the per-event payload shapes an
 * agent emits and plugins subscribe to (world/entity/room/message/voice/model/
 * pipeline events). The typed contract that decouples event producers from
 * consumers across the runtime and plugins.
 */
import type { HandlerCallback } from "./components";
import type { Entity, Room, World } from "./environment";
import type { Memory } from "./memory";
import type { ControlMessage } from "./messaging";
import type {
	LocalInferencePriority,
	ModelRegistrationMetadata,
	ModelTypeName,
	PiiPseudonymAssignment,
} from "./model";
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

	// Voice-attribution → entity-binding seam.
	// A recognized voice turn was attributed to an imprint cluster
	// (producer: a voice/speaker-ID plugin). A merge-engine owner
	// (e.g. plugin-lifeops) consumes it to create/merge the Entity.
	VOICE_TURN_OBSERVED = "VOICE_TURN_OBSERVED",
	// The merge engine bound an imprint cluster to an Entity id
	// (producer: the merge-engine owner). The voice-profile owner
	// consumes it to persist the binding back onto its profile.
	VOICE_ENTITY_BOUND = "VOICE_ENTITY_BOUND",

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
	MODEL_REGISTERED = "MODEL_REGISTERED",

	// Embedding events
	EMBEDDING_GENERATION_REQUESTED = "EMBEDDING_GENERATION_REQUESTED",
	EMBEDDING_GENERATION_COMPLETED = "EMBEDDING_GENERATION_COMPLETED",
	EMBEDDING_GENERATION_FAILED = "EMBEDDING_GENERATION_FAILED",

	// PII scrub job events (#14808). Trigger event for the async scrub rails -
	// `PiiScrubService` listens for PII_SCRUB_REQUESTED and drains a priority
	// BatchQueue on the core task scheduler (mirrors EMBEDDING_GENERATION_*).
	PII_SCRUB_REQUESTED = "PII_SCRUB_REQUESTED",
	PII_SCRUB_COMPLETED = "PII_SCRUB_COMPLETED",
	PII_SCRUB_FAILED = "PII_SCRUB_FAILED",

	// Error reporting (#12263) — the general-purpose failure event emitted by
	// `runtime.reportError` for failures outside the action path (providers,
	// services, background jobs, event handlers). Surfaced to the agent via the
	// RECENT_ERRORS provider and used to drive the owner-escalation threshold.
	ERROR_REPORTED = "ERROR_REPORTED",

	// Control events
	CONTROL_MESSAGE = "CONTROL_MESSAGE",

	// Form events
	FORM_FIELD_CONFIRMED = "FORM_FIELD_CONFIRMED",
	FORM_FIELD_CANCELLED = "FORM_FIELD_CANCELLED",

	// UI interaction events (#8792) — the agent observes shortcuts, slash
	// commands, and view switches (agent- or user-initiated) so a proactive
	// decider can comment on them. Connect-once contract every surface emits.
	VIEW_SWITCHED = "VIEW_SWITCHED",
	SLASH_COMMAND_INVOKED = "SLASH_COMMAND_INVOKED",
	SHORTCUT_FIRED = "SHORTCUT_FIRED",
	USER_TYPING_STARTED = "USER_TYPING_STARTED",
	USER_TYPING_PAUSED = "USER_TYPING_PAUSED",
	USER_DRAFT_ABANDONED = "USER_DRAFT_ABANDONED",

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
 * Payload for {@link EventType.MODEL_REGISTERED}, emitted by
 * `AgentRuntime.registerModel` whenever a plugin registers a model handler.
 * Carries registration metadata only — never the handler function — so
 * observers (e.g. the local-inference routing table) can mirror the runtime's
 * model registry without capturing handlers or patching the prototype.
 */
export interface ModelRegisteredEventPayload extends EventPayload {
	/** The model type key the handler was registered for (e.g. `TEXT_LARGE`). */
	modelType: string;
	/** The provider (plugin) name that registered the handler. */
	provider: string;
	/** Selection priority (higher wins); defaults to 0 when unspecified. */
	priority: number;
	/** Optional provider-declared metadata. Never includes handler functions. */
	metadata?: ModelRegistrationMetadata;
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
 * Payload for {@link EventType.PII_SCRUB_REQUESTED}: one enqueue of content onto
 * the async scrub rails (#14808). The service hashes `content` into the
 * content-addressed done-marker (`pii:<sha256(content)>:v<rulesetVersion>`) and
 * skips the item entirely when that marker is already present (idempotent
 * re-scrub no-op). `candidateSpans` are the model-judgment residue the caller
 * mined; when empty the seam runs tier-0 only and never invokes a model.
 */
export interface PiiScrubRequestPayload extends EventPayload {
	/** The exact content to scrub. Its sha256 is the idempotency handle. */
	content: string;
	/** Active ruleset version: the `v<...>` half of the done-marker key. */
	rulesetVersion: string;
	/** Model-judgment candidate spans (residue tier-0 cannot decide). */
	candidateSpans?: readonly string[];
	/** Optional retrieval context for the model. Never the secret vault. */
	contextPack?: string;
	/** Per-chunk cluster->surrogate slice (never the whole map). */
	pseudonymAssignments?: readonly PiiPseudonymAssignment[];
	/**
	 * Drain priority in the BatchQueue. Defaults to `low`: the scrub is
	 * deferred autonomous work. Distinct from the local-inference priority
	 * (which is always `background` for the model call itself).
	 */
	priority?: "high" | "normal" | "low";
	/**
	 * Local-lane inference priority forwarded to the seam. Defaults to
	 * `background` so the scrub never preempts an interactive turn.
	 */
	inferencePriority?: LocalInferencePriority;
	/** Correlates all items belonging to one scrub job (progress/observability). */
	jobId?: UUID;
	/** Opaque caller ref (e.g. the memory/document id) for write-back. */
	itemRef?: string;
}

/**
 * Payload for {@link EventType.PII_SCRUB_COMPLETED} / {@link EventType.PII_SCRUB_FAILED}.
 * `tier0Only` is true when the deterministic detectors covered everything and
 * no model call was made. `error` is set only on the FAILED variant.
 */
export interface PiiScrubResultPayload extends EventPayload {
	content: string;
	rulesetVersion: string;
	jobId?: UUID;
	itemRef?: string;
	tier0Only?: boolean;
	modelId?: string;
	error?: Error | string;
}

/**
 * Payload for control message events
 */
export interface ControlMessagePayload extends EventPayload {
	message: ControlMessage;
}

/**
 * Payload for {@link EventType.ERROR_REPORTED} — a structured failure surfaced
 * by `runtime.reportError`. `scope` is the reporting subsystem (used as the
 * `[scope]` log prefix), `code` is the machine-classifiable key (from
 * `ElizaError.code` when available, else a normalized fallback like
 * `UNCLASSIFIED`), and `context` carries serializable diagnostic detail.
 */
export interface ErrorReportedPayload extends EventPayload {
	scope: string;
	code: string;
	message: string;
	context?: Record<string, unknown>;
	runId?: UUID;
	roomId?: UUID;
}

/**
 * Payload for {@link EventType.VOICE_TURN_OBSERVED}.
 *
 * Emitted by a voice/speaker-ID plugin when a turn is attributed to an
 * imprint cluster. Consumed by the merge-engine owner (plugin-lifeops)
 * to create or merge the corresponding Entity. Entity / cluster ids are
 * opaque strings (the merge engine uses non-UUID ids such as `"self"`).
 */
export interface VoiceTurnObservedPayload extends EventPayload {
	/** Stable utterance id (the transcriber turn id is fine). */
	turnId: string;
	/** Recognized text for the turn (drives name/partner-claim extraction). */
	text: string;
	/** Imprint cluster id from the voice-profile store. */
	imprintClusterId: string;
	/** Confidence of the imprint match (0..1). */
	matchConfidence: number;
	/** Entity the imprint already resolved to, or `null` when unbound. */
	matchedEntityId: string | null;
	/** True when this turn was spoken by the OWNER. */
	isOwner?: boolean;
	/** ISO timestamp of the observation. */
	observedAt?: string;
}

/**
 * Payload for {@link EventType.VOICE_ENTITY_BOUND}.
 *
 * Emitted by the merge-engine owner once an imprint cluster is bound to
 * an Entity id. Consumed by the voice-profile owner to persist the
 * binding back onto every profile in that cluster.
 */
export interface VoiceEntityBoundPayload extends EventPayload {
	/** Imprint cluster the binding applies to. */
	imprintClusterId: string;
	/** Entity id the cluster is now bound to. */
	entityId: string;
	/** Display name resolved for the entity, when known. */
	displayName?: string;
	/** True when the merge engine created a new entity (vs. matched one). */
	wasCreated?: boolean;
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
// UI Interaction Event Payloads (#8792)
// ============================================================================

/** Who triggered a UI interaction. */
export type InteractionInitiator = "agent" | "user";

/**
 * Payload for {@link EventType.VIEW_SWITCHED} — the active view changed, by the
 * agent (action/evaluator) or the user (tab click, slash navigate, tile tap).
 */
export interface ViewSwitchedPayload extends EventPayload {
	viewId: string;
	viewLabel?: string;
	viewPath?: string | null;
	viewType?: string;
	/** Where the user was before this switch, when known. */
	previousViewId?: string | null;
	initiatedBy: InteractionInitiator;
	/** Room the switch happened in, for room-scoped proactive gating. */
	roomId?: UUID;
	/**
	 * The target view's declared `anticipatoryIntent` (#13587), resolved from the
	 * view registry at emit time. Present only for intent-bearing views; drives
	 * the proactive judge toward a single scoped greeting. Absent → label-only
	 * fallback (judge may stay silent).
	 */
	anticipatoryIntent?: string;
	/** The target view's one-line description, for judge grounding. */
	viewPurpose?: string;
}

/**
 * Payload for {@link EventType.SLASH_COMMAND_INVOKED} — a slash command ran
 * (e.g. `/settings`, `/wallet`). Carries the resolved target so a decider knows
 * whether intent was already expressed (and should usually stay quiet).
 */
export interface SlashCommandInvokedPayload extends EventPayload {
	/** Canonical command name (without the leading slash). */
	command: string;
	args?: string[];
	/** Resolved target kind: navigation, an agent action, or a client behavior. */
	targetKind?: "navigate" | "agent" | "client";
	/** Target view id when the command navigates to a view. */
	viewId?: string;
	initiatedBy: InteractionInitiator;
	roomId?: UUID;
}

/**
 * Payload for {@link EventType.SHORTCUT_FIRED} — a keyboard/UI shortcut fired.
 */
export interface ShortcutFiredPayload extends EventPayload {
	/** Stable shortcut id (e.g. "toggle-voice", "open-command-palette"). */
	shortcutId: string;
	/** Optional free-form context (the surface it fired on). */
	context?: string;
	initiatedBy: InteractionInitiator;
	roomId?: UUID;
}

/** Composer activity states reported by chat surfaces without draft contents. */
export type ComposerActivityKind =
	| "typing_started"
	| "typing_paused"
	| "draft_abandoned";

/**
 * Payload for composer activity events — the user's draft lifecycle in a chat
 * composer. Carries only metadata; the draft text never leaves the client.
 */
export interface ComposerActivityPayload extends EventPayload {
	activity: ComposerActivityKind;
	initiatedBy: "user";
	/** Stable client surface id (e.g. "continuous_chat_overlay"). */
	surface: string;
	/** Conversation or room id the composer is editing, when known. */
	conversationId?: string;
	/** Draft character count after trimming; never the draft text. */
	draftLength: number;
	/** Pause debounce age for typing_paused events. */
	idleForMs?: number;
	/** Why a draft cleared without submission, when known. */
	reason?: "cleared" | "blurred" | "conversation_switched" | "unknown";
	occurredAt: string;
	roomId?: UUID;
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
	[EventType.VOICE_TURN_OBSERVED]: VoiceTurnObservedPayload;
	[EventType.VOICE_ENTITY_BOUND]: VoiceEntityBoundPayload;
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
	[EventType.MODEL_REGISTERED]: ModelRegisteredEventPayload;
	[EventType.EMBEDDING_GENERATION_REQUESTED]: EmbeddingGenerationPayload;
	[EventType.EMBEDDING_GENERATION_COMPLETED]: EmbeddingGenerationPayload;
	[EventType.EMBEDDING_GENERATION_FAILED]: EmbeddingGenerationPayload;
	[EventType.PII_SCRUB_REQUESTED]: PiiScrubRequestPayload;
	[EventType.PII_SCRUB_COMPLETED]: PiiScrubResultPayload;
	[EventType.PII_SCRUB_FAILED]: PiiScrubResultPayload;
	[EventType.ERROR_REPORTED]: ErrorReportedPayload;
	[EventType.CONTROL_MESSAGE]: ControlMessagePayload;
	[EventType.FORM_FIELD_CONFIRMED]: FormFieldEventPayload;
	[EventType.FORM_FIELD_CANCELLED]: FormFieldEventPayload;
	// UI interaction event payloads (#8792)
	[EventType.VIEW_SWITCHED]: ViewSwitchedPayload;
	[EventType.SLASH_COMMAND_INVOKED]: SlashCommandInvokedPayload;
	[EventType.SHORTCUT_FIRED]: ShortcutFiredPayload;
	[EventType.USER_TYPING_STARTED]: ComposerActivityPayload;
	[EventType.USER_TYPING_PAUSED]: ComposerActivityPayload;
	[EventType.USER_DRAFT_ABANDONED]: ComposerActivityPayload;
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
