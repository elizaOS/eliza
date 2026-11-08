import type { ElizaErrorSeverity } from "../errors";
/**
 * Runtime event system: the `EventType` enum and the per-event payload shapes an
 * agent emits and plugins subscribe to (world/entity/room/message/voice/model/
 * pipeline events). The typed contract that decouples event producers from
 * consumers across the runtime and plugins.
 */
import type { HandlerCallback } from "./components";
import type { Entity, Room, World } from "./environment";
import type { MembershipMutationReceipt, MembershipScope } from "./membership";
import type { Memory } from "./memory";
import type { TurnOutcome } from "./message-service";
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
	MEMBERSHIP_AUTHORITY_CHANGED = "MEMBERSHIP_AUTHORITY_CHANGED",

	// Message events
	MESSAGE_RECEIVED = "MESSAGE_RECEIVED",
	MESSAGE_SENT = "MESSAGE_SENT",
	MESSAGE_DELETED = "MESSAGE_DELETED",
	MESSAGE_MUTATED = "MESSAGE_MUTATED",

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

	// Service instance is available through getService; startup observers finish
	// before callers waiting on getServiceLoadPromise receive the instance.
	SERVICE_STARTED = "SERVICE_STARTED",

	// Embedding events
	EMBEDDING_GENERATION_REQUESTED = "EMBEDDING_GENERATION_REQUESTED",
	EMBEDDING_GENERATION_COMPLETED = "EMBEDDING_GENERATION_COMPLETED",
	EMBEDDING_GENERATION_FAILED = "EMBEDDING_GENERATION_FAILED",

	// PII scrub job events. Trigger event for the async scrub rails -
	// `PiiScrubService` listens for PII_SCRUB_REQUESTED and drains a priority
	// BatchQueue on the core task scheduler (mirrors EMBEDDING_GENERATION_*).
	PII_SCRUB_REQUESTED = "PII_SCRUB_REQUESTED",
	PII_SCRUB_COMPLETED = "PII_SCRUB_COMPLETED",
	PII_SCRUB_FAILED = "PII_SCRUB_FAILED",

	// Error reporting — the general-purpose failure event emitted by
	// `runtime.reportError` for failures outside the action path (providers,
	// services, background jobs, event handlers). Surfaced to the agent via the
	// RECENT_ERRORS provider and used to drive the owner-escalation threshold.
	ERROR_REPORTED = "ERROR_REPORTED",

	// Control events
	CONTROL_MESSAGE = "CONTROL_MESSAGE",

	// Form events
	FORM_FIELD_CONFIRMED = "FORM_FIELD_CONFIRMED",
	FORM_FIELD_CANCELLED = "FORM_FIELD_CANCELLED",

	// UI interaction events — the agent observes shortcuts
	// and view switches (agent- or user-initiated) so a proactive
	// decider can comment on them. Connect-once contract every surface emits.
	VIEW_SWITCHED = "VIEW_SWITCHED",
	SHORTCUT_FIRED = "SHORTCUT_FIRED",
	USER_TYPING_STARTED = "USER_TYPING_STARTED",
	USER_TYPING_PAUSED = "USER_TYPING_PAUSED",
	USER_DRAFT_ABANDONED = "USER_DRAFT_ABANDONED",

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

/** Emitted only after authority commit and local authorization-cache invalidation. */
export interface MembershipAuthorityChangedPayload extends EventPayload {
	scope: MembershipScope;
	receipt: MembershipMutationReceipt;
}

/**
 * Payload for reaction-related events
 */
export interface MessagePayload extends EventPayload {
	message: Memory;
	callback?: HandlerCallback;
	/**
	 * A message emitted from a live message-service run is delivered now but its
	 * trajectory remains owned by the later RUN_ENDED boundary. Absent for
	 * delivery-only producers, where MESSAGE_SENT remains the terminal fallback.
	 */
	trajectoryTerminalOwner?: "run";
}

/**
 * Authoritative connector mutation receipt emitted after an inbox operation
 * commits. Consumers may derive diagnostics or learning signals from it, but
 * must never make the already-committed connector result fail.
 */
