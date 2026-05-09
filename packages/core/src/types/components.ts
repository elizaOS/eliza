import type {
	AgentContext,
	CacheScope,
	ContextGate,
	RoleGate,
} from "./contexts";
import type { Memory } from "./memory";
import type { Content } from "./primitives";
import type {
	JsonValue,
	ActionExample as ProtoActionExample,
	ActionParameter as ProtoActionParameter,
	ActionParameterSchema as ProtoActionParameterSchema,
	ActionParameters as ProtoActionParametersType,
} from "./proto.js";
import type { IAgentRuntime } from "./runtime";
import type { ActionPlan, State } from "./state";

export type {
	AgentContext,
	CacheScope,
	ContextGate,
	RoleGate,
} from "./contexts";

/**
 * JSON Schema type for action parameter validation.
 * Supports basic JSON Schema properties for parameter definition.
 */
export interface ActionParameterSchema
	extends Omit<
		ProtoActionParameterSchema,
		| "$typeName"
		| "$unknown"
		| "defaultValue"
		| "properties"
		| "items"
		| "enumValues"
		| "required"
		| "type"
	> {
	type: string;
	/** Default value if parameter is not provided */
	default?: JsonValue | null;
	/** For object types, define nested properties */
	properties?: Record<string, ActionParameterSchema>;
	/** Required child property names for object-valued parameters */
	required?: string[];
	/** Whether object-valued parameters allow undeclared properties */
	additionalProperties?: boolean | ActionParameterSchema;
	/** For array types, define the item schema */
	items?: ActionParameterSchema;
	/** Enumerated allowed values (schema-compatible) */
	enumValues?: string[];
	/** Enumerated allowed values */
	enum?: string[];
	/** Minimum string length for string-valued parameters */
	minLength?: number;
	/** Maximum string length for string-valued parameters */
	maxLength?: number;
	/** Regular expression pattern for string-valued parameters */
	pattern?: string;
	/** JSON Schema `oneOf`: value must match exactly one sub-schema */
	oneOf?: ReadonlyArray<ActionParameterSchema>;
	/** JSON Schema `anyOf`: value must match at least one sub-schema */
	anyOf?: ReadonlyArray<ActionParameterSchema>;
}

/**
 * Defines a single parameter for an action.
 * Parameters are extracted from the conversation by the LLM and passed to the action handler.
 */
export interface ActionParameter
	extends Omit<ProtoActionParameter, "$typeName" | "$unknown" | "schema"> {
	/** Parameter name (used as the key in the parameters object) */
	name: string;
	/** Human-readable description for LLM guidance */
	description: string;
	/** Compressed description for prompt-optimized rendering */
	descriptionCompressed?: string;
	/** Alias accepted for plugin compatibility; canonical output uses descriptionCompressed */
	compressedDescription?: string;
	/** Whether this parameter is required (default: false) */
	required?: boolean;
	/** JSON Schema for parameter validation */
	schema: ActionParameterSchema;
	/**
	 * Optional example values for this parameter.
	 * These are shown to the model in action descriptions to improve extraction accuracy.
	 */
	examples?: ActionParameterExampleValue[];
}

/**
 * Primitive value types that can be used in action parameters.
 */
export type ActionParameterValue = string | number | boolean | null;

/**
 * Example value types allowed for action parameter examples.
 * Supports primitives as well as nested objects/arrays for documentation purposes.
 */
export type ActionParameterExampleValue =
	| ActionParameterValue
	| ActionParameters
	| JsonValue
	| ActionParameterValue[]
	| ActionParameters[];

/**
 * Validated parameters passed to an action handler.
 * Keys are parameter names, values are the validated parameter values.
 * Supports nested objects and arrays for complex parameter structures.
 */
export interface ActionParameters {
	[key: string]:
		| ActionParameterValue
		| ActionParameters
		| ActionParameterValue[]
		| ActionParameters[]
		| JsonValue;
}

export type ProtoActionParameters = ProtoActionParametersType;

/**
 * Example content with associated user for demonstration purposes
 */
export interface ActionExample
	extends Omit<ProtoActionExample, "$typeName" | "$unknown" | "content"> {
	content: Content;
}

export type MessageHandlerAction = "RESPOND" | "IGNORE" | "STOP";

export interface MessageHandlerPlan {
	contexts: AgentContext[];
	reply?: string;
	requiresTool?: boolean;
	simple?: boolean;
	contextSlices?: string[];
	candidateActions?: string[];
	parentActionHints?: string[];
	[key: string]: JsonValue | undefined;
}

