import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { v4 as uuidv4 } from "uuid";

interface WorkingMemoryEntry {
	actionName: string;
	result: ActionResult;
	timestamp: number;
}

import Handlebars from "handlebars";
import {
	withCanonicalActionDocs,
	withCanonicalEvaluatorDocs,
	withCanonicalProviderDocs,
} from "./action-docs";
import { parseActionParams, validateActionParams } from "./actions";
import { ensureConnection as ensureConnectionStandalone } from "./connection";
import { InMemoryDatabaseAdapter } from "./database/inMemoryAdapter";
import { createTaskClipboardService } from "./features/advanced-capabilities/clipboard/services/taskClipboardService";
import { createAdvancedMemoryPlugin } from "./features/advanced-memory/index";
import {
	type CapabilityConfig,
	createBasicCapabilitiesPlugin,
} from "./features/basic-capabilities/index";
import { createLogger } from "./logger";
import { simpleHash } from "./optimization/ab-analysis";
import { getOptimizationRootDir } from "./optimization-root-dir";
import { installRuntimePluginLifecycle } from "./plugin-lifecycle";
import {
	getNativeRuntimeFeaturePlugin,
	type NativeRuntimeFeature,
	nativeRuntimeFeatureDefaults,
	nativeRuntimeFeaturePluginNames,
	resolveNativeRuntimeFeatureFromPluginName,
} from "./plugins/native-features";
import { BM25 } from "./search";
import { redactWithSecrets } from "./security/redact.js";
import { DefaultMessageService } from "./services/message";
import type { ToolPolicyService } from "./services/tool-policy";
import { decryptSecret, getSalt } from "./settings";
import {
	getStreamingContext,
	runInsideModelStreamChunkDelivery,
	runWithStreamingContext,
	type StreamingContext,
} from "./streaming-context";
import {
	getTrajectoryContext,
	setTrajectoryPurpose,
} from "./trajectory-context";
import {
	withActionStep,
	withEvaluatorStep,
	withProviderStep,
} from "./trajectory-utils";
import {
	type Action,
	type ActionContext,
	type ActionResult,
	type Agent,
	ChannelType,
	type Character,
	type Component,
	type Content,
	type ControlMessage,
	type Entity,
	type Evaluator,
	type EventHandler,
	type EventPayload,
	type EventPayloadMap,
	EventType,
	type GenerateTextOptions,
	type GenerateTextParams,
	type GenerateTextResult,
	getModelFallbackChain,
	type HandlerCallback,
	type HandlerOptions,
	type IAgentRuntime,
	type IDatabaseAdapter,
	type IMessagingAdapter,
	type JsonValue,
	type Log,
	type LogBody,
	type Memory,
	type MemoryMetadata,
	type MessageConnector,
	type MessageConnectorMetadata,
	type MessageConnectorRegistration,
	type Metadata,
	type ModelHandler,
	type ModelParamsMap,
	type ModelResultMap,
	ModelType,
	type ModelTypeName,
	type PairingAllowlistEntry,
	type PairingChannel,
	type PairingRequest,
	type Participant,
	type PatchOp,
	type PipelineHookContext,
	type PipelineHookPhase,
	type PipelineHookSpec,
	type Plugin,
	type PluginOwnership,
	type PromptSegment,
	type Provider,
	type ProviderResult,
	type ProviderValue,
	type Relationship,
	type ResolvedPipelineHook,
	type Room,
	type Route,
	type RuntimeEventStorage,
	type RuntimeSettings,
	type SendHandlerFunction,
	type Service,
	type ServiceClass,
	type ServiceTypeName,
	type State,
	type StateValue,
	type StreamChunkCallback,
	type TargetInfo,
	type Task,
	type TaskWorker,
	type TextGenerationModelType,
	type TextStreamResult,
	type UUID,
	type World,
} from "./types";
import type { IMessageService } from "./types/message-service";
import {
	afterMemoryPersistedPipelineHookContext,
	modelStreamChunkPipelineHookContext,
	modelStreamEndPipelineHookContext,
	outgoingPipelineHookContext,
	PIPELINE_HOOK_DEBUG_LOG_MS,
	PIPELINE_HOOK_ERROR_LOG_MS,
	PIPELINE_HOOK_WARN_MS,
	pipelineHookMetricRoomId,
	postModelPipelineHookContext,
	preModelPipelineHookContext,
	resolvePipelineHookSpec,
	sortPipelineHooksByPosition,
} from "./types/pipeline-hooks";
import type { PromptOptimizationRuntimeHooks } from "./types/prompt-optimization-hooks";
import { ScoreCard } from "./types/prompt-optimization-score-card";
import type {
	ExecutionTrace,
	ScoreSignal,
} from "./types/prompt-optimization-trace";
import {
	type SearchCategoryEnumerationOptions,
	type SearchCategoryLookupOptions,
	type SearchCategoryRegistration,
	SearchCategoryRegistryError,
} from "./types/search";
import type {
	RetryBackoffConfig,
	SchemaRow,
	SchemaValueSpec,
	StreamEvent,
	StructuredOutputFailure,
} from "./types/state";
import type { ToolPolicyConfig, ToolProfileId } from "./types/tools";
import {
	parseJSONObjectFromText,
	parseToonKeyValue,
	stringToUuid,
} from "./utils";
import {
	collectActionResultSizeWarnings,
	getActionResultActionName,
	getActionResultReference,
	MAX_ACTION_RESULT_ERROR_CHARS,
	MAX_ACTION_RESULT_TEXT_CHARS,
	stringifyActionResultError,
	trimActionResultForPromptState,
} from "./utils/action-results";
import { parseBooleanValue } from "./utils/boolean";
import { BufferUtils } from "./utils/buffer";
import { resolveProviderContexts } from "./utils/context-catalog";
import {
	getActiveRoutingContextsForTurn,
	shouldIncludeByContext,
} from "./utils/context-routing";
import { buildDeterministicSeed } from "./utils/deterministic";
import { getNumberEnv } from "./utils/environment";
import { getErrorMessage, isTransientModelError } from "./utils/model-errors";
import { resolveStateDir } from "./utils/state-dir";
import {
	ActionStreamFilter,
	ToonFieldStreamExtractor,
} from "./utils/streaming";
import { encodeToonValue } from "./utils/toon";
import { isPlainObject } from "./utils/type-guards";

const environmentSettings: RuntimeSettings = {};
const RUNTIME_TEMPLATE_CACHE = new Map<
	string,
	Handlebars.TemplateDelegate<Record<string, unknown>>