export interface MessageMutationPayload extends EventPayload {
	messageSource: string;
	messageId: string;
	operation: "mark_read" | "replied";
	domainEventId: string;
	committedAt: string;
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
export type RunEventStatus = "started" | "timeout" | TurnOutcome["status"];

export interface RunEventPayload extends EventPayload {
	outcome?: TurnOutcome;
	runId: UUID;
	messageId: UUID;
	roomId: UUID;
	entityId: UUID;
	startTime: number | bigint;
	status: RunEventStatus;
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
	/**
	 * Backend that served the request. This is distinct from the plugin source:
	 * the OpenAI-compatible plugin may route to OpenAI, Cerebras, or EvoLink.
	 */
	provider?: string;
	/** Concrete provider model id used for pricing and attribution. */
	model?: string;
	/** Alias of `model` retained for existing trajectory consumers. */
	modelName?: string;
	/** Human-readable logical slot, normally the string form of `type`. */
	modelLabel?: string;
	/** Authoritative provider-reported cost when one is available. */
	costUsd?: number;
	/** True when token counts were estimated instead of provider-reported. */
	usageEstimated?: boolean;
	tokens?: {
		prompt: number;
		completion: number;
		total: number;
		cacheReadInputTokens?: number;
		cacheCreationInputTokens?: number;
		reasoningTokens?: number;
		cachedInputTokens?: number;
		/** Cached input token count. */
		cached?: number;
		estimated?: boolean;
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
 * the async scrub rails. The service hashes `content` into the
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
	severity?: ElizaErrorSeverity;
	context?: Record<string, unknown>;
	runId?: UUID;
	roomId?: UUID;
}

/** Evidence sources accepted by the cross-plugin speaker-name policy. */
export type VoiceSpeakerNameEvidenceSource =
	| "platform_roster"
	| "calendar_attendee"
	| "self_introduction"
	| "user_correction"
	| "voice_profile"
	| "speaker_memory";

/** One inspectable source behind a speaker-name candidate. */
export interface VoiceSpeakerNameProvenancePayload {
	source: VoiceSpeakerNameEvidenceSource;
	confidence: number;
	evidenceId?: string;
	entityId?: string;
	profileId?: string;
	observedAt?: string;
}

/** Candidate retained for review when the policy cannot confirm a name. */
export interface VoiceSpeakerNameCandidatePayload {
	name: string;
	normalizedName: string;
	confidence: number;
	sources: VoiceSpeakerNameEvidenceSource[];
	provenance: VoiceSpeakerNameProvenancePayload[];
}

/**
 * Transport-safe result of the deterministic speaker-name policy.
 *
 * The producer owns evidence collection and policy evaluation. The entity
 * graph consumes only a confirmed decision; review, withheld, and unknown
 * decisions remain inspectable without creating or rebinding an identity.
 */
export interface VoiceSpeakerNameInferencePayload {
	resolution: "confirmed" | "needs_confirmation" | "withheld" | "unknown";
	displayName?: string;
	confidence: number;
	candidateNames: VoiceSpeakerNameCandidatePayload[];
	provenance: VoiceSpeakerNameProvenancePayload[];
	reasonCodes: string[];
	requiresReview: boolean;
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
	/**
	 * Evaluated name provenance for an explicit correction or meeting speaker.
	 * When present, consumers must bind only `resolution: "confirmed"` and must
	 * not infer identity again from the display text.
	 */
	speakerNameInference?: VoiceSpeakerNameInferencePayload;
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
	/** Name decision persisted alongside the voice-profile binding. */
	speakerNameInference?: VoiceSpeakerNameInferencePayload;
}

export interface FormFieldEventPayload extends EventPayload {
	sessionId: string;
	entityId: UUID;
	field: string;
	value?: JsonValue;
	externalData?: JsonValue;
	reason?: string;
}

// UI Interaction Event Payloads

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
	 * The target view's declared `anticipatoryIntent`, resolved from the
	 * view registry at emit time. Present only for intent-bearing views; drives
	 * the proactive judge toward a single scoped greeting. Absent → label-only
	 * fallback (judge may stay silent).
	 */
	anticipatoryIntent?: string;
	/** The target view's one-line description, for judge grounding. */
	viewPurpose?: string;
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
	/** Stable client surface id (e.g. "chat_overlay"). */
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
	[EventType.MEMBERSHIP_AUTHORITY_CHANGED]: MembershipAuthorityChangedPayload;
	[EventType.MESSAGE_RECEIVED]: MessagePayload;
	[EventType.MESSAGE_SENT]: MessagePayload;
	[EventType.MESSAGE_DELETED]: MessagePayload;
	[EventType.MESSAGE_MUTATED]: MessageMutationPayload;
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
	[EventType.SERVICE_STARTED]: EventPayload & { serviceType: string };
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
	// UI interaction event payloads
	[EventType.VIEW_SWITCHED]: ViewSwitchedPayload;
	[EventType.SHORTCUT_FIRED]: ShortcutFiredPayload;
	[EventType.USER_TYPING_STARTED]: ComposerActivityPayload;
	[EventType.USER_TYPING_PAUSED]: ComposerActivityPayload;
	[EventType.USER_DRAFT_ABANDONED]: ComposerActivityPayload;
	// Hook system event payloads
	[EventType.PIPELINE_HOOK_METRIC]: PipelineHookMetricPayload;
}

/**
 * Event handler function type
 */
export type EventHandler<T extends keyof EventPayloadMap> = (
	payload: EventPayloadMap[T],
) => Promise<void>;