export interface MessageHandlerExtractedRelationship {
	subject: string;
	predicate: string;
	object: string;
}

export interface MessageHandlerExtract {
	facts?: string[];
	relationships?: MessageHandlerExtractedRelationship[];
	/**
	 * Entities the inbound message is directed at — entity UUIDs or
	 * participant names that the post-parse pipeline resolves to UUIDs.
	 * Empty / omitted means "unknown / not directed at anyone in particular".
	 * Drives the "addressed" relationship edge from speaker → target.
	 */
	addressedTo?: string[];
}

export interface MessageHandlerResult {
	processMessage: MessageHandlerAction;
	plan: MessageHandlerPlan;
	thought: string;
	extract?: MessageHandlerExtract;
}

export type EvaluationDecision = "FINISH" | "NEXT_RECOMMENDED" | "CONTINUE";

export interface EvaluationResult {
	success: boolean;
	decision: EvaluationDecision;
	thought: string;
	messageToUser?: string;
	copyToClipboard?: {
		title: string;
		content: string;
		tags?: string[];
	};
	recommendedToolCallId?: string;
}

/**
 * Callback function type for handlers. actionName is optional so callers can attribute
 * the response to the action that produced it without parsing content (backward compatible).
 */
export type HandlerCallback = (
	response: Content,
	actionName?: string,
) => Promise<Memory[]>;

/**
 * Handler function type for processing messages
 */
export type Handler = (
	runtime: IAgentRuntime,
	message: Memory,
	state?: State,
	options?: HandlerOptions | Record<string, JsonValue | undefined>,
	callback?: HandlerCallback,
	responses?: Memory[],
) => Promise<ActionResult | undefined>;

/**
 * Validator function type for actions/evaluators
 *
 * `options` mirrors {@link Handler}: runtimes may omit it; actions that read
 * structured parameters should treat it as optional.
 */
export type Validator = (
	runtime: IAgentRuntime,
	message: Memory,
	state?: State,
	options?: HandlerOptions | Record<string, JsonValue | undefined>,
) => Promise<boolean>;

/**
 * When an action should fire.
 *
 * Three trigger scopes (ALWAYS / CONTEXT / MESSAGE) × three lifecycle phases
 * (BEFORE / DURING / AFTER) plus the default planner mode. All non-PLANNER
 * modes are hooks; the runtime fires them at fixed positions in the message
 * pipeline.
 *
 * - ALWAYS_*: every message, regardless of routing decision.
 * - CONTEXT_*: only when one of the action's `contexts` was selected by Stage 1.
 * - MESSAGE_*: hooks specifically on the messageHandler model call.
 * - PLANNER (default): planner picks based on user intent.
 *
 * `*_DURING` modes are non-blocking (parallel with the corresponding pipeline
 * step). All other hook modes are blocking.
 *
 * Cache contract: any hook that wants to influence the model prompt MUST use
 * the v5 staged-prefix renderer so Cerebras-style prompt-cache hits stay
 * intact across iterations.
 */
export const ActionMode = {
	PLANNER: "PLANNER",
	ALWAYS_BEFORE: "ALWAYS_BEFORE",
	ALWAYS_DURING: "ALWAYS_DURING",
	ALWAYS_AFTER: "ALWAYS_AFTER",
	CONTEXT_BEFORE: "CONTEXT_BEFORE",
	CONTEXT_DURING: "CONTEXT_DURING",
	CONTEXT_AFTER: "CONTEXT_AFTER",
	RESPONSE_HANDLER_BEFORE: "RESPONSE_HANDLER_BEFORE",
	RESPONSE_HANDLER_DURING: "RESPONSE_HANDLER_DURING",
	RESPONSE_HANDLER_AFTER: "RESPONSE_HANDLER_AFTER",
} as const;
export type ActionMode = (typeof ActionMode)[keyof typeof ActionMode];

/** Hook modes that run in parallel with the corresponding pipeline step. */
export const NON_BLOCKING_MODES = new Set<ActionMode>([
	ActionMode.ALWAYS_DURING,
	ActionMode.CONTEXT_DURING,
	ActionMode.RESPONSE_HANDLER_DURING,
]);