>();
const RUNTIME_TEMPLATE_CACHE_LIMIT = 256;
const PROVIDERS_PROMPT_MARKER = "__ELIZA_PROMPT_SEGMENT_PROVIDERS__";
const COMPOSE_STATE_PROVIDER_TIMEOUT_MS = 30_000;
const STABLE_PROMPT_TEMPLATE_KEYS = new Set([
	"agentName",
	"bio",
	"system",
	"topic",
	"topics",
	"adjective",
	"messageDirections",
	"postDirections",
	"directions",
	"examples",
	"characterPostExamples",
	"characterMessageExamples",
	"actionNames",
	"actionsWithDescriptions",
	"providersWithDescriptions",
]);
const STABLE_PROMPT_PROVIDER_NAMES = new Set([
	"ACTIONS",
	"CHARACTER",
	"PROVIDERS",
]);
const STRUCTURED_CODE_FENCE_PATTERN = /```([^\n`]*)\r?\n?([\s\S]*?)```/g;
const TOON_HEADER_PATTERN = /^TOON(?:\s+DOCUMENT)?[:\s-]*$/i;
const TOON_FIELD_PATTERN =
	/^[A-Za-z_][A-Za-z0-9_.-]*(?:\[[^\]\n]*\])?(?:\{[^\n]*\})?:/m;
const JSON_OBJECT_KEY_PATTERN =
	/(?:["'][^"'\n]+["']|[A-Za-z_][A-Za-z0-9_-]*)\s*:/;
const WEB_SEARCH_SERVICE_TYPE = "web_search";
const INTENTIONAL_MULTI_SERVICE_TYPES = new Set<string>([
	"wallet",
	"lp_pool",
	"token_data",
	"trajectories",
]);

/**
 * Thrown by `AgentRuntime.useModel` when a text-generation model is requested
 * but no LLM provider plugin is registered for any text model type at all.
 *
 * This is distinct from "one provider is registered but the specific type is
 * missing" — that case still throws the generic `No handler found for delegate
 * type` error so legitimate misconfigurations stay loud.
 *
 * Surfacing this as a typed error lets the chat layer render an actionable
 * hint instead of a generic parse-failure template. See issue elizaOS/eliza#7203.
 */
export class NoModelProviderConfiguredError extends Error {
	constructor(
		message: string = "This agent has no LLM provider configured. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or OPENROUTER_API_KEY in your environment, or sign in to Eliza Cloud (ELIZAOS_CLOUD_API_KEY).",
	) {
		super(message);
		this.name = "NoModelProviderConfiguredError";
	}
}

const TEXT_GENERATION_MODEL_KEYS: readonly string[] = [
	ModelType.TEXT_NANO,
	ModelType.TEXT_SMALL,
	ModelType.TEXT_MEDIUM,
	ModelType.TEXT_LARGE,
	ModelType.TEXT_MEGA,
	ModelType.RESPONSE_HANDLER,
	ModelType.ACTION_PLANNER,
	ModelType.TEXT_COMPLETION,
];

type StructuredResponseFormat = "JSON" | "TOON";

type StructuredResponseCandidate = {
	text: string;
	formats: StructuredResponseFormat[];
	source: string;
};

type DynamicPromptStreamExtractor = ToonFieldStreamExtractor;
type DynamicPromptRetryOptions = {
	abortSignal?: AbortSignal;
	retryBackoff?: number | RetryBackoffConfig;
};

function coerceOutgoingMessageText(text: unknown): string {
	if (text === null || text === undefined) {
		return "";
	}
	return String(text);
}

function resolveDynamicPromptModelType(
	modelType?: TextGenerationModelType,
	modelSize?: "nano" | "small" | "medium" | "large" | "mega",
): TextGenerationModelType {
	if (modelType) {
		return modelType;
	}

	switch (modelSize) {
		case "nano":
			return ModelType.TEXT_NANO;
		case "small":
			return ModelType.TEXT_SMALL;
		case "medium":
			return ModelType.TEXT_MEDIUM;
		case "mega":
			return ModelType.TEXT_MEGA;
		default:
			return ModelType.TEXT_LARGE;
	}
}

/**
 * Resolves the default structured-output format from a setting value.
 * Used by `dynamicPromptExecFromState` when no per-call preference is given.
 * Accepts `toon` or `json` (case-insensitive); anything else → TOON.
 */
export function resolveDefaultOutputFormat(
	raw: unknown,
): StructuredResponseFormat {
	if (typeof raw !== "string") return "TOON";
	switch (raw.trim().toLowerCase()) {
		case "json":
			return "JSON";
		case "toon":
			return "TOON";
		default:
			return "TOON";
	}
}

type ServiceResolver = (service: Service) => void;
type ServiceRejecter = (reason: Error | string) => void;
type ServicePromiseHandler = {
	resolve: ServiceResolver;
	reject: ServiceRejecter;
};

function isTextStreamResult(
	value: JsonValue | object,
): value is TextStreamResult {
	return (
		typeof value === "object" &&
		value !== null &&
		"textStream" in value &&
		"text" in value &&
		"usage" in value &&
		"finishReason" in value
	);
}

function callbackContentHasVisibleOutput(content: Content): boolean {
	if (typeof content.text === "string" && content.text.trim().length > 0) {
		return true;
	}
	return Array.isArray(content.attachments) && content.attachments.length > 0;
}

function suppressesVisibleActionResult(actionResult: ActionResult | undefined) {
	return actionResult?.data?.suppressVisibleCallback === true;
}

const ACTION_RESULT_CLIPBOARD_FLAGS = [
	"addToClipboard",
	"copyToClipboard",
	"persistToClipboard",
	"saveToClipboard",
] as const;
const ACTION_RESULT_CLIPBOARD_SUPPRESS_FLAGS = [
	"suppressActionResultClipboard",
	"suppressClipboard",
] as const;
const TERMINAL_ACTION_RESULT_NAMES = new Set([
	"REPLY",
	"RESPOND",
	"IGNORE",
	"STOP",
	"NONE",
]);
const ACTION_RESULT_CLIPBOARD_TEXT_PATTERN =
	/\b(copy|save|store|keep|persist|put)\b[\s\S]{0,80}\b(?:to|in|into|on)?\s*(?:the\s*)?clipboard\b/i;
const CLIPBOARD_ACTION_RESULT_TEXT_PATTERN =
	/\bclipboard\b[\s\S]{0,80}\b(copy|save|store|keep|persist)\b/i;
const ACTION_RESULT_CLIPBOARD_NEGATION_PATTERN =
	/\b(?:do\s+not|don't|dont|never|without)\b[\s\S]{0,80}\b(copy|save|store|keep|persist|put)\b[\s\S]{0,80}\bclipboard\b/i;

type ActionResultClipboardStatus = {
	text: string;
};

function isTruthyClipboardFlag(value: unknown): boolean {
	if (value === true) {
		return true;
	}
	if (typeof value === "string") {
		return /^(true|1|yes|y|on)$/i.test(value.trim());
	}
	return false;
}

function normalizeActionResultName(value: string): string {
	return value
		.trim()
		.replace(/[\s-]+/g, "_")
		.toUpperCase();
}

function isTerminalActionResultName(actionName: string): boolean {
	return TERMINAL_ACTION_RESULT_NAMES.has(
		normalizeActionResultName(actionName),
	);
}

function contentHasTruthyFlag(
	content: Content,
	flags: readonly string[],
): boolean {
	return flags.some((flag) => isTruthyClipboardFlag(content[flag]));
}

function actionResultDataHasTruthyFlag(
	actionResult: ActionResult | undefined,
	flags: readonly string[],
): boolean {
	return flags.some((flag) =>
		isTruthyClipboardFlag(actionResult?.data?.[flag]),
	);
}

function messageRequestsActionResultClipboard(message: Memory): boolean {
	if (contentHasTruthyFlag(message.content, ACTION_RESULT_CLIPBOARD_FLAGS)) {
		return true;
	}

	const text = message.content.text;
	if (typeof text !== "string" || !text.trim()) {
		return false;
	}

	if (ACTION_RESULT_CLIPBOARD_NEGATION_PATTERN.test(text)) {
		return false;
	}

	return (
		ACTION_RESULT_CLIPBOARD_TEXT_PATTERN.test(text) ||
		CLIPBOARD_ACTION_RESULT_TEXT_PATTERN.test(text)
	);
}

function actionResultRequestsClipboard(
	actionResult: ActionResult | undefined,
): boolean {
	return actionResultDataHasTruthyFlag(
		actionResult,
		ACTION_RESULT_CLIPBOARD_FLAGS,
	);
}

function suppressesActionResultClipboard(
	action: Action,
	actionResult: ActionResult | undefined,
): boolean {
	return (
		action.suppressActionResultClipboard === true ||
		actionResultDataHasTruthyFlag(
			actionResult,
			ACTION_RESULT_CLIPBOARD_SUPPRESS_FLAGS,
		)
	);
}

function stringFromContent(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function resolveActionResultClipboardTitle(
	message: Memory,
	action: Action,
	actionResult: ActionResult | undefined,
): string {
	return (
		stringFromContent(actionResult?.data?.clipboardTitle) ??
		stringFromContent(message.content.clipboardTitle) ??
		stringFromContent(message.content.title) ??
		`${action.name} result`
	);
}

function safeActionResultFilePart(value: string | undefined): string {
	const normalized =
		value?.trim().replace(/[^a-zA-Z0-9._-]/g, "_") || "unknown";
	return normalized.slice(0, 80) || "unknown";
}

function getSearchCategoryKey(category: string): string {
	return category.trim().toLowerCase();
}

function cloneSearchCategoryRegistration(
	registration: SearchCategoryRegistration,
): SearchCategoryRegistration {
	return {
		...registration,
		contexts: registration.contexts ? [...registration.contexts] : undefined,
		filters: registration.filters?.map((filter) => ({
			...filter,
			options: filter.options?.map((option) => ({ ...option })),
		})),
		capabilities: registration.capabilities
			? [...registration.capabilities]
			: undefined,
	};
}

function normalizeSearchCategoryRegistration(
	registration: SearchCategoryRegistration,
): SearchCategoryRegistration {
	const category =
		typeof registration.category === "string"
			? registration.category.trim()
			: "";
	const label =
		typeof registration.label === "string" ? registration.label.trim() : "";
	if (!category) {
		throw new Error("Search category registration requires a category");
	}
	if (!label) {
		throw new Error("Search category registration requires a label");
	}
	return cloneSearchCategoryRegistration({
		...registration,
		category,
		label,
		enabled: registration.enabled ?? true,
	});
}

function labelFromMessageConnectorSource(source: string): string {
	const label = source
		.replace(/[_-]+/g, " ")
		.trim()
		.replace(/\b\w/g, (char) => char.toUpperCase());
	return label || "Message Connector";
}

function cloneMessageConnector(connector: MessageConnector): MessageConnector {
	return {
		...connector,
		capabilities: [...connector.capabilities],
		supportedTargetKinds: [...connector.supportedTargetKinds],
		contexts: [...connector.contexts],
		metadata: connector.metadata ? { ...connector.metadata } : undefined,
	};
}

function normalizeMessageConnector(
	source: string,
	metadata: MessageConnectorMetadata = {},
): MessageConnector {
	const connector: MessageConnector = {
		source,
		label: metadata.label?.trim() || labelFromMessageConnectorSource(source),
		capabilities: metadata.capabilities
			? [...metadata.capabilities]
			: ["send_message"],
		supportedTargetKinds: metadata.supportedTargetKinds
			? [...metadata.supportedTargetKinds]
			: [],
		contexts: metadata.contexts ? [...metadata.contexts] : [],
	};

	if (metadata.description) connector.description = metadata.description;
	if (metadata.metadata) connector.metadata = { ...metadata.metadata };
	if (metadata.resolveTargets)
		connector.resolveTargets = metadata.resolveTargets;
	if (metadata.listRecentTargets)
		connector.listRecentTargets = metadata.listRecentTargets;
	if (metadata.listRooms) connector.listRooms = metadata.listRooms;
	if (metadata.getChatContext)
		connector.getChatContext = metadata.getChatContext;
	if (metadata.getUserContext)
		connector.getUserContext = metadata.getUserContext;

	return connector;
}

function getServiceClassLabel(serviceClass: ServiceClass): string {
	return (
		(serviceClass as { name?: string }).name ||
		serviceClass.constructor?.name ||
		"anonymous service class"
	);
}

export class AgentRuntime implements IAgentRuntime {
	#conversationLength = 100 as number;
	readonly agentId: UUID;
	readonly character: Character;
	public adapter!: IDatabaseAdapter;
	static #anonymousAgentCounter = 0;
	readonly actions: Action[] = [];
	readonly evaluators: Evaluator[] = [];
	readonly providers: Provider[] = [];
	readonly plugins: Plugin[] = [];
	public unloadPlugin!: (pluginName: string) => Promise<PluginOwnership | null>;
	public reloadPlugin!: (plugin: Plugin) => Promise<void>;
	public applyPluginConfig!: (
		pluginName: string,
		config: Record<string, string>,
	) => Promise<boolean>;
	public getPluginOwnership!: (pluginName: string) => PluginOwnership | null;
	public getAllPluginOwnership!: () => PluginOwnership[];
	events: RuntimeEventStorage = {};
	stateCache = new Map<string, State>();
	readonly fetch = fetch;
	services = new Map<ServiceTypeName, Service[]>();
	private serviceTypes = new Map<ServiceTypeName, ServiceClass[]>();
	models = new Map<string, ModelHandler[]>();
	routes: Route[] = [];
	private taskWorkers = new Map<string, TaskWorker>();
	private sendHandlers = new Map<string, SendHandlerFunction>();
	private messageConnectors = new Map<string, MessageConnector>();
	private searchCategories = new Map<string, SearchCategoryRegistration>();
	private eventHandlers: Map<string, Array<(data: EventPayload) => void>> =
		new Map();

	/**
	 * In-flight execution traces keyed by trace.id (unique uuid).
	 * A single run can produce multiple DPE calls; each gets its own trace.
	 * `runToTraces` maps runId -> set of trace ids for enrichment lookup.
	 */
	private activeTraces = new Map<string, ExecutionTrace>();
	private runToTraces = new Map<string, Set<string>>();
	/** Optional DPE-side prompt optimization I/O (merge, registry, baseline/failure traces). */
	private promptOptimizationHooks: PromptOptimizationRuntimeHooks | null = null;

	private pipelineHookEntries: ResolvedPipelineHook[] = [];
	private pipelineHookIdToIndex = new Map<string, number>();

	// A map of all plugins available to the runtime, keyed by name, for dependency resolution.
	private allAvailablePlugins = new Map<string, Plugin>();
	// The initial list of plugins specified by the character configuration.
	private characterPlugins: Plugin[] = [];
	// Capability options for basic capabilities configuration
	private capabilityOptions: CapabilityConfig = {};
	private readonly nativeFeatureOptions: Partial<
		Record<NativeRuntimeFeature, boolean>
	>;
	// Action planning option (undefined means use settings, true/false is explicit)
	private actionPlanningOption?: boolean;
	// LLM mode option for overriding model selection (undefined means use settings)
	private llmModeOption?: import("./types").LLMModeType;
	// Check should respond option (undefined means use settings, defaults to true)
	private checkShouldRespondOption?: boolean;
	// Flag to track if the character was auto-generated (no character provided)
	private isAnonymousCharacter = false;

	public logger;
	public enableAutonomy: boolean;
	private settings: RuntimeSettings;
	private servicePromiseHandlers = new Map<string, ServicePromiseHandler>(); // Combined handlers for resolve/reject
	private servicePromises = new Map<string, Promise<Service>>(); // read
	/** In-flight service start promises; dedupes concurrent getService() for the same type. */
	private startingServices = new Map<string, Promise<Service | null>>();
	private serviceRegistrationStatus = new Map<
		ServiceTypeName,
		"pending" | "registering" | "registered" | "failed"
	>(); // status tracking
	public initPromise: Promise<void>;
	private initResolver:
		| ((value?: void | PromiseLike<void>) => void)
		| undefined;
	private currentRunId?: UUID; // Track the current run ID
	private currentRoomId?: UUID; // Track the current room for logging
	private currentActionContext?: {
		// Track current action execution context
		actionName: string;
		actionId: UUID;
		prompts: Array<{
			modelType: string;
			prompt: string;
			timestamp: number;
		}>;
	};
	private maxWorkingMemoryEntries: number = 50; // Default value, can be overridden
	public messageService: IMessageService | null = null; // Lazily initialized
	public companionUrl?: string;
	/** Set when stop() has been called; prevents new service starts and use-after-stop. */
	private stopped = false;

	constructor(opts: {
		conversationLength?: number;
		agentId?: UUID;
		/** Optional character configuration. If not provided, an anonymous character is created. */
		character?: Character;
		plugins?: Plugin[];
		fetch?: typeof fetch;
		/** Database adapter. Use InMemoryDatabaseAdapter for in-memory-only runs. WHY: Caller owns DB lifecycle; no plugin registration race; single source of truth. */
		adapter?: IDatabaseAdapter;
		settings?: RuntimeSettings;
		allAvailablePlugins?: Plugin[];
		/**
		 * Log level for this runtime. Defaults to "error".
		 * Valid levels: "trace", "debug", "info", "warn", "error", "fatal"
		 */
		logLevel?: "trace" | "debug" | "info" | "warn" | "error" | "fatal";
		/** Disable basic basic-capabilities capabilities (reply, ignore, none, core providers) */
		disableBasicCapabilities?: boolean;
		/** Enable extended/advanced basic-capabilities capabilities (facts, roles, settings, room actions, etc.) */
		enableExtendedCapabilities?: boolean;
		/** Alias for enableExtendedCapabilities - Enable advanced basic-capabilities capabilities */
		advancedCapabilities?: boolean;
		/**
		 * Enable action planning mode for multi-action execution.
		 * When true (default), agent can plan and execute multiple actions per response.
		 * When false, agent executes only a single action per response (performance optimization
		 * useful for game situations where state updates with every action).
		 */
		actionPlanning?: boolean;
		/**
		 * LLM mode for overriding model selection.
		 * - "DEFAULT": Use the model type specified in the useModel call (no override)
		 * - "SMALL": Override all text generation model calls to use TEXT_SMALL
		 * - "LARGE": Override all text generation model calls to use TEXT_LARGE
		 *
		 * This is useful for cost optimization (force SMALL) or quality (force LARGE).
		 * While not recommended for production, it can be a fast way to make the agent run cheaper.
		 */
		llmMode?: import("./types").LLMModeType;
		/**
		 * Enable or disable the shouldRespond evaluation.
		 * When true (default), the agent evaluates whether to respond to each message.
		 * When false, the agent always responds (ChatGPT mode) - useful for direct chat interfaces.
		 */
		checkShouldRespond?: boolean;
		/**
		 * Enable autonomy capabilities for autonomous agent operation.
		 * When true, the agent can operate autonomously with its own thinking loop,
		 * communicating with admin users and running continuous background processing.
		 * Can be enabled at construction time or lazily via settings.
		 */
		enableAutonomy?: boolean;
		/** Enable trust engine, security, and permissions infrastructure. */
		enableTrust?: boolean;
		/** Enable encrypted secrets management and dynamic plugin activation. */
		enableSecretsManager?: boolean;
		/** Enable plugin introspection, install/eject/sync. */
		enablePluginManager?: boolean;
		enableKnowledge?: boolean;
		enableRelationships?: boolean;
		enableTrajectories?: boolean;
		/** Optional URL of a long-lived companion runtime for fire-and-forget embedding/task work. WHY: Thin runtimes (e.g. serverless) delegate embeddings and task-dirty notifications without blocking. */
		companionUrl?: string;
	}) {
		// Create default anonymous character if none provided
		let character: Character;
		if (opts.character) {
			character = opts.character;
			this.isAnonymousCharacter = false;
		} else {
			AgentRuntime.#anonymousAgentCounter++;
			character = {
				name: `Agent-${AgentRuntime.#anonymousAgentCounter}`,
				bio: ["An anonymous agent"],
				templates: {},
				messageExamples: [],
				postExamples: [],
				topics: [],
				adjectives: [],
				knowledge: [],
				plugins: [],
				secrets: {},
			};
			this.isAnonymousCharacter = true;
		}

		// Store capability options for use in initialize()
		// When character is anonymous, also signal to skip the character provider
		// Support both enableExtendedCapabilities and advancedCapabilities as aliases
		this.capabilityOptions = {
			disableBasic: opts.disableBasicCapabilities,
			enableExtended: opts.enableExtendedCapabilities,
			advancedCapabilities: opts.advancedCapabilities,
			skipCharacterProvider: this.isAnonymousCharacter,
			enableAutonomy: opts.enableAutonomy,
			enableTrust: opts.enableTrust,
			enableSecretsManager: opts.enableSecretsManager,
			enablePluginManager: opts.enablePluginManager,
		};
		this.nativeFeatureOptions = {
			knowledge: opts.enableKnowledge,
			relationships: opts.enableRelationships,
			trajectories: opts.enableTrajectories,
		};
		// Generate deterministic UUID from character name
		// Falls back to random UUID only if no character name is provided
		this.agentId =
			character.id ?? opts.agentId ?? stringToUuid(character.name ?? uuidv4());
		this.character = character;

		this.initPromise = new Promise((resolve) => {
			this.initResolver = resolve;
		});

		// Create the logger with namespace and log level (defaults to "error")
		this.logger = createLogger({
			namespace: `agent:${character.name ?? "unknown"}`,
			level: opts.logLevel ?? "error",
		});

		// Set conversation length from constructor, settings, or environment
		if (opts.conversationLength !== undefined) {
			this.#conversationLength = opts.conversationLength;
		} else if (opts.settings?.CONVERSATION_LENGTH) {
			this.#conversationLength =
				parseInt(String(opts.settings.CONVERSATION_LENGTH), 10) || 100;
		} else {
			this.#conversationLength = getNumberEnv(
				"CONVERSATION_LENGTH",
				100,
			) as number;
		}
		if (opts.adapter) {
			this.registerDatabaseAdapter(opts.adapter);
		}
		this.companionUrl = opts.companionUrl;
		this.fetch = (opts.fetch as typeof fetch) ?? this.fetch;
		this.settings = opts.settings ?? environmentSettings;
		const enableAutonomyFromSettings =
			this.character.settings?.ENABLE_AUTONOMY === true ||
			this.character.settings?.ENABLE_AUTONOMY === "true";
		this.enableAutonomy = opts.enableAutonomy ?? enableAutonomyFromSettings;

		this.plugins = []; // Initialize plugins as an empty array
		this.characterPlugins = opts.plugins ?? []; // Store the original character plugins

		// Store action planning option (undefined means check settings at runtime)
		this.actionPlanningOption = opts.actionPlanning;
		// Store LLM mode option (undefined means check settings at runtime)
		this.llmModeOption = opts.llmMode;
		// Store checkShouldRespond option (undefined means check settings at runtime)
		this.checkShouldRespondOption = opts.checkShouldRespond;

		if (opts.allAvailablePlugins) {
			for (const plugin of opts.allAvailablePlugins) {
				if (plugin.name) {
					this.allAvailablePlugins.set(plugin.name, plugin);
				}
			}
		}

		this.logger.debug(
			{ src: "agent", agentId: this.agentId, agentName: this.character.name },
			"Initialized",
		);
		this.currentRunId = undefined; // Initialize run ID tracker

		// Set max working memory entries from settings or environment
		if (opts.settings?.MAX_WORKING_MEMORY_ENTRIES) {
			this.maxWorkingMemoryEntries =
				parseInt(String(opts.settings.MAX_WORKING_MEMORY_ENTRIES), 10) || 50;
		} else {
			this.maxWorkingMemoryEntries = getNumberEnv(
				"MAX_WORKING_MEMORY_ENTRIES",
				50,
			) as number;
		}

		installRuntimePluginLifecycle(this);
	}

	private warnOnDuplicateServiceTypeRegistration(
		serviceType: ServiceTypeName | string,
		serviceClass: ServiceClass,
		existingServiceClasses: ServiceClass[],
		pluginName?: string,
	): void {
		if (
			existingServiceClasses.length === 0 ||
			INTENTIONAL_MULTI_SERVICE_TYPES.has(String(serviceType))
		) {
			return;
		}

		this.logger.warn(
			{
				src: "agent",
				agentId: this.agentId,
				plugin: pluginName,
				serviceType,
				serviceClass: getServiceClassLabel(serviceClass),
				existingServiceClasses:
					existingServiceClasses.map(getServiceClassLabel),
			},
			"Duplicate serviceType registration can make getService() ambiguous; use a distinct serviceType or getServicesByType()",
		);
	}

	/**
	 * Create a new run ID for tracking a sequence of model calls
	 */
	createRunId(): UUID {
		return uuidv4() as UUID;
	}

	/**
	 * Start a new run for tracking prompts
	 * @param roomId Optional room ID to associate logs with this conversation
	 */
	startRun(roomId?: UUID): UUID {
		this.currentRunId = this.createRunId();
		this.currentRoomId = roomId;
		return this.currentRunId;
	}

	/**
	 * End the current run
	 */
	endRun(): void {
		this.currentRunId = undefined;
		this.currentRoomId = undefined;
	}

	/**
	 * Get the current run ID (creates one if it doesn't exist)
	 */
	getCurrentRunId(): UUID {
		if (!this.currentRunId) {
			this.currentRunId = this.createRunId();
		}
		return this.currentRunId;
	}

	private resolveServiceTypeAlias(
		serviceType: ServiceTypeName | string,
	): string {
		return serviceType;
	}

	private resolveNativeFeatureEnabled(feature: NativeRuntimeFeature): boolean {
		const explicit = this.nativeFeatureOptions[feature];
		if (explicit !== undefined) {
			return explicit;
		}

		const settingKey = `ENABLE_${feature.toUpperCase()}`;
		const settingValue = parseBooleanValue(this.getSetting(settingKey));
		if (settingValue !== undefined) {
			return settingValue;
		}

		return nativeRuntimeFeatureDefaults[feature];
	}

	private hasNativeRuntimeFeature(feature: NativeRuntimeFeature): boolean {
		const pluginName = nativeRuntimeFeaturePluginNames[feature];
		return this.plugins.some((plugin) => plugin.name === pluginName);
	}

	private resolveNativeFeatureForServiceType(
		serviceType: ServiceTypeName | string,
	): NativeRuntimeFeature | null {
		switch (serviceType) {
			case "knowledge":
				return "knowledge";
			case "relationships":
				return "relationships";
			case "trajectories":
				return "trajectories";
			default:
				return null;
		}
	}

	private isNativeFeatureServiceEnabled(
		serviceType: ServiceTypeName | string,
	): boolean {
		const feature = this.resolveNativeFeatureForServiceType(serviceType);
		if (!feature) {
			return true;
		}
		return this.hasNativeRuntimeFeature(feature);
	}

	private isPluginManagedAsNativeFeature(
		plugin: Plugin | null | undefined,
	): boolean {
		return resolveNativeRuntimeFeatureFromPluginName(plugin?.name) !== null;
	}

	private async setNativeRuntimeFeatureEnabled(
		feature: NativeRuntimeFeature,
		enabled: boolean,
	): Promise<void> {
		const current = this.hasNativeRuntimeFeature(feature);
		if (current === enabled) {
			return;
		}

		if (enabled) {
			await this.registerPlugin(getNativeRuntimeFeaturePlugin(feature));
		} else {
			await this.unloadPlugin(nativeRuntimeFeaturePluginNames[feature]);
		}

		this.setSetting(`ENABLE_${feature.toUpperCase()}`, enabled);
	}

	async enableKnowledge(): Promise<void> {
		await this.setNativeRuntimeFeatureEnabled("knowledge", true);
	}

	async disableKnowledge(): Promise<void> {
		await this.setNativeRuntimeFeatureEnabled("knowledge", false);
	}

	isKnowledgeEnabled(): boolean {
		return this.hasNativeRuntimeFeature("knowledge");
	}

	async enableRelationships(): Promise<void> {
		await this.setNativeRuntimeFeatureEnabled("relationships", true);
	}

	async disableRelationships(): Promise<void> {
		await this.setNativeRuntimeFeatureEnabled("relationships", false);
	}

	isRelationshipsEnabled(): boolean {
		return this.hasNativeRuntimeFeature("relationships");
	}

	async enableTrajectories(): Promise<void> {
		await this.setNativeRuntimeFeatureEnabled("trajectories", true);
	}

	async disableTrajectories(): Promise<void> {
		await this.setNativeRuntimeFeatureEnabled("trajectories", false);
	}

	isTrajectoriesEnabled(): boolean {
		return this.hasNativeRuntimeFeature("trajectories");
	}

	private hooksForPhase(phase: PipelineHookPhase): ResolvedPipelineHook[] {
		return this.pipelineHookEntries.filter((e) => e.phase === phase);
	}

	private upsertPipelineHook(entry: ResolvedPipelineHook): void {
		const existing = this.pipelineHookIdToIndex.get(entry.id);
		if (existing !== undefined) {
			this.pipelineHookEntries[existing] = entry;
			return;
		}
		this.pipelineHookIdToIndex.set(entry.id, this.pipelineHookEntries.length);
		this.pipelineHookEntries.push(entry);
	}

	private async invokePipelineHooks(
		phase: PipelineHookPhase,
		ctx: PipelineHookContext,
		logLabel: string,
		pipelineHookTelemetry = true,
	): Promise<void> {
		const hooks = sortPipelineHooksByPosition(this.hooksForPhase(phase));
		if (!hooks.length) {
			return;
		}
		const runtime = this as unknown as IAgentRuntime;
		const roomId = pipelineHookMetricRoomId(ctx);

		const runOne = async (entry: ResolvedPipelineHook) => {
			const t0 = performance.now();
			let errorMessage: string | undefined;
			try {
				await entry.handler(runtime, ctx);
			} catch (error) {
				errorMessage = error instanceof Error ? error.message : String(error);
				this.logger.error(
					{
						src: "agent",
						agentId: this.agentId,
						hookId: entry.id,
						phase: entry.phase,
						error: errorMessage,
					},
					`${logLabel} threw; continuing`,
				);
			}
			{
				const durationMs = Math.round(performance.now() - t0);
				if (!pipelineHookTelemetry) {
					const baseLite = {
						src: "pipeline_hook" as const,
						agentId: this.agentId,
						hookId: entry.id,
						phase,
						roomId,
						durationMs,
					};
					if (durationMs >= PIPELINE_HOOK_WARN_MS) {
						this.logger.warn(
							baseLite,
							`PIPELINE HOOK SLOW (${durationMs}ms): ${entry.id} phase=${phase}`,
						);
					}
					if (durationMs >= PIPELINE_HOOK_ERROR_LOG_MS) {
						this.logger.error(
							baseLite,
							`PIPELINE HOOK VERY SLOW (${durationMs}ms): ${entry.id} phase=${phase}`,
						);
					}
				} else {
					const slow = durationMs >= PIPELINE_HOOK_WARN_MS;
					const baseFields = {
						src: "pipeline_hook" as const,
						agentId: this.agentId,
						hookId: entry.id,
						phase,
						roomId,
						durationMs,
					};
					if (durationMs >= PIPELINE_HOOK_DEBUG_LOG_MS) {
						this.logger.debug(baseFields, "Pipeline hook timing");
					}
					if (slow) {
						this.logger.warn(
							baseFields,
							`PIPELINE HOOK SLOW (${durationMs}ms): ${entry.id} phase=${phase}`,
						);
					}
					if (durationMs >= PIPELINE_HOOK_ERROR_LOG_MS) {
						this.logger.error(
							baseFields,
							`PIPELINE HOOK VERY SLOW (${durationMs}ms): ${entry.id} phase=${phase}`,
						);
					}
					try {
						await this.emitEvent(EventType.PIPELINE_HOOK_METRIC, {
							phase,
							hookId: entry.id,
							durationMs,
							roomId,
							slow,
							...(errorMessage !== undefined ? { error: errorMessage } : {}),
						});
					} catch (metricError) {
						this.logger.debug(
							{
								src: "pipeline_hook",
								agentId: this.agentId,
								hookId: entry.id,
								phase,
								error:
									metricError instanceof Error
										? metricError.message
										: String(metricError),
							},
							"PIPELINE_HOOK_METRIC listener failed",
						);
					}
				}
			}
		};

		if (
			phase === "parallel_with_should_respond" ||
			phase === "model_stream_chunk"
		) {
			await Promise.all(hooks.map((h) => runOne(h)));
			return;
		}

		const mutators = hooks.filter((h) => h.mutatesPrimary);
		const serialReaders = hooks.filter(
			(h) => !h.mutatesPrimary && h.schedule === "serial",
		);
		const concurrentReaders = hooks.filter(
			(h) => !h.mutatesPrimary && h.schedule === "concurrent",
		);

		for (const h of mutators) {
			await runOne(h);
		}
		for (const h of serialReaders) {
			await runOne(h);
		}
		await Promise.all(concurrentReaders.map((h) => runOne(h)));
	}

	registerPipelineHook(spec: PipelineHookSpec): void {
		this.upsertPipelineHook(resolvePipelineHookSpec(spec));
	}

	unregisterPipelineHook(id: string): void {
		const idx = this.pipelineHookIdToIndex.get(id);
		if (idx === undefined) {
			return;
		}
		this.pipelineHookEntries.splice(idx, 1);
		this.pipelineHookIdToIndex.clear();
		for (let i = 0; i < this.pipelineHookEntries.length; i++) {
			const e = this.pipelineHookEntries[i];
			this.pipelineHookIdToIndex.set(e.id, i);
		}
	}

	/**
	 * Run pipeline hooks for a phase (skip metadata, ordering, and outgoing redact).
	 * @param pipelineHookTelemetry When false, skips debug logs / `PIPELINE_HOOK_METRIC` per hook
	 * (still logs warn/error for slow hooks). Defaults to false for `model_stream_chunk` only.
	 */
	async applyPipelineHooks(
		phase: PipelineHookPhase,
		ctx: PipelineHookContext,
		pipelineHookTelemetry?: boolean,
	): Promise<void> {
		if (ctx.phase !== phase) {
			throw new Error(
				`applyPipelineHooks: phase mismatch (expected ${phase}, ctx.phase=${ctx.phase})`,
			);
		}

		const hookTelemetry =
			pipelineHookTelemetry !== undefined
				? pipelineHookTelemetry
				: phase !== "model_stream_chunk";

		const hasHooks = this.hooksForPhase(phase).length > 0;

		switch (phase) {
			case "incoming_before_compose": {
				if (!hasHooks) {
					return;
				}
				const c = ctx as Extract<
					PipelineHookContext,
					{ phase: "incoming_before_compose" }
				>;
				const md = c.message.content?.metadata;
				const meta =
					typeof md === "object" && md !== null
						? (md as Record<string, unknown>)
						: null;
				if (meta?.skipIncomingMessageHooks === true) {
					return;
				}
				const messageId = c.message.id;
				await this.invokePipelineHooks(
					phase,
					c,
					"Incoming pipeline hook",
					hookTelemetry,
				);
				if (messageId) {
					this.stateCache.delete(messageId);
					this.stateCache.delete(`${messageId}_action_results`);
				}
				return;
			}
			case "pre_should_respond": {
				if (!hasHooks) {
					return;
				}
				const c = ctx as Extract<
					PipelineHookContext,
					{ phase: "pre_should_respond" }
				>;
				const md = c.message.content?.metadata;
				const meta =
					typeof md === "object" && md !== null
						? (md as Record<string, unknown>)
						: null;
				if (meta?.skipPreShouldRespondHooks === true) {
					return;
				}
				await this.invokePipelineHooks(
					phase,
					c,
					"Pre-should-respond pipeline hook",
					hookTelemetry,
				);
				return;
			}
			case "parallel_with_should_respond": {
				if (!hasHooks) {
					return;
				}
				const c = ctx as Extract<
					PipelineHookContext,
					{ phase: "parallel_with_should_respond" }
				>;
				const md = c.message.content?.metadata;
				const meta =
					typeof md === "object" && md !== null
						? (md as Record<string, unknown>)
						: null;
				if (meta?.skipParallelWithShouldRespondHooks === true) {
					return;
				}
				await this.invokePipelineHooks(
					phase,
					c,
					"Parallel should-respond pipeline hook",
					hookTelemetry,
				);
				return;
			}
			case "outgoing_before_deliver": {
				const c = ctx as Extract<
					PipelineHookContext,
					{ phase: "outgoing_before_deliver" }
				>;
				if (hasHooks) {
					await this.invokePipelineHooks(
						phase,
						c,
						"Outgoing pipeline hook",
						hookTelemetry,
					);
				}
				c.content.text = this.redactSecrets(
					coerceOutgoingMessageText(c.content.text),
				);
				return;
			}
			case "pre_model":
			case "post_model": {
				if (!hasHooks) {
					return;
				}
				await this.invokePipelineHooks(
					phase,
					ctx as Extract<
						PipelineHookContext,
						{ phase: "pre_model" | "post_model" }
					>,
					phase === "pre_model"
						? "Pre-model pipeline hook"
						: "Post-model pipeline hook",
					hookTelemetry,
				);
				return;
			}
			case "after_memory_persisted": {
				if (!hasHooks) {
					return;
				}
				const c = ctx as Extract<
					PipelineHookContext,
					{ phase: "after_memory_persisted" }
				>;
				const md = c.memory.content?.metadata;
				const meta =
					typeof md === "object" && md !== null
						? (md as Record<string, unknown>)
						: null;
				if (meta?.skipAfterMemoryPersistedHooks === true) {
					return;
				}
				await this.invokePipelineHooks(
					phase,
					c,
					"After-memory-persisted pipeline hook",
					hookTelemetry,
				);
				return;
			}
			case "model_stream_chunk":
			case "model_stream_end": {
				if (!hasHooks) {
					return;
				}
				await this.invokePipelineHooks(
					phase,
					ctx as Extract<
						PipelineHookContext,
						{ phase: "model_stream_chunk" | "model_stream_end" }
					>,
					phase === "model_stream_chunk"
						? "Model stream chunk pipeline hook"
						: "Model stream end pipeline hook",
					hookTelemetry,
				);
				return;
			}
			default: {
				throw new Error(`Unknown pipeline hook phase: ${String(phase)}`);
			}
		}
	}

	async registerPlugin(plugin: Plugin): Promise<void> {
		if (!plugin.name) {
			// Ensure plugin.name is defined
			const errorMsg = "Plugin or plugin name is undefined";
			this.logger.error(
				{ src: "agent", agentId: this.agentId, error: errorMsg },
				"Plugin registration failed",
			);
			throw new Error(`registerPlugin: ${errorMsg}`);
		}

		// Check if a plugin with the same name is already registered.
		const existingPlugin = this.plugins.find((p) => p.name === plugin.name);
		if (existingPlugin) {
			this.logger.warn(
				{ src: "agent", agentId: this.agentId, plugin: plugin.name },
				"Plugin already registered, skipping",
			);
			return;
		}

		// Handle capability-aware registration for basic-capabilities plugin
		let pluginToRegister = plugin;
		if (plugin.name === "basic-capabilities") {
			const settings = this.character.settings;
			// Constructor options take precedence over character settings
			const disableBasic =
				this.capabilityOptions.disableBasic ??
				(settings?.DISABLE_BASIC_CAPABILITIES === true ||
					settings?.DISABLE_BASIC_CAPABILITIES === "true");
			// Support both enableExtended/enableExtendedCapabilities and advancedCapabilities as aliases
			const enableExtended =
				this.capabilityOptions.enableExtended ??
				this.capabilityOptions.advancedCapabilities ??
				(settings?.ENABLE_EXTENDED_CAPABILITIES === true ||
					settings?.ENABLE_EXTENDED_CAPABILITIES === "true" ||
					settings?.ADVANCED_CAPABILITIES === true ||
					settings?.ADVANCED_CAPABILITIES === "true");
			const skipCharacterProvider =
				this.capabilityOptions.skipCharacterProvider ?? false;
			const enableAutonomy =
				this.capabilityOptions.enableAutonomy ??
				(settings?.ENABLE_AUTONOMY === true ||
					settings?.ENABLE_AUTONOMY === "true");
			const enableTrust =
				this.capabilityOptions.enableTrust ??
				(settings?.ENABLE_TRUST === true || settings?.ENABLE_TRUST === "true");
			const enableSecretsManager =
				this.capabilityOptions.enableSecretsManager ??
				(settings?.ENABLE_SECRETS_MANAGER === true ||
					settings?.ENABLE_SECRETS_MANAGER === "true");
			const enablePluginManager =
				this.capabilityOptions.enablePluginManager ??
				(settings?.ENABLE_PLUGIN_MANAGER === true ||
					settings?.ENABLE_PLUGIN_MANAGER === "true");

			if (
				disableBasic ||
				enableExtended ||
				skipCharacterProvider ||
				enableAutonomy ||
				enableTrust ||
				enableSecretsManager ||
				enablePluginManager
			) {
				const config: CapabilityConfig = {
					disableBasic,
					enableExtended,
					skipCharacterProvider,
					enableAutonomy,
					enableTrust,
					enableSecretsManager,
					enablePluginManager,
				};
				const configuredPlugin = createBasicCapabilitiesPlugin(config);
				pluginToRegister = {
					...configuredPlugin,
					events: plugin.events ?? configuredPlugin.events,
				};
			}
		}

		(this.plugins as Plugin[]).push(pluginToRegister);
		this.logger.debug(
			{ src: "agent", agentId: this.agentId, plugin: pluginToRegister.name },
			"Plugin added",
		);

		if (pluginToRegister.init) {
			const config: Record<string, string> = {};
			if (pluginToRegister.config) {
				for (const [key, value] of Object.entries(pluginToRegister.config)) {
					if (value !== null && value !== undefined) {
						config[key] = String(value);
					}
				}
			}
			await pluginToRegister.init(config, this as unknown as IAgentRuntime);
			this.logger.debug(
				{ src: "agent", agentId: this.agentId, plugin: pluginToRegister.name },
				"Plugin initialized",
			);
		}
		if (pluginToRegister.adapter) {
			this.logger.debug(
				{ src: "agent", agentId: this.agentId, plugin: pluginToRegister.name },
				"Plugin declares adapter factory (handled pre-construction)",
			);
		}
		if (pluginToRegister.actions) {
			const existingActionNames = new Set(
				this.actions.map((action) => action.name),
			);
			for (const action of pluginToRegister.actions) {
				if (existingActionNames.has(action.name)) {
					this.logger.debug(
						{
							src: "agent",
							agentId: this.agentId,
							action: action.name,
							plugin: pluginToRegister.name,
						},
						"Skipping duplicate plugin action",
					);
					continue;
				}
				this.registerAction(action);
				existingActionNames.add(action.name);
			}
		}
		if (pluginToRegister.evaluators) {
			for (const evaluator of pluginToRegister.evaluators) {
				this.registerEvaluator(evaluator);
			}
		}
		if (pluginToRegister.providers) {
			for (const provider of pluginToRegister.providers) {
				this.registerProvider(provider);
			}
		}
		if (pluginToRegister.models) {
			for (const [modelType, handler] of Object.entries(
				pluginToRegister.models,
			)) {
				this.registerModel(
					modelType as ModelTypeName,
					handler as (
						runtime: IAgentRuntime,
						params: Record<string, JsonValue | object>,
					) => Promise<JsonValue | object>,
					pluginToRegister.name,
					pluginToRegister.priority,
				);
			}
		}
		if (pluginToRegister.routes) {
			for (const route of pluginToRegister.routes) {
				const routePath = route.path.startsWith("/")
					? route.path
					: `/${route.path}`;
				this.routes.push({
					...route,
					path: route.rawPath
						? routePath
						: `/${pluginToRegister.name}${routePath}`,
				});
			}
		}
		if (pluginToRegister.events) {
			for (const [eventName, eventHandlers] of Object.entries(
				pluginToRegister.events,
			)) {
				for (const eventHandler of eventHandlers) {
					this.registerEvent(
						eventName,
						eventHandler as (params: unknown) => Promise<void>,
					);
				}
			}
		}
		if (pluginToRegister.services) {
			for (const service of pluginToRegister.services) {
				const serviceType = service.serviceType as ServiceTypeName;

				this.logger.debug(
					{
						src: "agent",
						agentId: this.agentId,
						plugin: pluginToRegister.name,
						serviceType,
					},
					"Registering service",
				);

				if (!this.servicePromises.has(serviceType)) {
					this._createServiceResolver(serviceType);
				}
				this.serviceRegistrationStatus.set(serviceType, "pending");
				if (!this.serviceTypes.has(serviceType)) {
					this.serviceTypes.set(serviceType, []);
				}
				const services = this.serviceTypes.get(serviceType);
				if (services) {
					this.warnOnDuplicateServiceTypeRegistration(
						serviceType,
						service,
						services,
						pluginToRegister.name,
					);
					services.push(service);
				}

				// Eagerly kick off service start so it is available via the
				// sync getService() by the time actions/routes need it.
				// Fire-and-forget: cannot await here because _runServiceStart
				// awaits initPromise which resolves after initialize() completes
				// (after all registerPlugin calls finish). Awaiting would deadlock.
				this._ensureServiceStarted(serviceType).catch((err) => {
					this.logger.error(
						{
							src: "agent",
							agentId: this.agentId,
							plugin: pluginToRegister.name,
							serviceType,
							error: err instanceof Error ? err.message : String(err),
						},
						"Service start failed",
					);
				});
			}
		}
		if (pluginToRegister.adapter) {
			this.logger.debug(
				{
					src: "agent",
					agentId: this.agentId,
					plugin: pluginToRegister.name,
				},
				"Registering database adapter",
			);
			const basicCapabilitiesSettings = this.getBasicCapabilitiesSettings();
			const adapter = await Promise.resolve(
				pluginToRegister.adapter(this.agentId, basicCapabilitiesSettings),
			);
			this.registerDatabaseAdapter(adapter);
		}
	}

	getAllServices(): Map<ServiceTypeName, Service[]> {
		return this.services;
	}

	/**
	 * Stops all started services and clears runtime caches/handlers.
	 * For full teardown (including DB/adapter connection), call close() after stop().
	 */
	async stop() {
		if (this.stopped) {
			this.logger.debug(
				{ src: "agent", agentId: this.agentId },
				"Runtime already stopped",
			);
			return;
		}
		this.stopped = true;
		this.logger.debug(
			{ src: "agent", agentId: this.agentId },
			"Stopping runtime",
		);

		// Wait for any in-flight service starts so we don't leave services running
		const inFlight = Array.from(this.startingServices.values());
		if (inFlight.length > 0) {
			this.logger.debug(
				{ src: "agent", agentId: this.agentId, count: inFlight.length },
				"Waiting for in-flight service starts before stopping",
			);
			await Promise.all(inFlight);
		}

		for (const [serviceType, services] of this.services) {
			this.logger.debug(
				{ src: "agent", agentId: this.agentId, serviceType },
				"Stopping service",
			);
			for (const service of services) {
				const maybe = service as { stop?: () => Promise<void> };
				if (typeof maybe.stop === "function") {
					await maybe.stop();
				} else {
					this.logger.warn(
						{ src: "agent", agentId: this.agentId, serviceType },
						"Service instance is missing stop(); skipping",
					);
				}
			}
		}

		// Reject any pending service load promises so callers don't hang
		const stopError = new Error("Runtime stopped");
		for (const [serviceType, handler] of this.servicePromiseHandlers) {
			handler.reject(stopError);
			const promise = this.servicePromises.get(serviceType);
			if (promise) {
				// Prevent unhandled rejection noise when runtimes are cleaned up with
				// unresolved service-load promises during shutdown.
				void promise.catch(() => {});
			}
		}

		// Clear caches and handlers to avoid use-after-stop and release references
		this.eventHandlers.clear();
		this.events = {};
		this.stateCache.clear();
		this.servicePromises.clear();
		this.servicePromiseHandlers.clear();
		this.startingServices.clear();
	}

	/**
	 * Slim init: register plugins, ensure adapter ready, create message service.
	 * Does NOT run migrations, agent/entity/room creation, or embedding dimension.
	 * WHY: Those belong to provisioning (once at daemon boot); edge/ephemeral skip them.
	 */
	async initialize(options?: {
		skipMigrations?: boolean;
		/** Allow running without a persistent database adapter (benchmarks/tests). */
		allowNoDatabase?: boolean;
	}): Promise<void> {
		try {
			await this._initializeCore(options);
		} catch (err) {
			// Always resolve initPromise so eager service starts and stop()
			// do not hang waiting on a promise that never settles.
			if (this.initResolver) {
				this.initResolver();
				this.initResolver = undefined;
			}
			throw err;
		}
	}

	private async _initializeCore(options?: {
		skipMigrations?: boolean;
		allowNoDatabase?: boolean;
	}): Promise<void> {
		const pluginRegistrationPromises: Promise<void>[] = [];

		// Basic capabilities are now built into core - auto-register it first
		const basicCapabilitiesPlugin = createBasicCapabilitiesPlugin(
			this.capabilityOptions,
		);
		pluginRegistrationPromises.push(
			this.registerPlugin(basicCapabilitiesPlugin),
		);

		for (const feature of Object.keys(
			nativeRuntimeFeatureDefaults,
		) as NativeRuntimeFeature[]) {
			const enabled = this.resolveNativeFeatureEnabled(feature);
			if (enabled) {
				pluginRegistrationPromises.push(
					this.registerPlugin(getNativeRuntimeFeaturePlugin(feature)),
				);
			}
		}

		if (this.character.advancedPlanning === true) {
			const { createAdvancedPlanningPlugin } = await import(
				"./features/advanced-planning/index.ts"
			);
			pluginRegistrationPromises.push(
				this.registerPlugin(createAdvancedPlanningPlugin()),
			);
		}

		if (this.character.advancedMemory === true) {
			pluginRegistrationPromises.push(
				this.registerPlugin(createAdvancedMemoryPlugin()),
			);
		}

		for (const plugin of this.characterPlugins) {
			if (plugin && !this.isPluginManagedAsNativeFeature(plugin)) {
				pluginRegistrationPromises.push(this.registerPlugin(plugin));
			}
		}
		await Promise.all(pluginRegistrationPromises);

		const allowNoDatabase =
			options?.allowNoDatabase === true ||
			String(this.getSetting("ALLOW_NO_DATABASE") ?? "").toLowerCase() ===
				"true" ||
			String(process.env.ALLOW_NO_DATABASE ?? "").toLowerCase() === "true";

		if (!this.adapter) {
			if (allowNoDatabase) {
				this.logger.warn(
					{ src: "agent", agentId: this.agentId },
					"Database adapter not initialized; using in-memory adapter (ALLOW_NO_DATABASE)",
				);
				this.registerDatabaseAdapter(new InMemoryDatabaseAdapter());
			} else {
				this.logger.error(
					{ src: "agent", agentId: this.agentId },
					"Database adapter not initialized",
				);
				throw new Error(
					"Database adapter not initialized. The SQL plugin (@elizaos/plugin-sql) is required for agent initialization. Please ensure it is included in your character configuration.",
				);
			}
		}

		// Make adapter init idempotent - check if already initialized
		if (!(await this.adapter.isReady())) {
			await this.adapter.initialize();
		}

		// Initialize message service
		this.messageService = new DefaultMessageService();

		// Run migrations for all loaded plugins (unless explicitly skipped for serverless mode)
		const skipMigrations = options?.skipMigrations ?? false;
		if (skipMigrations) {
			this.logger.debug(
				{ src: "agent", agentId: this.agentId },
				"Skipping plugin migrations",
			);
		} else {
			this.logger.debug(
				{ src: "agent", agentId: this.agentId },
				"Running plugin migrations",
			);
			await this.runPluginMigrations();
			this.logger.debug(
				{ src: "agent", agentId: this.agentId },
				"Plugin migrations completed",
			);
		}

		// Ensure character has the agent ID set before calling ensureAgentExists
		// We create a new object with the ID to avoid mutating the original character
		const existingAgent = await this.ensureAgentExists({
			...this.character,
			id: this.agentId,
		} as Partial<Agent>);
		if (!existingAgent) {
			const errorMsg = `Agent ${this.agentId} does not exist in database after ensureAgentExists call`;
			throw new Error(errorMsg);
		}

		// Merge DB-persisted settings back into runtime character
		// This ensures settings from previous runs are available
		if (existingAgent.settings) {
			this.character.settings = {
				...existingAgent.settings,
				...this.character.settings, // Character file overrides DB
			};

			// Merge secrets from both character.secrets and settings.secrets
			// getSetting() checks character.secrets first, so we need to merge there too
			const dbSecrets =
				existingAgent.secrets && typeof existingAgent.secrets === "object"
					? existingAgent.secrets
					: {};
			const dbSettingsSecrets =
				existingAgent.settings.secrets &&
				typeof existingAgent.settings.secrets === "object"
					? existingAgent.settings.secrets
					: {};
			const settingsSecrets =
				this.character.settings.secrets &&
				typeof this.character.settings.secrets === "object"
					? this.character.settings.secrets
					: {};
			const characterSecrets =
				this.character.secrets && typeof this.character.secrets === "object"
					? this.character.secrets
					: {};

			// Merge into both locations that getSetting() checks
			const mergedSecrets = {
				...dbSecrets,
				...dbSettingsSecrets,
				...characterSecrets,
				...settingsSecrets, // settings.secrets has priority
			};

			if (Object.keys(mergedSecrets).length > 0) {
				const filteredSecrets: Record<string, string> = {};
				for (const [key, value] of Object.entries(mergedSecrets)) {
					if (value !== null && value !== undefined) {
						filteredSecrets[key] = String(value);
					}
				}
				if (Object.keys(filteredSecrets).length > 0) {
					this.character.secrets = filteredSecrets;
					this.character.settings.secrets = filteredSecrets;
				}
			}
		}

		// No need to transform agent's own ID
		let agentEntity =
			(await this.adapter.getEntitiesByIds([this.agentId]))[0] ?? null;

		if (!agentEntity) {
			if (!existingAgent.id) {
				throw new Error(`Agent ${this.agentId} has no ID`);
			}
			const created = await this.createEntity({
				id: this.agentId,
				names: [this.character.name ?? "Agent"],
				metadata: {},
				agentId: existingAgent.id,
			});
			if (!created) {
				const errorMsg = `Failed to create entity for agent ${this.agentId}`;
				throw new Error(errorMsg);
			}

			agentEntity =
				(await this.adapter.getEntitiesByIds([this.agentId]))[0] ?? null;
			if (!agentEntity)
				throw new Error(`Agent entity not found for ${this.agentId}`);

			this.logger.debug(
				{ src: "agent", agentId: this.agentId },
				"Agent entity created",
			);
		}

		// Room creation and participant setup
		const room = await this.getRoom(this.agentId);
		if (!room) {
			await this.adapter.createRooms([
				{
					id: this.agentId,
					name: this.character.name,
					source: "elizaos",
					type: ChannelType.SELF,
					channelId: this.agentId,
					messageServerId: this.agentId,
					worldId: this.agentId,
				},
			]);
		}
		const [participantsResult] = await this.adapter.getParticipantsForRooms([
			this.agentId,
		]);
		const participantIds = participantsResult?.entityIds ?? [];
		if (!participantIds.includes(this.agentId)) {
			const added = await this.adapter.createRoomParticipants(
				[this.agentId],
				this.agentId,
			);
			if (!added.length) {
				throw new Error(
					`Failed to add agent ${this.agentId} as participant to its own room`,
				);
			}
			this.logger.debug(
				{ src: "agent", agentId: this.agentId },
				"Agent linked to room",
			);
		}

		const embeddingModel = this.getModel(ModelType.TEXT_EMBEDDING);
		if (!embeddingModel) {
			this.logger.warn(
				{ src: "agent", agentId: this.agentId },
				"No TEXT_EMBEDDING model registered, skipping embedding setup",
			);
		} else {
			await this.ensureEmbeddingDimension();
		}

		// Resolve init promise to allow services to start
		if (this.initResolver) {
			this.initResolver();
			this.initResolver = undefined;
		}
	}

	private getBasicCapabilitiesSettings(): Record<string, string> {
		const out: Record<string, string> = {};

		for (const [key, value] of Object.entries(process.env)) {
			if (value !== undefined && value !== null && key) {
				out[key] = String(value);
			}
		}

		const settings =
			this.character.settings && typeof this.character.settings === "object"
				? this.character.settings
				: {};
		for (const [key, value] of Object.entries(settings)) {
			if (value === undefined || value === null) {
				continue;
			}
			if (key === "secrets" && typeof value === "object") {
				continue;
			}
			out[key] = typeof value === "string" ? value : String(value);
		}

		const secrets =
			this.character.settings?.secrets &&
			typeof this.character.settings.secrets === "object"
				? this.character.settings.secrets
				: {};
		for (const [key, value] of Object.entries(secrets)) {
			if (value !== undefined && value !== null) {
				out[key] = String(value);
			}
		}

		const topSecrets =
			this.character.secrets && typeof this.character.secrets === "object"
				? this.character.secrets
				: {};
		for (const [key, value] of Object.entries(topSecrets)) {
			if (value !== undefined && value !== null) {
				out[key] = String(value);
			}
		}

		return out;
	}

	registerDatabaseAdapter(adapter: IDatabaseAdapter) {
		if (this.adapter) {
			this.logger.warn(
				{ src: "agent", agentId: this.agentId },
				"Database adapter already registered, ignoring",
			);
		} else {
			this.adapter = adapter;
			this.logger.debug(
				{ src: "agent", agentId: this.agentId },
				"Database adapter registered",
			);
		}
	}

	async runPluginMigrations(): Promise<void> {
		if (!this.adapter) {
			this.logger.warn(
				{ src: "agent", agentId: this.agentId },
				"Database adapter not found, skipping plugin migrations",
			);
			return;
		}

		if (typeof this.adapter.runPluginMigrations !== "function") {
			this.logger.warn(
				{ src: "agent", agentId: this.agentId },
				"Database adapter does not support plugin migrations",
			);
			return;
		}

		const pluginsWithSchemas = this.plugins
			.filter((p) => p.schema)
			.map((p) => {
				const schema = p.schema || {};
				const normalizedSchema: Record<string, JsonValue> = {};
				for (const [key, value] of Object.entries(schema)) {
					if (
						typeof value === "string" ||
						typeof value === "number" ||
						typeof value === "boolean" ||
						value === null ||
						(typeof value === "object" && value !== null)
					) {
						normalizedSchema[key] = value as JsonValue;
					}
				}
				return { name: p.name, schema: normalizedSchema };
			});

		if (pluginsWithSchemas.length === 0) {
			this.logger.debug(
				{ src: "agent", agentId: this.agentId },
				"No plugins with schemas, skipping migrations",
			);
			return;
		}

		this.logger.debug(
			{ src: "agent", agentId: this.agentId, count: pluginsWithSchemas.length },
			"Found plugins with schemas",
		);

		const isProduction = process.env.NODE_ENV === "production";
		const forceDestructive =
			process.env.ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS === "true";

		await this.adapter.runPluginMigrations(pluginsWithSchemas, {
			verbose: !isProduction,
			force: forceDestructive,
			dryRun: false,
		});

		this.logger.debug(
			{ src: "agent", agentId: this.agentId },
			"Plugin migrations completed",
		);
	}

	async getConnection(): Promise<object> {
		// Updated return type
		if (!this.adapter) {
			throw new Error("Database adapter not registered");
		}
		return this.adapter.getConnection();
	}

	setSetting(key: string, value: string | boolean | null, secret = false) {
		if (secret) {
			if (!this.character.secrets) {
				this.character.secrets = {};
			}
			if (value !== null && value !== undefined) {
				// Secrets are stored as strings
				this.character.secrets[key] = String(value);
			}
		} else {
			if (!this.character.settings) {
				this.character.settings = {};
			}
			if (value !== null && value !== undefined) {
				this.character.settings[key] = value;
			}
		}
	}

	getSetting(key: string): string | boolean | number | null {
		const settings = this.character.settings;
		const secrets = this.character.secrets;
		const extraSettings =
			settings &&
			typeof settings === "object" &&
			"extra" in settings &&
			typeof settings.extra === "object" &&
			settings.extra !== null
				? (settings.extra as Record<
						string,
						string | boolean | number | undefined
					>)
				: undefined;
		const nestedSecrets =
			typeof settings === "object" &&
			settings !== null &&
			"secrets" in settings &&
			typeof settings.secrets === "object" &&
			settings.secrets !== null
				? (settings.secrets as Record<string, string | undefined>)
				: undefined;

		const value =
			secrets?.[key] ??
			settings?.[key] ??
			extraSettings?.[key] ??
			nestedSecrets?.[key] ??
			this.settings[key];

		// Handle each type appropriately
		if (value === undefined || value === null) {
			return null;
		}

		if (typeof value === "number") {
			return value;
		}

		if (typeof value === "boolean") {
			return value;
		}

		if (typeof value === "string") {
			// Only decrypt string values
			const decrypted = decryptSecret(value, getSalt());
			if (decrypted === "true") return true;
			if (decrypted === "false") return false;
			return decrypted;
		}

		return null;
	}

	getConversationLength() {
		return this.#conversationLength;
	}

	/**
	 * Check if action planning mode is enabled.
	 *
	 * When enabled (default), the agent can plan and execute multiple actions per response.
	 * When disabled, the agent executes only a single action per response - a performance
	 * optimization useful for game situations where state updates with every action.
	 *
	 * Priority: constructor option > character setting ACTION_PLANNING > default (true)
	 */
	isActionPlanningEnabled(): boolean {
		// Constructor option takes precedence
		if (this.actionPlanningOption !== undefined) {
			return this.actionPlanningOption;
		}

		// Check character settings
		const setting = this.getSetting("ACTION_PLANNING");
		if (setting !== null) {
			if (typeof setting === "boolean") {
				return setting;
			}
			if (typeof setting === "string") {
				return setting.toLowerCase() === "true";
			}
		}

		// Default to true (action planning enabled)
		return true;
	}

	/**
	 * Get the LLM mode for model selection override.
	 *
	 * - `DEFAULT`: Use the model type specified in the useModel call (no override)
	 * - `SMALL`: Override all text generation model calls to use TEXT_SMALL
	 * - `LARGE`: Override all text generation model calls to use TEXT_LARGE
	 *
	 * Priority: constructor option > character setting LLM_MODE > default (DEFAULT)
	 */
	getLLMMode(): import("./types").LLMModeType {
		// Constructor option takes precedence
		if (this.llmModeOption !== undefined) {
			return this.llmModeOption;
		}

		// Check character settings
		const setting = this.getSetting("LLM_MODE");
		if (setting !== null && typeof setting === "string") {
			const upper = setting.toUpperCase();
			if (upper === "SMALL" || upper === "LARGE" || upper === "DEFAULT") {
				return upper as import("./types").LLMModeType;
			}
		}

		// Default to DEFAULT (no override)
		return "DEFAULT";
	}

	/**
	 * Check if the shouldRespond evaluation is enabled.
	 *
	 * When enabled (default: true), the agent evaluates whether to respond to each message.
	 * When disabled, the agent always responds (ChatGPT mode) - useful for direct chat interfaces.
	 *
	 * Priority: constructor option > character setting CHECK_SHOULD_RESPOND > default (true)
	 */
	isCheckShouldRespondEnabled(): boolean {
		// Constructor option takes precedence
		if (this.checkShouldRespondOption !== undefined) {
			return this.checkShouldRespondOption;
		}

		// Check character settings
		const setting = this.getSetting("CHECK_SHOULD_RESPOND");
		if (setting !== null) {
			if (typeof setting === "boolean") {
				return setting;
			}
			if (typeof setting === "string") {
				return setting.toLowerCase() !== "false";
			}
		}

		// Default to true (check should respond is enabled)
		return true;
	}

	getOptimizationDir(): string {
		const setting = this.getSetting("OPTIMIZATION_DIR");
		return getOptimizationRootDir(typeof setting === "string" ? setting : null);
	}

	registerPromptOptimizationHooks(
		hooks: PromptOptimizationRuntimeHooks | null,
	): void {
		this.promptOptimizationHooks = hooks;
	}

	getPromptOptimizationHooks(): PromptOptimizationRuntimeHooks | null {
		return this.promptOptimizationHooks;
	}

	resolveProviderModelString(
		resolvedModelType: string,
		optionsModel?: string,
		effectiveModelId?: string,
	): string {
		if (effectiveModelId) return effectiveModelId;
		if (optionsModel) return optionsModel;

		const slotToSetting: Record<string, string> = {
			TEXT_NANO: "NANO_MODEL",
			TEXT_MINI: "MINI_MODEL",
			TEXT_SMALL: "SMALL_MODEL",
			TEXT_LARGE: "LARGE_MODEL",
			TEXT_MEGA: "MEGA_MODEL",
			RESPONSE_HANDLER: "RESPONSE_HANDLER_MODEL",
			ACTION_PLANNER: "ACTION_PLANNER_MODEL",
			REASONING_SMALL: "REASONING_SMALL_MODEL",
			REASONING_LARGE: "REASONING_LARGE_MODEL",
			TEXT_COMPLETION: "COMPLETION_MODEL",
		};

		const providerPrefixes = ["OLLAMA_", "OPENAI_", "ANTHROPIC_", ""];
		for (const candidate of getModelFallbackChain(
			resolvedModelType as ModelTypeName,
		)) {
			const settingKey = slotToSetting[candidate];
			if (!settingKey) continue;
			for (const prefix of providerPrefixes) {
				const val = this.getSetting(`${prefix}${settingKey}`);
				if (typeof val === "string" && val) return val;
			}
		}

		return resolvedModelType;
	}

	enrichTrace(runId: string, signal: ScoreSignal): void {
		const traceIds = this.runToTraces.get(runId);
		if (!traceIds) return;

		const targetTraceId = (signal as { traceId?: string }).traceId;

		for (const tid of traceIds) {
			if (targetTraceId && tid !== targetTraceId) continue;

			const trace = this.activeTraces.get(tid);
			if (!trace) continue;
			trace.scoreCard.signals.push(signal);
			const card = ScoreCard.fromJSON(trace.scoreCard);
			trace.scoreCard.compositeScore = card.composite();
			trace.enrichedAt = Date.now();
		}
	}

	getActiveTrace(runId: string): ExecutionTrace | undefined {
		const traceIds = this.runToTraces.get(runId);
		if (!traceIds) return undefined;
		let latest: ExecutionTrace | undefined;
		for (const tid of traceIds) {
			const t = this.activeTraces.get(tid);
			if (t) latest = t;
		}
		return latest;
	}

	getActiveTracesForRun(runId: string): ExecutionTrace[] {
		const traceIds = this.runToTraces.get(runId);
		if (!traceIds) return [];
		const traces: ExecutionTrace[] = [];
		for (const tid of traceIds) {
			const t = this.activeTraces.get(tid);
			if (t) traces.push(t);
		}
		return traces;
	}

	deleteActiveTrace(runId: string): void {
		const traceIds = this.runToTraces.get(runId);
		if (traceIds) {
			for (const tid of traceIds) {
				this.activeTraces.delete(tid);
			}
			this.runToTraces.delete(runId);
		}
	}

	deleteActiveTraceById(traceId: string): void {
		this.activeTraces.delete(traceId);
		for (const [rid, tids] of this.runToTraces) {
			if (tids.delete(traceId) && tids.size === 0) {
				this.runToTraces.delete(rid);
			}
		}
	}

	private static readonly ACTIVE_TRACE_TTL_MS = 5 * 60 * 1000;
	private activeTraceTtlPurgeCounter = 0;

	private purgeStaleActiveTraces(): void {
		const now = Date.now();
		const ttl = AgentRuntime.ACTIVE_TRACE_TTL_MS;
		for (const [id, t] of this.activeTraces) {
			if (now - t.createdAt <= ttl) continue;
			this.activeTraces.delete(id);
			for (const [rid, tids] of this.runToTraces) {
				tids.delete(id);
				if (tids.size === 0) this.runToTraces.delete(rid);
			}
		}
	}

	private maybeRunActiveTraceTTLPurge(): void {
		if (++this.activeTraceTtlPurgeCounter % 100 !== 0) return;
		this.purgeStaleActiveTraces();
	}

	/**
	 * Get the messaging adapter if available
	 *
	 * WHY: Messaging functionality is optional (only SQL adapters support it).
	 * Client plugins check this before using messaging features.
	 *
	 * @returns IMessagingAdapter if the current adapter implements it, null otherwise
	 */
	getMessagingAdapter(): IMessagingAdapter | null {
		// Check if the adapter implements IMessagingAdapter interface
		// by checking for presence of messaging-specific methods
		if (
			this.adapter &&
			typeof (this.adapter as Partial<IMessagingAdapter>)
				.createMessageServer === "function" &&
			typeof (this.adapter as Partial<IMessagingAdapter>).createChannel ===
				"function" &&
			typeof (this.adapter as Partial<IMessagingAdapter>).createMessage ===
				"function"
		) {
			return this.adapter as unknown as IMessagingAdapter;
		}
		return null;
	}

	registerProvider(provider: Provider) {
		const canonical = withCanonicalProviderDocs(provider);
		this.providers.push(canonical);
		this.logger.debug(
			{ src: "agent", agentId: this.agentId, provider: canonical.name },
			"Provider registered",
		);
	}

	registerAction(action: Action) {
		const canonical = withCanonicalActionDocs(action);
		if (this.actions.find((a) => a.name === canonical.name)) {
			this.logger.debug(
				{ src: "agent", agentId: this.agentId, action: canonical.name },
				"Action already registered, skipping",
			);
		} else {
			this.actions.push(canonical);
			this.logger.debug(
				{ src: "agent", agentId: this.agentId, action: canonical.name },
				"Action registered",
			);
		}
	}

	getAllActions(): Action[] {
		return [...this.actions];
	}

	/**
	 * Get actions filtered by tool policy.
	 *
	 * @param context - Optional policy context for filtering
	 * @returns Filtered actions based on policy
	 */
	async getFilteredActions(context?: {
		profile?: ToolProfileId;
		characterPolicy?: ToolPolicyConfig;
		channelPolicy?: ToolPolicyConfig;
		providerPolicy?: ToolPolicyConfig;
		worldPolicy?: ToolPolicyConfig;
		roomPolicy?: ToolPolicyConfig;
	}): Promise<Action[]> {
		const policyService = (await this._ensureServiceStarted(
			"tool_policy",
		)) as ToolPolicyService | null;

		if (!policyService || !context) {
			return [...this.actions];
		}

		return policyService.filterActions(this.actions, context);
	}

	/**
	 * Check if a specific action is allowed by tool policy.
	 *
	 * @param actionName - The action name to check
	 * @param context - Optional policy context
	 * @returns Whether the action is allowed
	 */
	async isActionAllowed(
		actionName: string,
		context?: {
			profile?: ToolProfileId;
			characterPolicy?: ToolPolicyConfig;
			channelPolicy?: ToolPolicyConfig;
			providerPolicy?: ToolPolicyConfig;
			worldPolicy?: ToolPolicyConfig;
			roomPolicy?: ToolPolicyConfig;
		},
	): Promise<{ allowed: boolean; reason: string }> {
		const policyService = (await this._ensureServiceStarted(
			"tool_policy",
		)) as ToolPolicyService | null;

		if (!policyService) {
			return { allowed: true, reason: "No policy service available" };
		}

		const result = policyService.isToolAllowed(actionName, context);
		return { allowed: result.allowed, reason: result.reason };
	}

	registerEvaluator(evaluator: Evaluator) {
		this.evaluators.push(withCanonicalEvaluatorDocs(evaluator));
	}

	// Helper functions for immutable action plan updates
	private updateActionPlan<T>(plan: T, updates: Partial<T>): T {
		return { ...plan, ...updates };
	}

	private updateActionStep<T, S>(
		plan: T & { steps: S[] },
		index: number,
		stepUpdates: Partial<S>,
	): T & { steps: S[] } {
		// Add bounds checking
		if (!plan.steps || index < 0 || index >= plan.steps.length) {
			this.logger.warn(
				{
					src: "agent",
					agentId: this.agentId,
					index,
					stepsCount: plan.steps?.length || 0,
				},
				"Invalid step index",
			);
			return plan;
		}
		return {
			...plan,
			steps: plan.steps.map((step: S, i: number) =>
				i === index ? { ...step, ...stepUpdates } : step,
			),
		};
	}

	private async writeActionResultSnapshot(params: {
		message: Memory;
		actionId: UUID;
		actionName: string;
		field: "text" | "error";
		content: string;
	}): Promise<string | undefined> {
		try {
			const directory = join(
				resolveStateDir(),
				"action-results",
				safeActionResultFilePart(params.message.roomId),
				safeActionResultFilePart(params.message.id),
			);
			await mkdir(directory, { recursive: true });
			const filePath = join(
				directory,
				`${Date.now()}-${safeActionResultFilePart(
					params.actionName,
				)}-${safeActionResultFilePart(params.actionId)}-${params.field}.txt`,
			);
			await writeFile(filePath, params.content, "utf8");
			return filePath;
		} catch (error) {
			this.logger.warn(
				{
					src: "agent",
					agentId: this.agentId,
					action: params.actionName,
					actionId: params.actionId,
					field: params.field,
					error: error instanceof Error ? error.message : String(error),
				},
				"Failed to persist oversized action result snapshot",
			);
			return undefined;
		}
	}

	private async prepareActionResultForPromptState(
		actionResult: ActionResult,
		message: Memory,
		actionId: UUID,
	): Promise<ActionResult> {
		const actionName = getActionResultActionName(actionResult);
		for (const warning of collectActionResultSizeWarnings(actionResult)) {
			this.logger.warn(
				{
					src: "agent",
					agentId: this.agentId,
					messageId: message.id,
					roomId: message.roomId,
					action: warning.actionName,
					actionId,
					field: warning.field,
					rawCharLength: warning.rawCharLength,
					estimatedTokens: warning.estimatedTokens,
					thresholdTokens: warning.thresholdTokens,
				},
				"Action result exceeds prompt-size warning threshold",
			);
		}

		const references: { text?: string; error?: string } = {};
		if (
			typeof actionResult.text === "string" &&
			actionResult.text.trim().length > MAX_ACTION_RESULT_TEXT_CHARS
		) {
			references.text =
				getActionResultReference(actionResult, "text") ??
				(await this.writeActionResultSnapshot({
					message,
					actionId,
					actionName,
					field: "text",
					content: actionResult.text,
				}));
		}

		const errorText = stringifyActionResultError(actionResult.error);
		if (
			typeof errorText === "string" &&
			errorText.trim().length > MAX_ACTION_RESULT_ERROR_CHARS
		) {
			references.error =
				getActionResultReference(actionResult, "error") ??
				(await this.writeActionResultSnapshot({
					message,
					actionId,
					actionName,
					field: "error",
					content: errorText,
				}));
		}

		return trimActionResultForPromptState(actionResult, references);
	}

	private async maybeStoreActionResultClipboard(params: {
		message: Memory;
		action: Action;
		actionId: UUID;
		actionText: string;
		actionResult?: ActionResult;
	}): Promise<ActionResultClipboardStatus | null> {
		const requested =
			messageRequestsActionResultClipboard(params.message) ||
			actionResultRequestsClipboard(params.actionResult);

		if (!requested) {
			return null;
		}

		if (
			isTerminalActionResultName(params.action.name) ||
			suppressesActionResultClipboard(params.action, params.actionResult)
		) {
			return null;
		}

		if (!params.actionText.trim()) {
			return {
				text: `No ${params.action.name} result text was available to copy to clipboard.`,
			};
		}

		const entityId =
			typeof params.message.entityId === "string"
				? params.message.entityId
				: undefined;

		try {
			const service = createTaskClipboardService(this as IAgentRuntime);
			const { item, replaced, snapshot } = await service.addItem(
				{
					title: resolveActionResultClipboardTitle(
						params.message,
						params.action,
						params.actionResult,
					),
					content: params.actionText,
					sourceType: "action_result",
					sourceId: params.actionId,
					sourceLabel: params.action.name,
				},
				entityId,
			);
			if (params.actionResult) {
				params.actionResult.data = {
					...params.actionResult.data,
					actionResultClipboard: {
						id: item.id,
						title: item.title,
						replaced,
						count: snapshot.items.length,
						maxItems: snapshot.maxItems,
					},
				};
			}
			const verb = replaced ? "Updated" : "Copied";
			return {
				text: `${verb} ${params.action.name} result to clipboard item ${item.id}: ${item.title}. Clipboard usage: ${snapshot.items.length}/${snapshot.maxItems}.`,
			};
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			this.logger.warn(
				{
					src: "agent",
					agentId: this.agentId,
					action: params.action.name,
					actionId: params.actionId,
					error: reason,
				},
				"Failed to store action result in task clipboard",
			);
			return {
				text: `Could not copy ${params.action.name} result to clipboard: ${reason}`,
			};
		}
	}

	async processActions(
		message: Memory,
		responses: Memory[],
		state?: State,
		callback?: HandlerCallback,
		processOptions?: {
			onStreamChunk?: StreamChunkCallback;
		},
	): Promise<void> {
		setTrajectoryPurpose("action");
		// Check if action planning is enabled
		const actionPlanningEnabled = this.isActionPlanningEnabled();

		// Determine if we have multiple actions to execute
		let allActions: string[] = [];
		let responsesToProcess = responses;

		if (actionPlanningEnabled) {
			// Multi-action mode: collect all actions
			for (const response of responses) {
				if (response.content?.actions && response.content.actions.length > 0) {
					allActions.push(...response.content.actions);
				}
			}
		} else {
			// Single-action mode: only take the first action from the first response with actions
			for (const response of responses) {
				if (response.content?.actions && response.content.actions.length > 0) {
					allActions = [response.content.actions[0]];
					// Create a modified response with only the first action
					responsesToProcess = [
						{
							...response,
							content: {
								...response.content,
								actions: [response.content.actions[0]],
							},
						},
					];
					this.logger.debug(
						{
							src: "agent",
							agentId: this.agentId,
							selectedAction: response.content.actions[0],
							skippedActions: response.content.actions.slice(1),
						},
						"Action planning disabled, limiting to first action",
					);
					break;
				}
			}
		}

		// Skip processing if no actions and respect single-action mode
		const hasMultipleActions = allActions.length > 1 && actionPlanningEnabled;
		const parentRunId = this.getCurrentRunId();
		const runId = this.createRunId();

		// Create action plan if multiple actions
		let actionPlan:
			| {
					runId: UUID;
					totalSteps: number;
					currentStep: number;
					steps: Array<{
						action: string;
						status: "pending" | "completed" | "failed";
						result?: ActionResult;
						error?: string;
					}>;
					thought: string;
					startTime: number;
			  }
			| undefined;

		const firstResponse = responses[0];
		const thought =
			firstResponse?.content?.thought ||
			`Executing ${allActions.length} actions: ${allActions.join(", ")}`;

		if (hasMultipleActions) {
			// Extract thought from response content

			actionPlan = {
				runId,
				totalSteps: allActions.length,
				currentStep: 0,
				steps: allActions.map((action) => ({
					action,
					status: "pending" as const,
				})),
				thought,
				startTime: Date.now(),
			};
		}

		let actionIndex = 0;
		// Track which action names have already been executed in this
		// processActions invocation. The LLM sometimes emits the same action
		// twice in `actions` (e.g. ["SEND_MESSAGE", "OWNER_CALENDAR",
		// "OWNER_CALENDAR"] when the user has multiple sub-intents the LLM
		// can't split into per-action params). Without dedupe the second run
		// uses the same params as the first → identical output → discord
		// dedup layer rejects it as a duplicate callback. Two identical
		// action+params runs in one turn is never useful, so collapse them.
		const executedActionKeys = new Set<string>();

		for (const response of responsesToProcess) {
			if (!response.content?.actions || response.content.actions.length === 0) {
				this.logger.warn(
					{ src: "agent", agentId: this.agentId },
					"No action found in response",
				);
				continue;
			}
			const actions = response.content.actions;
			const actionParamsByName = parseActionParams(response.content?.params);

			const actionResults: ActionResult[] = [];
			let accumulatedState = state;

			function normalizeAction(actionString: string) {
				return actionString.toLowerCase().replace(/_/g, "");
			}
			const normalizedActions = this.actions.map((action) => {
				const normalizedName = normalizeAction(action.name);
				const normalizedSimiles = action.similes
					? action.similes.map((simile) => normalizeAction(simile))
					: [];
				return {
					action,
					normalizedName,
					normalizedSimiles,
				};
			});
			const actionByName = new Map<string, Action>();
			for (const entry of normalizedActions) {
				if (!actionByName.has(entry.normalizedName)) {
					actionByName.set(entry.normalizedName, entry.action);
				}
			}
			this.logger.trace(
				{
					src: "agent",
					agentId: this.agentId,
					actions: this.actions.map((a) => normalizeAction(a.name)),
				},
				"Available actions",
			);

			for (const responseAction of actions) {
				// Update current step in plan immutably
				if (actionPlan) {
					actionPlan = this.updateActionPlan(actionPlan, {
						currentStep: actionIndex + 1,
					});
				}

				// Compose state with previous action results and plan
				accumulatedState = await this.composeState(message, [
					"RECENT_MESSAGES",
					"ACTION_STATE", // This will include the action plan
				]);

				// Add action plan to state if it exists
				if (actionPlan && accumulatedState.data) {
					accumulatedState.data.actionPlan = actionPlan;
					accumulatedState.data.actionResults = actionResults;
				}

				this.logger.debug(
					{ src: "agent", agentId: this.agentId, action: responseAction },
					"Processing action",
				);
				const normalizedResponseAction = normalizeAction(responseAction);

				// First try exact match
				let action = actionByName.get(normalizedResponseAction);

				if (!action) {
					// Then try fuzzy matching
					for (const entry of normalizedActions) {
						if (
							entry.normalizedName.includes(normalizedResponseAction) ||
							normalizedResponseAction.includes(entry.normalizedName)
						) {
							action = entry.action;
							break;
						}
					}
				}

				if (!action) {
					// Try similes
					for (const entry of normalizedActions) {
						const exactSimileMatch = entry.normalizedSimiles.find(
							(simile) => simile === normalizedResponseAction,
						);

						if (exactSimileMatch) {
							action = entry.action;
							this.logger.debug(
								{
									src: "agent",
									agentId: this.agentId,
									action: action.name,
									match: "simile",
								},
								"Action resolved via simile",
							);
							break;
						}

						const fuzzySimileMatch = entry.normalizedSimiles.find(
							(simile) =>
								simile.includes(normalizedResponseAction) ||
								normalizedResponseAction.includes(simile),
						);

						if (fuzzySimileMatch) {
							action = entry.action;
							this.logger.debug(
								{
									src: "agent",
									agentId: this.agentId,
									action: action.name,
									match: "fuzzy",
								},
								"Action resolved via fuzzy match",
							);
							break;
						}
					}
				}
				if (!action) {
					const errorMsg = `Action not found: ${responseAction}`;
					this.logger.error(
						{ src: "agent", agentId: this.agentId, action: responseAction },
						"Action not found",
					);

					if (actionPlan?.steps?.[actionIndex]) {
						actionPlan = this.updateActionStep(actionPlan, actionIndex, {
							status: "failed",
							error: errorMsg,
						});
					}

					const actionMemory: Memory = {
						id: uuidv4() as UUID,
						entityId: message.entityId,
						roomId: message.roomId,
						worldId: message.worldId,
						content: {
							thought: errorMsg,
							source: "auto",
							type: "action_result",
							actionName: responseAction,
							actionStatus: "failed",
							runId,
						},
					};
					await this.createMemory(actionMemory, "messages");
					actionIndex++;
					continue;
				}
				if (!action.handler) {
					this.logger.error(
						{ src: "agent", agentId: this.agentId, action: action.name },
						"Action has no handler",
					);

					// Update plan with error immutably
					if (actionPlan?.steps?.[actionIndex]) {
						actionPlan = this.updateActionStep(actionPlan, actionIndex, {
							status: "failed",
							error: "No handler",
						});
					}

					actionIndex++;
					continue;
				}
				this.logger.debug(
					{ src: "agent", agentId: this.agentId, action: action.name },
					"Executing action",
				);

				// Validate and attach action parameters (optional)
				const options: HandlerOptions = {};
				if (action.parameters && action.parameters.length > 0) {
					const responseActionKey = responseAction.trim().toUpperCase();
					const actionKey = action.name.trim().toUpperCase();
					const extractedParams =
						actionParamsByName.get(responseActionKey) ??
						actionParamsByName.get(actionKey);
					const validation = validateActionParams(action, extractedParams);
					if (!validation.valid) {
						this.logger.warn(
							{
								src: "agent",
								agentId: this.agentId,
								action: action.name,
								errors: validation.errors,
							},
							"Skipping action with invalid parameters",
						);
						if (actionPlan?.steps?.[actionIndex]) {
							actionPlan = this.updateActionStep(actionPlan, actionIndex, {
								status: "failed",
								error: validation.errors.join("; "),
							});
						}
						actionIndex++;
						continue;
					}

					if (validation.params) options.parameters = validation.params;
				}

				// Dedupe: same action name + identical params bucket means
				// repeating the run would emit identical output. Skip the
				// repeat instead of letting the discord callback layer reject
				// it as a duplicate. Key includes the JSON of params so that
				// distinct invocations with different params still go through.
				const actionDedupeKey = `${action.name.trim().toUpperCase()}::${
					options.parameters
						? JSON.stringify(options.parameters)
						: "<no-params>"
				}`;
				if (executedActionKeys.has(actionDedupeKey)) {
					this.logger.debug(
						{
							src: "agent",
							agentId: this.agentId,
							action: action.name,
							dedupeKey: actionDedupeKey,
						},
						"Skipping duplicate action invocation in same turn",
					);
					actionIndex++;
					continue;
				}
				executedActionKeys.add(actionDedupeKey);

				const actionId = uuidv4() as UUID;
				// Separate ID for streamed response message (independent from action badge)
				const responseMessageId = uuidv4() as UUID;

				this.currentActionContext = {
					actionName: action.name,
					actionId,
					prompts: [],
				};

				// Create action context with plan information
				const actionContext: ActionContext = {
					previousResults: actionResults,
					getPreviousResult: (actionName: string) => {
						return actionResults.find(
							(r) => r.data && r.data.actionName === actionName,
						);
					},
				};

				// Add plan information to options if multiple actions
				options.actionContext = actionContext;

				if (actionPlan) {
					options.actionPlan = {
						totalSteps: actionPlan.totalSteps,
						currentStep: actionPlan.currentStep,
						steps: actionPlan.steps,
						thought: actionPlan.thought,
					};
				}

				// Pass streaming callback to action handlers
				if (processOptions?.onStreamChunk) {
					options.onStreamChunk = processOptions.onStreamChunk;
				}

				await this.emitEvent(EventType.ACTION_STARTED, {
					messageId: actionId,
					roomId: message.roomId,
					world: message.worldId,
					content: {
						text: `Executing action: ${action.name}`,
						actions: [action.name],
						actionStatus: "executing",
						actionId: actionId,
						runId: runId,
						type: "agent_action",
						thought: thought,
						source: message.content?.source,
					},
				});

				const storedCallbackData: Content[] = [];
				let visibleCallbackIndex: number | null = null;

				const storageCallback = async (response: Content) => {
					// Use responseMessageId for the text response (separate from action badge)
					response.responseId = responseMessageId;
					if (callbackContentHasVisibleOutput(response)) {
						if (visibleCallbackIndex === null) {
							visibleCallbackIndex = storedCallbackData.length;
							storedCallbackData.push(response);
						} else {
							storedCallbackData[visibleCallbackIndex] = response;
						}
						return [];
					}
					storedCallbackData.push(response);
					return [];
				};

				// Create streaming context using responseMessageId (separate from actionId)
				// This ensures streamed text goes to its own message, independent from action badge
				//
				// Actions may have multiple useModel calls (e.g., JSON extraction + text generation).
				// onStreamEnd is called after each useModel stream completes, allowing us to reset
				// the filter so content type detection from one call doesn't affect the next.
				let actionStreamingContext:
					| (StreamingContext & { onStreamEnd: () => void })
					| undefined;
				if (processOptions?.onStreamChunk) {
					let currentFilter: ActionStreamFilter | null = null;
					const onStreamChunk = processOptions.onStreamChunk;
					// Track locally accumulated filtered text for this action stream.
					// Note: upstream `accumulated` is discarded because ActionStreamFilter may
					// transform/drop content, making upstream accumulated inconsistent with
					// the actual deltas the consumer receives.
					let filteredAccumulated = "";

					actionStreamingContext = {
						messageId: responseMessageId,
						onStreamChunk: async (
							chunk: string,
							msgId?: string,
							_accumulated?: string,
						) => {
							if (!currentFilter) {
								currentFilter = new ActionStreamFilter();
							}
							const textToStream = currentFilter.push(chunk);
							if (textToStream && onStreamChunk) {
								filteredAccumulated += textToStream;
								await this.applyPipelineHooks(
									"model_stream_chunk",
									modelStreamChunkPipelineHookContext({
										source: "process_actions",
										chunk: textToStream,
										messageId: msgId,
										roomId: message.roomId,
										runId,
										responseId: responseMessageId,
										accumulated: filteredAccumulated,
									}),
								);
								await onStreamChunk(textToStream, msgId, filteredAccumulated);
							}
						},
						onStreamEnd: () => {
							const textSnapshot = filteredAccumulated;
							void this.applyPipelineHooks(
								"model_stream_end",
								modelStreamEndPipelineHookContext({
									source: "process_actions",
									roomId: message.roomId,
									runId,
									responseId: responseMessageId,
									messageId: responseMessageId,
									text: textSnapshot,
								}),
							).catch((err) => {
								this.logger.debug(
									{
										src: "agent",
										agentId: this.agentId,
										error: err instanceof Error ? err.message : String(err),
									},
									"model_stream_end pipeline hook failed",
								);
							});
							// Reset filter and local accumulator for next useModel call
							currentFilter = null;
							filteredAccumulated = "";
						},
					};
				}

				// Execute action with its own streaming context
				const actionRuntime = this as unknown as IAgentRuntime;
				const result = await withActionStep(actionRuntime, action.name, () =>
					runWithStreamingContext(actionStreamingContext, () =>
						action.handler(
							actionRuntime,
							message,
							accumulatedState,
							options,
							storageCallback,
							responses,
						),
					),
				);

				// Handle void, null, true, false returns
				const isVoidReturn =
					result === undefined ||
					result === null ||
					typeof result === "boolean";

				// Only create ActionResult if we have a proper result
				let actionResult: ActionResult | undefined;

				if (!isVoidReturn) {
					// Ensure we have an ActionResult with required success field
					if (
						typeof result === "object" &&
						result !== null &&
						("values" in result || "data" in result || "text" in result)
					) {
						const resultData =
							typeof result.data === "object" &&
							result.data !== null &&
							!Array.isArray(result.data)
								? result.data
								: {};
						// Ensure success field exists with default true
						actionResult = {
							...result,
							data: {
								actionName: action.name,
								...resultData,
							},
							success: "success" in result ? result.success : true, // Default to true if not specified
						} as ActionResult;
					} else {
						// For non-ActionResult returns, serialize the result
						// Type narrowing: after the above checks, result is a primitive or unknown object
						const resultValue: string | number | boolean | null =
							typeof result === "string"
								? result
								: typeof result === "number"
									? result
									: typeof result === "boolean"
										? result
										: result === null
											? null
											: encodeToonValue({ result });
						actionResult = {
							success: true,
							data: {
								actionName: action.name,
								result: resultValue,
							},
						};
					}

					actionResult = await this.prepareActionResultForPromptState(
						actionResult,
						message,
						actionId,
					);
					actionResults.push(actionResult);

					// Merge returned values into state
					if (actionResult.values && accumulatedState) {
						const accumulatedStateData = accumulatedState.data;
						const rawActionResults = accumulatedStateData?.actionResults;
						const existingActionResults: ActionResult[] = Array.isArray(
							rawActionResults,
						)
							? rawActionResults
							: [];
						accumulatedState = {
							...accumulatedState,
							values: { ...accumulatedState.values, ...actionResult.values },
							data: {
								...accumulatedState.data,
								actionResults: [...existingActionResults, actionResult],
								actionPlan,
							},
						};
					}

					// Store in working memory (in state data) with cleanup
					if (accumulatedState?.data) {
						if (!accumulatedState.data.workingMemory)
							accumulatedState.data.workingMemory = {};

						// Add new entry first, then clean up if we exceed the limit
						const responseAction = actionResult.data?.actionName || action.name;
						const memoryKey = `action_${responseAction}_${uuidv4()}`;
						const memoryEntry: WorkingMemoryEntry = {
							actionName: action.name,
							result: actionResult,
							timestamp: Date.now(),
						};
						const workingMemory = accumulatedState.data.workingMemory as Record<
							string,
							WorkingMemoryEntry
						>;
						workingMemory[memoryKey] = memoryEntry;

						// Clean up old entries if we now exceed the limit
						const entries = Object.entries(workingMemory);
						if (entries.length > this.maxWorkingMemoryEntries) {
							let overflow = entries.length - this.maxWorkingMemoryEntries;
							while (overflow > 0) {
								let oldestKey: string | null = null;
								let oldestTimestamp = Number.POSITIVE_INFINITY;
								for (const [key, entry] of Object.entries(workingMemory)) {
									const timestamp = entry?.timestamp ?? 0;
									if (timestamp < oldestTimestamp) {
										oldestTimestamp = timestamp;
										oldestKey = key;
									}
								}
								if (!oldestKey) break;
								delete workingMemory[oldestKey];
								overflow--;
							}
						}
					}

					// Update plan with success immutably
					if (actionPlan?.steps?.[actionIndex]) {
						actionPlan = this.updateActionStep(actionPlan, actionIndex, {
							status: "completed",
							result: actionResult,
						});
					}
				}

				const isSuccess = actionResult?.success !== false;
				const statusText = isSuccess ? "completed" : "failed";
				const actionText =
					typeof actionResult?.text === "string"
						? actionResult.text.trim()
						: "";
				const visibleCallbackText = storedCallbackData.find((content) =>
					callbackContentHasVisibleOutput(content),
				)?.text;
				const actionTextForClipboard =
					actionText ||
					(typeof visibleCallbackText === "string"
						? visibleCallbackText.trim()
						: "");
				const suppressVisibleActionText =
					suppressesVisibleActionResult(actionResult);
				const clipboardStatus = await this.maybeStoreActionResultClipboard({
					message,
					action,
					actionId,
					actionText: actionTextForClipboard,
					actionResult,
				});
				const visibleActionText = suppressVisibleActionText
					? ""
					: (actionResult?.text ?? "");

				await this.emitEvent(EventType.ACTION_COMPLETED, {
					messageId: actionId,
					roomId: message.roomId,
					world: message.worldId,
					content: {
						// Use action's actual text, not status message (prevents overwriting streamed content)
						text: visibleActionText,
						actions: [action.name],
						actionStatus: statusText,
						actionId: actionId,
						type: "agent_action",
						thought: thought,
						actionResult: actionResult,
						source: message.content?.source, // Include original message source
					},
				});

				if (callback) {
					const visibleActionCallbackIndex = storedCallbackData.findIndex(
						(content) => callbackContentHasVisibleOutput(content),
					);
					if (actionText && !suppressVisibleActionText) {
						if (visibleActionCallbackIndex === -1) {
							storedCallbackData.push({
								text: clipboardStatus
									? `${actionText}\n\n${clipboardStatus.text}`
									: actionText,
								source: "action",
								action: action.name,
							});
						} else if (clipboardStatus) {
							const visibleCallback =
								storedCallbackData[visibleActionCallbackIndex];
							if (
								visibleCallback &&
								typeof visibleCallback.text === "string" &&
								visibleCallback.text.trim()
							) {
								visibleCallback.text = `${visibleCallback.text.trim()}\n\n${clipboardStatus.text}`;
							} else {
								storedCallbackData.push({
									text: clipboardStatus.text,
									source: "action",
									action: action.name,
								});
							}
						}
					} else if (clipboardStatus) {
						if (visibleActionCallbackIndex === -1) {
							storedCallbackData.push({
								text: clipboardStatus.text,
								source: "action",
								action: action.name,
							});
						} else {
							const visibleCallback =
								storedCallbackData[visibleActionCallbackIndex];
							if (
								visibleCallback &&
								typeof visibleCallback.text === "string" &&
								visibleCallback.text.trim()
							) {
								visibleCallback.text = `${visibleCallback.text.trim()}\n\n${clipboardStatus.text}`;
							}
						}
					}
				}

				if (callback) {
					for (const content of storedCallbackData) {
						await this.applyPipelineHooks(
							"outgoing_before_deliver",
							outgoingPipelineHookContext(content, {
								source: "action",
								roomId: message.roomId,
								message,
								actionName: action.name,
								responseId: content.responseId,
							}),
						);
						await callback(content);
					}
				}

				// Only persist action memories when the handler returned a real user-facing
				// message. Placeholder bookkeeping text is internal runtime state, not chat.
				if (actionText && !suppressVisibleActionText) {
					const actionMemory: Memory = {
						id: actionId,
						entityId: this.agentId,
						roomId: message.roomId,
						worldId: message.worldId,
						content: {
							text: actionText,
							source: "action",
							type: "action_result",
							actionName: action.name,
							actionStatus: statusText,
							runId,
							...(actionPlan
								? {
										planStep: `${actionPlan.currentStep}/${actionPlan.totalSteps}`,
										planThought: actionPlan.thought,
									}
								: {}),
							...(actionResult?.data
								? {
										data: actionResult.data as import("./types/proto.js").JsonObject,
									}
								: {}),
						},
					};
					await this.createMemory(actionMemory, "messages");
				}

				this.logger.debug(
					{ src: "agent", agentId: this.agentId, action: action.name },
					"Action completed",
				);

				// log to database with collected prompts
				const logResult = actionResult
					? {
							success: actionResult.success,
							text: actionResult.text,
							error: actionResult.error,
						}
					: undefined;
				await this.adapter.createLogs([
					{
						entityId: message.entityId,
						roomId: message.roomId,
						type: "action",
						body: {
							action: action.name,
							actionId,
							message: message.content.text,
							messageId: message.id,
							result: logResult,
							isVoidReturn,
							prompts: this.currentActionContext?.prompts || [],
							promptCount: this.currentActionContext?.prompts?.length || 0,
							runId,
							parentRunId,
							...(actionPlan && {
								planStep: `${actionPlan.currentStep}/${actionPlan.totalSteps}`,
								planThought: actionPlan.thought,
							}),
						},
					},
				]);

				// Clear action context
				this.currentActionContext = undefined;

				actionIndex++;
			}

			// Store accumulated results for evaluators and providers
			if (message.id) {
				this.stateCache.set(`${message.id}_action_results`, {
					values: { actionResults },
					data: { actionResults, actionPlan },
					text: encodeToonValue({ actionResults }),
				});
			}
		}
	}

	getActionResults(messageId: UUID): ActionResult[] {
		const cachedState = this.stateCache?.get(`${messageId}_action_results`);
		return (
			(cachedState?.data &&
				(cachedState.data.actionResults as ActionResult[])) ||
			[]
		);
	}

	async evaluate(
		message: Memory,
		state: State,
		didRespond?: boolean,
		callback?: HandlerCallback,
		responses?: Memory[],
	) {
		setTrajectoryPurpose("evaluation");
		const evaluatorPromises = this.evaluators.map(
			async (evaluator: Evaluator) => {
				if (!evaluator.handler) {
					return null;
				}
				if (!didRespond && !evaluator.alwaysRun) {
					return null;
				}
				const result = await evaluator.validate(
					this as unknown as IAgentRuntime,
					message,
					state,
				);
				if (result) {
					return evaluator;
				}
				return null;
			},
		);
		const evaluators = (await Promise.all(evaluatorPromises)).filter(
			Boolean,
		) as Evaluator[];
		if (evaluators.length === 0) {
			return [];
		}
		state = await this.composeState(message, ["RECENT_MESSAGES", "EVALUATORS"]);
		// Run evaluator handlers sequentially because multiple evaluators can
		// mutate shared memories/relationships for the same turn.
		for (const evaluator of evaluators) {
			if (!evaluator.handler) {
				continue;
			}
			const evaluatorRuntime = this as unknown as IAgentRuntime;
			await withEvaluatorStep(evaluatorRuntime, evaluator.name, () =>
				evaluator.handler(
					evaluatorRuntime,
					message,
					state,
					{},
					callback,
					responses,
				),
			);
			this.adapter.createLogs([
				{
					entityId: message.entityId,
					roomId: message.roomId,
					type: "evaluator",
					body: {
						evaluator: evaluator.name,
						messageId: message.id,
						message: message.content.text,
						runId: this.getCurrentRunId(),
					},
				},
			]);
		}
		return evaluators;
	}

	// highly SQL optimized queries
	async ensureConnections(
		entities: Entity[],
		rooms: Room[],
		source: string,
		world: World,
	): Promise<void> {
		// guards
		if (!entities) {
			this.logger.error(
				{ src: "agent", agentId: this.agentId },
				"ensureConnections called without entities",
			);
			return;
		}
		if (!rooms || rooms.length === 0) {
			this.logger.error(
				{ src: "agent", agentId: this.agentId },
				"ensureConnections called without rooms",
			);
			return;
		}

		// Create/ensure the world exists for this server
		await this.ensureWorldExists({ ...world, agentId: this.agentId });

		const firstRoom = rooms[0];

		// Helper function for chunking arrays
		const chunkArray = <T>(arr: T[], size: number): T[][] =>
			arr.reduce((chunks: T[][], item: T, i: number) => {
				if (i % size === 0) chunks.push([]);
				chunks[chunks.length - 1].push(item);
				return chunks;
			}, []);

		// Step 1: Create all rooms FIRST (before adding any participants)
		const roomIds = rooms.map((r: { id: UUID }) => r.id);
		const roomExistsCheck = await this.getRoomsByIds(roomIds);
		const roomsIdExists = roomExistsCheck?.map((r: { id: UUID }) => r.id);
		const roomsToCreate = roomIds.filter(
			(id: UUID) => !roomsIdExists?.includes(id),
		);

		const rf = {
			worldId: world.id,
			messageServerId: world.messageServerId,
			source,
			agentId: this.agentId,
		};

		if (roomsToCreate.length) {
			this.logger.debug(
				{ src: "agent", agentId: this.agentId, count: roomsToCreate.length },
				"Creating rooms",
			);
			const roomObjsToCreate: Room[] = rooms
				.filter((r) => roomsToCreate.includes(r.id))
				.map((r) => ({ ...r, ...rf, type: r.type || ChannelType.GROUP }));
			await this.createRooms(roomObjsToCreate);
		}

		// Step 2: Create all entities
		const entityIds = entities
			.map((e) => e.id)
			.filter((id): id is UUID => id !== undefined);
		const entityExistsCheck = await this.adapter.getEntitiesByIds(entityIds);
		const entitiesToUpdate =
			entityExistsCheck
				?.map((e) => e.id)
				.filter((id): id is UUID => id !== undefined) || [];
		const entitiesToCreate = entities.filter(
			(e) => e.id !== undefined && !entitiesToUpdate.includes(e.id),
		);

		const r = {
			roomId: firstRoom.id,
			channelId: firstRoom.channelId,
			type: firstRoom.type,
		};
		const wf = {
			worldId: world.id,
			messageServerId: world.messageServerId,
		};

		if (entitiesToCreate.length) {
			this.logger.debug(
				{ src: "agent", agentId: this.agentId, count: entitiesToCreate.length },
				"Creating entities",
			);
			const ef = {
				...r,
				...wf,
				source,
				agentId: this.agentId,
			};
			const entitiesToCreateWFields: Entity[] = entitiesToCreate.map((e) => ({
				...e,
				...ef,
				metadata: e.metadata || {},
			}));
			// pglite doesn't like over 10k records
			const batches = chunkArray(entitiesToCreateWFields, 5000);
			for (const batch of batches) {
				await this.createEntities(batch);
			}
		}

		// Step 3: Now add all participants (rooms and entities must exist by now)
		// Always add the agent to the first room
		await this.ensureParticipantInRoom(this.agentId, firstRoom.id);

		// Add all entities to the first room
		const entityIdsInFirstRoom = await this.getParticipantsForRoom(
			firstRoom.id,
		);
		const entityIdsInFirstRoomFiltered = entityIdsInFirstRoom.filter(
			(id): id is UUID => id !== undefined,
		);
		const missingIdsInRoom = entityIds.filter(
			(id: UUID) => !entityIdsInFirstRoomFiltered.includes(id),
		);

		if (missingIdsInRoom.length) {
			this.logger.debug(
				{
					src: "agent",
					agentId: this.agentId,
					count: missingIdsInRoom.length,
					channelId: firstRoom.id,
				},
				"Adding missing participants",
			);
			// pglite handle this at over 10k records fine though
			const batches = chunkArray(missingIdsInRoom, 5000);
			for (const batch of batches) {
				await this.createRoomParticipants(batch, firstRoom.id);
			}
		}

		this.logger.success(
			{ src: "agent", agentId: this.agentId, worldId: world.id },
			"World connected",
		);
	}

	async ensureConnection(params: {
		entityId: UUID;
		roomId: UUID;
		roomName?: string;
		worldId?: UUID;
		worldName?: string;
		userName?: string;
		name?: string;
		source?: string;
		type?: ChannelType | string;
		channelId?: string;
		messageServerId?: UUID;
		userId?: UUID;
		metadata?: Record<string, JsonValue>;
	}) {
		await ensureConnectionStandalone(this.adapter, {
			agentId: this.agentId,
			worldId: params.worldId,
			messageServerId: params.messageServerId,
			...params,
			source: params.source ?? "default",
		});
		this.logger.debug(
			{
				src: "agent",
				agentId: this.agentId,
				entityId: params.entityId,
				channelId: params.roomId,
			},
			"Entity connected",
		);
	}

	async ensureParticipantInRoom(entityId: UUID, roomId: UUID) {
		// Make sure entity exists in database before adding as participant
		const entity = (await this.adapter.getEntitiesByIds([entityId]))[0] ?? null;

		// If entity is not found but it's not the agent itself, we might still want to proceed
		// This can happen when an entity exists in the database but isn't associated with this agent
		if (!entity && entityId !== this.agentId) {
			this.logger.warn(
				{ src: "agent", agentId: this.agentId, entityId },
				"Entity not accessible, attempting to add as participant",
			);
		} else if (!entity && entityId === this.agentId) {
			throw new Error(
				`Agent entity ${entityId} not found, cannot add as participant.`,
			);
		} else if (!entity) {
			throw new Error(
				`User entity ${entityId} not found, cannot add as participant.`,
			);
		}
		const participantsResult = await this.adapter.getParticipantsForRooms([
			roomId,
		]);
		const participants = participantsResult[0]?.entityIds ?? [];
		if (!participants.includes(entityId)) {
			// Add participant using the ID
			const added = await this.adapter.createRoomParticipants(
				[entityId],
				roomId,
			);

			if (!added) {
				throw new Error(
					`Failed to add participant ${entityId} to room ${roomId}`,
				);
			}
			if (entityId === this.agentId) {
				this.logger.debug(
					{ src: "agent", agentId: this.agentId, channelId: roomId },
					"Agent linked to room",
				);
			} else {
				this.logger.debug(
					{ src: "agent", agentId: this.agentId, entityId, channelId: roomId },
					"User linked to room",
				);
			}
		}
	}

	async getParticipantsForEntity(entityId: UUID): Promise<Participant[]> {
		return await this.adapter.getParticipantsForEntities([entityId]);
	}

	async getParticipantsForEntities(entityIds: UUID[]): Promise<Participant[]> {
		return await this.adapter.getParticipantsForEntities(entityIds);
	}

	async getParticipantsForRoom(roomId: UUID): Promise<UUID[]> {
		const result = await this.adapter.getParticipantsForRooms([roomId]);
		return result[0]?.entityIds ?? [];
	}

	async getParticipantsForRooms(
		roomIds: UUID[],
	): Promise<import("./types/database").ParticipantsForRoomsResult> {
		return await this.adapter.getParticipantsForRooms(roomIds);
	}

	async isRoomParticipant(roomId: UUID, entityId: UUID): Promise<boolean> {
		const results = await this.adapter.areRoomParticipants([
			{ roomId, entityId },
		]);
		return results[0] ?? false;
	}

	async areRoomParticipants(
		pairs: Array<{ roomId: UUID; entityId: UUID }>,
	): Promise<boolean[]> {
		return await this.adapter.areRoomParticipants(pairs);
	}

	async addParticipant(entityId: UUID, roomId: UUID): Promise<boolean> {
		const ids = await this.adapter.createRoomParticipants([entityId], roomId);
		return ids.length > 0;
	}

	async createRoomParticipants(
		entityIds: UUID[],
		roomId: UUID,
	): Promise<UUID[]> {
		return await this.adapter.createRoomParticipants(entityIds, roomId);
	}

	/**
	 * Ensure the existence of a world.
	 *
	 * WHY upsert: Eliminates race condition where concurrent agent basic-capabilitiess
	 * could both try to create the same world. Upsert is atomic.
	 */
	async ensureWorldExists({ id, name, messageServerId, metadata }: World) {
		// Check if world exists (for logging only)
		const world = (await this.adapter.getWorldsByIds([id]))[0] ?? null;

		// Atomic upsert - handles both insert and update
		await this.adapter.upsertWorlds([
			{
				id,
				name,
				agentId: this.agentId,
				messageServerId,
				metadata,
			},
		]);

		this.logger.debug(
			{ src: "agent", agentId: this.agentId, worldId: id, messageServerId },
			world ? "World updated" : "World created",
		);
	}

	/**
	 * Ensure the existence of a room.
	 *
	 * WHY upsert: Eliminates race condition where concurrent connection attempts
	 * (e.g., Discord bot receiving messages in same channel simultaneously) could
	 * both try to create the same room. Upsert is atomic.
	 */
	async ensureRoomExists({
		id,
		name,
		source,
		type,
		channelId,
		messageServerId,
		worldId,
		metadata,
	}: Room) {
		if (!worldId) throw new Error("worldId is required");

		// Check if room exists (for logging only)
		const room = await this.getRoom(id);

		// Atomic upsert - handles both insert and update
		await this.adapter.upsertRooms([
			{
				id,
				name,
				agentId: this.agentId,
				source,
				type,
				channelId,
				messageServerId,
				worldId,
				metadata,
			},
		]);

		this.logger.debug(
			{ src: "agent", agentId: this.agentId, channelId: id },
			room ? "Room updated" : "Room created",
		);
	}

	async composeState(
		message: Memory,
		includeList: string[] | null = null,
		onlyInclude = false,
		skipCache = false,
	): Promise<State> {
		const trajectoryStepIdFromMessage =
			typeof message.metadata === "object" &&
			message.metadata !== null &&
			"trajectoryStepId" in message.metadata
				? (message.metadata as { trajectoryStepId?: string }).trajectoryStepId
				: undefined;
		const trajectoryStepId =
			typeof trajectoryStepIdFromMessage === "string" &&
			trajectoryStepIdFromMessage.trim() !== ""
				? trajectoryStepIdFromMessage
				: getTrajectoryContext()?.trajectoryStepId;

		// If we're running inside a trajectory step, always bypass the state cache so
		// providers are executed and can be logged for training/benchmark traces.
		if (trajectoryStepId) {
			skipCache = true;
		}

		const filterList = onlyInclude ? includeList : null;
		const emptyObj = {
			values: {},
			data: {},
			text: "",
		} as State;
		const cachedState =
			skipCache || !message.id
				? emptyObj
				: (await this.stateCache.get(message.id)) || emptyObj;
		const activeContexts = getActiveRoutingContextsForTurn(
			cachedState,
			message,
		);
		const providerNames = new Set<string>();
		if (filterList && filterList.length > 0) {
			for (const name of filterList) {
				providerNames.add(name);
			}
		} else {
			for (const p of this.providers.filter((p) => !p.private && !p.dynamic)) {
				if (
					activeContexts.length > 0 &&
					!shouldIncludeByContext(resolveProviderContexts(p), activeContexts)
				) {
					continue;
				}
				providerNames.add(p.name);
			}
		}
		if (!filterList && includeList && includeList.length > 0) {
			for (const name of includeList) {
				providerNames.add(name);
			}
		}
		const providersToGet: Provider[] = [];
		for (const provider of this.providers) {
			if (providerNames.has(provider.name)) {
				providersToGet.push(provider);
			}
		}
		providersToGet.sort(
			(a, b) =>
				(a.position || 0) - (b.position || 0) || a.name.localeCompare(b.name),
		);

		// Optional trajectory logging service (no-op by default).
		type TrajectoryLogger = Service & {
			logProviderAccess: (params: {
				stepId: string;
				providerName: string;
				data: Record<string, string | number | boolean | null>;
				purpose: string;
				query?: Record<string, string | number | boolean | null>;
				runId?: string;
				roomId?: string;
				messageId?: string;
				executionTraceId?: string;
			}) => void;
		};
		const trajLogger = (await this._ensureServiceStarted(
			"trajectories",
		)) as TrajectoryLogger | null;
		const providerData = await Promise.all(
			providersToGet.map(async (provider) => {
				const start = Date.now();
				let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
				let timedOut = false;
				const providerRuntime = this as unknown as IAgentRuntime;
				try {
					const result = await Promise.race([
						withProviderStep(providerRuntime, provider.name, () =>
							provider.get(providerRuntime, message, cachedState),
						),
						new Promise<ProviderResult>((resolve) => {
							timeoutHandle = setTimeout(() => {
								timedOut = true;
								this.logger.error(
									{
										src: "agent",
										agentId: this.agentId,
										provider: provider.name,
										timeoutMs: COMPOSE_STATE_PROVIDER_TIMEOUT_MS,
									},
									"Provider timed out during state composition",
								);
								resolve({ text: "", values: {}, data: {} });
							}, COMPOSE_STATE_PROVIDER_TIMEOUT_MS);
						}),
					]);
					const duration = Date.now() - start;

					// Only log slow successful providers. Timed-out providers already logged above.
					if (!timedOut && duration > 100) {
						this.logger.debug(
							{
								src: "agent",
								agentId: this.agentId,
								provider: provider.name,
								duration,
							},
							"Slow provider",
						);
					}
					return {
						...result,
						providerName: provider.name,
					};
				} catch (error) {
					this.logger.error(
						{
							src: "agent",
							agentId: this.agentId,
							provider: provider.name,
							error: error instanceof Error ? error.message : String(error),
						},
						"Provider failed during state composition",
					);
					return {
						text: "",
						values: {},
						data: {},
						providerName: provider.name,
					};
				} finally {
					if (timeoutHandle !== undefined) {
						clearTimeout(timeoutHandle);
					}
				}
			}),
		);

		if (trajectoryStepId && trajLogger) {
			const userText =
				typeof message.content?.text === "string" ? message.content.text : "";
			const trajCtx = getTrajectoryContext();
			const providerTraceId = this.getActiveTrace(this.getCurrentRunId())?.id;
			for (const r of providerData) {
				try {
					const textLen = typeof r.text === "string" ? r.text.length : 0;
					trajLogger.logProviderAccess({
						stepId: trajectoryStepId,
						providerName: r.providerName,
						data: { textLength: textLen },
						purpose: "compose_state",
						query: { message: userText.slice(0, 2000) },
						runId: trajCtx?.runId,
						roomId: trajCtx?.roomId,
						messageId: trajCtx?.messageId,
						executionTraceId: providerTraceId,
					});
				} catch {
					// Trajectory logging must never break core message flow.
				}
			}
		}
		const currentProviderResults: Record<
			string,
			{
				text?: string;
				values?: Record<string, ProviderValue>;
				providerName: string;
			}
		> = {
			...(cachedState.data?.providers as
				| Record<
						string,
						{
							text?: string;
							values?: Record<string, ProviderValue>;
							providerName: string;
						}
				  >
				| undefined),
		};
		for (const freshResult of providerData) {
			// Redact secrets from individual provider text results
			const redactedText = freshResult.text
				? this.redactSecrets(freshResult.text)
				: freshResult.text;
			currentProviderResults[freshResult.providerName] = {
				...freshResult,
				text: redactedText,
				values:
					freshResult.values && typeof freshResult.values === "object"
						? Object.fromEntries(
								Object.entries(freshResult.values).filter(
									([, value]) => value !== undefined,
								),
							)
						: undefined,
			};
		}
		const orderedTexts: string[] = [];
		for (const provider of providersToGet) {
			const result = currentProviderResults[provider.name];
			if (
				result?.text &&
				typeof result.text === "string" &&
				result.text.trim() !== ""
			) {
				orderedTexts.push(result.text);
			}
		}
		// Redact any secrets from provider context before use
		const rawProvidersText = orderedTexts.join("\n");
		const providersText = this.redactSecrets(rawProvidersText);
		const conversationSeed = buildDeterministicSeed(
			this.agentId,
			message.roomId,
			"conversation",
		);
		const aggregatedStateValues: Record<string, StateValue> = {
			...cachedState.values,
		};
		for (const provider of providersToGet) {
			const providerResult = currentProviderResults[provider.name];
			if (
				providerResult?.values &&
				typeof providerResult.values === "object" &&
				providerResult.values !== null
			) {
				Object.assign(aggregatedStateValues, providerResult.values);
			}
		}
		for (const providerName in currentProviderResults) {
			if (!providersToGet.some((p) => p.name === providerName)) {
				const providerResult = currentProviderResults[providerName];
				if (
					providerResult?.values &&
					typeof providerResult.values === "object" &&
					providerResult.values !== null
				) {
					Object.assign(aggregatedStateValues, providerResult.values);
				}
			}
		}
		const newState = {
			values: {
				...aggregatedStateValues,
				__conversationSeed: conversationSeed,
				providers: providersText,
			},
			data: {
				...cachedState.data,
				__conversationSeed: conversationSeed,
				providerOrder: providersToGet.map((provider) => provider.name),
				providers: currentProviderResults,
			},
			text: providersText,
		} as State;
		if (message.id) {
			this.stateCache.set(message.id, newState);
		}
		return newState;
	}

	/** Lazy service start: used internally by _ensureServiceStarted / getServiceLoadPromise. */
	/** Dedupes concurrent starts for the same type via startingServices so only one start runs. */
	private async _ensureServiceStarted(
		serviceType: ServiceTypeName | string,
	): Promise<Service | null> {
		if (this.stopped) return null;
		if (!this.isNativeFeatureServiceEnabled(serviceType)) return null;
		const key = this.resolveServiceTypeAlias(serviceType) as ServiceTypeName;
		const instances = this.services.get(key);
		if (instances && instances.length > 0) {
			return instances[0];
		}
		const classes = this.serviceTypes.get(key);
		if (!classes || classes.length === 0) {
			return null;
		}
		let inFlight = this.startingServices.get(key);
		if (!inFlight) {
			// Start ALL registered service classes for this type, not just the first.
			// This supports multiple services of the same type (e.g. multiple wallet services).
			inFlight = (async () => {
				let first: Service | null = null;
				for (const cls of classes) {
					const result = await this._runServiceStart(key, serviceType, cls);
					if (result && !first) first = result;
				}
				return first;
			})();
			this.startingServices.set(key, inFlight);
		}
		try {
			return await inFlight;
		} finally {
			this.startingServices.delete(key);
		}
	}

	/** Runs one service start; used by _ensureServiceStarted with startingServices dedupe. */
	private async _runServiceStart(
		key: ServiceTypeName,
		serviceType: string,
		serviceDef: ServiceClass,
	): Promise<Service | null> {
		this.serviceRegistrationStatus.set(key, "registering");
		await this.initPromise;
		if (typeof serviceDef.start !== "function") {
			this.logger.error(
				{ src: "agent", agentId: this.agentId, serviceType },
				"Service class has no static start method",
			);
			this.serviceRegistrationStatus.set(key, "failed");
			return null;
		}
		try {
			const serviceInstance = await serviceDef.start(
				this as unknown as IAgentRuntime,
			);
			if (!serviceInstance) {
				this.serviceRegistrationStatus.set(key, "failed");
				return null;
			}
			if (!this.services.has(key)) {
				this.services.set(key, []);
			}
			const serviceList = this.services.get(key);
			if (serviceList) {
				serviceList.push(serviceInstance);
			}
			const handler = this.servicePromiseHandlers.get(serviceType);
			if (handler) {
				handler.resolve(serviceInstance);
				this.servicePromiseHandlers.delete(serviceType);
			}
			if (serviceDef.registerSendHandlers) {
				serviceDef.registerSendHandlers(
					this as unknown as IAgentRuntime,
					serviceInstance,
				);
			}
			this.serviceRegistrationStatus.set(key, "registered");
			return serviceInstance;
		} catch (error) {
			this.logger.error(
				{
					src: "agent",
					agentId: this.agentId,
					serviceType,
					error: error instanceof Error ? error.message : String(error),
				},
				"Service start failed",
			);
			const handler = this.servicePromiseHandlers.get(serviceType);
			if (handler) {
				handler.reject(
					error instanceof Error ? error : new Error(String(error)),
				);
				this.servicePromiseHandlers.delete(serviceType);
				this.servicePromises.delete(serviceType);
			}
			this.serviceRegistrationStatus.set(key, "failed");
			return null;
		}
	}

	/** Returns the service instance or null. Synchronous lookup from the services map. */
	getService<T extends Service = Service>(
		serviceName: ServiceTypeName | string,
	): T | null {
		if (!this.isNativeFeatureServiceEnabled(serviceName)) {
			return null;
		}
		const key = this.resolveServiceTypeAlias(serviceName) as ServiceTypeName;
		const instances = this.services.get(key);
		if (instances && instances.length > 0) {
			return instances[0] as T;
		}
		return null;
	}

	/**
	 * Type-safe service getter that ensures the correct service type is returned
	 * @template T - The expected service class type
	 * @param serviceName - The service type name
	 * @returns The service instance with proper typing, or null if not found
	 */
	getTypedService<T extends Service = Service>(
		serviceName: ServiceTypeName | string,
	): T | null {
		return this.getService<T>(serviceName);
	}

	/**
	 * Get all services of a specific type
	 * @template T - The expected service class type
	 * @param serviceName - The service type name
	 * @returns Array of service instances with proper typing
	 */
	getServicesByType<T extends Service = Service>(
		serviceName: ServiceTypeName | string,
	): T[] {
		if (!this.isNativeFeatureServiceEnabled(serviceName)) {
			return [];
		}
		const key = this.resolveServiceTypeAlias(serviceName) as ServiceTypeName;
		const serviceInstances = this.services.get(key);
		if (!serviceInstances || serviceInstances.length === 0) {
			this.logger.debug(
				{ src: "agent", agentId: this.agentId, serviceName: key },
				"No services found for type",
			);
			return [];
		}
		return serviceInstances as T[];
	}

	/**
	 * Get all registered service types (includes lazy-registered, not yet started)
	 * @returns Array of registered service type names
	 */
	getRegisteredServiceTypes(): ServiceTypeName[] {
		return Array.from(this.serviceTypes.keys());
	}

	/**
	 * Check if a service type is registered (class registered; may not be started yet)
	 * @param serviceType - The service type to check
	 * @returns true if the service is registered
	 */
	hasService(serviceType: ServiceTypeName | string): boolean {
		if (!this.isNativeFeatureServiceEnabled(serviceType)) {
			return false;
		}
		const key = this.resolveServiceTypeAlias(serviceType) as ServiceTypeName;
		const classes = this.serviceTypes.get(key);
		return classes !== undefined && classes.length > 0;
	}

	/**
	 * Get the registration status of a service
	 * @param serviceType - The service type to check
	 * @returns the current registration status
	 */
	getServiceRegistrationStatus(
		serviceType: ServiceTypeName | string,
	): "pending" | "registering" | "registered" | "failed" | "unknown" {
		if (!this.isNativeFeatureServiceEnabled(serviceType)) {
			return "unknown";
		}
		const key = this.resolveServiceTypeAlias(serviceType) as ServiceTypeName;
		return this.serviceRegistrationStatus.get(key) || "unknown";
	}

	/**
	 * Get service health information
	 * @returns Object containing service health status
	 */
	getServiceHealth(): Record<
		string,
		{
			status: "pending" | "registering" | "registered" | "failed" | "unknown";
			instances: number;
			hasPromise: boolean;
		}
	> {
		const health: Record<
			string,
			{
				status: "pending" | "registering" | "registered" | "failed" | "unknown";
				instances: number;
				hasPromise: boolean;
			}
		> = {};

		// Check all registered services
		for (const [serviceType, instances] of this.services) {
			health[serviceType] = {
				status: this.getServiceRegistrationStatus(serviceType),
				instances: instances.length,
				hasPromise: this.servicePromises.has(serviceType),
			};
		}

		// Check services that have registration status but no instances yet
		for (const [serviceType, status] of this.serviceRegistrationStatus) {
			if (!health[serviceType]) {
				health[serviceType] = {
					status,
					instances: 0,
					hasPromise: this.servicePromises.has(serviceType),
				};
			}
		}

		return health;
	}

	async registerService(serviceDef: ServiceClass): Promise<void> {
		const serviceType = serviceDef.serviceType as ServiceTypeName;
		const serviceName = (serviceDef as { name?: string }).name || "Unknown";

		if (!serviceType) {
			this.logger.warn(
				{ src: "agent", agentId: this.agentId, serviceName },
				"Service missing serviceType property",
			);
			return;
		}
		this.logger.debug(
			{ src: "agent", agentId: this.agentId, serviceType },
			"Registering service (lazy; start() on first getService)",
		);
		if (serviceType === WEB_SEARCH_SERVICE_TYPE) {
			this.ensureWebSearchCategoryRegistered();
		}

		this.serviceRegistrationStatus.set(serviceType, "pending");
		if (!this.servicePromises.has(serviceType)) {
			this._createServiceResolver(serviceType);
		}
		if (!this.serviceTypes.has(serviceType)) {
			this.serviceTypes.set(serviceType, []);
		}
		const serviceClassList = this.serviceTypes.get(serviceType);
		if (!serviceClassList) {
			return;
		}
		serviceClassList.push(serviceDef);
	}

	/// ensures servicePromises & servicePromiseHandlers for a serviceType
	private _createServiceResolver(serviceType: ServiceTypeName | string) {
		let resolver: ServiceResolver | undefined;
		let rejecter: ServiceRejecter | undefined;
		const svcPromise = new Promise<Service>((resolve, reject) => {
			resolver = resolve;
			rejecter = reject;
		});
		// Prevent unhandled rejection if the service fails before anyone
		// awaits this promise.  Callers of getServiceLoadPromise() will
		// still observe the rejection when they await.
		svcPromise.catch(() => {});
		this.servicePromises.set(serviceType, svcPromise);
		if (!resolver) {
			throw new Error(`Failed to create resolver for service ${serviceType}`);
		}
		if (!rejecter) {
			throw new Error(`Failed to create rejecter for service ${serviceType}`);
		}
		this.servicePromiseHandlers.set(serviceType, {
			resolve: resolver,
			reject: rejecter,
		});
		const promise = this.servicePromises.get(serviceType);
		if (!promise) {
			throw new Error(`Service promise for ${serviceType} not found`);
		}
		return promise;
	}

	/// Returns a promise that resolves once this service is loaded (starts the service on first call).
	///
	/// Note: Plugins can register arbitrary service type strings; callers may
	/// therefore provide either a core `ServiceTypeName` or a plugin-defined string.
	getServiceLoadPromise(
		serviceType: ServiceTypeName | string,
	): Promise<Service> {
		const key = this.resolveServiceTypeAlias(serviceType) as ServiceTypeName;
		return this._ensureServiceStarted(key).then((s) => {
			if (!s)
				throw new Error(
					`Service ${String(serviceType)} not found or failed to start`,
				);
			return s;
		});
	}

	registerModel(
		modelType: ModelTypeName | string,
		handler: (
			runtime: IAgentRuntime,
			params: Record<string, JsonValue | object>,
		) => Promise<JsonValue | object>,
		provider: string,
		priority?: number,
	): void {
		const modelKey = String(modelType);
		if (!this.models.has(modelKey)) {
			this.models.set(modelKey, []);
		}

		const registrationOrder = Date.now();
		const modelsArray = this.models.get(modelKey);
		if (modelsArray) {
			modelsArray.push({
				handler,
				provider,
				priority: priority || 0,
				registrationOrder,
			});
			modelsArray.sort((a, b) => {
				if ((b.priority || 0) !== (a.priority || 0)) {
					return (b.priority || 0) - (a.priority || 0);
				}
				return (a.registrationOrder || 0) - (b.registrationOrder || 0);
			});
		}
	}

	private resolveModelRegistration(
		modelType: ModelTypeName | string,
		provider?: string,
	):
		| {
				handler: (
					runtime: IAgentRuntime,
					params: Record<string, JsonValue | object>,
				) => Promise<JsonValue | object>;
				modelKey: string;
				provider: string;
		  }
		| undefined {
		const requestedModelKey = String(modelType);

		for (const candidateKey of getModelFallbackChain(requestedModelKey)) {
			const models = this.models.get(candidateKey);
			if (!models?.length) {
				continue;
			}

			const modelWithProvider =
				provider && models.find((model) => model.provider === provider);
			if (provider && !modelWithProvider) {
				continue;
			}

			const resolvedModel = modelWithProvider ?? models[0];
			if (!resolvedModel) {
				continue;
			}

			if (candidateKey !== requestedModelKey) {
				this.logger.debug(
					{
						src: "agent",
						agentId: this.agentId,
						requestedModel: requestedModelKey,
						resolvedModel: candidateKey,
						provider: resolvedModel.provider,
					},
					"Model fallback applied",
				);
			}

			return {
				handler: resolvedModel.handler,
				modelKey: candidateKey,
				provider: resolvedModel.provider,
			};
		}

		return undefined;
	}

	getModel(
		modelType: ModelTypeName | string,
	):
		| ((
				runtime: IAgentRuntime,
				params: Record<string, JsonValue | object>,
		  ) => Promise<JsonValue | object>)
		| undefined {
		const resolvedModel = this.resolveModelRegistration(modelType);
		if (!resolvedModel) {
			return undefined;
		}

		// Return highest priority handler (first in array after sorting)
		this.logger.debug(
			{
				src: "agent",
				agentId: this.agentId,
				model: resolvedModel.modelKey,
				provider: resolvedModel.provider,
			},
			"Using model",
		);
		return resolvedModel.handler;
	}

	/**
	 * Retrieves model configuration settings from character settings with support for
	 * model-specific overrides and default fallbacks.
	 *
	 * Precedence order (highest to lowest):
	 * 1. Model-specific settings (e.g., TEXT_SMALL_TEMPERATURE)
	 * 2. Default settings (e.g., DEFAULT_TEMPERATURE)
	 *
	 * @param modelType The specific model type to get settings for
	 * @returns Object containing model parameters if they exist, or null if no settings are configured
	 */
	private getModelSettings(
		modelType?: ModelTypeName,
	): Record<string, number> | null {
		const modelSettings: Record<string, number> = {};

		// Helper to get a setting value with fallback chain
		const getSettingWithFallback = (
			param:
				| "MAX_TOKENS"
				| "TEMPERATURE"
				| "TOP_P"
				| "TOP_K"
				| "MIN_P"
				| "SEED"
				| "REPETITION_PENALTY"
				| "FREQUENCY_PENALTY"
				| "PRESENCE_PENALTY",
		): number | null => {
			// Try model-specific setting first
			if (modelType) {
				const modelSpecificKey = `${modelType}_${param}`;
				const modelValue = this.getSetting(modelSpecificKey);
				if (modelValue !== null && modelValue !== undefined) {
					const numValue = Number(modelValue);
					if (!Number.isNaN(numValue)) {
						return numValue;
					}
				}
			}

			// Fall back to default setting
			const defaultKey = `DEFAULT_${param}`;
			const defaultValue = this.getSetting(defaultKey);
			if (defaultValue !== null && defaultValue !== undefined) {
				const numValue = Number(defaultValue);
				if (!Number.isNaN(numValue)) {
					return numValue;
				}
			}

			return null;
		};

		// Get settings with proper fallback chain
		const maxTokens = getSettingWithFallback("MAX_TOKENS");
		const temperature = getSettingWithFallback("TEMPERATURE");
		const topP = getSettingWithFallback("TOP_P");
		const topK = getSettingWithFallback("TOP_K");
		const minP = getSettingWithFallback("MIN_P");
		const seed = getSettingWithFallback("SEED");
		const repetitionPenalty = getSettingWithFallback("REPETITION_PENALTY");
		const frequencyPenalty = getSettingWithFallback("FREQUENCY_PENALTY");
		const presencePenalty = getSettingWithFallback("PRESENCE_PENALTY");

		// Add settings if they exist
		if (maxTokens !== null) modelSettings.maxTokens = maxTokens;
		if (temperature !== null) modelSettings.temperature = temperature;
		if (topP !== null) modelSettings.topP = topP;
		if (topK !== null) modelSettings.topK = topK;
		if (minP !== null) modelSettings.minP = minP;
		if (seed !== null) modelSettings.seed = seed;
		if (repetitionPenalty !== null)
			modelSettings.repetitionPenalty = repetitionPenalty;
		if (frequencyPenalty !== null)
			modelSettings.frequencyPenalty = frequencyPenalty;
		if (presencePenalty !== null)
			modelSettings.presencePenalty = presencePenalty;

		// Return null if no settings were configured
		return Object.keys(modelSettings).length > 0 ? modelSettings : null;
	}

	/**
	 * Helper to log model calls to the database (used by both streaming and non-streaming paths)
	 */
	private logModelCall(
		modelType: string,
		modelKey: string,
		_params: unknown,
		promptContent: string | null,
		elapsedTime: number,
		provider: string | undefined,
		response: unknown,
	): void {
		// Log prompts to action context (except embeddings)
		if (modelKey !== ModelType.TEXT_EMBEDDING && promptContent) {
			if (this.currentActionContext) {
				this.currentActionContext.prompts.push({
					modelType: modelKey,
					prompt: promptContent,
					timestamp: Date.now(),
				});
			}
		}

		// Log to database
		const responseValue =
			Array.isArray(response) && response.every((x) => typeof x === "number")
				? "[array]"
				: typeof response === "string"
					? response
					: undefined;
		void this.adapter
			.createLogs([
				{
					entityId: this.agentId,
					roomId: this.currentRoomId ?? this.agentId,
					body: {
						modelType,
						modelKey,
						prompt: promptContent ?? undefined,
						systemPrompt: this.character.system ?? undefined,
						runId: this.getCurrentRunId(),
						timestamp: Date.now(),
						executionTime: elapsedTime,
						provider:
							provider || this.models.get(modelKey)?.[0]?.provider || "unknown",
						actionContext: this.currentActionContext
							? {
									actionName: this.currentActionContext.actionName,
									actionId: this.currentActionContext.actionId,
								}
							: undefined,
						response: responseValue,
					},
					type: `useModel:${modelKey}`,
				},
			])
			.catch((error) => {
				this.logger.debug(
					{
						src: "agent",
						agentId: this.agentId,
						model: modelKey,
						error: error instanceof Error ? error.message : String(error),
					},
					"Model call log write failed",
				);
			});
	}

	async useModel<T extends keyof ModelParamsMap, R = ModelResultMap[T]>(
		modelType: T,
		params: ModelParamsMap[T],
		provider?: string,
	): Promise<R> {
		let requestedModelKey = String(modelType);

		// Apply LLM mode override for text generation models
		const llmMode = this.getLLMMode();
		if (llmMode !== "DEFAULT") {
			// List of text generation model types that can be overridden
			const textGenerationModels = [
				ModelType.TEXT_NANO,
				ModelType.TEXT_SMALL,
				ModelType.TEXT_MEDIUM,
				ModelType.TEXT_LARGE,
				ModelType.TEXT_MEGA,
				ModelType.RESPONSE_HANDLER,
				ModelType.ACTION_PLANNER,
				ModelType.TEXT_COMPLETION,
			];

			if (
				textGenerationModels.includes(
					requestedModelKey as (typeof textGenerationModels)[number],
				)
			) {
				const overrideModelKey =
					llmMode === "SMALL" ? ModelType.TEXT_SMALL : ModelType.TEXT_LARGE;
				if (requestedModelKey !== overrideModelKey) {
					this.logger.debug(
						{
							src: "agent",
							agentId: this.agentId,
							originalModel: requestedModelKey,
							overrideModel: overrideModelKey,
							llmMode,
						},
						"LLM mode override applied",
					);
					requestedModelKey = overrideModelKey as typeof requestedModelKey;
				}
			}
		}

		// Only treat params as an object if it's actually an object (not a string or primitive)
		const paramsObj =
			params && typeof params === "object" && !Array.isArray(params)
				? (params as Record<string, JsonValue | object>)
				: null;
		const promptContent =
			(paramsObj &&
			"prompt" in paramsObj &&
			typeof paramsObj.prompt === "string"
				? paramsObj.prompt
				: null) ||
			(paramsObj && "input" in paramsObj && typeof paramsObj.input === "string"
				? paramsObj.input
				: null) ||
			(paramsObj && "messages" in paramsObj && Array.isArray(paramsObj.messages)
				? encodeToonValue({ messages: paramsObj.messages })
				: null) ||
			(typeof params === "string" ? params : null);
		const resolvedModel = this.resolveModelRegistration(
			requestedModelKey,
			provider,
		);
		const resolvedModelKey = resolvedModel?.modelKey ?? requestedModelKey;
		const handler = resolvedModel?.handler;
		if (!handler) {
			// If the request is for a text-generation model AND no text-generation
			// handler is registered for ANY of the text model types, this is the
			// "no LLM provider configured at all" state — surface a typed error
			// so callers (chat UI, etc.) can render an actionable hint instead of
			// a generic "No handler found for delegate type" parse-failure message.
			// Issue: elizaOS/eliza#7203.
			if (TEXT_GENERATION_MODEL_KEYS.includes(requestedModelKey)) {
				const hasAnyTextHandler = TEXT_GENERATION_MODEL_KEYS.some((key) => {
					const handlers = this.models.get(key);
					return Array.isArray(handlers) && handlers.length > 0;
				});
				if (!hasAnyTextHandler) {
					throw new NoModelProviderConfiguredError();
				}
			}
			const errorMsg = `No handler found for delegate type: ${requestedModelKey}`;
			throw new Error(errorMsg);
		}

		// Log input parameters (keep debug log if useful)
		// Skip verbose logging for binary data models (TRANSCRIPTION, IMAGE, AUDIO, VIDEO)
		const binaryModels: string[] = [
			ModelType.TRANSCRIPTION,
			ModelType.IMAGE,
			ModelType.AUDIO,
			ModelType.VIDEO,
		];
		if (!binaryModels.includes(resolvedModelKey)) {
			this.logger.trace(
				{
					src: "agent",
					agentId: this.agentId,
					model: resolvedModelKey,
					params,
				},
				"Model input",
			);
		} else {
			// For binary models, just log the type and size info
			let sizeInfo = "unknown size";
			if (Buffer.isBuffer(params)) {
				sizeInfo = `${params.length} bytes`;
			} else if (typeof Blob !== "undefined" && params instanceof Blob) {
				sizeInfo = `${params.size} bytes`;
			} else if (typeof params === "object" && params !== null) {
				if ("audio" in params && Buffer.isBuffer(params.audio)) {
					sizeInfo = `${(params.audio as Buffer).length} bytes`;
				} else if (
					"audio" in params &&
					typeof Blob !== "undefined" &&
					params.audio instanceof Blob
				) {
					sizeInfo = `${(params.audio as Blob).size} bytes`;
				}
			}
			this.logger.trace(
				{
					src: "agent",
					agentId: this.agentId,
					model: resolvedModelKey,
					size: sizeInfo,
				},
				"Model input (binary)",
			);
		}
		let modelParams: ModelParamsMap[T];
		const paramsClone = isPlainObject(params)
			? { ...(params as Record<string, JsonValue | object>) }
			: params;
		if (
			params === null ||
			params === undefined ||
			typeof params !== "object" ||
			Array.isArray(params) ||
			BufferUtils.isBuffer(params)
		) {
			modelParams = paramsClone as ModelParamsMap[T];
		} else {
			// Include model settings from character configuration if available
			const modelSettings = this.getModelSettings(requestedModelKey);

			if (modelSettings) {
				// Apply model settings if configured
				modelParams = {
					...modelSettings, // Apply model settings first (includes defaults and model-specific)
					...(paramsClone as Record<string, JsonValue | object>), // Then apply specific params (allowing overrides)
				} as ModelParamsMap[T];
			} else {
				// No model settings configured, use params as-is
				modelParams = paramsClone as ModelParamsMap[T];
			}

			// Auto-populate user parameter from character name if not provided
			// The `user` parameter is used by LLM providers for tracking and analytics purposes.
			// We only auto-populate when user is undefined (not explicitly set to empty string or null)
			// to allow users to intentionally set an empty identifier if needed.
			const shouldAttachUser =
				requestedModelKey === ModelType.TEXT_NANO ||
				requestedModelKey === ModelType.TEXT_SMALL ||
				requestedModelKey === ModelType.TEXT_MEDIUM ||
				requestedModelKey === ModelType.TEXT_LARGE ||
				requestedModelKey === ModelType.TEXT_MEGA ||
				requestedModelKey === ModelType.RESPONSE_HANDLER ||
				requestedModelKey === ModelType.ACTION_PLANNER ||
				requestedModelKey === ModelType.TEXT_COMPLETION;
			if (
				shouldAttachUser &&
				isPlainObject(modelParams) &&
				this.character.name
			) {
				const modelParamsRecord = modelParams as Record<
					string,
					JsonValue | object
				>;
				if (modelParamsRecord.user === undefined) {
					modelParamsRecord.user = this.character.name;
				}
			}
		}
		const startTime =
			typeof performance !== "undefined" &&
			typeof performance.now === "function"
				? performance.now()
				: Date.now();

		// Get streaming config
		// Define interface for params that may have streaming properties
		interface StreamingParams {
			stream?: boolean;
			onStreamChunk?: StreamChunkCallback;
		}
		const streamingCtx = getStreamingContext();
		const paramsAsStreaming = isPlainObject(modelParams)
			? (modelParams as StreamingParams)
			: undefined;
		const paramsChunk = paramsAsStreaming?.onStreamChunk;
		const ctxChunk = streamingCtx?.onStreamChunk;
		const msgId = streamingCtx?.messageId;
		const abortSignal = streamingCtx?.abortSignal;
		const explicitStream = paramsAsStreaming?.stream;

		// stream: false = force no stream, otherwise stream if any callback exists
		const shouldStream =
			explicitStream === false
				? false
				: !!(paramsChunk || ctxChunk || explicitStream);

		if (isPlainObject(modelParams) && paramsAsStreaming) {
			paramsAsStreaming.stream = shouldStream;
			delete paramsAsStreaming.onStreamChunk;
		}

		await this.invokePipelineHooks(
			"pre_model",
			preModelPipelineHookContext({
				requestedModelType: String(modelType),
				resolvedModelKey,
				provider: resolvedModel?.provider ?? provider,
				roomId: getTrajectoryContext()?.roomId,
				params: modelParams,
			}),
			"Pre-model pipeline hook",
		);

		const rawResponse = await handler(
			this as unknown as IAgentRuntime,
			modelParams as Record<string, JsonValue | object>,
		);

		const resultRef: { current: unknown } = { current: rawResponse };
		const modelOutToTrajectoryString = (v: unknown) =>
			typeof v === "string" ? v : encodeToonValue({ response: v });

		// Stream: broadcast to callbacks if streaming
		if (
			shouldStream &&
			(paramsChunk || ctxChunk) &&
			isTextStreamResult(rawResponse)
		) {
			// WHY undefined for accumulated: raw LLM tokens have no field-level
			// extraction; accumulated text is only meaningful after a TOON field
			// extractor has parsed and isolated a field. Passing undefined is
			// honest; consumers that need
			// accumulated data get it from the extractor's onChunk bridge in
			// dynamicPromptExecFromState, not from the raw token loop.
			let fullText = "";
			for await (const chunk of rawResponse.textStream) {
				if (abortSignal?.aborted) break;
				fullText += chunk;
				const trajStream = getTrajectoryContext();
				await this.invokePipelineHooks(
					"model_stream_chunk",
					modelStreamChunkPipelineHookContext({
						source: "use_model",
						chunk,
						messageId: msgId,
						roomId:
							(trajStream?.roomId as UUID | undefined) ??
							this.currentRoomId ??
							this.agentId,
						runId: this.getCurrentRunId(),
						...(trajStream?.messageId
							? { responseId: trajStream.messageId as UUID }
							: {}),
						accumulated: fullText,
					}),
					"Model stream chunk (useModel)",
					false,
				);
				await runInsideModelStreamChunkDelivery(async () => {
					if (paramsChunk) await paramsChunk(chunk, msgId, undefined);
					if (ctxChunk) await ctxChunk(chunk, msgId, undefined);
				});
			}

			const trajStreamEnd = getTrajectoryContext();
			await this.invokePipelineHooks(
				"model_stream_end",
				modelStreamEndPipelineHookContext({
					source: "use_model",
					roomId:
						(trajStreamEnd?.roomId as UUID | undefined) ??
						this.currentRoomId ??
						this.agentId,
					runId: this.getCurrentRunId(),
					messageId: msgId ?? trajStreamEnd?.messageId,
					text: fullText,
				}),
				"Model stream end (useModel)",
				true,
			);

			// Signal stream end to allow context to reset state between useModel calls
			const streamingCtxEnd = getStreamingContext();
			const ctxEnd = streamingCtxEnd?.onStreamEnd;
			if (ctxEnd) ctxEnd();

			resultRef.current = fullText;

			const elapsedTime =
				(typeof performance !== "undefined" &&
				typeof performance.now === "function"
					? performance.now()
					: Date.now()) - startTime;

			await this.invokePipelineHooks(
				"post_model",
				postModelPipelineHookContext({
					requestedModelType: String(modelType),
					resolvedModelKey,
					provider: resolvedModel?.provider ?? provider,
					roomId: getTrajectoryContext()?.roomId,
					durationMs: Math.round(elapsedTime),
					params: modelParams,
					result: resultRef,
					streaming: true,
				}),
				"Post-model pipeline hook",
			);

			this.logger.trace(
				{
					src: "agent",
					agentId: this.agentId,
					model: resolvedModelKey,
					duration: Number(elapsedTime.toFixed(2)),
					streaming: true,
				},
				"Model output (stream with callback complete)",
			);

			this.logModelCall(
				String(modelType),
				resolvedModelKey,
				params,
				promptContent,
				elapsedTime,
				resolvedModel?.provider ?? provider,
				resultRef.current,
			);

			await this.recordUseModelTrajectory({
				modelType: String(modelType),
				resolvedModelKey: String(resolvedModelKey),
				modelParams,
				promptContent,
				response: modelOutToTrajectoryString(resultRef.current),
				elapsedTime,
			});

			return resultRef.current as R;
		}

		const elapsedTime =
			(typeof performance !== "undefined" &&
			typeof performance.now === "function"
				? performance.now()
				: Date.now()) - startTime;

		await this.invokePipelineHooks(
			"post_model",
			postModelPipelineHookContext({
				requestedModelType: String(modelType),
				resolvedModelKey,
				provider: resolvedModel?.provider ?? provider,
				roomId: getTrajectoryContext()?.roomId,
				durationMs: Math.round(elapsedTime),
				params: modelParams,
				result: resultRef,
				streaming: false,
			}),
			"Post-model pipeline hook",
		);

		this.logger.trace(
			{
				src: "agent",
				agentId: this.agentId,
				model: resolvedModelKey,
				duration: Number(elapsedTime.toFixed(2)),
			},
			"Model output",
		);

		this.logModelCall(
			String(modelType),
			resolvedModelKey,
			params,
			promptContent,
			elapsedTime,
			resolvedModel?.provider ?? provider,
			resultRef.current,
		);

		await this.recordUseModelTrajectory({
			modelType: String(modelType),
			resolvedModelKey: String(resolvedModelKey),
			modelParams,
			promptContent,
			response: modelOutToTrajectoryString(resultRef.current),
			elapsedTime,
		});
		return resultRef.current as R;
	}

	/**
	 * Emit an llm-call entry against the current trajectory step for a
	 * `useModel` call. Pure dedupe of the streaming and non-streaming paths
	 * inside {@link useModel}; both paths formerly inlined an identical block.
	 *
	 * Skipped while the runtime is still initializing because
	 * {@link _ensureServiceStarted} awaits `initPromise` and would deadlock.
	 * Trajectory logging must never break core model flow, so any thrown
	 * error here is swallowed.
	 */
	private async recordUseModelTrajectory(args: {
		modelType: string;
		resolvedModelKey: string;
		modelParams: unknown;
		promptContent: string | null | undefined;
		response: string;
		elapsedTime: number;
	}): Promise<void> {
		if (this.initResolver) return;

		type TrajectoryLogger = Service & {
			logLlmCall: (params: {
				stepId: string;
				model: string;
				systemPrompt: string;
				userPrompt: string;
				response: string;
				temperature: number;
				maxTokens: number;
				purpose: string;
				actionType: string;
				latencyMs: number;
				modelSlot?: string;
				runId?: string;
				roomId?: string;
				messageId?: string;
				executionTraceId?: string;
			}) => void;
		};

		try {
			const trajCtx = getTrajectoryContext();
			const stepId = trajCtx?.trajectoryStepId;
			const trajLogger = (await this._ensureServiceStarted(
				"trajectories",
			)) as TrajectoryLogger | null;
			if (!stepId || !trajLogger) return;

			const tempRaw = isPlainObject(args.modelParams)
				? (args.modelParams as { temperature?: number }).temperature
				: undefined;
			const maxTokensRaw = isPlainObject(args.modelParams)
				? (args.modelParams as { maxTokens?: number }).maxTokens
				: undefined;
			const activeTrace = this.getActiveTrace(this.getCurrentRunId());
			trajLogger.logLlmCall({
				stepId,
				model: args.resolvedModelKey,
				systemPrompt:
					typeof this.character.system === "string"
						? this.character.system
						: "",
				userPrompt: args.promptContent ?? "",
				response: args.response,
				temperature: typeof tempRaw === "number" ? tempRaw : 0,
				maxTokens: typeof maxTokensRaw === "number" ? maxTokensRaw : 0,
				purpose: trajCtx?.purpose ?? "action",
				actionType: "runtime.useModel",
				latencyMs: Math.max(0, Math.round(args.elapsedTime)),
				modelSlot: args.modelType,
				runId: trajCtx?.runId,
				roomId: trajCtx?.roomId,
				messageId: trajCtx?.messageId,
				executionTraceId: activeTrace?.id,
			});
		} catch {
			// Trajectory logging must never break core model flow.
		}
	}

	/**
	 * Simplified text generation with optional character context.
	 */
	async generateText(
		input: string,
		options?: GenerateTextOptions,
	): Promise<GenerateTextResult> {
		if (!input?.trim()) {
			throw new Error("Input cannot be empty");
		}

		// Set defaults
		const includeCharacter = options?.includeCharacter ?? true;
		const modelType = options?.modelType ?? ModelType.TEXT_LARGE;

		let prompt = input;

		// Add character context if requested
		if (includeCharacter && this.character) {
			const c = this.character;
			const parts: string[] = [];

			// Add bio
			const bioText = Array.isArray(c.bio) ? c.bio.join(" ") : c.bio;
			if (bioText) {
				parts.push(`# About ${c.name}\n${bioText}`);
			}

			// Add system prompt
			if (c.system) {
				parts.push(c.system);
			}

			// Add style directives (all + chat)
			const styles = [...(c.style?.all || []), ...(c.style?.chat || [])];
			if (styles.length > 0) {
				parts.push(`Style:\n${styles.map((s) => `- ${s}`).join("\n")}`);
			}

			// Combine character context with input
			if (parts.length > 0) {
				prompt = `${parts.join("\n\n")}\n\n${input}`;
			}
		}

		const params: GenerateTextParams = {
			prompt,
			maxTokens: options?.maxTokens,
			minTokens: options?.minTokens,
			temperature: options?.temperature,
			topP: options?.topP,
			topK: options?.topK,
			minP: options?.minP,
			seed: options?.seed,
			repetitionPenalty: options?.repetitionPenalty,
			frequencyPenalty: options?.frequencyPenalty,
			presencePenalty: options?.presencePenalty,
			stopSequences: options?.stopSequences,
			// User identifier for provider tracking/analytics - auto-populates from character name if not provided
			// Explicitly set empty string or null will be preserved (not overridden)
			user:
				options && options.user !== undefined
					? options.user
					: this.character.name,
			responseFormat: options?.responseFormat,
		};

		const response = await this.useModel(modelType, params);

		return {
			text: response as string,
		};
	}

	// ============================================================================
	// Dynamic Prompt Execution with Validation-Aware Streaming
	// ============================================================================

	/**
	 * Performance metrics for dynamic prompt execution.
	 * Tracks success/failure rates per model+schema combination.
	 *
	 * Uses LRU-style eviction to prevent unbounded growth:
	 * - Max 100 entries (sufficient for typical model+schema combinations)
	 * - Entries older than 1 hour are pruned on access
	 */
	private static dynamicPromptMetrics = new Map<
		string,
		{
			lowestFailedTokenCount: number | null;
			highestSuccessTokenCount: number | null;
			totalAttempts: number;
			successfulAttempts: number;
			failedAttempts: number;
			lastUpdated: number;
		}
	>();

	private static readonly METRICS_MAX_ENTRIES = 100;
	private static readonly METRICS_TTL_MS = 60 * 60 * 1000; // 1 hour
	private static readonly STRUCTURED_FAILURE_PREVIEW_LIMIT = 4000;

	/**
	 * Get or create metrics entry with LRU eviction.
	 */
	private static getOrCreateMetrics(key: string) {
		const now = Date.now();

		// Prune stale entries periodically (when we access)
		if (
			AgentRuntime.dynamicPromptMetrics.size >
			AgentRuntime.METRICS_MAX_ENTRIES / 2
		) {
			for (const [k, v] of AgentRuntime.dynamicPromptMetrics) {
				if (now - v.lastUpdated > AgentRuntime.METRICS_TTL_MS) {
					AgentRuntime.dynamicPromptMetrics.delete(k);
				}
			}
		}

		// Evict oldest if still at max capacity
		if (
			AgentRuntime.dynamicPromptMetrics.size >= AgentRuntime.METRICS_MAX_ENTRIES
		) {
			let oldestKey: string | null = null;
			let oldestTime = Infinity;
			for (const [k, v] of AgentRuntime.dynamicPromptMetrics) {
				if (v.lastUpdated < oldestTime) {
					oldestTime = v.lastUpdated;
					oldestKey = k;
				}
			}
			if (oldestKey) {
				AgentRuntime.dynamicPromptMetrics.delete(oldestKey);
			}
		}

		let metric = AgentRuntime.dynamicPromptMetrics.get(key);
		if (!metric) {
			metric = {
				lowestFailedTokenCount: null,
				highestSuccessTokenCount: null,
				totalAttempts: 0,
				successfulAttempts: 0,
				failedAttempts: 0,
				lastUpdated: now,
			};
			AgentRuntime.dynamicPromptMetrics.set(key, metric);
		}
		return metric;
	}

	private setStructuredOutputFailureState(
		state: State,
		failure: StructuredOutputFailure,
	): void {
		const issues = Array.isArray(failure.issues)
			? failure.issues.filter(
					(issue): issue is string =>
						typeof issue === "string" && issue.trim().length > 0,
				)
			: [];
		const summaryParts = [
			`Structured output ${failure.kind.replaceAll("_", " ")}`,
			`model=${failure.model}`,
			`format=${failure.format}`,
			`attempt=${failure.attempts}/${failure.maxRetries + 1}`,
			...(issues.length > 0 ? [`issue=${issues[0]}`] : []),
			...(failure.parseError ? [`error=${failure.parseError}`] : []),
		];

		state.values = {
			...state.values,
			structuredOutputFailureSummary: summaryParts.join("; "),
		};
		state.data = {
			...state.data,
			structuredOutputFailure: failure,
		};
	}

	private clearStructuredOutputFailureState(state: State): void {
		if (state.values?.structuredOutputFailureSummary !== undefined) {
			const { structuredOutputFailureSummary: _discard, ...restValues } =
				state.values;
			state.values = restValues;
		}

		if (state.data?.structuredOutputFailure !== undefined) {
			const { structuredOutputFailure: _discard, ...restData } = state.data;
			state.data = restData;
		}
	}

	/**
	 * Dynamic prompt execution with state injection, schema-based parsing, and validation-aware streaming.
	 *
	 * WHY THIS EXISTS:
	 * LLMs are powerful but unreliable for structured outputs. They can:
	 * - Silently truncate output when hitting token limits
	 * - Skip fields or produce malformed structures
	 * - Hallucinate or ignore parts of the prompt
	 *
	 * This method addresses these issues by:
	 * 1. Validation codes: Injects UUID codes the LLM must echo back
	 * 2. Streaming with safety: Enables streaming while detecting truncation
	 * 3. Performance tracking: Tracks success/failure rates per model+schema
	 */
	async dynamicPromptExecFromState({
		state: stateArg,
		params,
		schema,
		options = {},
	}: {
		state?: State;
		params: Omit<GenerateTextParams, "prompt"> & {
			prompt: string | ((ctx: { state: State }) => string);
		};
		schema: SchemaRow[];
		options?: {
			key?: string;
			promptName?: string;
			modelSize?: "nano" | "small" | "medium" | "large" | "mega";
			modelType?: import("./types").TextGenerationModelType;
			model?: string;
			preferredEncapsulation?: "json" | "toon";
			forceFormat?: "json" | "toon";
			requiredFields?: string[];
			contextCheckLevel?: 0 | 1 | 2 | 3;
			checkpointCodes?: boolean;
			maxRetries?: number;
			retryBackoff?: number | RetryBackoffConfig;
			disableCache?: boolean;
			cacheTTL?: number;
			onStreamChunk?: StreamChunkCallback;
			onStreamEvent?: (
				event: StreamEvent,
				messageId?: string,
			) => void | Promise<void>;
			abortSignal?: AbortSignal;
		};
	}): Promise<Record<string, unknown> | null> {
		const state: State =
			stateArg ?? ({ values: {}, data: {}, text: "" } as State);

		// Validate schema input
		if (!schema || schema.length === 0) {
			this.logger.error(
				"dynamicPromptExecFromState: schema must have at least one entry",
			);
			this.clearStructuredOutputFailureState(state);
			return null;
		}

		const flattenedSchema = this.flattenSchemaRows(schema);
		const schemaWarnings = this.collectSchemaDefinitionWarnings(schema);
		for (const warning of schemaWarnings) {
			this.logger.warn(`dynamicPromptExecFromState schema warning: ${warning}`);
		}

		// Validate field names are valid identifiers
		const invalidFields = flattenedSchema.filter((row) => {
			if (!row.field || typeof row.field !== "string") return true;
			// Field names should be valid identifiers: start with letter/underscore, contain only alphanumeric/underscore
			return !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(row.field);
		});

		if (invalidFields.length > 0) {
			this.logger.error(
				`dynamicPromptExecFromState: invalid field names in schema: ${invalidFields.map((f) => f.field || "(empty)").join(", ")}`,
			);
			this.clearStructuredOutputFailureState(state);
			return null;
		}

		// Generate keys for metrics
		const resolvedModelType = resolveDynamicPromptModelType(
			options.modelType,
			options.modelSize,
		);
		const modelIdentifier =
			options.modelType || options.model || resolvedModelType;
		const schemaKey = this.buildSchemaMetricKey(schema);
		const modelSchemaKey = `${modelIdentifier}:${schemaKey}`;

		// Get validation level from settings or options
		const validationLevelRaw = this.getSetting("VALIDATION_LEVEL");
		const validationLevel =
			typeof validationLevelRaw === "string"
				? validationLevelRaw.toLowerCase()
				: undefined;

		// Map VALIDATION_LEVEL to contextCheckLevel and default retries
		let defaultContextCheckLevel: 0 | 1 | 2 | 3 = 2;
		let defaultRetries = 1;

		if (validationLevel === "trusted" || validationLevel === "fast") {
			defaultContextCheckLevel = 0;
			defaultRetries = 0;
		} else if (validationLevel === "progressive") {
			defaultContextCheckLevel = 1;
			defaultRetries = 2;
		} else if (validationLevel === "strict" || validationLevel === "safe") {
			defaultContextCheckLevel = 3;
			defaultRetries = 3;
		} else if (validationLevel !== undefined) {
			// Warn about unrecognized validation level
			this.logger.warn(
				`Unrecognized VALIDATION_LEVEL "${validationLevel}". ` +
					`Valid values: trusted, fast, progressive, strict, safe. ` +
					`Falling back to default (level 2).`,
			);
		}

		const maxRetries = options.maxRetries ?? defaultRetries;
		const checkpointCodesEnabled =
			options.checkpointCodes ??
			parseBooleanValue(this.getSetting("PROMPT_CHECKPOINT_CODES")) ??
			false;
		let currentRetry = 0;
		const promptCode = () => uuidv4().replaceAll("-", "").slice(0, 8);
		let lastStructuredFailure: StructuredOutputFailure | null = null;

		// Initialize metrics with LRU eviction
		const metric = AgentRuntime.getOrCreateMetrics(modelSchemaKey);

		// Extractor is created once and persists across retries
		let extractor: DynamicPromptStreamExtractor | undefined;
		let contextLevel: 0 | 1 | 2 | 3 = defaultContextCheckLevel;
		const perFieldCodes = new Map<string, string>();

		let traceModelId: string | undefined;
		let tracePromptKey: string | undefined;
		let traceVariant = "baseline";
		let traceArtifactVersion: number | undefined;
		const traceStartTime = Date.now();
		const optimizationHooks = this.getPromptOptimizationHooks();

		if (optimizationHooks) {
			traceModelId = this.resolveProviderModelString(
				resolvedModelType,
				options.model,
			);
			const schemaHash = this.buildSchemaMetricKey(schema)
				.split("")
				.reduce((h, c) => ((h * 31) ^ c.charCodeAt(0)) >>> 0, 5381)
				.toString(16)
				.slice(0, 8);
			tracePromptKey = options.promptName ?? schemaHash;
		}

		while (currentRetry <= maxRetries) {
			const template = params.prompt;
			const templateStr =
				typeof template === "function" ? template({ state }) : template;

			let finalTemplateStr = templateStr;
			if (
				optimizationHooks &&
				traceModelId &&
				tracePromptKey &&
				currentRetry === 0
			) {
				try {
					const merged = await optimizationHooks.mergePromptTemplate(this, {
						baselineTemplate: templateStr,
						modelId: traceModelId,
						modelSlot: resolvedModelType,
						promptKey: tracePromptKey,
					});
					finalTemplateStr = merged.template;
					traceVariant = merged.variant;
					traceArtifactVersion = merged.artifactVersion;
				} catch (optErr) {
					this.logger.warn(
						{ error: optErr },
						"Optimization artifact lookup failed",
					);
				}
			}

			// Get keys from state (excluding text, values, data)
			const stateKeys = Object.keys(state);
			const filteredKeys = stateKeys.filter(
				(key) => !["text", "values", "data"].includes(key),
			);
			const filteredState = filteredKeys.reduce(
				(acc: Record<string, unknown>, key) => {
					acc[key] = state[key];
					return acc;
				},
				{},
			);
			const templateContext = { ...filteredState, ...state.values };

			const outputSegments = this.renderPromptTemplateSegments(
				finalTemplateStr,
				templateContext,
				state,
			);
			const output = outputSegments.map((segment) => segment.content).join("");

			// Process format options
			let format: StructuredResponseFormat = resolveDefaultOutputFormat(
				this.getSetting("PROMPT_OUTPUT_FORMAT"),
			);
			const requestedFormat =
				options.forceFormat ?? options.preferredEncapsulation;
			if (requestedFormat) {
				format = resolveDefaultOutputFormat(requestedFormat);
			}

			/**
			 * Rough token count estimate for logging/debugging purposes only.
			 *
			 * NOTE: This is a heuristic approximation, not an accurate tokenizer.
			 * Modern LLMs use subword tokenization (BPE, WordPiece, SentencePiece)
			 * where actual token counts vary significantly by model and content.
			 *
			 * The 1.3x multiplier accounts for:
			 * - Subword splitting of longer/uncommon words
			 * - Punctuation and special characters as separate tokens
			 * - Whitespace handling differences
			 *
			 * For accurate counts, use model-specific tokenizers (e.g., tiktoken).
			 * This estimate is sufficient for logging and rough capacity planning.
			 */
			const estToken = (text: string) => {
				const words = text
					.trim()
					.split(/\s+|\b/)
					.filter((w) => /\w+/.test(w));
				return Math.ceil(words.length * 1.3);
			};

			this.logger.debug(
				`dynamicPromptExecFromState: using format ${format}, ~${estToken(output).toLocaleString()} tokens`,
			);

			// Set context level on first iteration
			if (currentRetry === 0) {
				contextLevel = options.contextCheckLevel ?? defaultContextCheckLevel;

				// Generate per-field validation codes for levels 0-1
				if (contextLevel <= 1) {
					for (const row of schema) {
						const defaultValidate = contextLevel === 1;
						const needsValidation = row.validateField ?? defaultValidate;
						if (needsValidation) {
							perFieldCodes.set(row.field, promptCode());
						}
					}
				}
			}

			// Optional checkpoint codes: level 2+ gets first codes, level 3 gets both.
			const first = checkpointCodesEnabled && contextLevel >= 2;
			const last = checkpointCodesEnabled && contextLevel >= 3;

			// Build extended schema with validation codes
			const extSchema: Array<{
				field: string;
				description: string;
				required?: boolean;
			}> = [];

			const codesSchema = (prefix: string) => [
				{
					field: `${prefix}initial_code`,
					description: "echo the initial prompt code",
				},
				{
					field: `${prefix}middle_code`,
					description: "echo the middle prompt code",
				},
				{
					field: `${prefix}end_code`,
					description: "echo the end prompt code",
				},
			];

			if (first) {
				extSchema.push(...codesSchema("one_"));
			}

			// Add schema fields with per-field codes for levels 0-1
			for (const row of schema) {
				const fieldCode = perFieldCodes.get(row.field);
				if (fieldCode) {
					extSchema.push({
						field: `code_${row.field}_start`,
						description: `output exactly: ${fieldCode}`,
					});
				}
				extSchema.push(row);
				if (fieldCode) {
					extSchema.push({
						field: `code_${row.field}_end`,
						description: `output exactly: ${fieldCode}`,
					});
				}
			}

			if (last) {
				extSchema.push(...codesSchema("two_"));
			}

			// Generate prompt with format example
			const isJSON = format === "JSON";

			const EXAMPLE = isJSON
				? this.renderJsonSchemaExample(schema)
				: this.renderToonSchemaExample(schema);
			const VALIDATION_INSTRUCTIONS = this.buildValidationOutputInstructions({
				format,
				schema,
				perFieldCodes,
				includeFirstCheckpoint: first,
				includeLastCheckpoint: last,
			});

			const initCode = checkpointCodesEnabled ? promptCode() : "";
			const midCode = checkpointCodesEnabled ? promptCode() : "";
			const finalCode = checkpointCodesEnabled ? promptCode() : "";

			// Check for smart retry context (set by previous retry iteration)
			const smartRetryContextRaw = (state as Record<string, unknown>)
				._smartRetryContext;
			const smartRetryContext =
				typeof smartRetryContextRaw === "string"
					? smartRetryContextRaw.trim()
					: "";

			const section_start = "# Strict Output instructions";
			const section_end = "";

			const variableSegments = this.joinPromptSegmentGroups([
				checkpointCodesEnabled
					? [{ content: `initial code: ${initCode}`, stable: false }]
					: [],
				outputSegments,
				smartRetryContext
					? [{ content: smartRetryContext, stable: false }]
					: [],
				checkpointCodesEnabled
					? [{ content: `middle code: ${midCode}`, stable: false }]
					: [],
			]).concat({ content: "\n", stable: false });
			// Prompt cache hints: build segments so providers can cache the stable prefix.
			// WHY: We only mark content stable when it is identical across calls for the same
			// schema/character. VALIDATION_INSTRUCTIONS contains per-call UUIDs (perFieldCodes,
			// checkpoint codes), so it must be in an unstable segment; otherwise provider caches
			// would never hit. Format instructions and example (same for same schema) are stable.
			const formatStablePrefix =
				section_start +
				`\nReturn only ${format}. No prose before or after it. No <think>.

`;
			const formatStableSuffix = `
Use this shape:
${EXAMPLE}

Return exactly one ${isJSON ? "JSON object" : "TOON document"}.
${section_end}`;
			const endBlock = checkpointCodesEnabled
				? `\nend code: ${finalCode}\n`
				: "\n";
			// Middle block: validation text when present (unstable); else "\n\n" so prompt string is unchanged.
			const formatMiddleBlock = VALIDATION_INSTRUCTIONS
				? `${VALIDATION_INSTRUCTIONS}\n\n`
				: "\n\n";

			const segments: PromptSegment[] = this.mergePromptSegments([
				...variableSegments,
				{ content: formatStablePrefix, stable: true },
				{ content: formatMiddleBlock, stable: false },
				{ content: formatStableSuffix, stable: true },
				{ content: endBlock, stable: false },
			]);
			const prompt = segments.map((s) => s.content).join("");

			// Token estimate used for:
			// 1. Debug logging of prompt size
			// 2. Metrics tracking: highestSuccessTokenCount / lowestFailedTokenCount
			//    (useful for identifying token-count-related failure patterns)
			const outputTokenEst = estToken(prompt);
			this.logger.debug(
				`dynamicPromptExecFromState prompt ~${outputTokenEst.toLocaleString()} tokens`,
			);

			// Create a structured extractor on first iteration if streaming.
			// TOON needs field-aware extraction; raw structured tokens must not be
			// forwarded to user-visible streaming callbacks.
			if (
				currentRetry === 0 &&
				options.onStreamChunk &&
				!extractor &&
				format === "TOON"
			) {
				const streamFields = schema
					.filter((row) => {
						if (row.streamField !== undefined) return row.streamField;
						return row.field === "text";
					})
					.map((row) => row.field);

				// Only use fallback if no explicit streamField settings exist
				// Don't override explicit streamField: false on "text" field
				const hasExplicitStreamSettings = schema.some(
					(r) => r.streamField !== undefined,
				);
				const finalStreamFields =
					streamFields.length > 0
						? streamFields
						: !hasExplicitStreamSettings &&
								schema.some((r) => r.field === "text")
							? ["text"]
							: [];

				const streamMessageId = `stream-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

				// WHY accumulated is forwarded: the extractor tracks the full extracted text
				// per field internally (`content` in emitFieldContent). Surfacing it
				// here means consumers like first-sentence voice detection or Eliza's
				// streaming-text resolver can use the authoritative value instead of
				// Note: this design prevents dual extractor conflicts by providing authoritative accumulated data
				// re-accumulating from deltas — which broke when two extractors ran
				// concurrently (the dual-extractor garbling bug).
				const onChunk = (
					chunk: string,
					_field?: string,
					accumulated?: string,
				) => options.onStreamChunk?.(chunk, streamMessageId, accumulated);
				const onEvent = options.onStreamEvent
					? (event: StreamEvent) =>
							options.onStreamEvent?.(event, streamMessageId)
					: undefined;

				extractor = new ToonFieldStreamExtractor({
					level: contextLevel,
					schema,
					streamFields: finalStreamFields,
					onChunk,
					onEvent,
					abortSignal: options.abortSignal,
				});
			}

			// Pass promptSegments so providers can use cache hints when supported (Anthropic block cache, OpenAI/Gemini prefix).
			const modelParams = {
				...params,
				prompt,
				promptSegments: segments,
				providerOptions: {
					agentName: this.character.name,
				},
				...(extractor
					? {
							onStreamChunk: (chunk: string) => {
								extractor?.push(chunk);
							},
						}
					: {}),
			};

			// Check for cancellation before request
			if (options.abortSignal?.aborted) {
				extractor?.signalError("Cancelled by user");
				delete (state as Record<string, unknown>)._smartRetryContext;
				this.clearStructuredOutputFailureState(state);
				return null;
			}

			let response: string;
			try {
				response = await runWithStreamingContext(undefined, () =>
					this.useModel(resolvedModelType, modelParams, options.model),
				);
			} catch (modelError) {
				const modelErrorMessage = getErrorMessage(modelError);
				const isTransientFailure = isTransientModelError(modelError);
				const willRetry = currentRetry + 1 <= maxRetries;
				const failureMessage = isTransientFailure
					? `Model call failed transiently${willRetry ? ", retrying" : ""}: ${modelErrorMessage}`
					: `Model call failed: ${modelErrorMessage}`;
				if (isTransientFailure) {
					this.logger.warn(failureMessage);
				} else {
					this.logger.error(failureMessage);
				}
				lastStructuredFailure = {
					source: "dynamicPromptExecFromState",
					kind: "model_error",
					model: String(modelIdentifier),
					format,
					schemaFields: flattenedSchema.map((row) => row.field),
					attempts: currentRetry + 1,
					maxRetries,
					timestamp: Date.now(),
					key: options.key ?? modelSchemaKey,
					parseError: modelErrorMessage,
					issues: [
						"Model call failed before a structured response could be validated.",
					],
				};
				currentRetry++;

				if (options.abortSignal?.aborted) {
					return this.cancelStructuredPromptRetry(state, extractor);
				}

				if (currentRetry <= maxRetries) {
					if (
						!(await this.waitForStructuredPromptRetryBackoff(
							state,
							extractor,
							options,
							currentRetry,
						))
					) {
						return null;
					}

					// Signal retry to extractor if it exists
					if (extractor) {
						extractor.signalRetry(currentRetry);
						extractor.reset();
					}
				}
				continue;
			}

			// Clean response (remove <think> blocks)
			const cleanResponse = response.replace(/<think>[\s\S]*?<\/think>/g, "");

			let responseContent: Record<string, unknown> | null = null;
			let parseErrorMessage: string | undefined;
			const validationIssues: string[] = [];
			try {
				responseContent = this.parseStructuredResponse(cleanResponse, format);
				this.logger.debug(
					`dynamicPromptExecFromState parsed: ${JSON.stringify(responseContent)}`,
				);
			} catch (e) {
				parseErrorMessage = e instanceof Error ? e.message : String(e);
				this.logger.error(
					`dynamicPromptExecFromState parse error: ${parseErrorMessage}`,
				);
			}

			responseContent = this.normalizeStructuredResponse(responseContent);

			// Validate response
			let allGood = true;
			let schemaValidation: { missingPaths: string[]; invalidPaths: string[] } =
				{
					missingPaths: [],
					invalidPaths: [],
				};
			if (!responseContent) {
				validationIssues.push(
					"No structured output could be parsed from the model response.",
				);
				this.logger.warn(
					`dynamicPromptExecFromState parse problem: ${cleanResponse}`,
				);
				allGood = false;
			} else {
				// Validate codes based on context level
				if (contextLevel <= 1) {
					// Per-field validation
					for (const [field, expectedCode] of perFieldCodes) {
						const startCodeField = `code_${field}_start`;
						const endCodeField = `code_${field}_end`;
						const startCode = responseContent[startCodeField];
						const endCode = responseContent[endCodeField];

						if (startCode !== expectedCode || endCode !== expectedCode) {
							validationIssues.push(
								`Per-field validation failed for ${field}.`,
							);
							this.logger.warn(
								`Per-field validation failed for ${field}: expected=${expectedCode}, start=${startCode}, end=${endCode}`,
							);
							allGood = false;
						}

						delete responseContent[startCodeField];
						delete responseContent[endCodeField];
					}
				} else {
					// Checkpoint validation
					const validationCodes: [string, string][] = [
						...(first
							? [
									["one_initial_code", initCode] as [string, string],
									["one_middle_code", midCode] as [string, string],
									["one_end_code", finalCode] as [string, string],
								]
							: []),
						...(last
							? [
									["two_initial_code", initCode] as [string, string],
									["two_middle_code", midCode] as [string, string],
									["two_end_code", finalCode] as [string, string],
								]
							: []),
					];

					for (const [field, expected] of validationCodes) {
						if (responseContent[field] !== expected) {
							validationIssues.push(
								`Checkpoint validation failed for ${field}.`,
							);
							this.logger.warn(
								`Checkpoint ${field} mismatch: expected ${expected}`,
							);
							allGood = false;
						}
					}

					if (first) {
						delete responseContent.one_initial_code;
						delete responseContent.one_middle_code;
						delete responseContent.one_end_code;
					}
					if (last) {
						delete responseContent.two_initial_code;
						delete responseContent.two_middle_code;
						delete responseContent.two_end_code;
					}
				}

				schemaValidation = this.validateResponseAgainstSchema(
					responseContent,
					schema,
				);
				if (
					schemaValidation.missingPaths.length > 0 ||
					schemaValidation.invalidPaths.length > 0
				) {
					if (schemaValidation.missingPaths.length > 0) {
						validationIssues.push(
							`Missing required schema paths: ${schemaValidation.missingPaths.join(", ")}`,
						);
						this.logger.warn(
							`Missing required schema paths: ${schemaValidation.missingPaths.join(", ")}`,
						);
					}
					if (schemaValidation.invalidPaths.length > 0) {
						validationIssues.push(
							`Invalid schema paths: ${schemaValidation.invalidPaths.join(", ")}`,
						);
						this.logger.warn(
							`Invalid schema paths: ${schemaValidation.invalidPaths.join(", ")}`,
						);
					}
					allGood = false;
				}

				// Validate required fields
				if (options.requiredFields && options.requiredFields.length > 0) {
					const isMissingField = (value: unknown): boolean => {
						if (value === undefined || value === null) return true;
						if (typeof value === "string") return value.trim().length === 0;
						if (Array.isArray(value)) return value.length === 0;
						if (typeof value === "object")
							return Object.keys(value).length === 0;
						return false;
					};

					const missingFields = options.requiredFields.filter(
						(field) =>
							!responseContent ||
							!(field in responseContent) ||
							isMissingField(responseContent[field]),
					);
					if (missingFields.length > 0) {
						validationIssues.push(
							`Missing required fields: ${missingFields.join(", ")}`,
						);
						this.logger.warn(
							`Missing required fields: ${missingFields.join(", ")}`,
						);
						allGood = false;
					}
				}
			}

			// Update metrics
			metric.totalAttempts++;

			if (allGood && responseContent) {
				// Success - flush buffered content for levels 2-3
				if (extractor) {
					extractor.flush();
				}

				metric.successfulAttempts++;
				if (
					metric.highestSuccessTokenCount === null ||
					outputTokenEst > metric.highestSuccessTokenCount
				) {
					metric.highestSuccessTokenCount = outputTokenEst;
				}
				metric.lastUpdated = Date.now();

				this.logger.debug(
					`dynamicPromptExecFromState success [${modelSchemaKey}]: ${outputTokenEst} tokens`,
				);

				// Clean up smart retry context from state
				delete (state as Record<string, unknown>)._smartRetryContext;

				if (optimizationHooks && traceModelId && tracePromptKey) {
					try {
						const scoreCard = new ScoreCard();
						scoreCard.add({
							source: "dpe",
							kind: "parseSuccess",
							value: 1.0,
							reason: "Structured output parsed successfully",
						});
						const schemaOk =
							schemaValidation.missingPaths.length === 0 &&
							schemaValidation.invalidPaths.length === 0;
						scoreCard.add({
							source: "dpe",
							kind: "schemaValid",
							value: schemaOk ? 1.0 : 0.0,
							reason: schemaOk
								? "Response matched schema paths"
								: `Schema issues: missing [${schemaValidation.missingPaths.join(", ")}]; invalid [${schemaValidation.invalidPaths.join(", ")}]`,
						});
						scoreCard.add({
							source: "dpe",
							kind: "retriesUsed",
							value: Math.max(0, 1.0 - currentRetry / Math.max(maxRetries, 1)),
							reason: `Succeeded on attempt ${currentRetry + 1} of ${maxRetries + 1}`,
						});
						scoreCard.add({
							source: "dpe",
							kind: "tokenEfficiency",
							value: Math.min(1.0, 500 / Math.max(outputTokenEst, 1)),
							reason: `Estimated output tokens ${outputTokenEst} vs reference 500`,
						});

						const templateHashInput =
							typeof params.prompt === "string"
								? params.prompt
								: tracePromptKey;
						const computedTemplateHash = simpleHash(templateHashInput);

						const trace: ExecutionTrace = {
							id: uuidv4(),
							traceVersion: 1,
							type: "trace",
							promptKey: tracePromptKey,
							modelSlot: resolvedModelType,
							modelId: traceModelId,
							runId: this.getCurrentRunId?.() ?? undefined,
							templateHash: computedTemplateHash,
							schemaFingerprint: schemaKey,
							artifactVersion: traceArtifactVersion,
							variant: traceVariant,
							parseSuccess: true,
							schemaValid:
								schemaValidation.missingPaths.length === 0 &&
								schemaValidation.invalidPaths.length === 0,
							validationCodesMatched: true,
							retriesUsed: currentRetry,
							tokenEstimate: outputTokenEst,
							latencyMs: Date.now() - traceStartTime,
							response: responseContent,
							scoreCard: scoreCard.toJSON(),
							createdAt: Date.now(),
						};

						this.maybeRunActiveTraceTTLPurge();
						const runId = trace.runId;
						if (runId) {
							this.activeTraces.set(trace.id, trace);
							if (!this.runToTraces.has(runId)) {
								this.runToTraces.set(runId, new Set());
							}
							this.runToTraces.get(runId)?.add(trace.id);
						}

						void optimizationHooks
							.persistRegistryEntry(this, {
								promptKey: tracePromptKey,
								schemaFingerprint: schemaKey,
								templateHash: computedTemplateHash,
								promptTemplate:
									typeof params.prompt === "string" ? params.prompt : "",
								schema: JSON.parse(JSON.stringify(schema)) as SchemaRow[],
							})
							.catch((err) => {
								this.logger.warn(
									{ error: err, src: "dpe" },
									"Failed to write prompt optimization registry",
								);
							});
						void optimizationHooks
							.appendBaselineTrace(this, { trace })
							.catch((err) => {
								this.logger.warn("Failed to write optimization trace", err);
							});
					} catch (traceErr) {
						this.logger.warn(
							{ error: traceErr },
							"Failed to build optimization trace",
						);
					}
				}

				this.clearStructuredOutputFailureState(state);
				return responseContent;
			}

			lastStructuredFailure = {
				source: "dynamicPromptExecFromState",
				kind: !responseContent
					? parseErrorMessage
						? "parse_error"
						: "parse_problem"
					: "validation_error",
				model: String(modelIdentifier),
				format,
				schemaFields: flattenedSchema.map((row) => row.field),
				attempts: currentRetry + 1,
				maxRetries,
				timestamp: Date.now(),
				key: options.key ?? modelSchemaKey,
				parseError: parseErrorMessage,
				issues: validationIssues,
				responsePreview: this.redactSecrets(cleanResponse).slice(
					0,
					AgentRuntime.STRUCTURED_FAILURE_PREVIEW_LIMIT,
				),
			};

			// Failure - update metrics
			metric.failedAttempts++;
			if (
				metric.lowestFailedTokenCount === null ||
				outputTokenEst < metric.lowestFailedTokenCount
			) {
				metric.lowestFailedTokenCount = outputTokenEst;
			}

			currentRetry++;

			if (options.abortSignal?.aborted) {
				return this.cancelStructuredPromptRetry(state, extractor);
			}

			if (currentRetry <= maxRetries) {
				if (
					!(await this.waitForStructuredPromptRetryBackoff(
						state,
						extractor,
						options,
						currentRetry,
					))
				) {
					return null;
				}

				// Signal retry to extractor
				let smartRetryContextNext: string | undefined;
				if (extractor) {
					const { validatedFields } = extractor.signalRetry(currentRetry);
					const diagnosis = extractor.diagnose();

					this.logger.warn(
						`dynamicPromptExecFromState retry ${currentRetry}/${maxRetries}`,
						`validated=${validatedFields.join(",") || "none"}`,
						`missing=${diagnosis.missingFields.join(",") || "none"}`,
					);

					// For level 1, build smart retry context
					if (contextLevel === 1 && validatedFields.length > 0) {
						const validatedContent = extractor.getValidatedFields();
						const validatedParts: string[] = [];
						for (const [field, content] of validatedContent) {
							const truncated =
								content.length > 500 ? `${content.slice(0, 500)}...` : content;
							if (format === "TOON") {
								validatedParts.push(
									encodeToonValue({
										[field]: truncated,
									}),
								);
							} else {
								validatedParts.push(`<${field}>${truncated}</${field}>`);
							}
						}
						if (validatedParts.length > 0) {
							smartRetryContextNext = `\n\n[RETRY CONTEXT]\nYou previously produced these valid fields:\n${validatedParts.join("\n")}\n\nPlease complete: ${diagnosis.missingFields.concat(diagnosis.invalidFields, diagnosis.incompleteFields).join(", ") || "all fields"}`;
						}
					}

					extractor.reset();
				}

				if (smartRetryContextNext) {
					(state as Record<string, unknown>)._smartRetryContext =
						smartRetryContextNext;
				}
			}
		}

		// Max retries exceeded
		if (extractor) {
			const diagnosis = extractor.diagnose();
			const diagnosticParts: string[] = [];
			if (diagnosis.missingFields.length > 0) {
				diagnosticParts.push(`missing: ${diagnosis.missingFields.join(", ")}`);
			}
			if (diagnosis.invalidFields.length > 0) {
				diagnosticParts.push(`invalid: ${diagnosis.invalidFields.join(", ")}`);
			}
			if (diagnosis.incompleteFields.length > 0) {
				diagnosticParts.push(
					`incomplete: ${diagnosis.incompleteFields.join(", ")}`,
				);
			}
			extractor.signalError(
				`Failed after ${maxRetries} retries. ${diagnosticParts.length > 0 ? diagnosticParts.join("; ") : "unknown error"}`,
			);
		}

		const finalFailureMessage = `dynamicPromptExecFromState failed after ${maxRetries} retries [${modelSchemaKey}]`;
		const finalFailureSummary = `${metric.successfulAttempts}/${metric.totalAttempts} successful`;
		if (
			lastStructuredFailure?.kind === "model_error" &&
			isTransientModelError(lastStructuredFailure.parseError)
		) {
			this.logger.warn(finalFailureMessage, finalFailureSummary);
		} else {
			this.logger.error(finalFailureMessage, finalFailureSummary);
		}

		if (optimizationHooks && traceModelId && tracePromptKey) {
			try {
				this.purgeStaleActiveTraces();

				const scoreCard = new ScoreCard();
				scoreCard.add({
					source: "dpe",
					kind: "parseSuccess",
					value: 0.0,
					reason: `No valid parse after ${maxRetries} retries`,
				});
				scoreCard.add({
					source: "dpe",
					kind: "schemaValid",
					value: 0.0,
					reason: "Parse or validation never succeeded",
				});
				scoreCard.add({
					source: "dpe",
					kind: "retriesUsed",
					value: 0.0,
					reason: "All retry attempts exhausted",
				});

				const failTemplateHash = simpleHash(
					typeof params.prompt === "string" ? params.prompt : tracePromptKey,
				);

				const trace: ExecutionTrace = {
					id: uuidv4(),
					traceVersion: 1,
					type: "trace",
					promptKey: tracePromptKey,
					modelSlot: resolvedModelType,
					modelId: traceModelId,
					runId: this.getCurrentRunId?.() ?? undefined,
					templateHash: failTemplateHash,
					schemaFingerprint: schemaKey,
					artifactVersion: traceArtifactVersion,
					variant: traceVariant,
					parseSuccess: false,
					schemaValid: false,
					validationCodesMatched: false,
					retriesUsed: maxRetries,
					tokenEstimate: 0,
					latencyMs: Date.now() - traceStartTime,
					scoreCard: scoreCard.toJSON(),
					createdAt: Date.now(),
				};

				void optimizationHooks
					.persistRegistryEntry(this, {
						promptKey: tracePromptKey,
						schemaFingerprint: schemaKey,
						templateHash: failTemplateHash,
						promptTemplate:
							typeof params.prompt === "string" ? params.prompt : "",
						schema: JSON.parse(JSON.stringify(schema)) as SchemaRow[],
					})
					.catch((err) => {
						this.logger.warn(
							{ error: err, src: "dpe" },
							"Failed to write prompt optimization registry",
						);
					});
				void optimizationHooks
					.appendFailureTrace(this, { trace })
					.catch((err) => {
						this.logger.warn("Failed to write failure trace", err);
					});
			} catch (traceErr) {
				this.logger.warn({ error: traceErr }, "Failed to build failure trace");
			}
		}

		// Clean up smart retry context from state
		delete (state as Record<string, unknown>)._smartRetryContext;
		if (lastStructuredFailure) {
			this.setStructuredOutputFailureState(state, lastStructuredFailure);
		} else {
			this.clearStructuredOutputFailureState(state);
		}
		return null;
	}

	private flattenSchemaRows(rows: SchemaRow[]): SchemaRow[] {
		const flattened: SchemaRow[] = [];
		for (const row of rows) {
			flattened.push(row);
			if (row.properties?.length) {
				flattened.push(...this.flattenSchemaRows(row.properties));
			}
			if (row.items?.properties?.length) {
				flattened.push(...this.flattenSchemaRows(row.items.properties));
			}
		}
		return flattened;
	}

	private renderJsonSchemaExample(rows: SchemaRow[]): string {
		const exampleObject = Object.fromEntries(
			rows.map((row) => [row.field, this.buildJsonExampleValue(row)]),
		);
		return `${JSON.stringify(exampleObject, null, 2)}\n`;
	}

	private renderToonSchemaExample(rows: SchemaRow[]): string {
		const exampleObject = Object.fromEntries(
			rows.map((row) => [row.field, this.buildJsonExampleValue(row)]),
		);
		return `${encodeToonValue(exampleObject)}\n`;
	}

	private buildJsonExampleValue(spec: SchemaValueSpec): unknown {
		return this.buildJsonExampleValueAtDepth(spec, 0);
	}

	private buildJsonExampleValueAtDepth(
		spec: SchemaValueSpec,
		depth: number,
	): unknown {
		if (depth > 8) {
			return "[max schema depth reached]";
		}

		switch (this.getEffectiveSchemaValueType(spec)) {
			case "number":
				return 123;
			case "boolean":
				return true;
			case "object":
				if (spec.properties?.length) {
					return Object.fromEntries(
						spec.properties.map((row) => [
							row.field,
							this.buildJsonExampleValueAtDepth(row, depth + 1),
						]),
					);
				}
				return {};
			case "array":
				return [
					this.buildJsonExampleValueAtDepth(
						spec.items ?? { description: spec.description },
						depth + 1,
					),
				];
			default:
				return spec.description;
		}
	}

	private validateResponseAgainstSchema(
		responseContent: Record<string, unknown>,
		schema: SchemaRow[],
	): { missingPaths: string[]; invalidPaths: string[] } {
		const missingPaths: string[] = [];
		const invalidPaths: string[] = [];
		for (const row of schema) {
			this.validateSchemaValue(
				responseContent[row.field],
				row,
				row.field,
				missingPaths,
				invalidPaths,
			);
		}
		return { missingPaths, invalidPaths };
	}

	private validateSchemaValue(
		value: unknown,
		spec: SchemaValueSpec,
		path: string,
		missingPaths: string[],
		invalidPaths: string[],
	): void {
		this.validateSchemaValueAtDepth(
			value,
			spec,
			path,
			missingPaths,
			invalidPaths,
			0,
		);
	}

	private validateSchemaValueAtDepth(
		value: unknown,
		spec: SchemaValueSpec,
		path: string,
		missingPaths: string[],
		invalidPaths: string[],
		depth: number,
	): void {
		if (depth > 8) {
			invalidPaths.push(path);
			return;
		}

		const isMissingValue = (inner: unknown): boolean => {
			if (inner === undefined || inner === null) return true;
			if (typeof inner === "string") return inner.trim().length === 0;
			if (Array.isArray(inner)) return inner.length === 0;
			if (typeof inner === "object") return Object.keys(inner).length === 0;
			return false;
		};

		if (isMissingValue(value)) {
			if (spec.required) {
				missingPaths.push(path);
			}
			return;
		}

		switch (this.getEffectiveSchemaValueType(spec)) {
			case "number":
				if (
					typeof value !== "number" &&
					!(
						typeof value === "string" &&
						value.trim() !== "" &&
						!Number.isNaN(Number(value))
					)
				) {
					invalidPaths.push(path);
				}
				return;
			case "boolean":
				if (
					typeof value !== "boolean" &&
					!(
						typeof value === "string" &&
						["true", "false"].includes(value.trim().toLowerCase())
					)
				) {
					invalidPaths.push(path);
				}
				return;
			case "object":
				if (
					typeof value !== "object" ||
					value === null ||
					Array.isArray(value)
				) {
					invalidPaths.push(path);
					return;
				}
				for (const property of spec.properties ?? []) {
					this.validateSchemaValueAtDepth(
						(value as Record<string, unknown>)[property.field],
						property,
						`${path}.${property.field}`,
						missingPaths,
						invalidPaths,
						depth + 1,
					);
				}
				return;
			case "array":
				if (!Array.isArray(value)) {
					invalidPaths.push(path);
					return;
				}
				if (spec.items) {
					value.forEach((item, index) => {
						this.validateSchemaValueAtDepth(
							item,
							spec.items as SchemaValueSpec,
							`${path}[${index}]`,
							missingPaths,
							invalidPaths,
							depth + 1,
						);
					});
				}
				return;
			default:
				return;
		}
	}

	private buildValidationOutputInstructions({
		format,
		schema,
		perFieldCodes,
		includeFirstCheckpoint,
		includeLastCheckpoint,
	}: {
		format: StructuredResponseFormat;
		schema: SchemaRow[];
		perFieldCodes: Map<string, string>;
		includeFirstCheckpoint: boolean;
		includeLastCheckpoint: boolean;
	}): string {
		const isJsonLike = format === "JSON" || format === "TOON";
		const lines: string[] = [];

		if (includeFirstCheckpoint) {
			lines.push(
				isJsonLike
					? 'Echo the prompt checkpoint fields: "one_initial_code", "one_middle_code", "one_end_code".'
					: "",
			);
		}

		for (const row of schema) {
			const fieldCode = perFieldCodes.get(row.field);
			if (!fieldCode) {
				continue;
			}

			lines.push(
				isJsonLike
					? `For "${row.field}", include "code_${row.field}_start": "${fieldCode}" and "code_${row.field}_end": "${fieldCode}".`
					: "",
			);
		}

		if (includeLastCheckpoint) {
			lines.push(
				isJsonLike
					? 'Echo the final checkpoint fields: "two_initial_code", "two_middle_code", "two_end_code".'
					: "",
			);
		}

		return lines.length > 0 ? `${lines.join("\n")}\n` : "";
	}

	private getEffectiveSchemaValueType(
		spec: SchemaValueSpec,
	): NonNullable<SchemaValueSpec["type"]> {
		if (spec.type) {
			return spec.type;
		}
		if (spec.items) {
			return "array";
		}
		if ((spec.properties?.length ?? 0) > 0) {
			return "object";
		}
		return "string";
	}

	private collectSchemaDefinitionWarnings(rows: SchemaRow[]): string[] {
		const warnings: string[] = [];
		for (const row of rows) {
			this.collectSchemaSpecWarnings(row, row.field, warnings);
		}
		return warnings;
	}

	private collectSchemaSpecWarnings(
		spec: SchemaValueSpec,
		path: string,
		warnings: string[],
		depth = 0,
	): void {
		if (depth > 8) {
			warnings.push(`${path} exceeds max supported nesting depth`);
			return;
		}

		const hasProperties = (spec.properties?.length ?? 0) > 0;
		const hasItems = spec.items !== undefined;

		if (hasProperties && hasItems) {
			warnings.push(
				`${path} defines both properties and items; choose one shape`,
			);
		}

		if (spec.type === "array" && hasProperties) {
			warnings.push(`${path} is type "array" but also defines properties`);
		}

		if (spec.type === "object" && hasItems) {
			warnings.push(`${path} is type "object" but also defines items`);
		}

		if (
			(spec.type === "string" ||
				spec.type === "number" ||
				spec.type === "boolean") &&
			(hasProperties || hasItems)
		) {
			warnings.push(
				`${path} is type "${spec.type}" but also defines nested structure`,
			);
		}

		for (const property of spec.properties ?? []) {
			this.collectSchemaSpecWarnings(
				property,
				`${path}.${property.field}`,
				warnings,
				depth + 1,
			);
		}

		if (spec.items) {
			this.collectSchemaSpecWarnings(
				spec.items,
				`${path}[]`,
				warnings,
				depth + 1,
			);
		}
	}

	private buildSchemaMetricKey(rows: SchemaRow[]): string {
		return rows.map((row) => this.serializeSchemaMetricRow(row)).join("|");
	}

	private serializeSchemaMetricRow(row: SchemaRow): string {
		return `${row.field}${row.required ? "!" : ""}:${this.serializeSchemaMetricSpec(row)}`;
	}

	private serializeSchemaMetricSpec(spec: SchemaValueSpec): string {
		return this.serializeSchemaMetricSpecAtDepth(spec, 0);
	}

	private serializeSchemaMetricSpecAtDepth(
		spec: SchemaValueSpec,
		depth: number,
	): string {
		if (depth > 8) {
			return "max-depth";
		}

		const effectiveType = this.getEffectiveSchemaValueType(spec);
		switch (effectiveType) {
			case "object":
				return `object{${(spec.properties ?? [])
					.map(
						(property) =>
							`${property.field}${property.required ? "!" : ""}:${this.serializeSchemaMetricSpecAtDepth(property, depth + 1)}`,
					)
					.join(",")}}`;
			case "array":
				return `array[${spec.items ? this.serializeSchemaMetricSpecAtDepth(spec.items, depth + 1) : "unknown"}]`;
			default:
				return effectiveType;
		}
	}

	private cancelStructuredPromptRetry(
		state: State,
		extractor: DynamicPromptStreamExtractor | undefined,
	): null {
		extractor?.signalError("Cancelled by user");
		delete (state as Record<string, unknown>)._smartRetryContext;
		this.clearStructuredOutputFailureState(state);
		return null;
	}

	private async waitForStructuredPromptRetryBackoff(
		state: State,
		extractor: DynamicPromptStreamExtractor | undefined,
		options: DynamicPromptRetryOptions,
		currentRetry: number,
	): Promise<boolean> {
		if (!options.retryBackoff) {
			return true;
		}
		const delayMs = this.calculateBackoffDelay(
			options.retryBackoff,
			currentRetry,
		);
		this.logger.debug(
			`Retry backoff: waiting ${delayMs}ms before retry ${currentRetry}`,
		);

		if (await this.abortableSleep(delayMs, options.abortSignal)) {
			this.cancelStructuredPromptRetry(state, extractor);
			return false;
		}
		return true;
	}

	/**
	 * Calculate retry backoff delay.
	 */
	private calculateBackoffDelay(
		config: number | RetryBackoffConfig,
		retryCount: number,
	): number {
		if (typeof config === "number") {
			return config;
		}
		const { initialMs = 1000, multiplier = 2, maxMs = 30000 } = config;
		const delay = initialMs * multiplier ** (retryCount - 1);
		return Math.min(delay, maxMs);
	}

	/**
	 * Sleep for a duration that can be interrupted by an abort signal.
	 * Returns true if aborted, false if sleep completed normally.
	 */
	private abortableSleep(ms: number, signal?: AbortSignal): Promise<boolean> {
		if (signal?.aborted) return Promise.resolve(true);

		return new Promise((resolve) => {
			const timeout = setTimeout(() => {
				signal?.removeEventListener("abort", onAbort);
				resolve(false);
			}, ms);

			const onAbort = () => {
				clearTimeout(timeout);
				resolve(true);
			};

			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	/**
	 * Template rendering helpers for prompt caching and deterministic compilation.
	 */
	private getCompiledRuntimeTemplate(
		template: string,
		alreadyUpgraded = false,
	): Handlebars.TemplateDelegate<Record<string, unknown>> {
		const source = alreadyUpgraded
			? template
			: this.upgradeDoubleToTriple(template);
		const cached = RUNTIME_TEMPLATE_CACHE.get(source);
		if (cached) {
			return cached;
		}

		const compiled = Handlebars.compile(source);
		RUNTIME_TEMPLATE_CACHE.set(source, compiled);
		if (RUNTIME_TEMPLATE_CACHE.size > RUNTIME_TEMPLATE_CACHE_LIMIT) {
			const oldestKey = RUNTIME_TEMPLATE_CACHE.keys().next().value;
			if (typeof oldestKey === "string") {
				RUNTIME_TEMPLATE_CACHE.delete(oldestKey);
			}
		}

		return compiled;
	}

	private cleanDynamicPromptTemplateOutput(rawOutput: string): string {
		return rawOutput
			.replace(/<output>[\s\S]*?<\/output>\s*/g, "")
			.replace(/\noutput:\n[\s\S]*$/i, "")
			.replace(/\r\n/g, "\n")
			.replace(/[ \t]+\n/g, "\n")
			.replace(/\n{3,}/g, "\n\n")
			.trim();
	}

	private extractTemplatePlaceholderKeys(templateChunk: string): string[] {
		const keys = new Set<string>();
		const PLACEHOLDER_PATTERN = /\{\{\{?\s*([a-zA-Z0-9_.]+)\s*\}?\}\}/g;
		let match = PLACEHOLDER_PATTERN.exec(templateChunk);
		while (match) {
			if (match[1]) {
				keys.add(match[1]);
			}
			match = PLACEHOLDER_PATTERN.exec(templateChunk);
		}
		return [...keys];
	}

	private isTemplateChunkStable(templateChunk: string): boolean {
		const placeholderKeys = this.extractTemplatePlaceholderKeys(templateChunk);
		return placeholderKeys.every(
			(key) => key !== "providers" && STABLE_PROMPT_TEMPLATE_KEYS.has(key),
		);
	}

	private getPromptProviderSegments(state: State): PromptSegment[] {
		const providerResults = state.data.providers as
			| Record<string, { text?: string; providerName?: string }>
			| undefined;
		if (!providerResults) {
			return [];
		}

		const providerOrder = Array.isArray(state.data.providerOrder)
			? (state.data.providerOrder as string[])
			: Object.keys(providerResults).sort((left, right) =>
					left.localeCompare(right),
				);

		const segments: PromptSegment[] = [];
		for (const providerName of providerOrder) {
			const result = providerResults[providerName];
			if (!result?.text || result.text.trim() === "") {
				continue;
			}

			if (segments.length > 0) {
				segments.push({ content: "\n", stable: false });
			}

			segments.push({
				content: result.text,
				stable: STABLE_PROMPT_PROVIDER_NAMES.has(providerName),
			});
		}

		return this.mergePromptSegments(segments);
	}

	private renderPromptTemplateSegments(
		templateStr: string,
		context: Record<string, unknown>,
		state: State,
	): PromptSegment[] {
		const upgradedTemplate = this.upgradeDoubleToTriple(templateStr);
		const templateWithMarkers = upgradedTemplate.replace(
			/\{\{\{?\s*providers\s*\}?\}\}/g,
			PROVIDERS_PROMPT_MARKER,
		);
		const templateFunction = this.getCompiledRuntimeTemplate(
			templateWithMarkers,
			true,
		);
		const renderedWithMarkers = this.cleanDynamicPromptTemplateOutput(
			templateFunction(context),
		);

		if (
			!templateWithMarkers.includes(PROVIDERS_PROMPT_MARKER) ||
			!renderedWithMarkers.includes(PROVIDERS_PROMPT_MARKER)
		) {
			return [
				{
					content: renderedWithMarkers,
					stable: this.isTemplateChunkStable(upgradedTemplate),
				},
			];
		}

		const providerSegments = this.getPromptProviderSegments(state);
		if (providerSegments.length === 0) {
			return [
				{
					content: renderedWithMarkers.replaceAll(
						PROVIDERS_PROMPT_MARKER,
						String(context.providers ?? ""),
					),
					stable: false,
				},
			];
		}

		const templateChunks = templateWithMarkers.split(PROVIDERS_PROMPT_MARKER);
		const renderedChunks = renderedWithMarkers.split(PROVIDERS_PROMPT_MARKER);
		const segments: PromptSegment[] = [];

		for (let i = 0; i < renderedChunks.length; i += 1) {
			const renderedChunk = renderedChunks[i] ?? "";
			if (renderedChunk.length > 0) {
				segments.push({
					content: renderedChunk,
					stable: this.isTemplateChunkStable(templateChunks[i] ?? ""),
				});
			}

			if (i < renderedChunks.length - 1) {
				segments.push(...providerSegments.map((segment) => ({ ...segment })));
			}
		}

		return this.mergePromptSegments(segments);
	}

	private joinPromptSegmentGroups(groups: PromptSegment[][]): PromptSegment[] {
		const result: PromptSegment[] = [];

		for (const group of groups) {
			const normalized = this.mergePromptSegments(group);
			if (normalized.length === 0) {
				continue;
			}

			if (result.length > 0) {
				result.push({ content: "\n\n", stable: false });
			}

			result.push(...normalized.map((segment) => ({ ...segment })));
		}

		return result;
	}

	private mergePromptSegments(segments: PromptSegment[]): PromptSegment[] {
		const merged: PromptSegment[] = [];

		for (const segment of segments) {
			if (segment.content.length === 0) {
				continue;
			}

			const previous = merged[merged.length - 1];
			if (previous && previous.stable === segment.stable) {
				previous.content += segment.content;
			} else {
				merged.push({ ...segment });
			}
		}

		return merged;
	}

	/**
	 * Convert double-brace Handlebars bindings to triple-brace (non-escaping).
	 *
	 * Handlebars uses:
	 * - `{{var}}` for HTML-escaped output
	 * - `{{{var}}}` for raw/unescaped output
	 *
	 * This function upgrades simple variable bindings to triple-brace so that
	 * special characters in state values don't get HTML-encoded in prompts.
	 *
	 * The regex preserves Handlebars helpers and special syntax:
	 * - `{{#if}}`, `{{/if}}` - block helpers (start with # or /)
	 * - `{{! comment }}` - comments (start with !)
	 * - `{{> partial}}` - partials (start with >)
	 * - `{{{already_raw}}}` - already triple-braced
	 * - `{{else}}` - else blocks
	 */
	private upgradeDoubleToTriple(tpl: string): string {
		// Pattern breakdown:
		// (?<!\{)      - not preceded by { (avoids matching inside {{{ )
		// \{\{         - match opening {{
		// (?!...)      - not followed by Handlebars special chars: # / ! > { else
		// (\s*)        - capture leading whitespace
		// (\S+?)       - capture variable name (non-greedy, non-whitespace)
		// (\s*)        - capture trailing whitespace
		// \}\}         - match closing }}
		// (?!\})       - not followed by } (avoids matching {{{ }}}
		const DOUBLE_BRACE_VAR =
			/(?<!\{)\{\{(?!#|\/|!|>|\{|else\b)(\s*)(\S+?)(\s*)\}\}(?!\})/g;

		return tpl.replace(DOUBLE_BRACE_VAR, "{{{$1$2$3}}}");
	}

	/**
	 * Normalize structured response (handle nested response objects).
	 *
	 * Some LLMs wrap their output in extra `{response: {...}}` layers.
	 * This recursively unwraps them up to a reasonable depth limit.
	 */
	private normalizeStructuredResponse(
		responseContent: Record<string, unknown> | null,
		depth = 0,
	): Record<string, unknown> | null {
		if (!responseContent) return null;

		// Safety limit to prevent infinite recursion on pathological input
		const MAX_UNWRAP_DEPTH = 3;
		if (depth >= MAX_UNWRAP_DEPTH) return responseContent;

		// If there's a nested 'response' object with the actual fields, unwrap it
		if (
			"response" in responseContent &&
			typeof responseContent.response === "object" &&
			responseContent.response !== null
		) {
			const nested = responseContent.response as Record<string, unknown>;
			// Only unwrap if nested has fields (not empty)
			if (Object.keys(nested).length > 0) {
				// Recursively unwrap in case of multiple nesting levels
				return this.normalizeStructuredResponse(nested, depth + 1);
			}
		}
		return responseContent;
	}

	private parseStructuredResponse(
		response: string,
		expectedFormat: StructuredResponseFormat,
	): Record<string, unknown> | null {
		const parserOrder =
			expectedFormat === "JSON"
				? (["JSON", "TOON"] as const)
				: (["TOON", "JSON"] as const);
		const candidates = this.extractStructuredResponseCandidates(response);

		for (const candidate of candidates) {
			for (const parser of parserOrder) {
				if (parser === "JSON") {
					if (!candidate.formats.includes("JSON")) {
						continue;
					}

					const parsed = parseJSONObjectFromText(candidate.text);
					if (parsed) {
						if (candidate.source !== "raw" || expectedFormat !== "JSON") {
							this.logger.debug(
								`dynamicPromptExecFromState recovered JSON from ${candidate.source}`,
							);
						}
						return parsed;
					}
					continue;
				}

				if (!candidate.formats.includes("TOON")) {
					continue;
				}

				const parsed = parseToonKeyValue(candidate.text);
				if (parsed) {
					if (candidate.source !== "raw" || expectedFormat === "JSON") {
						this.logger.debug(
							`dynamicPromptExecFromState recovered TOON from ${candidate.source}`,
						);
					}
					return parsed;
				}
			}
		}

		return null;
	}

	private extractStructuredResponseCandidates(
		response: string,
	): StructuredResponseCandidate[] {
		const seen = new Set<string>();
		const candidates: StructuredResponseCandidate[] = [];

		const addCandidate = (
			text: string,
			source: string,
			hints: StructuredResponseFormat[] = [],
		): void => {
			const trimmed = text.trim();
			if (!trimmed || seen.has(trimmed)) {
				return;
			}

			const formats = Array.from(
				new Set([...hints, ...this.detectStructuredResponseFormats(trimmed)]),
			);
			if (formats.length === 0) {
				return;
			}

			seen.add(trimmed);
			candidates.push({ text: trimmed, formats, source });
		};

		addCandidate(response, "raw");

		for (const match of response.matchAll(STRUCTURED_CODE_FENCE_PATTERN)) {
			const label = match[1]?.trim().toLowerCase() ?? "";
			const content = match[2]?.trim() ?? "";
			const hints: StructuredResponseFormat[] =
				label === "json" || label === "json5"
					? ["JSON"]
					: label === "toon"
						? ["TOON"]
						: [];
			addCandidate(content, label ? `fence:${label}` : "fence", hints);
		}

		const embeddedJson = this.extractEmbeddedJsonObject(response);
		if (embeddedJson) {
			addCandidate(embeddedJson, "embedded-json", ["JSON"]);
		}

		const embeddedToon = this.extractEmbeddedToonDocument(response);
		if (embeddedToon) {
			addCandidate(embeddedToon, "embedded-toon", ["TOON"]);
		}

		return candidates;
	}

	private detectStructuredResponseFormats(
		text: string,
	): StructuredResponseFormat[] {
		const trimmed = text.trim();
		const formats: StructuredResponseFormat[] = [];

		if (this.looksLikeJsonObject(trimmed)) {
			formats.push("JSON");
		}
		if (this.looksLikeToonDocument(trimmed)) {
			formats.push("TOON");
		}
		return formats;
	}

	private looksLikeJsonObject(text: string): boolean {
		const trimmed = text.trim();
		return (
			trimmed.startsWith("{") &&
			trimmed.includes("}") &&
			JSON_OBJECT_KEY_PATTERN.test(trimmed)
		);
	}

	private looksLikeToonDocument(text: string): boolean {
		const lines = text
			.trim()
			.split(/\r?\n/)
			.filter((line) => line.trim().length > 0);
		if (lines.length === 0) {
			return false;
		}

		const firstLine = lines[0]?.trim() ?? "";
		if (TOON_HEADER_PATTERN.test(firstLine)) {
			return lines
				.slice(1)
				.some((line) => TOON_FIELD_PATTERN.test(line.trim()));
		}

		if (!TOON_FIELD_PATTERN.test(firstLine)) {
			return false;
		}

		if (lines.length === 1) {
			const [, value = ""] = firstLine.split(/:(.*)/s);
			const trimmedValue = value.trim();
			return !(trimmedValue.startsWith("{") && trimmedValue.endsWith("}"));
		}

		let structuredFieldCount = 0;
		for (const line of lines) {
			const trimmed = line.trim();
			if (TOON_FIELD_PATTERN.test(trimmed)) {
				structuredFieldCount += 1;
				continue;
			}
			if (/^[\t ]+/.test(line)) {
				continue;
			}
			return false;
		}

		return structuredFieldCount > 0;
	}

	private extractEmbeddedToonDocument(text: string): string | null {
		const lines = text.trim().split(/\r?\n/);
		const startIndex = lines.findIndex((line) => {
			const trimmed = line.trim();
			return (
				TOON_HEADER_PATTERN.test(trimmed) || TOON_FIELD_PATTERN.test(trimmed)
			);
		});

		if (startIndex === -1) {
			return null;
		}

		const collected: string[] = [];
		let sawStructuredField = false;

		for (let index = startIndex; index < lines.length; index++) {
			const line = lines[index] ?? "";
			const trimmed = line.trim();
			const isStructuredField = TOON_FIELD_PATTERN.test(trimmed);
			const isIndented = /^[\t ]+/.test(line);
			const isHeader = TOON_HEADER_PATTERN.test(trimmed);

			if (isHeader && !sawStructuredField) {
				collected.push(line);
				continue;
			}

			if (isStructuredField) {
				sawStructuredField = true;
				collected.push(line);
				continue;
			}

			if (trimmed.length === 0 || isIndented) {
				if (collected.length > 0) {
					collected.push(line);
					continue;
				}
			}

			break;
		}

		return sawStructuredField ? collected.join("\n").trim() : null;
	}

	private extractEmbeddedJsonObject(text: string): string | null {
		const trimmed = text.trim();
		if (this.looksLikeJsonObject(trimmed)) {
			return trimmed;
		}

		for (
			let start = text.indexOf("{");
			start !== -1;
			start = text.indexOf("{", start + 1)
		) {
			const candidate = this.extractBalancedJsonObject(text, start);
			if (candidate && this.looksLikeJsonObject(candidate)) {
				return candidate.trim();
			}
		}

		return null;
	}

	private extractBalancedJsonObject(
		text: string,
		startIndex: number,
	): string | null {
		let depth = 0;
		let inString = false;
		let stringQuote = "";
		let escaped = false;

		for (let index = startIndex; index < text.length; index++) {
			const char = text[index] ?? "";

			if (inString) {
				if (escaped) {
					escaped = false;
					continue;
				}
				if (char === "\\") {
					escaped = true;
					continue;
				}
				if (char === stringQuote) {
					inString = false;
					stringQuote = "";
				}
				continue;
			}

			if (char === '"' || char === "'") {
				inString = true;
				stringQuote = char;
				continue;
			}

			if (char === "{") {
				depth += 1;
				continue;
			}

			if (char !== "}") {
				continue;
			}

			depth -= 1;
			if (depth === 0) {
				return text.slice(startIndex, index + 1);
			}
			if (depth < 0) {
				return null;
			}
		}

		return null;
	}

	registerEvent<T extends keyof EventPayloadMap>(
		event: T,
		handler: EventHandler<T>,
	): void;
	registerEvent<P extends EventPayload = EventPayload>(
		event: string,
		handler: (params: P) => Promise<void>,
	): void;
	registerEvent(
		event: string,
		handler: (params: EventPayload) => Promise<void>,
	): void {
		if (!this.events[event]) {
			this.events[event] = [];
		}
		const eventHandlers = this.events[event];
		if (eventHandlers) {
			eventHandlers.push(
				handler as (
					params: EventPayloadMap[keyof EventPayloadMap] | EventPayload,
				) => Promise<void>,
			);
		}
	}

	unregisterEvent<T extends keyof EventPayloadMap>(
		event: T,
		handler: EventHandler<T>,
	): void;
	unregisterEvent<P extends EventPayload = EventPayload>(
		event: string,
		handler: (params: P) => Promise<void>,
	): void;
	unregisterEvent(
		event: string,
		handler: (params: EventPayload) => Promise<void>,
	): void {
		const handlers = this.events?.[event];
		if (!handlers) return;
		const filtered = handlers.filter((h) => h !== handler);
		if (filtered.length > 0) {
			this.events[event] = filtered;
		} else {
			delete this.events[event];
		}
	}

	getEvent(
		event: string,
	):
		| ((
				params: EventPayloadMap[keyof EventPayloadMap] | EventPayload,
		  ) => Promise<void>)[]
		| undefined {
		return this.events[event] as
			| ((
					params: EventPayloadMap[keyof EventPayloadMap] | EventPayload,
			  ) => Promise<void>)[]
			| undefined;
	}

	async emitEvent(event: string | string[], params: JsonValue | object) {
		const events = Array.isArray(event) ? event : [event];
		for (const eventName of events) {
			const eventHandlers = this.events[eventName];
			if (!eventHandlers) {
				continue;
			}
			let paramsWithRuntime:
				| EventPayloadMap[keyof EventPayloadMap]
				| EventPayload = {
				runtime: this as unknown as IAgentRuntime,
				source: "runtime",
			};
			if (typeof params === "object" && params && params !== null) {
				const paramsObj = params as Record<string, JsonValue | object>;
				paramsWithRuntime = {
					...paramsObj,
					runtime: this as unknown as IAgentRuntime,
					source:
						typeof paramsObj.source === "string" ? paramsObj.source : "runtime",
				} as EventPayloadMap[keyof EventPayloadMap] | EventPayload;
			}
			await Promise.all(
				eventHandlers.map((handler) =>
					handler(paramsWithRuntime as EventPayloadMap[keyof EventPayloadMap]),
				),
			);
		}
	}

	async ensureEmbeddingDimension() {
		if (!this.adapter) {
			throw new Error(
				"Database adapter not initialized before ensureEmbeddingDimension",
			);
		}
		const model = this.getModel(ModelType.TEXT_EMBEDDING);
		if (!model) {
			throw new Error("No TEXT_EMBEDDING model registered");
		}

		// Pass null to get a test vector for dimension detection
		// Model handlers should return a zero-filled vector of the correct dimension when null is passed
		const embedding = await this.useModel(ModelType.TEXT_EMBEDDING, null);
		if (!embedding?.length) {
			throw new Error("Invalid embedding received");
		}

		await this.adapter.ensureEmbeddingDimension(embedding.length);
		this.logger.debug(
			{ src: "agent", agentId: this.agentId, dimension: embedding.length },
			"Embedding dimension set",
		);
	}

	registerTaskWorker(taskHandler: TaskWorker): void {
		if (this.taskWorkers.has(taskHandler.name)) {
			this.logger.warn(
				{ src: "agent", agentId: this.agentId, task: taskHandler.name },
				"Task worker already registered, overwriting",
			);
		}
		this.taskWorkers.set(taskHandler.name, taskHandler);
	}

	getTaskWorker(name: string): TaskWorker | undefined {
		return this.taskWorkers.get(name);
	}

	unregisterTaskWorker(name: string): boolean {
		return this.taskWorkers.delete(name);
	}

	get db(): object {
		return this.adapter.db;
	}
	async init(): Promise<void> {
		await this.adapter.initialize();
	}
	/**
	 * Closes the database adapter. Call after stop() for full teardown (stops services then closes DB/connection).
	 */
	async close(): Promise<void> {
		if (this.adapter) {
			await this.adapter.close();
		}
	}
	async getAgent(agentId: UUID): Promise<Agent | null> {
		const agents = await this.adapter.getAgentsByIds([agentId]);
		return agents[0] ?? null;
	}
	async getAgents(): Promise<Partial<Agent>[]> {
		return await this.adapter.getAgents();
	}
	async createAgent(agent: Partial<Agent>): Promise<boolean> {
		const ids = await this.adapter.createAgents([agent]);
		return ids.length > 0;
	}
	async updateAgent(agentId: UUID, agent: Partial<Agent>): Promise<boolean> {
		return await this.adapter.updateAgents([{ agentId, agent }]);
	}
	async deleteAgent(agentId: UUID): Promise<boolean> {
		return await this.adapter.deleteAgents([agentId]);
	}
	async countAgents(): Promise<number> {
		return await this.adapter.countAgents();
	}
	async cleanupAgents(): Promise<void> {
		return await this.adapter.cleanupAgents();
	}

	// Batch agent methods
	async getAgentsByIds(agentIds: UUID[]): Promise<Agent[]> {
		return await this.adapter.getAgentsByIds(agentIds);
	}
	async createAgents(agents: Partial<Agent>[]): Promise<UUID[]> {
		return await this.adapter.createAgents(agents);
	}
	async upsertAgents(agents: Partial<Agent>[]): Promise<void> {
		return await this.adapter.upsertAgents(agents);
	}
	async updateAgents(
		updates: Array<{ agentId: UUID; agent: Partial<Agent> }>,
	): Promise<boolean> {
		return await this.adapter.updateAgents(updates);
	}
	async deleteAgents(agentIds: UUID[]): Promise<boolean> {
		return await this.adapter.deleteAgents(agentIds);
	}

	async ensureAgentExists(agent: Partial<Agent>): Promise<Agent> {
		if (!agent.id) {
			throw new Error("Agent id is required");
		}

		// WHY upsert instead of get-check-create: Eliminates race condition where
		// two concurrent calls could both see agent doesn't exist and both try to
		// create it. Upsert is atomic (single SQL statement), so the database
		// guarantees only one succeeds.

		// Fetch existing agent to perform intelligent merge (if it exists)
		const existingAgent =
			(await this.adapter.getAgentsByIds([agent.id]))[0] ?? null;

		let agentToUpsert: Partial<Agent>;

		if (existingAgent) {
			// Merge DB-persisted settings with character configuration
			// Priority: DB (persisted runtime settings) < character.json (file overrides)
			const mergedSettings = {
				...existingAgent.settings, // Keep all DB-persisted settings
				...agent.settings, // Override only keys present in character.json
			};

			// Deep merge secrets to preserve runtime-generated secrets
			const existingSecrets =
				existingAgent.secrets && typeof existingAgent.secrets === "object"
					? existingAgent.secrets
					: {};
			const existingSettingsSecrets =
				existingAgent.settings?.secrets &&
				typeof existingAgent.settings.secrets === "object"
					? existingAgent.settings.secrets
					: {};
			const agentSecrets =
				agent.secrets && typeof agent.secrets === "object" ? agent.secrets : {};
			const agentSettingsSecrets =
				agent.settings?.secrets && typeof agent.settings.secrets === "object"
					? agent.settings.secrets
					: {};
			const mergedSecrets = {
				...existingSecrets,
				...existingSettingsSecrets,
				...agentSecrets,
				...agentSettingsSecrets,
			};

			if (Object.keys(mergedSecrets).length > 0) {
				mergedSettings.secrets = mergedSecrets;
			}

			agentToUpsert = {
				...existingAgent, // Keep all DB-persisted data
				...agent, // Override with character.json values
				settings: mergedSettings, // Use intelligently merged settings
				id: agent.id,
				updatedAt: Date.now(),
				secrets:
					Object.keys(mergedSecrets).length > 0 ? mergedSecrets : agent.secrets,
			};
		} else {
			// No existing agent - upsert will insert it
			agentToUpsert = {
				...agent,
				id: agent.id,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			} as Agent;
		}

		// Atomic upsert - handles both insert and update cases
		await this.adapter.upsertAgents([agentToUpsert]);

		// Fetch and return the final state
		const refreshedAgent =
			(await this.adapter.getAgentsByIds([agent.id]))[0] ?? null;

		if (!refreshedAgent) {
			throw new Error(`Failed to retrieve agent after upsert: ${agent.id}`);
		}

		this.logger.debug(
			{ src: "agent", agentId: agent.id },
			existingAgent ? "Agent updated on restart" : "Agent created",
		);
		return refreshedAgent;
	}
	async getEntityById(entityId: UUID): Promise<Entity | null> {
		const entities = await this.adapter.getEntitiesByIds([entityId]);
		if (!entities?.length) return null;
		return entities[0];
	}

	async getEntitiesForRooms(
		roomIds: UUID[],
		includeComponents?: boolean,
	): Promise<import("./types/database").EntitiesForRoomsResult> {
		return await this.adapter.getEntitiesForRooms(roomIds, includeComponents);
	}

	async getEntitiesForRoom(
		roomId: UUID,
		includeComponents?: boolean,
	): Promise<Entity[]> {
		const result = await this.adapter.getEntitiesForRooms(
			[roomId],
			includeComponents,
		);
		return result[0]?.entities ?? [];
	}
	async createEntity(entity: Entity): Promise<boolean> {
		if (!entity.agentId) {
			entity.agentId = this.agentId;
		}
		const ids = await this.createEntities([entity]);
		return ids.length > 0;
	}

	async createEntities(entities: Entity[]): Promise<UUID[]> {
		entities.forEach((e) => {
			e.agentId = this.agentId;
		});
		const result = await this.adapter.createEntities(entities);
		// Some adapters (e.g. plugin-sql) return boolean instead of UUID[].
		// Normalize to UUID[] so callers and wrappers get a consistent contract.
		if (Array.isArray(result)) return result;
		if (result) return entities.map((e) => e.id as UUID);
		return [];
	}
	async upsertEntities(entities: Entity[]): Promise<void> {
		entities.forEach((e) => {
			e.agentId = this.agentId;
		});
		return await this.adapter.upsertEntities(entities);
	}

	async getComponents(
		entityId: UUID,
		worldId?: UUID,
		sourceEntityId?: UUID,
	): Promise<Component[]> {
		return await this.adapter.getComponentsForEntities(
			[entityId],
			worldId,
			sourceEntityId,
		);
	}

	async getComponentsByNaturalKeys(
		keys: Array<{
			entityId: UUID;
			type: string;
			worldId?: UUID;
			sourceEntityId?: UUID;
		}>,
	): Promise<(Component | null)[]> {
		return await this.adapter.getComponentsByNaturalKeys(keys);
	}

	async getComponentsForEntities(
		entityIds: UUID[],
		worldId?: UUID,
		sourceEntityId?: UUID,
	): Promise<Component[]> {
		return await this.adapter.getComponentsForEntities(
			entityIds,
			worldId,
			sourceEntityId,
		);
	}
	async addEmbeddingToMemory(memory: Memory): Promise<Memory> {
		if (memory.embedding) {
			return memory;
		}
		const memoryText = memory.content.text;
		if (!memoryText) {
			throw new Error("Cannot generate embedding: Memory content is empty");
		}
		memory.embedding = await this.useModel(ModelType.TEXT_EMBEDDING, {
			text: memoryText,
		});
		return memory;
	}

	/**
	 * Queue a memory for embedding generation. If companionUrl is set, POSTs to companion
	 * and returns without waiting (fire-and-forget). WHY: Thin runtime doesn't block on embedding.
	 */
	async queueEmbeddingGeneration(
		memory: Memory,
		priority?: "high" | "normal" | "low",
	): Promise<void> {
		priority = priority || "normal";
		if (!memory || memory.embedding || !memory.content?.text) {
			return;
		}

		if (this.companionUrl) {
			const url = `${this.companionUrl.replace(/\/$/, "")}/embedding-generation`;
			void this.fetch(url, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					agentId: this.agentId,
					memory,
					priority,
					runId: this.getCurrentRunId(),
				}),
			}).catch(() => {});
			return;
		}

		await this.emitEvent(EventType.EMBEDDING_GENERATION_REQUESTED, {
			runtime: this,
			memory,
			priority,
			source: "runtime",
			retryCount: 0,
			maxRetries: 3,
			runId: this.getCurrentRunId(),
		});
	}
	async getMemories(params: {
		entityId?: UUID;
		agentId?: UUID;
		roomId?: UUID;
		limit?: number;
		count?: number;
		offset?: number;
		unique?: boolean;
		tableName: string;
		start?: number;
		end?: number;
		worldId?: UUID;
		metadata?: Record<string, unknown>;
		orderBy?: "createdAt";
		orderDirection?: "asc" | "desc";
	}): Promise<Memory[]> {
		return await this.adapter.getMemories({
			...params,
			limit: params.limit ?? params.count,
			tableName: params.tableName ?? "messages",
		});
	}
	async getAllMemories(): Promise<Memory[]> {
		const tables = ["memories", "messages", "facts", "documents"];
		const allMemories: Memory[] = [];

		for (const tableName of tables) {
			const memories = await this.adapter.getMemories({
				agentId: this.agentId,
				tableName,
				limit: 10000, // Get a large number to fetch all
			});
			allMemories.push(...memories);
		}

		return allMemories;
	}
	async getMemoriesByIds(ids: UUID[], tableName?: string): Promise<Memory[]> {
		return await this.adapter.getMemoriesByIds(ids, tableName);
	}
	async getMemoriesByRoomIds(params: {
		tableName: string;
		roomIds: UUID[];
		limit?: number;
	}): Promise<Memory[]> {
		return await this.adapter.getMemoriesByRoomIds(params);
	}

	async getCachedEmbeddings(params: {
		query_table_name: string;
		query_threshold: number;
		query_input: string;
		query_field_name: string;
		query_field_sub_name: string;
		query_match_count: number;
	}): Promise<{ embedding: number[]; levenshtein_score: number }[]> {
		return await this.adapter.getCachedEmbeddings(params);
	}
	async searchMemories(params: {
		embedding: number[];
		query?: string;
		match_threshold?: number;
		limit?: number;
		roomId?: UUID;
		unique?: boolean;
		worldId?: UUID;
		entityId?: UUID;
		tableName: string;
	}): Promise<Memory[]> {
		const memories = await this.adapter.searchMemories({
			...params,
			tableName: params.tableName ?? "messages",
		});
		if (params.query) {
			const rerankedMemories = await this.rerankMemories(
				params.query,
				memories,
			);
			return rerankedMemories;
		}
		return memories;
	}
	async rerankMemories(query: string, memories: Memory[]): Promise<Memory[]> {
		const docs = memories.map((memory) => ({
			title: memory.id,
			content: memory.content.text,
		}));
		const bm25 = new BM25(docs);
		const results = bm25.search(query, memories.length);
		return results.map((result) => memories[result.index]);
	}
	/**
	 * Get the secrets to redact from character settings.
	 * Returns an empty object if no secrets are configured.
	 */
	private getSecretsForRedaction(): Record<string, string> {
		const secrets = this.character?.settings?.secrets;
		if (!secrets || typeof secrets !== "object") {
			return {};
		}
		// Filter to only include string values
		const result: Record<string, string> = {};
		for (const [key, value] of Object.entries(secrets)) {
			if (typeof value === "string" && value.length > 0) {
				result[key] = value;
			}
		}
		return result;
	}

	/**
	 * Redact secrets from text content.
	 * This prevents character secrets from appearing in outputs or memories.
	 */
	redactSecrets(text: string): string {
		if (!text) {
			return text;
		}
		const secrets = this.getSecretsForRedaction();
		if (Object.keys(secrets).length === 0) {
			return text;
		}
		return redactWithSecrets(text, { secrets, applyPatterns: true });
	}

	async clearAllAgentMemories(): Promise<void> {
		this.logger.info(
			{ src: "agent", agentId: this.agentId },
			"Clearing all memories",
		);

		const allMemories = await this.getAllMemories();
		const memoryIds = allMemories
			.map((memory) => memory.id)
			.filter((id): id is UUID => id !== undefined);

		if (memoryIds.length === 0) {
			this.logger.debug(
				{ src: "agent", agentId: this.agentId },
				"No memories to delete",
			);
			return;
		}

		await this.adapter.deleteMemories(memoryIds);
		this.logger.info(
			{ src: "agent", agentId: this.agentId, count: memoryIds.length },
			"Memories cleared",
		);
	}
	async deleteAllMemories(roomIds: UUID[], tableName: string): Promise<void> {
		await this.adapter.deleteAllMemories(roomIds, tableName);
	}
	async countMemories(
		roomIdOrParams:
			| UUID
			| {
					roomId?: UUID;
					unique?: boolean;
					tableName?: string;
					entityId?: UUID;
					agentId?: UUID;
					metadata?: Record<string, unknown>;
			  },
		unique?: boolean,
		tableName?: string,
	): Promise<number> {
		if (typeof roomIdOrParams === "string") {
			return await this.adapter.countMemories({
				roomIds: [roomIdOrParams as UUID],
				unique,
				tableName: tableName ?? "messages",
			});
		}
		return await this.adapter.countMemories({
			roomIds: roomIdOrParams.roomId ? [roomIdOrParams.roomId] : undefined,
			unique: roomIdOrParams.unique,
			tableName: roomIdOrParams.tableName ?? "messages",
			entityId: roomIdOrParams.entityId,
			agentId: roomIdOrParams.agentId,
			metadata: roomIdOrParams.metadata,
		});
	}
	async getLogs(params: {
		entityId?: UUID;
		roomId?: UUID;
		type?: string;
		limit?: number;
		offset?: number;
	}): Promise<Log[]> {
		return await this.adapter.getLogs(params);
	}
	// Batch log methods
	async getLogsByIds(logIds: UUID[]): Promise<Log[]> {
		return await this.adapter.getLogsByIds(logIds);
	}

	async createLogs(
		params: Array<{
			body: LogBody;
			entityId: UUID;
			roomId: UUID;
			type: string;
		}>,
	): Promise<void> {
		return await this.adapter.createLogs(params);
	}

	async updateLogs(
		logs: Array<{ id: UUID; updates: Partial<Log> }>,
	): Promise<void> {
		return await this.adapter.updateLogs(logs);
	}

	async deleteLogs(logIds: UUID[]): Promise<void> {
		return await this.adapter.deleteLogs(logIds);
	}
	async createWorld(world: World): Promise<UUID> {
		const ids = await this.adapter.createWorlds([world]);
		return ids[0];
	}
	async getWorld(id: UUID): Promise<World | null> {
		const worlds = await this.adapter.getWorldsByIds([id]);
		return worlds[0] ?? null;
	}
	async deleteWorld(worldId: UUID): Promise<void> {
		await this.adapter.deleteWorlds([worldId]);
	}
	async getAllWorlds(): Promise<World[]> {
		return await this.adapter.getAllWorlds();
	}
	async updateWorld(world: World): Promise<void> {
		await this.adapter.updateWorlds([world]);
	}

	// Batch world methods
	async getWorldsByIds(worldIds: UUID[]): Promise<World[]> {
		return await this.adapter.getWorldsByIds(worldIds);
	}
	async createWorlds(worlds: World[]): Promise<UUID[]> {
		return await this.adapter.createWorlds(worlds);
	}
	async upsertWorlds(worlds: World[]): Promise<void> {
		return await this.adapter.upsertWorlds(worlds);
	}
	async deleteWorlds(worldIds: UUID[]): Promise<void> {
		await this.adapter.deleteWorlds(worldIds);
	}
	async updateWorlds(worlds: World[]): Promise<void> {
		await this.adapter.updateWorlds(worlds);
	}

	async getRoom(roomId: UUID): Promise<Room | null> {
		const rooms = await this.adapter.getRoomsByIds([roomId]);
		if (!rooms?.length) return null;
		return rooms[0];
	}

	async getRoomsByIds(roomIds: UUID[]): Promise<Room[]> {
		return await this.adapter.getRoomsByIds(roomIds);
	}
	async createRoom({
		id,
		name,
		source,
		type,
		channelId,
		messageServerId,
		worldId,
	}: Room): Promise<UUID> {
		if (!worldId) throw new Error("worldId is required");
		const res = await this.adapter.createRooms([
			{
				id,
				name,
				source,
				type,
				channelId,
				messageServerId,
				worldId,
			},
		]);
		if (!res.length) throw new Error("Failed to create room");
		return res[0];
	}

	async createRooms(rooms: Room[]): Promise<UUID[]> {
		return await this.adapter.createRooms(rooms);
	}
	async upsertRooms(rooms: Room[]): Promise<void> {
		return await this.adapter.upsertRooms(rooms);
	}

	async deleteRoomsByWorldId(worldId: UUID): Promise<void> {
		await this.adapter.deleteRoomsByWorldIds([worldId]);
	}
	async getRoomsForParticipant(entityId: UUID): Promise<UUID[]> {
		return await this.adapter.getRoomsForParticipants([entityId]);
	}

	async getRoomsForParticipants(entityIds: UUID[]): Promise<UUID[]> {
		return await this.adapter.getRoomsForParticipants(entityIds);
	}

	// deprecate this one
	async getRooms(worldId: UUID): Promise<Room[]> {
		return await this.adapter.getRoomsByWorlds([worldId]);
	}

	async getRoomsByWorld(worldId: UUID): Promise<Room[]> {
		return await this.adapter.getRoomsByWorlds([worldId]);
	}
	async getParticipantUserState(
		roomId: UUID,
		entityId: UUID,
	): Promise<"FOLLOWED" | "MUTED" | null> {
		const results = await this.adapter.getParticipantUserStates([
			{ roomId, entityId },
		]);
		return results[0] ?? null;
	}
	async updateParticipantUserState(
		roomId: UUID,
		entityId: UUID,
		state: "FOLLOWED" | "MUTED" | null,
	): Promise<void> {
		await this.adapter.updateParticipantUserStates([
			{ roomId, entityId, state },
		]);
	}

	async getParticipantUserStates(
		pairs: Array<{ roomId: UUID; entityId: UUID }>,
	): Promise<("FOLLOWED" | "MUTED" | null)[]> {
		return await this.adapter.getParticipantUserStates(pairs);
	}

	async updateParticipantUserStates(
		updates: Array<{
			roomId: UUID;
			entityId: UUID;
			state: "FOLLOWED" | "MUTED" | null;
		}>,
	): Promise<void> {
		await this.adapter.updateParticipantUserStates(updates);
	}
	async getRelationships(params: {
		entityIds?: UUID[];
		entityId?: UUID;
		tags?: string[];
		limit?: number;
		offset?: number;
	}): Promise<Relationship[]> {
		const entityIds =
			Array.isArray(params.entityIds) && params.entityIds.length > 0
				? params.entityIds
				: params.entityId
					? [params.entityId]
					: [];
		return await this.adapter.getRelationships({
			entityIds,
			tags: params.tags,
			limit: params.limit,
			offset: params.offset,
		});
	}
	// Batch cache methods
	async getCaches<T>(keys: string[]): Promise<Map<string, T>> {
		return await this.adapter.getCaches<T>(keys);
	}

	async setCaches<T>(
		entries: Array<{ key: string; value: T }>,
	): Promise<boolean> {
		return await this.adapter.setCaches<T>(entries);
	}

	async deleteCaches(keys: string[]): Promise<boolean> {
		return await this.adapter.deleteCaches(keys);
	}

	async getTasks(params: {
		roomId?: UUID;
		tags?: string[];
		entityId?: UUID;
	}): Promise<Task[]> {
		return await this.adapter.getTasks({ ...params, agentIds: [this.agentId] });
	}
	async getTasksByName(name: string): Promise<Task[]> {
		return await this.adapter.getTasksByName(name);
	}

	/** WHY fire-and-forget: Notify companion that tasks changed so it can poll/process; no need to block. */
	private _notifyCompanionTasksDirty(): void {
		if (!this.companionUrl) return;
		const url = `${this.companionUrl.replace(/\/$/, "")}/task-dirty`;
		void this.fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ agentId: this.agentId }),
		}).catch(() => {});
	}

	async createTask(task: Task): Promise<UUID> {
		const ids = await this.adapter.createTasks([task]);
		this._notifyCompanionTasksDirty();
		return ids[0];
	}

	async getTask(id: UUID): Promise<Task | null> {
		const tasks = await this.adapter.getTasksByIds([id]);
		return tasks[0] ?? null;
	}

	async updateTask(id: UUID, task: Partial<Task>): Promise<void> {
		await this.adapter.updateTasks([{ id, task }]);
		this._notifyCompanionTasksDirty();
	}

	async deleteTask(id: UUID): Promise<void> {
		return await this.adapter.deleteTasks([id]);
	}

	async log(params: {
		body: LogBody;
		entityId: UUID;
		roomId: UUID;
		type: string;
	}): Promise<void> {
		return await this.adapter.createLogs([params]);
	}

	async deleteLog(logId: UUID): Promise<void> {
		return await this.adapter.deleteLogs([logId]);
	}

	async getCache<T>(key: string): Promise<T | undefined> {
		const caches = await this.adapter.getCaches<T>([key]);
		return caches.get(key);
	}

	async setCache<T>(key: string, value: T): Promise<boolean> {
		return await this.adapter.setCaches<T>([{ key, value }]);
	}

	async deleteCache(key: string): Promise<boolean> {
		return await this.adapter.deleteCaches([key]);
	}

	// Batch task methods
	async createTasks(tasks: Task[]): Promise<UUID[]> {
		const ids = await this.adapter.createTasks(tasks);
		this._notifyCompanionTasksDirty();
		return ids;
	}

	async getTasksByIds(taskIds: UUID[]): Promise<Task[]> {
		return await this.adapter.getTasksByIds(taskIds);
	}

	async updateTasks(
		updates: Array<{ id: UUID; task: Partial<Task> }>,
	): Promise<void> {
		await this.adapter.updateTasks(updates);
		this._notifyCompanionTasksDirty();
	}

	async deleteTasks(taskIds: UUID[]): Promise<void> {
		return await this.adapter.deleteTasks(taskIds);
	}

	/**
	 * Run callback in a database transaction. Forwards options.entityContext to the adapter.
	 * WHY forward only: RLS (withEntityContext) is implemented in the adapter (e.g. plugin-sql Postgres);
	 * runtime does not touch Postgres or connection context.
	 */
	async transaction<T>(
		callback: (tx: IDatabaseAdapter<object>) => Promise<T>,
		options?: { entityContext?: UUID },
	): Promise<T> {
		return await this.adapter.transaction(callback, options);
	}

	async queryEntities(params: {
		componentType?: string;
		componentDataFilter?: Record<string, unknown>;
		agentId?: UUID;
		entityIds?: UUID[];
		worldId?: UUID;
		limit?: number;
		offset?: number;
		includeAllComponents?: boolean;
		entityContext?: UUID;
	}): Promise<Entity[]> {
		return await this.adapter.queryEntities({
			...params,
			agentId: params.agentId ?? this.agentId,
		});
	}

	// Batch entity methods
	async getEntitiesByIds(entityIds: UUID[]): Promise<Entity[]> {
		return await this.adapter.getEntitiesByIds(entityIds);
	}

	async updateEntities(entities: Entity[]): Promise<void> {
		return await this.adapter.updateEntities(entities);
	}

	async deleteEntities(entityIds: UUID[]): Promise<void> {
		return await this.adapter.deleteEntities(entityIds);
	}
	async searchEntitiesByName(params: {
		query: string;
		agentId?: UUID;
		limit?: number;
	}): Promise<Entity[]> {
		return await this.adapter.searchEntitiesByName({
			query: params.query,
			agentId: params.agentId ?? this.agentId,
			limit: params.limit,
		});
	}
	async getEntitiesByNames(params: {
		names: string[];
		agentId?: UUID;
	}): Promise<Entity[]> {
		return await this.adapter.getEntitiesByNames({
			names: params.names,
			agentId: params.agentId ?? this.agentId,
		});
	}

	// Single-item entity wrapper
	async updateEntity(entity: Entity): Promise<void> {
		return await this.adapter.updateEntities([entity]);
	}

	// Batch component methods
	async createComponents(components: Component[]): Promise<UUID[]> {
		return await this.adapter.createComponents(components);
	}

	async getComponentsByIds(componentIds: UUID[]): Promise<Component[]> {
		return await this.adapter.getComponentsByIds(componentIds);
	}

	async updateComponents(components: Component[]): Promise<void> {
		return await this.adapter.updateComponents(components);
	}

	async deleteComponents(componentIds: UUID[]): Promise<void> {
		return await this.adapter.deleteComponents(componentIds);
	}

	// Single-item component wrappers
	async createComponent(component: Component): Promise<boolean> {
		const ids = await this.adapter.createComponents([component]);
		return ids.length > 0;
	}

	async getComponent(
		entityId: UUID,
		type: string,
		worldId?: UUID,
		sourceEntityId?: UUID,
	): Promise<Component | null> {
		// This one doesn't have a batch equivalent for the entity+type query
		// It uses the getComponents query method
		const results = await this.adapter.getComponentsByNaturalKeys([
			{ entityId, type, worldId, sourceEntityId },
		]);
		return results[0] ?? null;
	}

	async updateComponent(component: Component): Promise<void> {
		return await this.adapter.updateComponents([component]);
	}

	async deleteComponent(componentId: UUID): Promise<void> {
		return await this.adapter.deleteComponents([componentId]);
	}

	async upsertComponent(component: Component): Promise<void> {
		return await this.adapter.upsertComponents([component]);
	}

	async upsertComponents(
		components: Component[],
		options?: { entityContext?: UUID },
	): Promise<void> {
		return await this.adapter.upsertComponents(components, options);
	}

	async patchComponent(
		componentId: UUID,
		ops: PatchOp[],
		options?: { entityContext?: UUID },
	): Promise<void> {
		return await this.adapter.patchComponents([{ componentId, ops }], options);
	}

	async patchComponents(
		updates: Array<{ componentId: UUID; ops: PatchOp[] }>,
		options?: { entityContext?: UUID },
	): Promise<void> {
		return await this.adapter.patchComponents(updates, options);
	}

	async patchComponentField(
		componentId: UUID,
		op: PatchOp,
		options?: { entityContext?: UUID },
	): Promise<void> {
		return await this.adapter.patchComponents(
			[{ componentId, ops: [op] }],
			options,
		);
	}

	async getComponentsByType(
		type: string,
		agentId?: UUID,
		options?: { entityContext?: UUID },
	): Promise<Component[]> {
		// Wraps queryEntities and extracts components from entities
		const entities = await this.adapter.queryEntities({
			componentType: type,
			agentId: agentId ?? this.agentId,
			includeAllComponents: false, // Only return matched components
			...(options?.entityContext != null && {
				entityContext: options.entityContext,
			}),
		});

		// Flatten components from all entities
		const components: Component[] = [];
		for (const entity of entities) {
			if (entity.components) {
				components.push(...entity.components);
			}
		}
		return components;
	}

	async upsertMemory(
		memory: Memory,
		tableName: string,
		options?: { entityContext?: UUID },
	): Promise<void> {
		// Apply secret redaction (same as createMemory) to prevent plaintext secrets
		const secrets = this.getSecretsForRedaction();
		if (Object.keys(secrets).length > 0 && memory.content?.text) {
			memory = {
				...memory,
				content: {
					...memory.content,
					text: redactWithSecrets(memory.content.text, {
						secrets,
						applyPatterns: true,
					}),
				},
			};
		}
		return await this.adapter.upsertMemories([{ memory, tableName }], options);
	}

	async upsertMemories(
		memories: Array<{ memory: Memory; tableName: string }>,
		options?: { entityContext?: UUID },
	): Promise<void> {
		return await this.adapter.upsertMemories(memories, options);
	}

	// Batch relationship methods
	async createRelationships(
		relationships: Array<{
			sourceEntityId: UUID;
			targetEntityId: UUID;
			tags?: string[];
			metadata?: Metadata;
		}>,
	): Promise<UUID[]> {
		return await this.adapter.createRelationships(relationships);
	}

	async getRelationshipsByIds(
		relationshipIds: UUID[],
	): Promise<Relationship[]> {
		return await this.adapter.getRelationshipsByIds(relationshipIds);
	}

	async getRelationshipsByPairs(
		pairs: Array<{ sourceEntityId: UUID; targetEntityId: UUID }>,
	): Promise<(Relationship | null)[]> {
		return await this.adapter.getRelationshipsByPairs(pairs);
	}

	async updateRelationships(relationships: Relationship[]): Promise<void> {
		return await this.adapter.updateRelationships(relationships);
	}

	async deleteRelationships(relationshipIds: UUID[]): Promise<void> {
		return await this.adapter.deleteRelationships(relationshipIds);
	}

	// Single-item relationship wrappers
	async createRelationship(params: {
		sourceEntityId: UUID;
		targetEntityId: UUID;
		tags?: string[];
		metadata?: Metadata;
	}): Promise<boolean> {
		const ids = await this.adapter.createRelationships([params]);
		return ids.length > 0;
	}

	async getRelationship(params: {
		sourceEntityId: UUID;
		targetEntityId: UUID;
	}): Promise<Relationship | null> {
		// This one doesn't have a batch equivalent for the source+target query
		// It uses the getRelationship query method
		const results = await this.adapter.getRelationshipsByPairs([params]);
		return results[0] ?? null;
	}

	async updateRelationship(relationship: Relationship): Promise<void> {
		return await this.adapter.updateRelationships([relationship]);
	}

	// ── Batch memory passthroughs ────────────────────────────────────────
	// These go straight to the adapter with no transformation.
	// WHY no redaction here: batch callers are responsible for their own
	// content. The single-item createMemory() wrapper below handles
	// redaction for the common case.
	async createMemories(
		memories: Array<{ memory: Memory; tableName: string; unique?: boolean }>,
	): Promise<UUID[]> {
		return await this.adapter.createMemories(memories);
	}

	async updateMemories(
		memories: Array<Partial<Memory> & { id: UUID; metadata?: MemoryMetadata }>,
	): Promise<void> {
		return await this.adapter.updateMemories(memories);
	}

	async deleteMemories(memoryIds: UUID[]): Promise<void> {
		return await this.adapter.deleteMemories(memoryIds);
	}

	// ── Single-item memory wrappers ────────────────────────────────────
	// These exist for caller convenience. getMemoryById and createMemory
	// are the most frequently called methods in the entire codebase.
	async getMemoryById(id: UUID): Promise<Memory | null> {
		const memories = await this.adapter.getMemoriesByIds([id]);
		return memories.length > 0 ? memories[0] : null;
	}

	// WHY createMemory is special: it performs secret redaction before
	// delegating to the adapter. This is the ONLY place where API keys,
	// tokens, and other secrets are scrubbed from memory content. Internal
	// runtime code deliberately calls this wrapper (not adapter.createMemories
	// directly) to ensure redaction always happens.
	async createMemory(
		memory: Memory,
		tableName: string,
		unique?: boolean,
	): Promise<UUID> {
		if (unique !== undefined) memory.unique = unique;

		// Redact any secrets from memory content before storing
		const secrets = this.getSecretsForRedaction();
		if (Object.keys(secrets).length > 0 && memory.content?.text) {
			memory = {
				...memory,
				content: {
					...memory.content,
					text: redactWithSecrets(memory.content.text, {
						secrets,
						applyPatterns: true,
					}),
				},
			};
		}

		const ids = await this.adapter.createMemories([
			{ memory, tableName, unique },
		]);
		const memoryId = ids[0];
		await this.applyPipelineHooks(
			"after_memory_persisted",
			afterMemoryPersistedPipelineHookContext(memory, tableName, memoryId),
		);
		return memoryId;
	}

	async updateMemory(
		memory: Partial<Memory> & { id: UUID; metadata?: MemoryMetadata },
	): Promise<boolean> {
		await this.adapter.updateMemories([memory]);
		return true; // Successfully updated if no error thrown
	}

	async deleteMemory(memoryId: UUID): Promise<void> {
		return await this.adapter.deleteMemories([memoryId]);
	}

	// ── Participant passthroughs & wrappers ──────────────────────────────
	async deleteParticipants(
		participants: Array<{ entityId: UUID; roomId: UUID }>,
	): Promise<boolean> {
		return await this.adapter.deleteParticipants(participants);
	}

	async updateParticipants(
		participants: Array<{
			entityId: UUID;
			roomId: UUID;
			updates: Partial<Participant>;
		}>,
	): Promise<void> {
		return await this.adapter.updateParticipants(participants);
	}

	async removeParticipant(entityId: UUID, roomId: UUID): Promise<boolean> {
		return await this.adapter.deleteParticipants([{ entityId, roomId }]);
	}

	// ── Room passthroughs & wrappers ────────────────────────────────────
	async updateRooms(rooms: Room[]): Promise<void> {
		return await this.adapter.updateRooms(rooms);
	}

	async deleteRooms(roomIds: UUID[]): Promise<void> {
		return await this.adapter.deleteRooms(roomIds);
	}

	// Single-item room wrappers
	async updateRoom(room: Room): Promise<void> {
		return await this.adapter.updateRooms([room]);
	}

	async deleteRoom(roomId: UUID): Promise<void> {
		return await this.adapter.deleteRooms([roomId]);
	}

	on(event: string, callback: (data: EventPayload) => void): void {
		if (!this.eventHandlers.has(event)) {
			this.eventHandlers.set(event, []);
		}
		const handlers = this.eventHandlers.get(event);
		if (handlers) {
			handlers.push(callback);
		}
	}
	off(event: string, callback: (data: EventPayload) => void): void {
		const handlers = this.eventHandlers.get(event);
		if (!handlers) {
			return;
		}
		const index = handlers.indexOf(callback);
		if (index !== -1) {
			handlers.splice(index, 1);
		}
	}
	emit(event: string, data: EventPayload): void {
		const handlers = this.eventHandlers.get(event);
		if (!handlers) {
			return;
		}
		for (const handler of handlers) {
			handler(data);
		}
	}
	async sendControlMessage(params: {
		roomId: UUID;
		action: "enable_input" | "disable_input";
		target?: string;
	}): Promise<void> {
		const { roomId, action, target } = params;
		const controlMessage: ControlMessage = {
			type: "control",
			payload: {
				action,
				target,
			},
			roomId,
		};
		await this.emitEvent("CONTROL_MESSAGE", {
			runtime: this,
			message: controlMessage,
			source: "agent",
		});

		this.logger.debug(
			{ src: "agent", agentId: this.agentId, action, channelId: roomId },
			"Control message sent",
		);
	}

	private ensureWebSearchCategoryRegistered(): void {
		if (this.searchCategories.has("web")) {
			return;
		}
		this.registerSearchCategory({
			category: "web",
			label: "Web search",
			description:
				"Search current web pages and discovery surfaces through IWebSearchService.",
			contexts: ["knowledge", "browser"],
			filters: [
				{
					name: "query",
					label: "Query",
					type: "string",
					required: true,
				},
				{
					name: "limit",
					label: "Limit",
					type: "number",
					description: "Maximum results to return.",
				},
				{
					name: "region",
					label: "Region",
					type: "string",
					description: "Optional region code.",
				},
				{
					name: "language",
					label: "Language",
					type: "string",
					description: "Optional language code.",
				},
				{
					name: "sortBy",
					label: "Sort",
					type: "enum",
					options: [
						{ label: "Relevance", value: "relevance" },
						{ label: "Date", value: "date" },
						{ label: "Popularity", value: "popularity" },
					],
				},
				{
					name: "safeSearch",
					label: "Safe search",
					type: "enum",
					options: [
						{ label: "Strict", value: "strict" },
						{ label: "Moderate", value: "moderate" },
						{ label: "Off", value: "off" },
					],
				},
			],
			resultSchemaSummary:
				"SearchResponse: query, results with title/url/description/snippet/source/publishedDate, suggestions, relatedSearches, nextPageToken.",
			capabilities: [
				"search",
				"news",
				"images",
				"videos",
				"suggestions",
				"page_info",
			],
			serviceType: WEB_SEARCH_SERVICE_TYPE,
		});
	}

	registerSearchCategory(registration: SearchCategoryRegistration): void {
		const normalized = normalizeSearchCategoryRegistration(registration);
		const key = getSearchCategoryKey(normalized.category);
		if (this.searchCategories.has(key)) {
			this.logger.warn(
				{
					src: "agent",
					agentId: this.agentId,
					searchCategory: normalized.category,
				},
				"Search category already registered, overwriting",
			);
		}
		this.searchCategories.set(key, normalized);
		this.logger.debug(
			{
				src: "agent",
				agentId: this.agentId,
				searchCategory: normalized.category,
			},
			"Search category registered",
		);
	}

	getSearchCategories(
		options: SearchCategoryEnumerationOptions = {},
	): SearchCategoryRegistration[] {
		const requestedContexts =
			options.contexts && options.contexts.length > 0
				? new Set(options.contexts)
				: null;
		return Array.from(this.searchCategories.values())
			.filter((registration) => {
				if (!options.includeDisabled && registration.enabled === false) {
					return false;
				}
				if (!requestedContexts) {
					return true;
				}
				if (!registration.contexts || registration.contexts.length === 0) {
					return true;
				}
				return registration.contexts.some((context) =>
					requestedContexts.has(context),
				);
			})
			.map(cloneSearchCategoryRegistration)
			.sort((a, b) => a.category.localeCompare(b.category));
	}

	getSearchCategory(
		category: string,
		options: SearchCategoryLookupOptions = {},
	): SearchCategoryRegistration {
		const key = getSearchCategoryKey(category);
		const registration = this.searchCategories.get(key);
		if (!registration) {
			throw new SearchCategoryRegistryError(
				"SEARCH_CATEGORY_NOT_FOUND",
				category,
				`No search category registered for category: ${category}`,
			);
		}
		if (!options.includeDisabled && registration.enabled === false) {
			throw new SearchCategoryRegistryError(
				"SEARCH_CATEGORY_DISABLED",
				registration.category,
				registration.disabledReason
					? `Search category disabled: ${registration.category} (${registration.disabledReason})`
					: `Search category disabled: ${registration.category}`,
			);
		}
		return cloneSearchCategoryRegistration(registration);
	}

	registerSendHandler(source: string, handler: SendHandlerFunction): void {
		if (this.sendHandlers.has(source)) {
			this.logger.warn(
				{ src: "agent", agentId: this.agentId, handlerSource: source },
				"Send handler already registered, overwriting",
			);
		}
		this.sendHandlers.set(source, handler);
		this.messageConnectors.set(source, normalizeMessageConnector(source));
		this.logger.debug(
			{ src: "agent", agentId: this.agentId, handlerSource: source },
			"Send handler registered",
		);
	}

	registerMessageConnector(registration: MessageConnectorRegistration): void {
		const source =
			typeof registration.source === "string" ? registration.source.trim() : "";
		if (!source) {
			throw new Error("Message connector registration requires a source");
		}
		if (this.messageConnectors.has(source) || this.sendHandlers.has(source)) {
			this.logger.warn(
				{ src: "agent", agentId: this.agentId, handlerSource: source },
				"Message connector already registered, overwriting",
			);
		}

		this.registerSendHandler(source, registration.sendHandler);
		this.messageConnectors.set(
			source,
			normalizeMessageConnector(source, registration),
		);
	}

	getMessageConnectors(): MessageConnector[] {
		return Array.from(this.messageConnectors.values())
			.filter((connector) => this.sendHandlers.has(connector.source))
			.map(cloneMessageConnector)
			.sort((a, b) => a.source.localeCompare(b.source));
	}

	async sendMessageToTarget(
		target: TargetInfo,
		content: Content,
	): Promise<void> {
		const handler = this.sendHandlers.get(target.source);
		if (!handler) {
			const errorMsg = `No send handler registered for source: ${target.source}`;
			this.logger.error(
				{ src: "agent", agentId: this.agentId, handlerSource: target.source },
				"Send handler not found",
			);
			throw new Error(errorMsg);
		}
		await handler(this as unknown as IAgentRuntime, target, content);
	}
	async getMemoriesByWorldId(params: {
		worldId: UUID;
		limit?: number;
		tableName?: string;
	}): Promise<Memory[]> {
		return await this.adapter.getMemoriesByWorldId(params);
	}
	async runMigrations(migrationsPaths?: string[]): Promise<void> {
		if (this.adapter?.runMigrations) {
			await this.adapter.runMigrations(migrationsPaths);
		} else {
			this.logger.warn(
				{ src: "agent", agentId: this.agentId },
				"Database adapter does not support migrations",
			);
		}
	}

	async isReady(): Promise<boolean> {
		if (!this.adapter) {
			throw new Error("Database adapter not registered");
		}
		return await this.adapter.isReady();
	}

	// Pairing Methods
	// ===============================

	async getPairingRequestsForChannel(
		channel: PairingChannel,
		agentId: UUID,
	): Promise<PairingRequest[]> {
		const results = await this.adapter.getPairingRequests([
			{ channel, agentId },
		]);
		return results[0]?.requests ?? [];
	}

	async getPairingRequests(
		queries: Array<{ channel: PairingChannel; agentId: UUID }>,
	): Promise<import("./types/database").PairingRequestsResult> {
		return await this.adapter.getPairingRequests(queries);
	}

	async getPairingAllowlistForChannel(
		channel: PairingChannel,
		agentId: UUID,
	): Promise<PairingAllowlistEntry[]> {
		const results = await this.adapter.getPairingAllowlists([
			{ channel, agentId },
		]);
		return results[0]?.entries ?? [];
	}

	async getPairingAllowlists(
		queries: Array<{ channel: PairingChannel; agentId: UUID }>,
	): Promise<import("./types/database").PairingAllowlistsResult> {
		return await this.adapter.getPairingAllowlists(queries);
	}

	// Batch pairing methods
	async createPairingRequests(requests: PairingRequest[]): Promise<UUID[]> {
		return await this.adapter.createPairingRequests(requests);
	}

	async updatePairingRequests(requests: PairingRequest[]): Promise<void> {
		return await this.adapter.updatePairingRequests(requests);
	}

	async deletePairingRequests(ids: UUID[]): Promise<void> {
		return await this.adapter.deletePairingRequests(ids);
	}

	async createPairingAllowlistEntries(
		entries: PairingAllowlistEntry[],
	): Promise<UUID[]> {
		return await this.adapter.createPairingAllowlistEntries(entries);
	}

	async updatePairingAllowlistEntries(
		entries: PairingAllowlistEntry[],
	): Promise<void> {
		return await this.adapter.updatePairingAllowlistEntries(entries);
	}

	async deletePairingAllowlistEntries(ids: UUID[]): Promise<void> {
		return await this.adapter.deletePairingAllowlistEntries(ids);
	}

	// Single-item pairing wrappers
	async createPairingRequest(request: PairingRequest): Promise<UUID> {
		const ids = await this.adapter.createPairingRequests([request]);
		return ids[0];
	}

	async updatePairingRequest(request: PairingRequest): Promise<void> {
		return await this.adapter.updatePairingRequests([request]);
	}

	async deletePairingRequest(id: UUID): Promise<void> {
		return await this.adapter.deletePairingRequests([id]);
	}

	async createPairingAllowlistEntry(
		entry: PairingAllowlistEntry,
	): Promise<UUID> {
		const ids = await this.adapter.createPairingAllowlistEntries([entry]);
		return ids[0];
	}

	async deletePairingAllowlistEntry(id: UUID): Promise<void> {
		return await this.adapter.deletePairingAllowlistEntries([id]);
	}

	// ── Batch pass-throughs required by IDatabaseAdapter ────────────────

	async deleteRoomsByWorldIds(worldIds: UUID[]): Promise<void> {
		return this.adapter.deleteRoomsByWorldIds(worldIds);
	}

	async getRoomsByWorlds(
		worldIds: UUID[],
		limit?: number,
		offset?: number,
	): Promise<Room[]> {
		return this.adapter.getRoomsByWorlds(worldIds, limit, offset);
	}
}