/** All non-PLANNER hook modes, in canonical pipeline order. */
export const HOOK_MODES: readonly ActionMode[] = [
	ActionMode.ALWAYS_BEFORE,
	ActionMode.RESPONSE_HANDLER_BEFORE,
	ActionMode.RESPONSE_HANDLER_DURING,
	ActionMode.RESPONSE_HANDLER_AFTER,
	ActionMode.CONTEXT_BEFORE,
	ActionMode.CONTEXT_DURING,
	ActionMode.CONTEXT_AFTER,
	ActionMode.ALWAYS_DURING,
	ActionMode.ALWAYS_AFTER,
];

/**
 * Represents an action the agent can perform
 */
export interface Action {
	/** Action name */
	name: string;

	/** Detailed description */
	description: string;

	/** Compressed description for prompt-optimized action selection */
	descriptionCompressed?: string;
	/** Alias accepted for plugin compatibility; canonical output uses descriptionCompressed */
	compressedDescription?: string;

	/** Handler function */
	handler: Handler;

	/** Validation function */
	validate: Validator;

	/** Similar action descriptions */
	similes?: string[];

	/** Example usages */
	examples?: ActionExample[][];

	/** Optional priority for action ordering */
	priority?: number;

	/** Optional tags for categorization */
	tags?: string[];

	/**
	 * When true, the message service treats this action as owning the turn
	 * instead of adding extra planner follow-up text after execution.
	 *
	 * Use this for actions that already emit a complete user-facing reply or
	 * that launch asynchronous background work whose progress will continue
	 * outside the current chat turn.
	 */
	suppressPostActionContinuation?: boolean;

	/**
	 * When true, runtime-level action result finalizers must not store this
	 * action's visible result text in task clipboard state.
	 */
	suppressActionResultClipboard?: boolean;

	/**
	 * Optional input parameters for the action.
	 * When defined, the LLM will be prompted to extract these parameters from the conversation
	 * and they will be validated before being passed to the handler via HandlerOptions.parameters.
	 *
	 * Parameters can be required or optional. Optional parameters may have defaults
	 * or can be backfilled inside the action handler if not provided.
	 *
	 * @example
	 * ```typescript
	 * parameters: [
	 *   {
	 *     name: "targetUser",
	 *     description: "The username or ID of the user to send the message to",
	 *     required: true,
	 *     schema: { type: "string" }
	 *   },
	 *   {
	 *     name: "platform",
	 *     description: "The platform to send the message on (telegram, discord, etc)",
	 *     required: false,
	 *     schema: { type: "string", enum: ["telegram", "discord", "x"], default: "telegram" }
	 *   }
	 * ]
	 * ```
	 */
	parameters?: ActionParameter[];

	/**
	 * Domain contexts this action belongs to.
	 * Used by the context-routing classifier to scope the planner's action search.
	 * An action may belong to multiple contexts (e.g., a token-swap action is both
	 * "wallet" and "automation").
	 */
	contexts?: AgentContext[];

	/** Declarative context gate for v5 native tool planning. */
	contextGate?: ContextGate;

	/** Whether prompt/tool metadata for this action is stable enough to cache. */
	cacheStable?: boolean;

	/** Cache partition hint for stable action metadata. */
	cacheScope?: CacheScope;

	/** Optional role gate checked by planners before exposing this action. */
	roleGate?: RoleGate;

	/**
	 * Optional connector account policy checked by planner tool exposure and
	 * again immediately before handler execution. This must not be implemented
	 * only inside validate(); validate is advisory and can be bypassed by native
	 * tool calls.
	 */
	connectorAccountPolicy?:
		| import("../connectors/account-manager").ConnectorAccountPolicy
		| readonly import("../connectors/account-manager").ConnectorAccountPolicy[];

	/** Compatibility alias for early adopters of connectorAccountPolicy. */
	accountPolicy?:
		| import("../connectors/account-manager").ConnectorAccountPolicy
		| readonly import("../connectors/account-manager").ConnectorAccountPolicy[];

	/** Child tool/action names or inline definitions exposed beneath this action. */
	subActions?: Array<string | Action>;

	/** Whether this action should delegate selection to a sub-planner. */
	subPlanner?: boolean | { name?: string; description?: string };

	/**
	 * When this action should fire. Defaults to {@link ActionMode.PLANNER}.
	 * Non-PLANNER values turn the action into a hook that fires at a fixed
	 * pipeline position; see {@link ActionMode} for the full taxonomy.
	 */
	mode?: ActionMode;

	/**
	 * Ordering hint for hook actions sharing the same mode. Lower priority
	 * runs first. Default: 100. Ignored for `*_DURING` modes (parallel) and
	 * for `PLANNER`.
	 */
	modePriority?: number;
}

/**
 * JSON-serializable primitive values.
 * These are the basic types that can be serialized to JSON.
 */
export type JsonPrimitive = string | number | boolean | null;

/**
 * Value types allowed in provider results.
 *
 * This type accepts:
 * - Primitive JSON values (string, number, boolean, null, undefined)
 * - Arrays of values
 * - Any object (Record<string, unknown>)
 *
 * The broad object type (Record<string, unknown>) ensures that domain types
 * like Memory[], Character, Content, etc. are accepted without requiring
 * unsafe 'as unknown as' casts, while still maintaining JSON-serializable
 * semantics at runtime.
 */
export type ProviderValue =
	| JsonPrimitive
	| JsonValue
	| Uint8Array
	| bigint
	| object
	| ProviderValue[]
	| { [key: string]: ProviderValue | undefined }
	| undefined;

/**
 * Data record type that accepts any JSON-serializable values.
 * This is broader than ProviderValue to accommodate domain types
 * like Memory[], Character, Content without requiring casts.
 * The index signature allows dynamic property access.
 */
export type ProviderDataRecord = {
	[key: string]: ProviderValue;
};

/**
 * Result returned by a provider
 */
export interface ProviderResult {
	/** Human-readable text for LLM prompt inclusion */
	text?: string;

	/** Key-value pairs for template variable substitution */
	values?: Record<string, ProviderValue>;

	/**
	 * Structured data for programmatic access by other components.
	 * Accepts JSON-serializable values and domain objects.
	 */
	data?: ProviderDataRecord;
}

/**
 * Provider for external data/services
 */
export interface Provider {
	/** Provider name */
	name: string;

	/** Description of the provider */
	description?: string;

	/** Compressed description for prompt-optimized rendering */
	descriptionCompressed?: string;
	/** Alias accepted for plugin compatibility; canonical output uses descriptionCompressed */
	compressedDescription?: string;

	/** Whether the provider is dynamic */
	dynamic?: boolean;

	/** Position of the provider in the provider list, positive or negative */
	position?: number;

	/**
	 * Whether the provider is private
	 *
	 * Private providers are not displayed in the regular provider list, they have to be called explicitly
	 */
	private?: boolean;

	/** Keywords used to determine relevance for action filtering */
	relevanceKeywords?: string[];

	/**
	 * Domain contexts this provider belongs to.
	 * The context-routing classifier uses these to decide which providers to
	 * include in the planner's state composition for a given turn.
	 */
	contexts?: AgentContext[];

	/** Declarative context gate for v5 provider selection. */
	contextGate?: ContextGate;

	/** Whether this provider's prompt contribution is stable enough to cache. */
	cacheStable?: boolean;

	/** Cache partition hint for stable provider content. */
	cacheScope?: CacheScope;

	/** Optional role gate checked before including this provider. */
	roleGate?: RoleGate;

	/** Child provider/action names exposed beneath this provider, if any. */
	subActions?: string[];

	/** Whether this provider should be composed through a sub-planner. */
	subPlanner?: boolean | { name?: string; description?: string };

	/**
	 * Additional providers that should run alongside this provider when it is
	 * selected by the planner. Use this for provider composition, not semantic
	 * routing.
	 */
	companionProviders?: string[];

	/** Data retrieval function */
	get: (
		runtime: IAgentRuntime,
		message: Memory,
		state: State,
	) => Promise<ProviderResult>;
}

/**
 * Error codes an action handler may set on `ActionResult.values.error` or
 * `ActionResult.data.error` to signal that the next step requires a fresh
 * confirmation message from the user. Native planner execution checks for
 * these (alongside the canonical `requiresConfirmation: true` flag) and
 * pauses the chain so the agent does not spin re-running the same step.
 *
 * Keep this list aligned with `ACTION_CONFIRMATION_STATUS_VALUES` below —
 * both the type and the runtime set are exported so callers (actions,
 * test-spies, downstream packages) can `Set.has(code)` without re-declaring
 * the strings.
 */
export type ActionConfirmationStatus =
	| "CONFIRMATION_REQUIRED"
	| "NOT_CONFIRMED"
	| "REQUIRES_CONFIRMATION"
	| "AWAITING_CONFIRMATION"
	| "NEEDS_CONFIRMATION";

/**
 * Runtime set of {@link ActionConfirmationStatus} values. Frozen so callers
 * cannot mutate the canonical list.
 */
export const ACTION_CONFIRMATION_STATUS_VALUES: ReadonlySet<ActionConfirmationStatus> =
	new Set<ActionConfirmationStatus>([
		"CONFIRMATION_REQUIRED",
		"NOT_CONFIRMED",
		"REQUIRES_CONFIRMATION",
		"AWAITING_CONFIRMATION",
		"NEEDS_CONFIRMATION",
	]);

/**
 * Type-narrowing predicate. Returns true when `value` is a known confirmation
 * status string. Use this on stringly-typed error fields off `ActionResult`.
 */
export function isActionConfirmationStatus(
	value: unknown,
): value is ActionConfirmationStatus {
	return (
		typeof value === "string" &&
		ACTION_CONFIRMATION_STATUS_VALUES.has(value as ActionConfirmationStatus)
	);
}

/**
 * Result returned by an action after execution
 * Used for action chaining and state management
 */
export interface ActionResult {
	/** Whether the action succeeded */
	success: boolean;

	/** Optional text description of the result */
	text?: string;

	/** Values to merge into the state */
	values?: Record<string, ProviderValue>;

	/**
	 * Data payload containing action-specific results.
	 * Accepts any JSON-serializable object values including domain types.
	 */
	data?: ProviderDataRecord;

	/** Error information if the action failed */
	error?: string | Error;

	/** Whether to continue the action chain (for chained actions) */
	continueChain?: boolean;

	/** Optional cleanup function to execute after action completion */
	cleanup?: () => void | Promise<void>;
}

/**
 * Context provided to actions during execution
 * Allows actions to access previous results and execution state
 */
export interface ActionContext {
	/** Results from previously executed actions in this run */
	previousResults: ActionResult[];

	/** Get a specific previous result by action name */
	getPreviousResult?: (actionName: string) => ActionResult | undefined;
}

/**
 * Canonical callback type for streaming response chunks.
 *
 * WHY one type: Before this consolidation the same `(chunk, messageId?) => …`
 * signature was inlined in 8+ locations across runtime, model, message-service,
 * and streaming-context types — with inconsistent return types (`Promise<void>`
 * vs `void | Promise<void>`). Adding data (e.g. `accumulated`) required editing
 * every copy. A single alias eliminates drift and makes future extensions
 * (field name, token index, session handle) a one-line additive change.
 *
 * WHY `accumulated`: Two independent stream extractors in `useModel`
 * previously caused TTS garbling because consumers had to re-derive the full
 * text from deltas — and the two extractors produced deltas at different
 * timings. Providing the authoritative accumulated text from the extractor
 * makes that entire category of reassembly bugs impossible.
 *
 * WHY `void | Promise<void>`: The most permissive return — allows both sync
 * callbacks (simple loggers, test spies) and async ones (network, TTS).
 *
 * @param chunk - Delta text since the last emission for this field.
 * @param messageId - Streaming session / message identifier (UUID or opaque string).
 * @param accumulated - Full extracted text so far for the streaming field.
 *   Present when the emission originates from a structured field extractor.
 *   Undefined for raw-token streams (useModel without an extractor) where no
 *   field-level accumulation exists.
 */
export type StreamChunkCallback = (
	chunk: string,
	messageId?: string,
	accumulated?: string,
) => void | Promise<void>;

/**
 * Options passed to action handlers during execution
 * Provides context about the current execution and queued action plans
 */
export interface HandlerOptions {
	/** Context with previous action results and utilities */
	actionContext?: ActionContext;

	/** Multi-step action plan information */
	actionPlan?: ActionPlan;

	/** Optional stream chunk callback for streaming responses */
	onStreamChunk?: StreamChunkCallback;

	/**
	 * Validated input parameters extracted from the conversation.
	 * Only present when the action defines parameters and they were successfully extracted.
	 *
	 * Parameters are validated against the action's parameter schema before being passed here.
	 * Optional parameters may be undefined if not provided in the conversation.
	 *
	 * @example
	 * ```typescript
	 * handler: async (runtime, message, state, options) => {
	 *   const params = options?.parameters;
	 *   if (params) {
	 *     const targetUser = params.targetUser as string;
	 *     const platform = params.platform as string ?? "telegram"; // backfill default
	 *   }
	 * }
	 * ```
	 */
	parameters?: ActionParameters;

	/**
	 * Parameter validation errors, if the action defined parameters but extraction/validation was incomplete.
	 *
	 * Actions SHOULD handle these errors gracefully (e.g. ask the user for missing required values,
	 * or infer from context when safe).
	 */
	parameterErrors?: string[];

	/** Allow extensions from plugins */
	[key: string]: JsonValue | object | undefined;
}
