/** Owns one agent’s public runtime identity, registries, settings, and initialization. Model dispatch, structured prompts, provider composition, service startup, embeddings, and data mutations have dedicated owners that share this runtime’s state. Settings remain agent-scoped, and embedding width stays pinned to the provider that passed the boot probe. */

import { RuntimeDataMutations } from "./runtime/data-mutations.js";
import {
	EmbeddingDimensionProbeError,
	RuntimeEmbeddings,
} from "./runtime/embeddings.js";
import {
	RuntimeServiceLifecycle,
	type ServicePromiseHandler,
	type ServiceRejecter,
	type ServiceResolver,
} from "./runtime/service-lifecycle.js";

export {
	EMBEDDING_STORE_ACCEPT_MODEL_SETTING,
	EMBEDDING_STORE_IDENTITY_CACHE_KEY,
	EmbeddingDimensionProbeError,
	type EmbeddingProbeAttempt,
	type EmbeddingStoreIdentity,
} from "./runtime/embeddings.js";

import { RuntimeModelDispatch } from "./runtime/model-dispatch/dispatcher.js";
import {
	type ResolvedModelRegistration,
	TEXT_GENERATION_MODEL_KEYS,
} from "./runtime/model-dispatch/policy.js";

export {
	NoModelProviderConfiguredError,
	readReasoningTokensFromResponse,
} from "./runtime/model-dispatch/policy.js";

import { RuntimePipelineHooks } from "./runtime/pipeline-hooks.js";
import { ProviderStateComposer } from "./runtime/state-composition/composer.js";

export { calculateProviderOverlaps } from "./runtime/state-composition/provider-execution.js";

import { v4 as uuidv4 } from "uuid";
import {
	withCanonicalActionDocs,
	withCanonicalProviderDocs,
} from "./action-docs";
import { ensureConnection as ensureConnectionStandalone } from "./connection";
import { registerConnectorSourceDefinitions } from "./connectors";
import { deriveKnownSecrets } from "./constants/secrets";
import {
	validateQueryEntitiesPagination,
	validateTaskQueryPagination,
} from "./database";
import { InMemoryDatabaseAdapter } from "./database/inMemoryAdapter";
import {
	mergeWorldMetadataForLegacyWrite,
	worldMetadataValueEquals,
} from "./database/world-metadata-cas";
import { ElizaError, type ReportedError, toElizaError } from "./errors";
import {
	type CapabilityConfig,
	type CapabilitySettingFlags,
	createBasicCapabilitiesPlugin,
	resolveCapabilityConfig,
} from "./features/basic-capabilities/index";
import { createLogger } from "./logger";
import { installRuntimePluginLifecycle } from "./plugin-lifecycle";
import { createCoreSecurityHooksPlugin } from "./plugins/core-security-hooks";
import {
	getNativeRuntimeFeaturePlugin,
	type NativeRuntimeFeature,
	nativeRuntimeFeatureDefaults,
	nativeRuntimeFeaturePluginNames,
	resolveNativeRuntimeFeatureFromPluginName,
	resolveNativeRuntimeFeatureFromServiceType,
} from "./plugins/native-features";
import { resolveActionEventWorldId } from "./runtime/action-event-world";
import { settleActionHandler } from "./runtime/action-handler-settlement";
import { getActionRolePolicyWarnings } from "./runtime/action-role-policy";
import { runWithActionRoutingContext } from "./runtime/action-routing-context";
import { BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS } from "./runtime/builtin-field-evaluators";
import { ChatPreHandlerRegistry } from "./runtime/chat-pre-handler-registry";
import { ContextRegistry } from "./runtime/context-registry";
import { DEFAULT_CONTEXT_DEFINITIONS } from "./runtime/default-contexts";
import type { ResponseHandlerEvaluator } from "./runtime/response-handler-evaluators";
import type { ResponseHandlerFieldEvaluator } from "./runtime/response-handler-field-evaluator";
import { ResponseHandlerFieldRegistry } from "./runtime/response-handler-field-registry";
import { RoomHandlerQueue } from "./runtime/room-handler-queue";
import { ShortcutRegistry } from "./runtime/shortcut-registry";
import { SingleFlightMemo } from "./runtime/single-flight-memo";
import { ActivePromptTraces } from "./runtime/structured-prompt/active-traces";
import { StructuredPromptExecutor } from "./runtime/structured-prompt/executor";
import {
	buildCanonicalSystemPrompt,
	resolveEffectiveSystemPrompt,
	textFromChatMessageContent,
} from "./runtime/system-prompt";
import { TurnControllerRegistry } from "./runtime/turn-controller";
import { BM25 } from "./search";
import {
	locateConfiguredSecretFragmentTaint,
	type SecretFragment,
	type SecretFragmentTaintProfile,
} from "./security/fragment-redaction.js";
import {
	authorizeOwnerExclusiveDisclosure,
	CompositeEntityRecognizer,
	collectPiiPromptText,
	DEFAULT_PSEUDONYM_BLOCKLIST,
	PII_ENTITY_RECOGNIZER_SERVICE,
	PII_SWAP_DISABLED_KINDS_SETTING,
	PII_SWAP_ENABLED_SETTING,
	PII_SWAP_EXEMPT_VALUES_SETTING,
	type PiiEntityRecognizer,
	type PiiEntityRecognizerService,
	PRIVACY_DENIED_TEXT,
	PseudonymSession,
	parsePiiSwapList,
	RegexEntityRecognizer,
	revalidateOwnerExclusiveDisclosure,
} from "./security/index.js";
import { MIN_SECRET_LENGTH, redactWithSecrets } from "./security/redact.js";
import {
	parseSecretSwapExemptValues,
	SECRET_SWAP_ENABLED_SETTING,
	SECRET_SWAP_EXEMPT_VALUES_SETTING,
	SecretSwapSession,
} from "./security/secret-swap";
import { DefaultMessageService } from "./services/message";
import {
	drainPostDeliveryTasks,
	pendingPostDeliveryTaskCount,
} from "./services/post-delivery-task-tracker.ts";
import type { TaskService } from "./services/task";
import type { ToolPolicyService } from "./services/tool-policy";
import { decryptSecret, getSalt } from "./settings";
import {
	getTrajectoryContext,
	invalidateTurnMemoPrefix,
	setTrajectoryPurpose,
} from "./trajectory-context";
import type { SendHandlerFunction } from "./types";
import {
	type AccessContext,
	type Action,
	type ActionMode,
	type ActionResult,
	type Agent,
	type AppendConnectorAccountAuditEventParams,
	assertPublicRouteIntent,
	ChannelType,
	type Character,
	type Component,
	type ConnectorAccountAuditEventRecord,
	type ConnectorAccountCredentialRefRecord,
	type ConnectorAccountRecord,
	type ConsumeOAuthFlowStateParams,
	type ControlMessage,
	type CreateOAuthFlowStateParams,
	type DeleteConnectorAccountCredentialRefsParams,
	type DeleteConnectorAccountParams,
	type DeleteOAuthFlowStateParams,
	type Entity,
	type EventHandler,
	type EventPayload,
	type EventPayloadMap,
	EventType,
	type GenerateTextOptions,
	type GenerateTextParams,
	type GenerateTextResult,
	type GetConnectorAccountCredentialRefParams,
	type GetConnectorAccountParams,
	type GetOAuthFlowStateParams,
	type HandlerCallback,
	type IAgentRuntime,
	type IDatabaseAdapter,
	type IMessagingAdapter,
	type JsonValue,
	type ListConnectorAccountCredentialRefsParams,
	type ListConnectorAccountsParams,
	type Log,
	type LogBody,
	type Memory,
	type MemoryMetadata,
	type MessageSearchHit,
	type Metadata,
	type ModelHandler,
	type ModelParamsMap,
	type ModelRegistrationInfo,
	type ModelRegistrationMetadata,
	type ModelResultMap,
	ModelType,
	type ModelTypeName,
	type OAuthFlowRecord,
	type PairingAllowlistEntry,
	type PairingChannel,
	type PairingRequest,
	type Participant,
	type PatchOp,
	type Plugin,
	type PluginOwnership,
	type Provider,
	type RegisteredEvaluator,
	type Relationship,
	type RemotePluginInstallOptions,
	type RemotePluginInstanceHandle,
	type Room,
	type Route,
	type RuntimeEventStorage,
	type RuntimeSettings,
	type RuntimeStopOptions,
	type Service,
	type ServiceClass,
	ServiceType,
	type ServiceTypeName,
	type SetConnectorAccountCredentialRefParams,
	type State,
	type Task,
	type TaskWorker,
	type UpdateOAuthFlowStateParams,
	type UpsertConnectorAccountParams,
	type UUID,
	type World,
} from "./types";
import type {
	ChatPreHandler,
	ChatPreHandlerContext,
	ChatPreHandlerResult,
} from "./types/chat-pre-handler";
import type { AgentContext } from "./types/contexts";
import type { IMessageService } from "./types/message-service";
import type { PromptOptimizationRuntimeHooks } from "./types/prompt-optimization-hooks";
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
import type { ShortcutDefinition } from "./types/shortcut";
import type { ToolPolicyConfig, ToolProfileId } from "./types/tools";
import { stringToUuid, validateUuid } from "./utils";
import { parseBooleanValue } from "./utils/boolean";
import { createHash } from "./utils/crypto-compat";
import { getNumberEnv } from "./utils/environment";
import { PromptBatcher, PromptDispatcher } from "./utils/prompt-batcher";
import { resolvePromptBatcherSettings } from "./utils/prompt-batcher/config";
import { getOptimizationRootDir } from "./utils/state-dir";
import { isPlainObject } from "./utils/type-guards";

export {
	mergeProviderOptionsWithCachePlan,
	resolveDefaultOutputFormat,
	resolveDynamicPromptStreamFields,
} from "./runtime/structured-prompt/options.js";

import { RuntimeConnectorRegistry } from "./runtime/connector-registry.js";

const environmentSettings: RuntimeSettings = {};
const DEFAULT_SERVICE_START_SHUTDOWN_TIMEOUT_MS = 1_000;
const DEFAULT_FAST_SERVICE_STOP_TIMEOUT_MS = 500;
const DEFAULT_FAST_ROOM_DRAIN_TIMEOUT_MS = 500;
// Page size for the getAllMemories partition sweep. The sweep must be complete
// — the media GC builds its referenced-set from it — so it paginates until a
// short page instead of issuing one bounded read that silently truncates.
const GET_ALL_MEMORIES_PAGE_SIZE = 10_000;

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

function getServiceClassLabel(serviceClass: ServiceClass): string {
	return (
		(serviceClass as { name?: string }).name ||
		serviceClass.constructor.name ||
		"anonymous service class"
	);
}

function isMessagingAdapter(
	adapter: IDatabaseAdapter,
): adapter is IDatabaseAdapter & IMessagingAdapter {
	const candidate = adapter as Partial<IMessagingAdapter>;
	return (
		typeof candidate.createMessageServer === "function" &&
		typeof candidate.createChannel === "function" &&
		typeof candidate.createMessage === "function"
	);
}

function resolveShutdownTimeoutMs(envName: string, fallbackMs: number): number {
	const raw = process.env[envName];
	const parsed = Number(raw);
	if (raw?.trim() === "0") return 0;
	if (Number.isFinite(parsed) && parsed > 0) return parsed;
	return fallbackMs;
}

function timeoutAfter(ms: number): Promise<"timeout"> {
	return new Promise((resolve) => {
		setTimeout(() => resolve("timeout"), ms);
	});
}

async function settleBeforeTimeout(
	work: Promise<void>,
	timeoutMs: number,
): Promise<boolean> {
	if (timeoutMs <= 0) return false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			work.then(() => true),
			new Promise<false>((resolve) => {
				timer = setTimeout(() => resolve(false), timeoutMs);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

/**
 * Configuration keys that operators commonly place under `settings.secrets`
 * but that carry no credential; their values are safe in prompts and must not
 * be redacted literally. Closed set on purpose: any other key under `secrets`
 * keeps the literal redaction.
 */
const NON_CREDENTIAL_SECRET_KEYS: ReadonlySet<string> = new Set([
	"TIMEZONE",
	"TZ",
	"LOCALE",
	"LANGUAGE",
	"LANG",
]);

export class AgentRuntime implements IAgentRuntime {
	private readonly dataMutations = new RuntimeDataMutations(this, {
		invalidateTurnEntityDetails: (...args) =>
			this.invalidateTurnEntityDetails(...args),
		invalidateTurnIdentityClusters: (...args) =>
			this.invalidateTurnIdentityClusters(...args),
		getSecretsForRedaction: (...args) => this.getSecretsForRedaction(...args),
		roomMessagesMemo: () => this.roomMessagesMemo,
		roomReadMemo: () => this.roomReadMemo,
	});
	private readonly serviceLifecycle = new RuntimeServiceLifecycle(this, {
		stopRequested: () => this.stopRequested,
		isNativeFeatureServiceEnabled: (...args) =>
			this.isNativeFeatureServiceEnabled(...args),
		resolveServiceTypeAlias: (...args) => this.resolveServiceTypeAlias(...args),
		initResolver: () => this.initResolver,
		serviceTypes: () => this.serviceTypes,
		serviceInstancesByClass: () => this.serviceInstancesByClass,
		startingServiceClasses: () => this.startingServiceClasses,
		failedServiceClasses: () => this.failedServiceClasses,
		startingServices: () => this.startingServices,
		serviceRegistrationStatus: () => this.serviceRegistrationStatus,
		servicePromiseHandlers: () => this.servicePromiseHandlers,
		servicePromises: () => this.servicePromises,
		stopped: () => this.stopped,
	});
	private readonly embeddings = new RuntimeEmbeddings(this, {
		resolveModelRegistrations: (...args) =>
			this.resolveModelRegistrations(...args),
		fetch: (...args) => this.fetch(...args),
	});
	private readonly modelDispatch = new RuntimeModelDispatch(this, {
		models: () => this.models,
		pinnedEmbeddingProvider: () => this.embeddings.getPinnedProvider(),
		currentRoomId: () => this.currentRoomId,
		isSecretSwapEnabled: (...args) => this.isSecretSwapEnabled(...args),
		isPiiSwapEnabled: (...args) => this.isPiiSwapEnabled(...args),
		hooksForPhase: (...args) => this.hooksForPhase(...args),
		invokePipelineHooks: (...args) => this.invokePipelineHooks(...args),
		attachEffectiveSystemPrompt: (...args) =>
			this.attachEffectiveSystemPrompt(...args),
		createSecretSwapSession: (...args) => this.createSecretSwapSession(...args),
		createPiiSwapSession: (...args) => this.createPiiSwapSession(...args),
		collectPromptText: (...args) => this.collectPromptText(...args),
		initResolver: () => this.initResolver,
		_ensureServiceStarted: (...args) => this._ensureServiceStarted(...args),
		buildRuntimeSystemPrompt: (...args) =>
			this.buildRuntimeSystemPrompt(...args),
		getFirstUserPromptFromMessages: (...args) =>
			this.getFirstUserPromptFromMessages(...args),
	});
	private readonly pipelineHooks = new RuntimePipelineHooks(this);
	// Plugin lifecycle and host send-availability probes share this legacy map.
	private sendHandlers = new Map<string, SendHandlerFunction>();
	readonly #connectorRegistry = new RuntimeConnectorRegistry(
		this,
		this.sendHandlers,
	);
	private readonly promptTraces = new ActivePromptTraces();
	private readonly structuredPrompts = new StructuredPromptExecutor(
		this,
		this.promptTraces,
	);
	/** The runtime invokes request preparation before each resolved model handler. */
	readonly supportsModelAttemptPreparation = true;
	#conversationLength = 100;
	readonly agentId: UUID;
	readonly runtimeInstanceId: UUID;
	readonly character: Character;
	public adapter!: IDatabaseAdapter;
	static #anonymousAgentCounter = 0;
	readonly actions: Action[] = [];
	readonly providers: Provider[] = [];
	readonly evaluators: RegisteredEvaluator[] = [];
	readonly responseHandlerEvaluators: ResponseHandlerEvaluator[] = [];
	readonly responseHandlerFieldEvaluators: ResponseHandlerFieldEvaluator[] = [];
	/** Pre-LLM action shortcuts (#8791), registered from `Plugin.shortcuts`. */
	readonly shortcutRegistry = new ShortcutRegistry();
	/** Chat pre-handlers, registered from `Plugin.chatPreHandlers`. */
	readonly chatPreHandlerRegistry = new ChatPreHandlerRegistry();
	readonly responseHandlerFieldRegistry = new ResponseHandlerFieldRegistry();
	readonly turnControllers = new TurnControllerRegistry();
	readonly roomHandlerQueue = new RoomHandlerQueue({
		onListenerError: (error, event) =>
			this.reportError("AgentRuntime.roomHandlerQueue.listener", error, {
				event,
				diagnosticOnly: true,
			}),
	});
	readonly plugins: Plugin[] = [];
	/**
	 * Per-runtime context registry seeded with first-party context definitions
	 * during `_initializeCore`. Plugins may register additional contexts before
	 * Stage 1 runs.
	 */
	readonly contexts: ContextRegistry = new ContextRegistry([]);
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
	private readonly providerState = new ProviderStateComposer(this, {
		hasProviderSelectionHooks: () =>
			this.hooksForPhase("compose_state_providers").length > 0,
		ensureServiceStarted: (type) => this._ensureServiceStarted(type),
		isStopping: () => this.stopRequested,
	});
	// Turn-scoped single-flight read coalescing (see runtime/single-flight-memo).
	// A Stage-1 compose issues getRoom 4x (RECENT_MESSAGES / CHARACTER /
	// PLATFORM_* / WORLD) and 3 overlapping room messages-scans (RECENT_MESSAGES
	// at conversationLength, FACTS at 10, ATTACHMENTS at ≤50); on a serializing
	// store each duplicate is a full extra round-trip. The 1s TTL comfortably
	// covers one compose fan-out while bounding staleness from out-of-process
	// writers; in-process correctness comes from the mutation wrappers below
	// invalidating the relevant key (createMemory → roomMessagesMemo,
	// room mutators → roomReadMemo), never from the TTL.
	private static readonly READ_MEMO_TTL_MS = 1_000;
	private static readonly READ_MEMO_MAX_ENTRIES = 1_000;
	// Floor for the coalesced messages window so every standard compose-time
	// consumer (conversationLength, FACTS' 10, ATTACHMENTS' 50) is served by
	// one superset fetch sliced per caller.
	private static readonly ROOM_MESSAGES_MEMO_MIN_WINDOW = 50;
	private readonly roomReadMemo = new SingleFlightMemo<Room | null>(
		AgentRuntime.READ_MEMO_TTL_MS,
		AgentRuntime.READ_MEMO_MAX_ENTRIES,
	);
	private readonly roomMessagesMemo = new SingleFlightMemo<Memory[], number>(
		AgentRuntime.READ_MEMO_TTL_MS,
		AgentRuntime.READ_MEMO_MAX_ENTRIES,
	);
	private invalidateTurnEntityDetails(): void {
		invalidateTurnMemoPrefix(`entity-details:${this.agentId}:`);
	}
	private invalidateTurnIdentityClusters(): void {
		invalidateTurnMemoPrefix(`identity-cluster:${this.agentId}:`);
	}
	readonly fetch = fetch;
	promptBatcher: PromptBatcher;
	services = new Map<ServiceTypeName, Service[]>();
	private serviceTypes = new Map<ServiceTypeName, ServiceClass[]>();

	/**
	 * Bounded ring of failures surfaced via {@link reportError} (#12263). Read
	 * by the RECENT_ERRORS provider and the owner-escalation threshold. Oldest
	 * entries drop once the cap is exceeded.
	 */
	private reportedErrors: ReportedError[] = [];
	private static readonly REPORTED_ERROR_RING_CAP = 200;
	/** Re-entrancy latch so a failure inside reportError stays warn-only (J7). */
	private inReportError = false;
	models = new Map<string, ModelHandler[]>();
	routes: Route[] = [];
	private secretRedactionProfileSignature = "";
	private secretRedactionProfileRevision = 0;
	private taskWorkers = new Map<string, TaskWorker>();
	private searchCategories = new Map<string, SearchCategoryRegistration>();
	private eventHandlers: Map<string, Array<(data: EventPayload) => void>> =
		new Map();
	/** Optional DPE-side prompt optimization I/O (merge, registry, baseline/failure traces). */
	private promptOptimizationHooks: PromptOptimizationRuntimeHooks | null = null;

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
	/** Full settlement of each type's current parallel startup set, used by teardown. */
	private startingServices = new Map<string, Promise<Service | null>>();
	private startingServiceClasses = new Map<ServiceClass, Promise<Service>>();
	private serviceInstancesByClass = new Map<ServiceClass, Service>();
	private failedServiceClasses = new Set<ServiceClass>();
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
	public messageService: IMessageService | null = null; // Lazily initialized
	public companionUrl?: string;
	/** Set when stop() has completed service teardown. */
	private stopped = false;
	/** Set permanently at the first stop request, before any drain can yield. */
	private stopRequested = false;
	/** Records an initialization attempt that released waiters by failing. */
	private initializationFailed = false;
	/** Typed cancellation boundary for deferred plugin/service startup. */
	private readonly stopController = new AbortController();
	/** The active stop attempt; concurrent callers await the same teardown. */
	private stopPromise: Promise<void> | null = null;

	constructor(opts: {
		conversationLength?: number;
		agentId?: UUID;
		/** Host-persisted installation identity. Omitted only by ephemeral/test runtimes. */
		runtimeInstanceId?: UUID;
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
		enableDocuments?: boolean;
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
				documents: [],
				plugins: [],
				secrets: {},
			} as Character;
			this.isAnonymousCharacter = true;
		}

		// Resolve the full capability config once, at construction: explicit
		// constructor options win, and any option left unspecified falls back to
		// the matching character setting. initialize() then builds the
		// basic-capabilities plugin from this config, so registerPlugin needs no
		// name-keyed branch to re-derive it. Anonymous characters have no character
		// provider to inject, so skipCharacterProvider is forced on.
		this.capabilityOptions = resolveCapabilityConfig(
			{
				disableBasic: opts.disableBasicCapabilities,
				enableExtended: opts.enableExtendedCapabilities,
				advancedCapabilities: opts.advancedCapabilities,
				skipCharacterProvider: this.isAnonymousCharacter,
				enableAutonomy: opts.enableAutonomy,
				enableTrust: opts.enableTrust,
				enableSecretsManager: opts.enableSecretsManager,
				enablePluginManager: opts.enablePluginManager,
			},
			character.settings as CapabilitySettingFlags | undefined,
		);
		this.nativeFeatureOptions = {
			documents: opts.enableDocuments,
			relationships: opts.enableRelationships,
			trajectories: opts.enableTrajectories,
			// Character flags are the explicit override for these two features
			// (default false in the registry); build-character-config surfaces
			// them as flags deliberately.
			advancedPlanning: character.advancedPlanning,
			advancedMemory: character.advancedMemory,
		};
		// Generate deterministic UUID from character name
		// Falls back to random UUID only if no character name is provided
		this.agentId =
			character.id ?? opts.agentId ?? stringToUuid(character.name ?? uuidv4());
		this.runtimeInstanceId = opts.runtimeInstanceId ?? (uuidv4() as UUID);
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
			const parsedConversationLength = parseInt(
				String(opts.settings.CONVERSATION_LENGTH),
				10,
			);
			this.#conversationLength = Number.isNaN(parsedConversationLength)
				? 100
				: parsedConversationLength;
		} else {
			this.#conversationLength =
				getNumberEnv("CONVERSATION_LENGTH", 100) ?? 100;
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
		const promptBatcherSettings = resolvePromptBatcherSettings();
		this.promptBatcher = new PromptBatcher(
			this,
			new PromptDispatcher(promptBatcherSettings.dispatcher),
			promptBatcherSettings.batcher,
		);

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
			serviceClass.allowsMultiple === true ||
			existingServiceClasses.some(
				(existing) => existing.allowsMultiple === true,
			)
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

	private nativeRuntimeFeatureSettingKey(
		feature: NativeRuntimeFeature,
	): string {
		return `ENABLE_${feature.toUpperCase()}`;
	}

	private resolveNativeFeatureEnabled(feature: NativeRuntimeFeature): boolean {
		const explicit = this.nativeFeatureOptions[feature];
		if (explicit !== undefined) {
			return explicit;
		}

		const settingKey = this.nativeRuntimeFeatureSettingKey(feature);
		const settingValue = parseBooleanValue(this.getSetting(settingKey));
		if (settingValue !== undefined) {
			return settingValue;
		}

		return nativeRuntimeFeatureDefaults[feature];
	}

	private isSecretSwapEnabled(): boolean {
		return (
			parseBooleanValue(this.getSetting(SECRET_SWAP_ENABLED_SETTING)) ?? false
		);
	}

	private createSecretSwapSession(): SecretSwapSession {
		const toSecretStrings = (
			values: Record<string, unknown> | undefined,
		): Record<string, string | undefined> => {
			const result: Record<string, string | undefined> = {};
			const entries = values ? Object.entries(values) : [];
			for (const [key, value] of entries) {
				if (typeof value === "string") {
					result[key] = value;
				}
			}
			return result;
		};
		const settingsSecrets =
			this.character.settings &&
			typeof this.character.settings === "object" &&
			"secrets" in this.character.settings &&
			this.character.settings.secrets &&
			typeof this.character.settings.secrets === "object"
				? toSecretStrings(
						this.character.settings.secrets as Record<string, unknown>,
					)
				: undefined;
		// Registry/config-derived catalog (#10469): seed every secret-bearing env
		// value so a plugin's `FOO_API_KEY` is swapped even when it never appears
		// in a recognised inline token shape. Character secrets win on conflict.
		const envSecrets = deriveKnownSecrets(
			process.env as Record<string, string | undefined>,
		);
		return new SecretSwapSession({
			knownSecrets: {
				...envSecrets,
				...settingsSecrets,
				...toSecretStrings(this.character.secrets),
			},
			exemptValues: parseSecretSwapExemptValues(
				this.getSetting(SECRET_SWAP_EXEMPT_VALUES_SETTING),
			),
		});
	}

	private isPiiSwapEnabled(): boolean {
		return (
			parseBooleanValue(this.getSetting(PII_SWAP_ENABLED_SETTING)) ?? false
		);
	}

	/**
	 * Build the turn's PII pseudonymization session (#10469 / #7007). The
	 * recognizer is the composite of the runtime's built-in regex recognizer
	 * (street addresses) and — if a plugin registered the
	 * `PII_ENTITY_RECOGNIZER_SERVICE` — the local NER model (person/org/location).
	 * With no model plugin present the layer runs regex-only: degraded coverage,
	 * but still never leaks what it does detect. The agent's own name is added to
	 * the blocklist so the model's identity is never pseudonymized.
	 */
	private createPiiSwapSession(): PseudonymSession {
		const recognizers: PiiEntityRecognizer[] = [new RegexEntityRecognizer()];
		const nerService = this.getService(PII_ENTITY_RECOGNIZER_SERVICE) as
			| (Service & Partial<PiiEntityRecognizerService>)
			| null;
		const nerRecognizer = nerService?.getRecognizer?.() ?? null;
		if (nerRecognizer) recognizers.push(nerRecognizer);

		const blocklist = [
			...DEFAULT_PSEUDONYM_BLOCKLIST,
			...(this.character.name ? [this.character.name] : []),
			...parsePiiSwapList(this.getSetting(PII_SWAP_EXEMPT_VALUES_SETTING)),
		];
		return new PseudonymSession({
			recognizer: new CompositeEntityRecognizer(recognizers, { blocklist }),
			blocklist,
			disabledKinds: parsePiiSwapList(
				this.getSetting(PII_SWAP_DISABLED_KINDS_SETTING),
			),
		});
	}

	/** Flatten every string leaf of the model params plus the system prompt into
	 * one text blob for the PII recognizer to scan. Uses the shared bounded
	 * descriptor-safe PII walker so cyclic / over-deep / sparse / Proxy graphs
	 * fail closed with {@link PII_PSEUDONYM_UNBOUNDED} before `learn`. */
	private collectPromptText(
		params: unknown,
		systemPrompt: string | undefined,
	): string {
		return collectPiiPromptText(params, systemPrompt);
	}

	private hasNativeRuntimeFeature(feature: NativeRuntimeFeature): boolean {
		const pluginName = nativeRuntimeFeaturePluginNames[feature];
		return this.plugins.some((plugin) => plugin.name === pluginName);
	}

	private resolveNativeFeatureForServiceType(
		serviceType: ServiceTypeName | string,
	): NativeRuntimeFeature | null {
		return resolveNativeRuntimeFeatureFromServiceType(serviceType);
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

		this.setSetting(this.nativeRuntimeFeatureSettingKey(feature), enabled);
	}

	async enableDocuments(): Promise<void> {
		await this.setNativeRuntimeFeatureEnabled("documents", true);
	}

	async disableDocuments(): Promise<void> {
		await this.setNativeRuntimeFeatureEnabled("documents", false);
	}

	isDocumentsEnabled(): boolean {
		return this.hasNativeRuntimeFeature("documents");
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
	private hooksForPhase(
		...args: Parameters<RuntimePipelineHooks["hooksForPhase"]>
	): ReturnType<RuntimePipelineHooks["hooksForPhase"]> {
		return this.pipelineHooks.hooksForPhase(...args);
	}
	private upsertPipelineHook(
		...args: Parameters<RuntimePipelineHooks["upsertPipelineHook"]>
	): ReturnType<RuntimePipelineHooks["upsertPipelineHook"]> {
		return this.pipelineHooks.upsertPipelineHook(...args);
	}
	private invokePipelineHooks(
		...args: Parameters<RuntimePipelineHooks["invokePipelineHooks"]>
	): ReturnType<RuntimePipelineHooks["invokePipelineHooks"]> {
		return this.pipelineHooks.invokePipelineHooks(...args);
	}
	registerPipelineHook(
		...args: Parameters<RuntimePipelineHooks["registerPipelineHook"]>
	): ReturnType<RuntimePipelineHooks["registerPipelineHook"]> {
		return this.pipelineHooks.registerPipelineHook(...args);
	}
	unregisterPipelineHook(
		...args: Parameters<RuntimePipelineHooks["unregisterPipelineHook"]>
	): ReturnType<RuntimePipelineHooks["unregisterPipelineHook"]> {
		return this.pipelineHooks.unregisterPipelineHook(...args);
	}
	applyPipelineHooks(
		...args: Parameters<RuntimePipelineHooks["applyPipelineHooks"]>
	): ReturnType<RuntimePipelineHooks["applyPipelineHooks"]> {
		return this.pipelineHooks.applyPipelineHooks(...args);
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
		const assertRuntimeActive = (): void => {
			if (!this.stopRequested) return;
			throw new ElizaError(
				`Cannot register plugin "${plugin.name}" after runtime stop was requested`,
				{
					code: "RUNTIME_STOPPED_DURING_PLUGIN_REGISTRATION",
					severity: "ephemeral",
					context: { agentId: this.agentId, plugin: plugin.name },
				},
			);
		};
		assertRuntimeActive();

		// Check if a plugin with the same name is already registered.
		const existingPlugin = this.plugins.find((p) => p.name === plugin.name);
		if (existingPlugin) {
			this.logger.warn(
				{ src: "agent", agentId: this.agentId, plugin: plugin.name },
				"Plugin already registered, skipping",
			);
			return;
		}

		// Registration is purely structural: whatever plugin the caller declares —
		// including basic-capabilities, already built from the resolved capability
		// config by initialize() — is registered as-is. No name-keyed branch
		// re-derives or rebuilds a specific plugin; capability configuration is
		// owned by the declaring plugin (via resolveCapabilityConfig +
		// createBasicCapabilitiesPlugin), not by this method.
		const pluginToRegister = plugin;
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
			await pluginToRegister.init(config, this);
			assertRuntimeActive();
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
			// Delegate collision/override policy to registerAction() so a single
			// authority (resolveComponentCollision) decides first-wins vs declared
			// override and emits the observable WARN. Pre-filtering here would
			// silently swallow duplicates before that policy could see them.
			for (const action of pluginToRegister.actions) {
				this.registerAction(action);
			}
		}
		if (pluginToRegister.providers) {
			for (const provider of pluginToRegister.providers) {
				if (provider.registerByDefault === false) {
					this.logger.debug(
						{
							src: "agent",
							agentId: this.agentId,
							provider: provider.name,
							plugin: pluginToRegister.name,
						},
						"Skipping plugin provider with registerByDefault=false",
					);
					continue;
				}
				// Collision/override policy owned by registerProvider().
				this.registerProvider(provider);
			}
		}
		if (pluginToRegister.evaluators) {
			// Collision/override policy owned by registerEvaluator().
			for (const evaluator of pluginToRegister.evaluators) {
				this.registerEvaluator(evaluator);
			}
		}
		if (pluginToRegister.shortcuts) {
			this.registerShortcuts(pluginToRegister.shortcuts);
		}
		if (pluginToRegister.chatPreHandlers) {
			this.registerChatPreHandlers(pluginToRegister.chatPreHandlers);
		}
		if (pluginToRegister.responseHandlerEvaluators) {
			const existingResponseHandlerEvaluatorNames = new Set(
				this.responseHandlerEvaluators.map((evaluator) => evaluator.name),
			);
			for (const evaluator of pluginToRegister.responseHandlerEvaluators) {
				if (existingResponseHandlerEvaluatorNames.has(evaluator.name)) {
					this.logger.debug(
						{
							src: "agent",
							agentId: this.agentId,
							evaluator: evaluator.name,
							plugin: pluginToRegister.name,
						},
						"Skipping duplicate plugin response-handler evaluator",
					);
					continue;
				}
				this.registerResponseHandlerEvaluator(evaluator);
				existingResponseHandlerEvaluatorNames.add(evaluator.name);
			}
		}
		if (pluginToRegister.responseHandlerFieldEvaluators) {
			const existingFieldNames = new Set(
				this.responseHandlerFieldEvaluators.map((evaluator) => evaluator.name),
			);
			for (const evaluator of pluginToRegister.responseHandlerFieldEvaluators) {
				if (existingFieldNames.has(evaluator.name)) {
					this.logger.debug(
						{
							src: "agent",
							agentId: this.agentId,
							evaluator: evaluator.name,
							plugin: pluginToRegister.name,
						},
						"Skipping duplicate plugin response-handler field evaluator",
					);
					continue;
				}
				this.registerResponseHandlerFieldEvaluator(evaluator);
				existingFieldNames.add(evaluator.name);
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
					pluginToRegister.modelMetadata?.[modelType],
				);
			}
		}
		if (pluginToRegister.connectorSources) {
			registerConnectorSourceDefinitions(
				pluginToRegister.connectorSources,
				pluginToRegister.name,
			);
		}
		if (pluginToRegister.routes) {
			for (const route of pluginToRegister.routes) {
				assertPublicRouteIntent(route, pluginToRegister.name);
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
			const serviceTypesToStart = new Set<ServiceTypeName>();
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
				serviceTypesToStart.add(serviceType);
			}

			// Register every sibling implementation before startup takes a class
			// snapshot, otherwise the first declaration can fail before a later
			// implementation of the same service type is visible.
			for (const serviceType of serviceTypesToStart) {
				void this.serviceLifecycle.startServiceEagerly(
					serviceType,
					pluginToRegister.name,
				);
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
			assertRuntimeActive();
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
	async stop(options?: RuntimeStopOptions): Promise<void> {
		if (this.stopPromise) {
			this.logger.debug(
				{ src: "agent", agentId: this.agentId },
				"Runtime stop already in progress",
			);
			await this.stopPromise;
			return;
		}
		if (this.stopped) {
			this.logger.debug(
				{ src: "agent", agentId: this.agentId },
				"Runtime already stopped",
			);
			return;
		}

		let resolveStop!: () => void;
		let rejectStop!: (reason?: unknown) => void;
		const stopAttempt = new Promise<void>((resolve, reject) => {
			resolveStop = resolve;
			rejectStop = reject;
		});
		// Publish single-flight ownership before invoking a service hook. A hook is
		// synchronous but may itself request shutdown; that reentrant call must join
		// this attempt instead of starting a second teardown.
		this.stopPromise = stopAttempt;
		if (!this.stopRequested) {
			this.stopRequested = true;
			this.stopController.abort(
				new DOMException("Runtime stop requested", "AbortError"),
			);
			// Freeze connector/service ingress before the first shutdown await. Without
			// this phase, a gateway delivery can begin a new turn while the runtime is
			// already waiting for its room-owner drain, behind the eventual service-stop
			// snapshot. Hooks are synchronous by contract to make that boundary atomic.
			for (const [serviceType, services] of this.services) {
				for (const service of services) {
					try {
						service?.prepareStop?.("runtime-stop");
					} catch (err) {
						// error-policy:J6 admission preparation is best-effort so one broken
						// connector cannot deny every service its teardown opportunity.
						this.logger.warn(
							{
								src: "agent",
								agentId: this.agentId,
								serviceType,
								error: err instanceof Error ? err.message : String(err),
							},
							"Service prepareStop() threw; continuing",
						);
					}
				}
			}
		}

		void this._stopAfterAdmissionCordon(options).then(resolveStop, rejectStop);
		try {
			await stopAttempt;
		} finally {
			if (this.stopPromise === stopAttempt) {
				this.stopPromise = null;
			}
		}
	}

	private async _stopAfterAdmissionCordon(
		options?: RuntimeStopOptions,
	): Promise<void> {
		this.roomHandlerQueue.closeAdmissions("runtime-stop");
		this.turnControllers.abortAllTurns("runtime-stop");
		const fast = options?.fast === true;
		const roomDrain = this.roomHandlerQueue.quiesceAll();
		if (fast && this.roomHandlerQueue.pendingTotal() > 0) {
			const timeoutMs = resolveShutdownTimeoutMs(
				"ELIZA_FAST_ROOM_DRAIN_TIMEOUT_MS",
				DEFAULT_FAST_ROOM_DRAIN_TIMEOUT_MS,
			);
			if (!(await settleBeforeTimeout(roomDrain, timeoutMs))) {
				const error = new ElizaError(
					"Fast runtime shutdown timed out while a room owner was still active",
					{
						code: "RUNTIME_FAST_STOP_ROOM_DRAIN_TIMEOUT",
						context: {
							agentId: this.agentId,
							pendingRooms: this.roomHandlerQueue.pendingTotal(),
							timeoutMs,
						},
						severity: "ephemeral",
					},
				);
				this.reportError("AgentRuntime.stop.roomDrain", error, {
					pendingRooms: this.roomHandlerQueue.pendingTotal(),
					timeoutMs,
				});
				throw error;
			}
		} else {
			await roomDrain;
		}
		if (!fast) {
			const pending = pendingPostDeliveryTaskCount(this);
			if (pending > 0) {
				this.logger.info(
					{ src: "agent", agentId: this.agentId, pending },
					"Draining post-delivery work before runtime shutdown",
				);
				await drainPostDeliveryTasks(this);
			}
		}
		const previousFastShutdown = process.env.ELIZA_FAST_SHUTDOWN;
		if (fast) {
			process.env.ELIZA_FAST_SHUTDOWN = "1";
		}
		try {
			await this._stopServices(fast, options?.serviceStopTimeoutMs);
		} finally {
			if (fast) {
				if (previousFastShutdown === undefined) {
					delete process.env.ELIZA_FAST_SHUTDOWN;
				} else {
					process.env.ELIZA_FAST_SHUTDOWN = previousFastShutdown;
				}
			}
		}
	}

	private async _stopServices(
		fast: boolean,
		serviceStopTimeoutMs?: number,
	): Promise<void> {
		this.stopped = true;
		this.logger.debug(
			{ src: "agent", agentId: this.agentId, fast },
			"Stopping runtime",
		);

		const inFlightEntries = Array.from(this.startingServices.entries());
		const inFlight = inFlightEntries.map(([, promise]) => promise);
		if (inFlight.length > 0) {
			const serviceTypes = inFlightEntries.map(([serviceType]) => serviceType);
			if (fast) {
				this.logger.info(
					{ src: "agent", agentId: this.agentId, serviceTypes },
					"Fast shutdown: skipping wait for in-flight service starts",
				);
				this.startingServices.clear();
			} else {
				const timeoutMs = resolveShutdownTimeoutMs(
					"ELIZA_SHUTDOWN_SERVICE_START_TIMEOUT_MS",
					DEFAULT_SERVICE_START_SHUTDOWN_TIMEOUT_MS,
				);
				if (timeoutMs === 0) {
					this.logger.info(
						{ src: "agent", agentId: this.agentId, serviceTypes },
						"Skipping wait for in-flight service starts",
					);
					this.startingServices.clear();
				} else {
					this.logger.info(
						{
							src: "agent",
							agentId: this.agentId,
							count: inFlight.length,
							serviceTypes,
							timeoutMs,
						},
						"Waiting for in-flight service starts before stopping",
					);
					const waitStartedAt = Date.now();
					const result = await Promise.race([
						Promise.allSettled(inFlight).then(() => "settled" as const),
						timeoutAfter(timeoutMs),
					]);
					if (result === "timeout" && this.startingServices.size > 0) {
						this.logger.warn(
							{
								src: "agent",
								agentId: this.agentId,
								serviceTypes,
								timeoutMs,
								elapsedMs: Date.now() - waitStartedAt,
							},
							"Timed out waiting for in-flight service starts; proceeding with shutdown",
						);
						this.startingServices.clear();
					}
				}
			}
		}

		const fastStopTasks: Promise<void>[] = [];
		for (const [serviceType, services] of this.services) {
			this.logger.debug(
				{ src: "agent", agentId: this.agentId, serviceType },
				"Stopping service",
			);
			for (const service of services) {
				if (fast) {
					fastStopTasks.push(
						this._stopServiceInstance(serviceType, service, "fast shutdown"),
					);
				} else {
					await this._stopServiceInstance(serviceType, service, "shutdown");
				}
			}
		}
		if (fast && fastStopTasks.length > 0) {
			const timeoutMs =
				serviceStopTimeoutMs !== undefined &&
				Number.isFinite(serviceStopTimeoutMs) &&
				serviceStopTimeoutMs >= 0
					? Math.floor(serviceStopTimeoutMs)
					: resolveShutdownTimeoutMs(
							"ELIZA_SHUTDOWN_SERVICE_STOP_TIMEOUT_MS",
							DEFAULT_FAST_SERVICE_STOP_TIMEOUT_MS,
						);
			if (timeoutMs > 0) {
				await Promise.race([
					Promise.allSettled(fastStopTasks),
					timeoutAfter(timeoutMs),
				]);
			} else {
				await Promise.allSettled(fastStopTasks);
			}
		}

		// Reject any pending service load promises so callers don't hang
		const stopError = new Error("Runtime stopped");
		for (const [serviceType, handler] of this.servicePromiseHandlers) {
			handler.reject(stopError);
			const promise = this.servicePromises.get(serviceType);
			if (promise) {
				// error-policy:J5 unhandled-rejection suppression — the rejection is
				// delivered to getServiceLoadPromise() awaiters via handler.reject
				// above; this only silences unhandled-rejection noise at shutdown.
				void promise.catch(() => {});
			}
		}

		// Clear caches and handlers to avoid use-after-stop and release references
		this.promptBatcher.dispose();
		this.eventHandlers.clear();
		this.events = {};
		this.stateCache.clear();
		// Abort before dropping the map. Each execution owns the only handle to
		// its provider work — no caller retains the controller — so clearing
		// alone would strand in-flight provider calls past teardown with nothing
		// left able to cancel them.
		this.providerState.stop();
		this.roomReadMemo.invalidate();
		this.roomMessagesMemo.invalidate();
		this.servicePromises.clear();
		this.servicePromiseHandlers.clear();
		this.startingServices.clear();
		this.startingServiceClasses.clear();
		this.serviceInstancesByClass.clear();
		this.failedServiceClasses.clear();
	}

	private _stopServiceInstance(
		serviceType: string,
		service: Service | null | undefined,
		reason: string,
	): Promise<void> {
		return this.serviceLifecycle._stopServiceInstance(
			serviceType,
			service,
			reason,
		);
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
		this.initializationFailed = false;
		try {
			await this._initializeCore(options);
		} catch (err) {
			this.initializationFailed = true;
			// error-policy:J2 Release initialization waiters before preserving
			// the original initialization failure for the caller.
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
		// Seed the per-runtime context registry with the first-party taxonomy
		// before any plugin registers. Subsequent plugin/extension calls to
		// `runtime.contexts.tryRegister(...)` will be idempotent on these ids.
		const { skipped: skippedContexts } = this.contexts.tryRegisterMany(
			DEFAULT_CONTEXT_DEFINITIONS,
		);
		for (const id of skippedContexts) {
			this.logger.warn(
				{ src: "agent", agentId: this.agentId, context: id },
				"First-party context already registered, skipping",
			);
		}

		// Register the canonical core response-handler field evaluators. These
		// own the top-level properties of the Stage-1 LLM's structured output
		// (shouldRespond, contexts, intents, candidateActionNames, replyText,
		// facts, relationships, addressedTo). Plugins may register additional
		// fields (e.g. app-lifeops contributes `threadOps`).
		for (const evaluator of BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS) {
			this.registerResponseHandlerFieldEvaluator(evaluator);
		}

		const pluginRegistrationPromises: Promise<void>[] = [];

		// Basic capabilities are now built into core - auto-register it first
		const basicCapabilitiesPlugin = createBasicCapabilitiesPlugin(
			this.capabilityOptions,
		);
		// Extended capabilities predate the native relationships feature and still
		// export its MESSAGE/POST actions, relationship providers, and evaluators
		// for compatibility. When the native feature is enabled (the default), it
		// owns those components. Remove the legacy copies before registration so
		// startup does not register the same capability family twice.
		if (this.resolveNativeFeatureEnabled("relationships")) {
			const nativeRelationships =
				getNativeRuntimeFeaturePlugin("relationships");
			const actionNames = new Set(
				(nativeRelationships.actions ?? []).map((action) => action.name),
			);
			const providerNames = new Set(
				(nativeRelationships.providers ?? []).map((provider) => provider.name),
			);
			const evaluatorNames = new Set(
				(nativeRelationships.evaluators ?? []).map(
					(evaluator) => evaluator.name,
				),
			);
			basicCapabilitiesPlugin.actions = basicCapabilitiesPlugin.actions?.filter(
				(action) => !actionNames.has(action.name),
			);
			basicCapabilitiesPlugin.providers =
				basicCapabilitiesPlugin.providers?.filter(
					(provider) => !providerNames.has(provider.name),
				);
			basicCapabilitiesPlugin.evaluators =
				basicCapabilitiesPlugin.evaluators?.filter(
					(evaluator) => !evaluatorNames.has(evaluator.name),
				);
		}
		pluginRegistrationPromises.push(
			this.registerPlugin(basicCapabilitiesPlugin),
		);

		// Always-on core message-path security defenses. Registered through the
		// plugin lifecycle (GHSA-gh63-5vpj-39qp incoming-message hardening + #9949
		// injection-risk stamping) so their pipeline hooks appear in plugin
		// bookkeeping and dispose with the runtime, rather than a lazy dynamic
		// import buried in initialize.
		pluginRegistrationPromises.push(
			this.registerPlugin(createCoreSecurityHooksPlugin()),
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

		for (const plugin of this.characterPlugins) {
			if (plugin && !this.isPluginManagedAsNativeFeature(plugin)) {
				pluginRegistrationPromises.push(this.registerPlugin(plugin));
			}
		}
		await Promise.all(pluginRegistrationPromises);
		for (const warning of getActionRolePolicyWarnings(this.actions)) {
			if (warning.type === "unmatched") {
				this.logger.warn(
					{
						src: "agent",
						agentId: this.agentId,
						action: warning.actionName,
						policyRole: warning.policyRole,
					},
					"[AgentRuntime] ACTION_ROLE_POLICY entry does not match a registered action name",
				);
				continue;
			}
			this.logger.warn(
				{
					src: "agent",
					agentId: this.agentId,
					action: warning.actionName,
					policyRole: warning.policyRole,
					declaredRole: warning.declaredRole,
				},
				"[AgentRuntime] ACTION_ROLE_POLICY entry lowers the action's declared role gate",
			);
		}

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
				this.registerDatabaseAdapter(new InMemoryDatabaseAdapter(this.agentId));
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
			const dbSettings = isPlainObject(existingAgent.settings)
				? existingAgent.settings
				: {};
			const dbExtraSettings = isPlainObject(dbSettings.extra)
				? dbSettings.extra
				: {};
			const dbSettingsSecrets = isPlainObject(dbSettings.secrets)
				? dbSettings.secrets
				: {};
			const characterSettings = isPlainObject(this.character.settings)
				? this.character.settings
				: {};
			const characterExtraSettings = isPlainObject(characterSettings.extra)
				? characterSettings.extra
				: {};
			const characterSettingsSecrets = isPlainObject(characterSettings.secrets)
				? characterSettings.secrets
				: {};
			const characterSecrets =
				this.character.secrets && typeof this.character.secrets === "object"
					? this.character.secrets
					: {};
			const dbSettingsWithRuntimeOverrides = { ...existingAgent.settings };

			for (const key of Object.keys(this.settings)) {
				const runtimeValue = this.getRuntimeSettingValue(key);
				if (runtimeValue === undefined) {
					continue;
				}

				const hasDbValue =
					Object.hasOwn(dbSettings, key) ||
					Object.hasOwn(dbExtraSettings, key) ||
					Object.hasOwn(dbSettingsSecrets, key);
				const hasCharacterValue =
					Object.hasOwn(characterSettings, key) ||
					Object.hasOwn(characterExtraSettings, key) ||
					Object.hasOwn(characterSettingsSecrets, key) ||
					Object.hasOwn(characterSecrets, key);

				if (hasDbValue && !hasCharacterValue) {
					dbSettingsWithRuntimeOverrides[key] = runtimeValue;
				}
			}

			this.character.settings = {
				...dbSettingsWithRuntimeOverrides,
				...this.character.settings, // Character file overrides DB
			};

			// Merge secrets from both character.secrets and settings.secrets
			// getSetting() checks character.secrets first, so we need to merge there too
			const dbSecrets =
				existingAgent.secrets && typeof existingAgent.secrets === "object"
					? existingAgent.secrets
					: {};
			const runtimeSecretOverrides: Record<string, string | boolean | number> =
				{};

			for (const key of Object.keys(this.settings)) {
				const runtimeValue = this.getRuntimeSettingValue(key);
				if (runtimeValue === undefined) {
					continue;
				}

				const hasDbSecret =
					Object.hasOwn(dbSecrets, key) ||
					Object.hasOwn(dbSettingsSecrets, key);
				const hasCharacterSecret =
					Object.hasOwn(characterSecrets, key) ||
					Object.hasOwn(characterSettingsSecrets, key);

				if (hasDbSecret && !hasCharacterSecret) {
					runtimeSecretOverrides[key] = runtimeValue;
				}
			}

			// Merge into both locations that getSetting() checks
			const mergedSecrets = {
				...dbSecrets,
				...dbSettingsSecrets,
				...runtimeSecretOverrides,
				...characterSecrets,
				...characterSettingsSecrets, // character settings.secrets has priority
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
			// The getRoom above memoized null for this id; drop it.
			this.roomReadMemo.invalidate(this.agentId);
		}
		const [participantsResult] = await this.adapter.getParticipantsForRooms([
			this.agentId,
		]);
		const participantIds = participantsResult.entityIds;
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
			try {
				await this.ensureEmbeddingDimension();
			} catch (error) {
				if (!(error instanceof EmbeddingDimensionProbeError)) {
					throw error;
				}
				const pendingLocalHandler =
					error.attempts.length === 1 &&
					error.attempts[0]?.provider === "local" &&
					error.attempts[0]?.error.includes(
						"no on-device embedding handler is registered",
					);
				// error-policy:J4 Embeddings enter an explicit disabled state until
				// the deferred probe succeeds; the runtime remains otherwise usable.
				// Every registered TEXT_EMBEDDING provider failed the dimension
				// probe. Do not abort boot: ensureEmbeddingDimension() has already
				// flipped the runtime into embedding-disabled mode, so memory writes
				// skip vector generation instead of emitting vectors the SQL adapter
				// would silently drop against its default-sized column (#8769). The
				// deferred boot re-probe (packages/agent) re-runs the probe after
				// late plugins register and re-enables embeddings on success.
				const context = {
					src: "agent",
					agentId: this.agentId,
					attempts: error.attempts,
				};
				const pendingConfiguredHandler =
					error.attempts.length === 1 &&
					error.attempts[0]?.error === "no registered handler yet";
				if (pendingConfiguredHandler) {
					this.logger.info(
						context,
						"Configured TEXT_EMBEDDING provider has not registered yet; keeping embedding generation disabled until the deferred re-probe pins it",
					);
				} else if (pendingLocalHandler) {
					this.logger.info(
						context,
						"Local TEXT_EMBEDDING handler will register during deferred plugin boot; keeping embedding generation disabled until the deferred probe",
					);
				} else {
					this.logger.error(
						{
							src: "agent",
							agentId: this.agentId,
							attempts: error.attempts,
						},
						"All registered TEXT_EMBEDDING providers failed the dimension probe; continuing boot with embedding generation disabled — memory recall over new memories is degraded until a provider recovers",
					);
					this.reportError("AgentRuntime.embeddingDimensionProbe", error, {
						attempts: error.attempts,
					});
				}
			}
		}

		// LOUD GUARD (owner-private disclosure regression class): a world whose
		// canonical owner is a bare platform id (snowflake) instead of a valid
		// entity UUID makes resolveCanonicalOwnerId return null (validateUuid
		// rejects it), which denies every owner-private provider with
		// `owner_mismatch`. This has recurred whenever a connector persisted a raw
		// snowflake into `ownership.ownerId`. Assert it loudly at boot so the
		// regression is caught in CI/health instead of silently degrading recall.
		try {
			await this.assertResolvableWorldOwners();
		} catch (guardError) {
			// error-policy:J6 the guard is diagnostic; a scan failure must not brick
			// startup. Report and continue.
			this.reportError("AgentRuntime.assertResolvableWorldOwners", guardError);
		}

		// Resolve init promise to allow services to start
		if (this.initResolver) {
			this.initResolver();
			this.initResolver = undefined;
		}
	}

	/**
	 * Fail-loud scan for the owner-private disclosure regression class: any world
	 * whose `ownership.ownerId` (or an OWNER-role grant) is a non-UUID value — the
	 * bare-snowflake shape that makes resolveCanonicalOwnerId return null and
	 * denies owner-private recall with `owner_mismatch`. Logs each offender
	 * loudly and reports one aggregated error; it is diagnostic, not fatal.
	 */
	async assertResolvableWorldOwners(): Promise<void> {
		if (typeof this.adapter?.getAllWorlds !== "function") {
			return;
		}
		const worlds = await this.getAllWorlds();
		const offenders: Array<{
			worldId: string;
			field: string;
			value: string;
		}> = [];
		for (const world of worlds) {
			const metadata = (world?.metadata ?? {}) as {
				ownership?: { ownerId?: unknown };
				roles?: Record<string, unknown>;
			};
			const ownerId = metadata.ownership?.ownerId;
			if (
				typeof ownerId === "string" &&
				ownerId.length > 0 &&
				validateUuid(ownerId) === null
			) {
				offenders.push({
					worldId: String(world?.id ?? "unknown"),
					field: "ownership.ownerId",
					value: ownerId,
				});
			}
			const roles = metadata.roles;
			if (roles && typeof roles === "object") {
				for (const [entityId, role] of Object.entries(roles)) {
					if (role === "OWNER" && validateUuid(entityId) === null) {
						offenders.push({
							worldId: String(world?.id ?? "unknown"),
							field: "roles[OWNER]",
							value: entityId,
						});
					}
				}
			}
		}
		if (offenders.length === 0) {
			return;
		}
		for (const offender of offenders) {
			this.logger.error(
				{
					src: "agent",
					agentId: this.agentId,
					worldId: offender.worldId,
					field: offender.field,
				},
				"OWNER-PRIVATE DISCLOSURE GUARD: world owner is a non-resolvable, non-UUID value (bare platform id/snowflake). resolveCanonicalOwnerId will return null and owner-private providers will be denied with owner_mismatch. Fix the connector so it records a canonical entity UUID.",
			);
		}
		this.reportError(
			"AgentRuntime.assertResolvableWorldOwners",
			new Error(
				`${offenders.length} world(s) record a non-resolvable owner (bare snowflake / non-UUID). Owner-private recall is degraded until fixed.`,
			),
			{ offenderCount: offenders.length },
		);
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
			} else {
				// null clears — callers use setSetting(key, null) to revoke a
				// previously bridged credential (cloud disconnect, connector
				// admin wipe, plugin Settings blanking an optional param).
				delete this.character.secrets[key];
			}
		} else {
			if (!this.character.settings) {
				this.character.settings = {};
			}
			if (value !== null && value !== undefined) {
				this.character.settings[key] = value;
			} else {
				delete this.character.settings[key];
			}
		}
		// Keep the constructor settings map aligned so getRuntimeSettingValue
		// cannot resurrect a cleared key after character.secrets/settings drop it.
		if (value !== null && value !== undefined) {
			this.settings[key] = value;
		} else {
			delete this.settings[key];
		}
	}

	private getCharacterEnvSetting(
		key: string,
	): string | boolean | number | undefined {
		const env = (this.character as { env?: unknown }).env;
		if (!env || typeof env !== "object" || Array.isArray(env)) {
			return undefined;
		}

		const envRecord = env as Record<string, unknown>;
		const vars =
			envRecord.vars &&
			typeof envRecord.vars === "object" &&
			!Array.isArray(envRecord.vars)
				? (envRecord.vars as Record<string, unknown>)
				: undefined;

		const directValue = envRecord[key];
		if (
			typeof directValue === "string" ||
			typeof directValue === "boolean" ||
			typeof directValue === "number"
		) {
			return directValue;
		}

		const varsValue = vars?.[key];
		if (
			typeof varsValue === "string" ||
			typeof varsValue === "boolean" ||
			typeof varsValue === "number"
		) {
			return varsValue;
		}
		return undefined;
	}

	private getRuntimeSettingValue(
		key: string,
	): string | boolean | number | undefined {
		const value = this.settings[key];
		if (
			typeof value === "string" ||
			typeof value === "boolean" ||
			typeof value === "number"
		) {
			return value;
		}
		return undefined;
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
			this.getCharacterEnvSetting(key) ??
			this.getRuntimeSettingValue(key);

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
		return this.structuredPrompts.resolveProviderModelString(
			resolvedModelType,
			optionsModel,
			effectiveModelId,
		);
	}
	enrichTrace(runId: string, signal: ScoreSignal): void {
		this.promptTraces.enrichTrace(runId, signal);
	}
	getActiveTrace(runId: string): ExecutionTrace | undefined {
		return this.promptTraces.getActiveTrace(runId);
	}
	getActiveTracesForRun(runId: string): ExecutionTrace[] {
		return this.promptTraces.getActiveTracesForRun(runId);
	}
	deleteActiveTrace(runId: string): void {
		this.promptTraces.deleteActiveTrace(runId);
	}
	deleteActiveTraceById(traceId: string): void {
		this.promptTraces.deleteActiveTraceById(traceId);
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
		if (this.adapter && isMessagingAdapter(this.adapter)) {
			return this.adapter;
		}
		return null;
	}

	/**
	 * Shared collision policy for the three primary component registries
	 * (actions, providers, evaluators). Registration is deterministic first-wins:
	 * the earliest-registered component of a given name is authoritative and the
	 * order in which plugins register is stable across a boot.
	 *
	 * A later registrant of the same name is either:
	 *  - a DECLARED override (`override: true`) — an intentional supersede. We log
	 *    the takeover at INFO and instruct the caller to replace the incumbent.
	 *  - an UNDECLARED collision — two plugins claimed the same name without one
	 *    declaring precedence. This is the unsafe, order-sensitive case the
	 *    arch-audit flagged: which component wins used to be decided by a silent
	 *    first-wins dedupe. We now keep the incumbent (still deterministic) but
	 *    surface a WARN so the drift is observable instead of silent.
	 *
	 * @returns `true` if the caller should REPLACE the incumbent (declared
	 *   override), `false` if it should keep the incumbent and skip the newcomer.
	 */
	private resolveComponentCollision(
		kind: "action" | "provider" | "evaluator",
		name: string,
		override: boolean | undefined,
	): boolean {
		if (override === true) {
			this.logger.info(
				{ src: "agent", agentId: this.agentId, [kind]: name },
				`[AgentRuntime] ${kind} "${name}" declares override:true — superseding the already-registered ${kind} of the same name.`,
			);
			return true;
		}
		this.logger.warn(
			{ src: "agent", agentId: this.agentId, [kind]: name },
			`[AgentRuntime] ${kind} name collision: a ${kind} named "${name}" is already registered; keeping the first and skipping this one. Which one wins is load-order-dependent — give the two distinct names, or set override:true on the ${kind} that should intentionally supersede.`,
		);
		return false;
	}

	registerProvider(provider: Provider) {
		if (this.providers.includes(provider)) {
			this.logger.debug(
				{ src: "agent", agentId: this.agentId, provider: provider.name },
				"Provider instance already registered, skipping",
			);
			return;
		}
		const canonical = withCanonicalProviderDocs(provider);
		Object.assign(provider, canonical);
		const existingIndex = this.providers.findIndex(
			(p) => p.name === provider.name,
		);
		if (existingIndex !== -1) {
			if (
				this.resolveComponentCollision(
					"provider",
					provider.name,
					provider.override,
				)
			) {
				this.providers[existingIndex] = provider;
			}
			return;
		}
		this.providers.push(provider);
		this.logger.debug(
			{ src: "agent", agentId: this.agentId, provider: provider.name },
			"Provider registered",
		);
	}

	registerAction(action: Action) {
		if (this.actions.includes(action)) {
			this.logger.debug(
				{ src: "agent", agentId: this.agentId, action: action.name },
				"Action instance already registered, skipping",
			);
			return;
		}
		const canonical = withCanonicalActionDocs(action);
		Object.assign(action, canonical);
		const existingIndex = this.actions.findIndex((a) => a.name === action.name);
		if (existingIndex !== -1) {
			if (
				this.resolveComponentCollision("action", action.name, action.override)
			) {
				this.actions[existingIndex] = action;
			}
		} else {
			this.actions.push(action);
			this.logger.debug(
				{ src: "agent", agentId: this.agentId, action: action.name },
				"Action registered",
			);
		}
	}

	/** Register a pre-LLM action shortcut (#8791) into this runtime's registry. */
	registerShortcut(shortcut: ShortcutDefinition) {
		this.shortcutRegistry.register(shortcut);
		this.logger.debug(
			{ src: "agent", agentId: this.agentId, shortcut: shortcut.id },
			"Shortcut registered",
		);
	}

	registerShortcuts(shortcuts: readonly ShortcutDefinition[]) {
		for (const shortcut of shortcuts) this.registerShortcut(shortcut);
	}

	unregisterShortcut(id: string) {
		this.shortcutRegistry.unregister(id);
		this.logger.debug(
			{ src: "agent", agentId: this.agentId, shortcut: id },
			"Shortcut unregistered",
		);
	}

	/** Register a chat pre-handler into this runtime's registry. */
	registerChatPreHandler(handler: ChatPreHandler) {
		this.chatPreHandlerRegistry.register(handler);
		this.logger.debug(
			{ src: "agent", agentId: this.agentId, preHandler: handler.id },
			"Chat pre-handler registered",
		);
	}

	registerChatPreHandlers(handlers: readonly ChatPreHandler[]) {
		for (const handler of handlers) this.registerChatPreHandler(handler);
	}

	unregisterChatPreHandler(id: string) {
		this.chatPreHandlerRegistry.unregister(id);
		this.logger.debug(
			{ src: "agent", agentId: this.agentId, preHandler: id },
			"Chat pre-handler unregistered",
		);
	}

	/**
	 * Drain registered chat pre-handlers by priority before normal action
	 * processing; the first non-null result short-circuits the turn.
	 */
	drainChatPreHandlers(
		ctx: ChatPreHandlerContext,
	): Promise<ChatPreHandlerResult | null> {
		return this.chatPreHandlerRegistry.drain(ctx);
	}

	registerEvaluator(evaluator: RegisteredEvaluator) {
		if (this.evaluators.includes(evaluator)) {
			this.logger.debug(
				{ src: "agent", agentId: this.agentId, evaluator: evaluator.name },
				"Evaluator instance already registered, skipping",
			);
			return;
		}
		const existingIndex = this.evaluators.findIndex(
			(item) => item.name === evaluator.name,
		);
		if (existingIndex !== -1) {
			if (
				this.resolveComponentCollision(
					"evaluator",
					evaluator.name,
					evaluator.override,
				)
			) {
				this.evaluators[existingIndex] = evaluator;
			}
			return;
		}
		this.evaluators.push(evaluator);
		this.logger.debug(
			{ src: "agent", agentId: this.agentId, evaluator: evaluator.name },
			"Evaluator registered",
		);
	}

	unregisterEvaluator(name: string): boolean {
		const normalized = typeof name === "string" ? name.trim() : "";
		if (!normalized) return false;
		const index = this.evaluators.findIndex(
			(evaluator) => evaluator.name === normalized,
		);
		if (index === -1) return false;
		this.evaluators.splice(index, 1);
		this.logger.debug(
			{ src: "agent", agentId: this.agentId, evaluator: normalized },
			"Evaluator unregistered",
		);
		return true;
	}

	registerResponseHandlerEvaluator(evaluator: ResponseHandlerEvaluator) {
		if (
			this.responseHandlerEvaluators.find(
				(item) => item.name === evaluator.name,
			)
		) {
			this.logger.debug(
				{
					src: "agent",
					agentId: this.agentId,
					evaluator: evaluator.name,
				},
				"Response-handler evaluator already registered, skipping",
			);
			return;
		}
		this.responseHandlerEvaluators.push(evaluator);
		this.logger.debug(
			{
				src: "agent",
				agentId: this.agentId,
				evaluator: evaluator.name,
			},
			"Response-handler evaluator registered",
		);
	}

	unregisterResponseHandlerEvaluator(name: string): boolean {
		const normalized = typeof name === "string" ? name.trim() : "";
		if (!normalized) return false;
		const index = this.responseHandlerEvaluators.findIndex(
			(evaluator) => evaluator.name === normalized,
		);
		if (index === -1) return false;
		this.responseHandlerEvaluators.splice(index, 1);
		this.logger.debug(
			{ src: "agent", agentId: this.agentId, evaluator: normalized },
			"Response-handler evaluator unregistered",
		);
		return true;
	}

	registerResponseHandlerFieldEvaluator(
		evaluator: ResponseHandlerFieldEvaluator,
	) {
		if (
			this.responseHandlerFieldEvaluators.find(
				(item) => item.name === evaluator.name,
			)
		) {
			this.logger.debug(
				{
					src: "agent",
					agentId: this.agentId,
					evaluator: evaluator.name,
				},
				"Response-handler field evaluator already registered, skipping",
			);
			return;
		}
		this.responseHandlerFieldEvaluators.push(evaluator);
		this.responseHandlerFieldRegistry.register(evaluator);
		this.logger.debug(
			{
				src: "agent",
				agentId: this.agentId,
				evaluator: evaluator.name,
				priority: evaluator.priority ?? 100,
			},
			"Response-handler field evaluator registered",
		);
	}

	unregisterResponseHandlerFieldEvaluator(name: string): boolean {
		const normalized = typeof name === "string" ? name.trim() : "";
		if (!normalized) return false;
		const index = this.responseHandlerFieldEvaluators.findIndex(
			(evaluator) => evaluator.name === normalized,
		);
		if (index === -1) return false;
		this.responseHandlerFieldEvaluators.splice(index, 1);
		this.responseHandlerFieldRegistry.unregister(normalized);
		this.logger.debug(
			{ src: "agent", agentId: this.agentId, evaluator: normalized },
			"Response-handler field evaluator unregistered",
		);
		return true;
	}

	/**
	 * Abort the active turn for `roomId`. Convenience wrapper for
	 * `turnControllers.abortTurn`. Returns true if a turn was aborted.
	 */
	abortTurn(roomId: string, reason: string): boolean {
		return this.turnControllers.abortTurn(roomId, reason);
	}

	unregisterAction(name: string): boolean {
		const normalized = typeof name === "string" ? name.trim() : "";
		if (!normalized) return false;
		const index = this.actions.findIndex(
			(action) => action.name === normalized,
		);
		if (index === -1) return false;
		this.actions.splice(index, 1);
		this.logger.debug(
			{ src: "agent", agentId: this.agentId, action: normalized },
			"Action unregistered",
		);
		return true;
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
		let policyService: ToolPolicyService | null;
		try {
			policyService = (await this._ensureServiceStarted(
				"tool_policy",
			)) as ToolPolicyService | null;
		} catch (error) {
			// error-policy:J4 explicit user-facing degrade — a tool_policy service
			// that was configured but failed to start cannot safely authorize tools.
			// Keep the turn alive with no executable actions and surface the failure.
			this.reportError("AgentRuntime.getFilteredActions", error, {
				serviceType: "tool_policy",
			});
			return [];
		}

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
		let policyService: ToolPolicyService | null;
		try {
			policyService = (await this._ensureServiceStarted(
				"tool_policy",
			)) as ToolPolicyService | null;
		} catch (error) {
			// error-policy:J4 explicit user-facing degrade — a tool_policy service
			// that was configured but failed to start cannot safely authorize tools.
			// Deny the action and surface the service failure.
			this.reportError("AgentRuntime.isActionAllowed", error, {
				serviceType: "tool_policy",
			});
			return {
				allowed: false,
				reason: "Tool policy service failed to start",
			};
		}

		if (!policyService) {
			return { allowed: true, reason: "No policy service available" };
		}

		const result = policyService.isToolAllowed(actionName, context);
		return { allowed: result.allowed, reason: result.reason };
	}

	getActionResults(messageId: UUID): ActionResult[] {
		const cachedState = this.stateCache.get(`${messageId}_action_results`);
		return (
			(cachedState?.data &&
				(cachedState.data.actionResults as ActionResult[])) ||
			[]
		);
	}

	/**
	 * Run actions whose `mode` matches the given hook position. The runtime
	 * fires this from fixed places in the message pipeline (see
	 * services/message.ts). DURING modes execute handlers in parallel; all
	 * other hook modes run sequentially in `modePriority` ascending order.
	 * CONTEXT hooks are gated by `selectedContexts` overlapping the action's
	 * `contexts`.
	 */
	async runActionsByMode(
		mode: ActionMode,
		message: Memory,
		state?: State,
		options?: {
			didRespond?: boolean;
			callback?: HandlerCallback;
			responses?: Memory[];
			selectedContexts?: readonly AgentContext[];
		},
	): Promise<Action[]> {
		let candidates = this.actions.filter((action) => action.mode === mode);

		if (
			mode === "CONTEXT_BEFORE" ||
			mode === "CONTEXT_DURING" ||
			mode === "CONTEXT_AFTER"
		) {
			const selected = new Set(options?.selectedContexts ?? []);
			candidates = candidates.filter((action) => {
				const tags = action.contexts ?? [];
				return tags.some((tag) => selected.has(tag));
			});
		}

		candidates = candidates
			.slice()
			.sort(
				(a, b) =>
					(a.modePriority ?? 100) - (b.modePriority ?? 100) ||
					a.name.localeCompare(b.name),
			);
		if (candidates.length === 0) return [];

		setTrajectoryPurpose(mode === "ALWAYS_AFTER" ? "evaluation" : "hook");

		const validated: Action[] = [];
		await Promise.all(
			candidates.map(async (action) => {
				if (action.disclosureGate?.require === "owner_exclusive") {
					const disclosure = await authorizeOwnerExclusiveDisclosure(
						this,
						message,
					);
					if (!disclosure.allowed) {
						this.logger.info(
							{
								src: "agent",
								agentId: this.agentId,
								action: action.name,
								mode,
								reason: disclosure.reason,
							},
							"Owner-private mode action denied for untrusted delivery audience",
						);
						return;
					}
				}
				try {
					const ok = await action.validate(this, message, state);
					if (ok) validated.push(action);
				} catch (err) {
					// error-policy:J4 Mode actions are isolated; failed validation is
					// reported while independent actions remain eligible.
					this.logger.warn(
						{
							src: "agent",
							agentId: this.agentId,
							action: action.name,
							mode,
							err: err instanceof Error ? err.message : String(err),
						},
						"runActionsByMode validate failed",
					);
					this.reportError("AgentRuntime.modeActionValidate", err, {
						action: action.name,
						mode,
					});
				}
			}),
		);
		if (validated.length === 0) return [];

		validated.sort(
			(a, b) =>
				(a.modePriority ?? 100) - (b.modePriority ?? 100) ||
				a.name.localeCompare(b.name),
		);

		const composedState =
			state ?? (await this.composeState(message, ["RECENT_MESSAGES"]));

		const messageId = message.id;
		const roomId = message.roomId;
		const worldId = await resolveActionEventWorldId(
			this,
			message,
			"AgentRuntime.resolveActionEventWorldId",
		);

		const runOne = async (action: Action) => {
			await this.emitEvent(EventType.ACTION_STARTED, {
				runtime: this,
				messageId,
				roomId,
				world: worldId,
				content: {
					text: `Executing ${mode} action: ${action.name}`,
					actions: [action.name],
					actionStatus: "executing",
					source: message.content.source,
				},
			}).catch((err) =>
				// error-policy:J7 diagnostics-must-not-kill-the-loop — a broken
				// event bus must not abort the action, but it must surface.
				this.reportError("AgentRuntime.emitEvent", err, {
					event: EventType.ACTION_STARTED,
					messageId,
				}),
			);

			let success = true;
			let errorMsg: string | undefined;
			try {
				if (action.disclosureGate?.require === "owner_exclusive") {
					const disclosure = await authorizeOwnerExclusiveDisclosure(
						this,
						message,
					);
					if (!disclosure.allowed) {
						success = false;
						errorMsg = PRIVACY_DENIED_TEXT;
					}
				}
				if (success) {
					const protectedCallback =
						action.disclosureGate?.require === "owner_exclusive" &&
						options?.callback
							? async (
									...callbackArgs: Parameters<
										NonNullable<typeof options.callback>
									>
								) => {
									const disclosure = await revalidateOwnerExclusiveDisclosure(
										this,
										message,
									);
									if (disclosure.allowed) {
										return options.callback?.(...callbackArgs) ?? [];
									}
									return (
										options.callback?.(
											{
												text: PRIVACY_DENIED_TEXT,
												actions: ["PRIVACY_DENIED"],
												data: {
													privacyDenied: true,
													privacyReason: disclosure.reason,
												},
											},
											"PRIVACY_DENIED",
										) ?? []
									);
								}
							: options?.callback;
					await settleActionHandler({
						runtime: this,
						action,
						callback: protectedCallback,
						handlerError: "rethrow",
						invoke: (actionCallback) =>
							runWithActionRoutingContext(
								{ actionName: action.name, modelClass: action.modelClass },
								() =>
									action.handler(
										this,
										message,
										composedState,
										{ mode },
										actionCallback,
										options?.responses,
									),
							),
					});
					if (action.disclosureGate?.require === "owner_exclusive") {
						const disclosure = await revalidateOwnerExclusiveDisclosure(
							this,
							message,
						);
						if (!disclosure.allowed) {
							success = false;
							errorMsg = PRIVACY_DENIED_TEXT;
						}
					}
				}
			} catch (err) {
				// error-policy:J1 The mode-action boundary records an explicit
				// failed result while allowing independent actions to complete.
				success = false;
				errorMsg = err instanceof Error ? err.message : String(err);
				this.logger.warn(
					{
						src: "agent",
						agentId: this.agentId,
						action: action.name,
						mode,
						err: errorMsg,
					},
					"runActionsByMode handler failed",
				);
				this.reportError("AgentRuntime.modeActionHandler", err, {
					action: action.name,
					mode,
				});
			}

			await this.emitEvent(EventType.ACTION_COMPLETED, {
				runtime: this,
				messageId,
				roomId,
				world: worldId,
				content: {
					text: success
						? `${mode} action ${action.name} completed`
						: `${mode} action ${action.name} failed: ${errorMsg ?? "unknown"}`,
					actions: [action.name],
					actionStatus: success ? "completed" : "failed",
					source: message.content.source,
					error: errorMsg,
				},
			}).catch((err) =>
				// error-policy:J7 diagnostics-must-not-kill-the-loop — a broken
				// event bus must not abort the action, but it must surface.
				this.reportError("AgentRuntime.emitEvent", err, {
					event: EventType.ACTION_COMPLETED,
					messageId,
				}),
			);
		};

		const isDuring =
			mode === "ALWAYS_DURING" ||
			mode === "CONTEXT_DURING" ||
			mode === "RESPONSE_HANDLER_DURING";
		if (isDuring) {
			await Promise.all(validated.map(runOne));
		} else {
			for (const action of validated) {
				await runOne(action);
			}
		}

		return validated;
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
		const roomsIdExists = roomExistsCheck.map((r: { id: UUID }) => r.id);
		const roomsToCreate = roomIds.filter(
			(id: UUID) => !roomsIdExists.includes(id),
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
				.map((e) => e.id)
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
		const result = await ensureConnectionStandalone(this.adapter, {
			agentId: this.agentId,
			worldId: params.worldId,
			messageServerId: params.messageServerId,
			...params,
			source: params.source ?? "default",
		});
		// ensureConnectionStandalone writes the room through adapter.upsertRooms directly
		// rather than this.upsertRooms, so it bypasses the room-read memo invalidation.
		// Invalidate here to uphold the "every room mutation is immediately visible"
		// invariant — otherwise a concurrent compose could be served a memoized null (for
		// a just-created room) or a <=1s-stale Room after a metadata upsert.
		this.roomReadMemo.invalidate(params.roomId);
		this.invalidateTurnEntityDetails();
		if (result.createdRoomParticipants > 0) {
			this.logger.debug(
				{
					src: "agent",
					agentId: this.agentId,
					entityId: params.entityId,
					channelId: params.roomId,
					createdRoomParticipants: result.createdRoomParticipants,
				},
				"Entity connected",
			);
		}
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
		return this.adapter.getParticipantsForEntities([entityId]);
	}

	async getParticipantsForEntities(entityIds: UUID[]): Promise<Participant[]> {
		return this.adapter.getParticipantsForEntities(entityIds);
	}

	async getParticipantsForRoom(roomId: UUID): Promise<UUID[]> {
		const result = await this.adapter.getParticipantsForRooms([roomId]);
		return result[0]?.entityIds ?? [];
	}

	async getParticipantsForRooms(
		roomIds: UUID[],
	): Promise<import("./types/database").ParticipantsForRoomsResult> {
		return this.adapter.getParticipantsForRooms(roomIds);
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
		return this.adapter.areRoomParticipants(pairs);
	}

	async addParticipant(entityId: UUID, roomId: UUID): Promise<boolean> {
		const ids = await this.adapter.createRoomParticipants([entityId], roomId);
		this.invalidateTurnEntityDetails();
		return ids.length > 0;
	}

	async createRoomParticipants(
		entityIds: UUID[],
		roomId: UUID,
	): Promise<UUID[]> {
		const ids = await this.adapter.createRoomParticipants(entityIds, roomId);
		this.invalidateTurnEntityDetails();
		return ids;
	}

	/** Ensures a world exists while preserving persisted metadata and revision. */
	async ensureWorldExists({ id, name, messageServerId, metadata }: World) {
		let world: World | null = null;
		let completed = false;
		for (let attempt = 0; attempt < 3; attempt += 1) {
			world = (await this.adapter.getWorldsByIds([id]))[0] ?? null;
			const mergedMetadata = world
				? mergeWorldMetadataForLegacyWrite(
						world.metadata as Metadata | undefined,
						metadata as Metadata | undefined,
						String(id),
					)
				: metadata;
			if (
				world &&
				worldMetadataValueEquals(world.metadata ?? {}, mergedMetadata ?? {}) &&
				world.name === (name ?? world.name) &&
				world.messageServerId === (messageServerId ?? world.messageServerId)
			) {
				completed = true;
				break;
			}
			try {
				await this.adapter.upsertWorlds([
					{
						...world,
						id,
						name: name ?? world?.name,
						agentId: this.agentId,
						messageServerId: messageServerId ?? world?.messageServerId,
						metadata: mergedMetadata as World["metadata"],
					},
				]);
				completed = true;
				break;
			} catch (error) {
				if (
					!(error instanceof ElizaError) ||
					!(
						["WORLD_METADATA_STALE_WRITE", "WORLD_ALREADY_EXISTS"] as const
					).includes(
						error.code as "WORLD_METADATA_STALE_WRITE" | "WORLD_ALREADY_EXISTS",
					)
				) {
					throw error;
				}
				// error-policy:J2 — retry against a fresh snapshot after a concurrent
				// creator wins the unique insert or a legacy writer advances revision.
			}
		}
		if (!completed) {
			throw new ElizaError("World ensure retries were exhausted", {
				code: "WORLD_ENSURE_CONFLICT_EXHAUSTED",
				context: { worldId: id, attempts: 3 },
			});
		}

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
		// The existence probe above may have memoized null/stale for this id.
		this.roomReadMemo.invalidate(id);

		this.logger.debug(
			{ src: "agent", agentId: this.agentId, channelId: id },
			room ? "Room updated" : "Room created",
		);
	}
	composeState(
		...args: Parameters<IAgentRuntime["composeState"]>
	): ReturnType<IAgentRuntime["composeState"]> {
		return this.providerState.composeState(...args);
	}

	/** Starts every pending implementation in parallel and waits for the full set. */
	private _ensureServiceStarted(
		serviceType: ServiceTypeName | string,
	): Promise<Service | null> {
		return this.serviceLifecycle._ensureServiceStarted(serviceType);
	}

	/** Runs one service start; used by _ensureServiceStarted with startingServices dedupe. */
	private _runServiceStart(
		key: ServiceTypeName,
		serviceType: string,
		serviceDef: ServiceClass,
	): Promise<Service | null> {
		return this.serviceLifecycle._runServiceStart(key, serviceType, serviceDef);
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
	 * Get all registered service types, including lazy-registered services
	 * that have not started.
	 * @returns Array of registered service type names
	 */
	getRegisteredServiceTypes(): ServiceTypeName[] {
		return Array.from(this.serviceTypes.keys());
	}

	/**
	 * Check if a service type is registered; its class may still be awaiting
	 * startup.
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

	getLifecycleState():
		| "initializing"
		| "running"
		| "failed"
		| "stopping"
		| "stopped" {
		if (this.stopRequested) {
			return this.stopped && this.stopPromise === null ? "stopped" : "stopping";
		}
		if (this.initializationFailed) return "failed";
		return this.initResolver ? "initializing" : "running";
	}

	getStopSignal(): AbortSignal {
		return this.stopController.signal;
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
			throw new ElizaError("Service is missing its serviceType property", {
				code: "SERVICE_TYPE_MISSING",
				context: { serviceName },
			});
		}
		if (this.stopRequested) {
			throw new ElizaError(
				`Cannot register service ${String(serviceType)} after runtime stop was requested`,
				{
					code: "RUNTIME_STOPPED_DURING_SERVICE_REGISTRATION",
					severity: "ephemeral",
					context: { agentId: this.agentId, serviceType },
				},
			);
		}
		this.logger.debug(
			{ src: "agent", agentId: this.agentId, serviceType },
			"Registering service (lazy; start() on first getService)",
		);

		this.serviceRegistrationStatus.set(serviceType, "pending");
		if (!this.servicePromises.has(serviceType)) {
			this._createServiceResolver(serviceType);
		}
		if (!this.serviceTypes.has(serviceType)) {
			this.serviceTypes.set(serviceType, []);
		}
		const serviceClassList = this.serviceTypes.get(serviceType);
		if (!serviceClassList) {
			throw new ElizaError("Service type registry initialization failed", {
				code: "SERVICE_TYPE_REGISTRY_INVALID",
				context: { serviceType },
			});
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
		// error-policy:J5 unhandled-rejection suppression — callers of
		// getServiceLoadPromise() still observe the rejection when they await;
		// this only prevents an unhandled rejection if the service fails first.
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
		metadata?: ModelRegistrationMetadata,
	): void {
		this.modelDispatch.registerModel(
			modelType,
			handler,
			provider,
			priority,
			metadata,
		);
	}

	/**
	 * Handler-free snapshot of every registered model handler, sorted by
	 * priority (descending) then registration order within each model type —
	 * the same order `getModel`/`useModel` select in. Exposes the private
	 * `models` map as metadata so hosts and observers can render a routing
	 * table or seed a mirror without touching handler functions. Pair with the
	 * {@link EventType.MODEL_REGISTERED} event to stay live.
	 */
	getModelRegistrations(): ModelRegistrationInfo[] {
		return this.modelDispatch.getModelRegistrations();
	}

	/**
	 * The runtime-selected text-model provider, or undefined to use the default
	 * (highest-priority) handler. Read from `ELIZA_BRAIN_PROVIDER` so an owner
	 * action that mutates `character.settings` (and/or persists it to config)
	 * flips the chat brain on the next model call with no restart. Returns
	 * undefined when the setting is empty OR names a provider that has no
	 * registered text handler, so a stale or mistyped value never strands the
	 * brain — it simply falls back to the default provider. The same contract
	 * holds at call time: useModel keeps the default-chain registrations behind
	 * the override as a failover tail, so a rate-limited/exhausted override
	 * provider falls to the registered backups instead of stranding the brain.
	 */
	/**
	 * Record the provider that served a successful `useModel` call, keyed by the
	 * requested model-type string. Only real (non-empty) provider names are
	 * stored so a caller reading it back never sees a fabricated value (#13623).
	 */
	private noteResolvedModelProvider(
		modelTypeKey: string,
		provider: string | undefined,
	): void {
		this.modelDispatch.noteResolvedModelProvider(modelTypeKey, provider);
	}

	/**
	 * The provider name that served the most recent successful `useModel` call
	 * for the given model type, or `undefined` if no such call has completed
	 * (so callers can fail-closed rather than fabricate a provider). Lets the
	 * trajectory stage recorders in `services/message.ts` name the real provider
	 * that answered the messageHandler / factsAndRelationships call instead of
	 * the hardcoded `"default"` literal (#13623).
	 */
	getLastResolvedModelProvider(
		modelType: ModelTypeName | string,
	): string | undefined {
		return this.modelDispatch.getLastResolvedModelProvider(modelType);
	}

	private resolveTextProviderOverride(): string | undefined {
		return this.modelDispatch.resolveTextProviderOverride();
	}

	private isCanonicalModelCapabilityDisabled(modelType: string): boolean {
		return this.modelDispatch.isCanonicalModelCapabilityDisabled(modelType);
	}

	private assertCanonicalModelCapabilityEnabled(modelType: string): void {
		this.modelDispatch.assertCanonicalModelCapabilityEnabled(modelType);
	}

	private resolveModelRegistration(
		modelType: ModelTypeName | string,
		provider?: string,
	): ResolvedModelRegistration | undefined {
		return this.modelDispatch.resolveModelRegistration(modelType, provider);
	}

	private resolveModelRegistrations(
		modelType: ModelTypeName | string,
		provider?: string,
	): ResolvedModelRegistration[] {
		return this.modelDispatch.resolveModelRegistrations(modelType, provider);
	}

	private logModelProviderFailover(args: {
		requestedModelKey: string;
		failedModel: ResolvedModelRegistration;
		nextModel: ResolvedModelRegistration;
		error: unknown;
	}): void {
		this.modelDispatch.logModelProviderFailover(args);
	}

	private shouldFailOverModelProvider(
		error: unknown,
		modelType: string,
	): boolean {
		return this.modelDispatch.shouldFailOverModelProvider(error, modelType);
	}

	private throwNoModelHandler(requestedModelKey: string): never {
		return this.modelDispatch.throwNoModelHandler(requestedModelKey);
	}

	/**
	 * Surface the failure that ends a `useModel` failover chain. A real `Error`
	 * with a message rethrows unchanged so provider SDK stack traces and typed
	 * subclasses (e.g. `NoModelProviderConfiguredError`, which the chat UI
	 * narrows on) survive the boundary. Everything else — the bare
	 * `{ status, error }` objects some providers/AI-SDK paths throw, or a
	 * message-less `Error` — becomes an `ElizaError` whose message names the
	 * provider, HTTP status, and underlying cause. Without this, a bare object
	 * stringified to the diagnostically useless "[object Object]" in logs,
	 * trajectories, and any user-surfaced failure text.
	 */
	private rethrowModelFailoverError(
		error: unknown,
		failed?: { modelKey: string; provider: string },
	): never {
		return this.modelDispatch.rethrowModelFailoverError(error, failed);
	}

	getModel(
		modelType: ModelTypeName | string,
	):
		| ((
				runtime: IAgentRuntime,
				params: Record<string, JsonValue | object>,
		  ) => Promise<JsonValue | object>)
		| undefined {
		return this.modelDispatch.getModel(modelType);
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
		return this.modelDispatch.getModelSettings(modelType);
	}

	/**
	 * Helper to log model calls to the database (used by both streaming and non-streaming paths)
	 */
	private buildRuntimeSystemPrompt(): string | undefined {
		const prompt = buildCanonicalSystemPrompt({
			character: this.character,
			userRole: getTrajectoryContext()?.userRole,
		});
		return prompt || undefined;
	}

	private attachEffectiveSystemPrompt(
		modelKey: string,
		params: unknown,
	): string | undefined {
		if (
			!TEXT_GENERATION_MODEL_KEYS.includes(modelKey) ||
			!isPlainObject(params)
		) {
			return undefined;
		}
		const paramsRecord = params as Record<
			string,
			JsonValue | object | undefined
		>;
		const systemPrompt = resolveEffectiveSystemPrompt({
			params,
			fallback: this.buildRuntimeSystemPrompt(),
		});
		if (systemPrompt !== undefined && !Object.hasOwn(paramsRecord, "system")) {
			paramsRecord.system = systemPrompt;
		}
		return systemPrompt;
	}

	/** Resolve the concrete provider model id used for final-wire budgeting. */
	private resolveRegistrationModelName(
		metadata: ModelRegistrationMetadata | undefined,
	): string | undefined {
		return this.modelDispatch.resolveRegistrationModelName(metadata);
	}

	/**
	 * Budget the exact text-generation request after runtime transforms and
	 * pre-model hooks. UTF-8 bytes are a conservative token upper bound, so the
	 * runtime can reject before a provider handler without silently rewriting
	 * any model-facing field.
	 */
	private buildFinalModelInputBudget(
		params: unknown,
		metadata: ModelRegistrationMetadata | undefined,
	) {
		return this.modelDispatch.buildFinalModelInputBudget(params, metadata);
	}

	/** Clone caller-owned request data before runtime transforms. Arrays and
	 * plain records become handler-owned; opaque transport collaborators retain
	 * identity because cloning them would change platform semantics. */
	private cloneModelRequestGraph<T>(value: T): T {
		return this.modelDispatch.cloneModelRequestGraph<T>(value);
	}

	/** Freeze the complete admitted handler payload so provider code cannot add,
	 * remove, or rewrite model-bound data after the final measurement. Only
	 * arrays and plain records belong to the request graph; platform objects
	 * such as AbortSignal remain opaque transport collaborators. */
	private freezeAdmittedModelRequest(value: unknown): void {
		this.modelDispatch.freezeAdmittedModelRequest(value);
	}

	private getFirstUserPromptFromMessages(
		messages: unknown,
	): string | undefined {
		if (!Array.isArray(messages)) {
			return undefined;
		}
		for (const message of messages) {
			if (!message || typeof message !== "object" || Array.isArray(message)) {
				continue;
			}
			const record = message as { role?: unknown; content?: unknown };
			if (record.role !== "user") {
				continue;
			}
			const content = textFromChatMessageContent(record.content);
			if (content) {
				return content;
			}
		}
		return undefined;
	}

	private logModelCall(
		modelType: string,
		modelKey: string,
		_params: unknown,
		promptContent: string | null,
		systemPrompt: string | undefined,
		elapsedTime: number,
		provider: string | undefined,
		response: unknown,
	): void {
		this.modelDispatch.logModelCall(
			modelType,
			modelKey,
			_params,
			promptContent,
			systemPrompt,
			elapsedTime,
			provider,
			response,
		);
	}

	useModel<T extends keyof ModelParamsMap, R = ModelResultMap[T]>(
		modelType: T,
		params: ModelParamsMap[T],
		provider?: string,
	): Promise<R> {
		return this.modelDispatch.useModel<T, R>(modelType, params, provider);
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
	private recordUseModelTrajectory(args: {
		modelType: string;
		resolvedModelKey: string;
		provider?: string;
		modelParams: unknown;
		promptContent: string | null | undefined;
		result?: unknown;
		response: string;
		elapsedTime: number;
		providerRecorded: boolean;
	}): Promise<void> {
		return this.modelDispatch.recordUseModelTrajectory(args);
	}

	/**
	 * Emit a failure llm-call entry for a `useModel` attempt that threw before
	 * producing a usable result. Without this, a rejected provider attempt is
	 * invisible in the trajectory: if failover succeeds, only the successful
	 * call appears and the failed (and often billed) attempt is lost; if every
	 * attempt fails, the step has zero model entries at all (#17532).
	 *
	 * Records the real error — sanitized of secrets — as the response payload
	 * with `finishReason: "error"`, and does NOT fabricate an empty response or
	 * zero token counts. Trajectory logging never breaks core model flow, so
	 * failures here are swallowed and surfaced via reportError instead.
	 */
	private recordFailedModelTrajectory(args: {
		modelType: string;
		resolvedModelKey: string;
		provider?: string;
		modelParams: unknown;
		promptContent: string | null | undefined;
		error: unknown;
		elapsedTime: number;
	}): Promise<void> {
		return this.modelDispatch.recordFailedModelTrajectory(args);
	}

	/**
	 * Simplified text generation with optional character context.
	 */
	async generateText(
		input: string,
		options?: GenerateTextOptions,
	): Promise<GenerateTextResult> {
		if (!input.trim()) {
			throw new Error("Input cannot be empty");
		}

		// Set defaults
		const includeCharacter = options?.includeCharacter ?? true;
		const modelType = options?.modelType ?? ModelType.TEXT_LARGE;

		let prompt = input;
		let system: string | undefined;

		// Add character context if requested
		if (includeCharacter && this.character) {
			const c = this.character;
			const parts: string[] = [];

			system = this.buildRuntimeSystemPrompt();

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
			system,
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
			text: response,
		};
	}
	async dynamicPromptExecFromState(
		args: Parameters<IAgentRuntime["dynamicPromptExecFromState"]>[0],
	): Promise<Record<string, unknown> | null> {
		return this.structuredPrompts.dynamicPromptExecFromState(args);
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
		const handlers = this.events[event];
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
				runtime: this,
				source: "runtime",
			};
			if (typeof params === "object" && params && params !== null) {
				const paramsObj = params as Record<string, JsonValue | object>;
				paramsWithRuntime = {
					...paramsObj,
					runtime: this,
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

	/**
	 * Diagnostic boundary for failures outside the action path (#12263). Logs
	 * with a `[scope]` prefix, records the failure in the bounded ring, emits
	 * {@link EventType.ERROR_REPORTED}, and forwards it into the
	 * AgentEventService `"error"` stream when that service is registered.
	 *
	 * Self-safe: never throws. A failure inside this method (or inside an
	 * `ERROR_REPORTED` handler it triggers) is caught and logged as a warning
	 * without re-entering `reportError`, guarded by {@link inReportError}.
	 */
	reportError(
		scope: string,
		error: unknown,
		context?: Record<string, unknown>,
	): void {
		if (this.inReportError) {
			// error-policy:J7 diagnostics-must-not-kill-the-loop — a failure while
			// reporting must not recurse; warn-only and return.
			this.logger.warn(
				{ src: "agent", scope },
				`[${scope}] reportError re-entered while already reporting; dropping nested error`,
			);
			return;
		}
		this.inReportError = true;
		try {
			const normalized = toElizaError(error);
			const merged: Record<string, unknown> | undefined =
				context || normalized.context
					? { ...normalized.context, ...context }
					: undefined;
			const runId =
				typeof merged?.runId === "string" ? (merged.runId as UUID) : undefined;
			const roomId =
				typeof merged?.roomId === "string"
					? (merged.roomId as UUID)
					: undefined;

			this.logger.error(
				{
					src: "agent",
					scope,
					code: normalized.code,
					severity: normalized.severity,
					context: merged,
					err: normalized,
				},
				`[${scope}] ${normalized.message}`,
			);

			const entry: ReportedError = {
				scope,
				code: normalized.code,
				message: normalized.message,
				context: merged,
				at: Date.now(),
			};
			this.reportedErrors.push(entry);
			if (this.reportedErrors.length > AgentRuntime.REPORTED_ERROR_RING_CAP) {
				this.reportedErrors.splice(
					0,
					this.reportedErrors.length - AgentRuntime.REPORTED_ERROR_RING_CAP,
				);
			}

			this.forwardToAgentEventStream(entry, runId);

			// Fire-and-forget: emitEvent is async but reportError is a sync
			// diagnostic one-liner. A rejected emit (bad handler) is swallowed to
			// the logger here — it must not surface as an unhandled rejection and
			// must not re-enter reportError.
			void this.emitEvent(EventType.ERROR_REPORTED, {
				runtime: this,
				source: scope,
				scope,
				code: normalized.code,
				message: normalized.message,
				context: merged,
				runId,
				roomId,
			}).catch((emitErr) => {
				// error-policy:J7 diagnostics-must-not-kill-the-loop — a broken
				// ERROR_REPORTED handler is logged, never re-reported.
				this.logger.warn(
					{ src: "agent", scope, err: emitErr },
					`[${scope}] ERROR_REPORTED emit failed`,
				);
			});
		} catch (reportErr) {
			// error-policy:J7 diagnostics-must-not-kill-the-loop — reportError is
			// the diagnostic boundary; its own failure may only warn.
			this.logger.warn(
				{ src: "agent", scope, err: reportErr },
				`[${scope}] reportError itself failed`,
			);
		} finally {
			this.inReportError = false;
		}
	}

	/** Snapshot copy of the reported-error ring (newest last). */
	getRecentReportedErrors(): ReportedError[] {
		return this.reportedErrors.map((entry) => ({ ...entry }));
	}

	/**
	 * Forward a reported error into the AgentEventService `"error"` stream when
	 * that service is registered. Duck-typed via ServiceType.AGENT_EVENT so core
	 * keeps no import edge to the service class. Best-effort: a missing or
	 * throwing service is warn-only (still inside the reportError latch).
	 */
	private forwardToAgentEventStream(
		entry: ReportedError,
		runId: UUID | undefined,
	): void {
		const service = this.getService(ServiceType.AGENT_EVENT) as {
			emit?: (event: {
				runId: string;
				stream: string;
				data: Record<string, unknown>;
			}) => void;
		} | null;
		if (!service || typeof service.emit !== "function") return;
		try {
			service.emit({
				runId: runId ?? "runtime",
				stream: "error",
				data: {
					type: "error",
					scope: entry.scope,
					code: entry.code,
					message: entry.message,
					context: entry.context,
					recoverable: true,
				},
			});
		} catch (streamErr) {
			// error-policy:J7 diagnostics-must-not-kill-the-loop — the event
			// stream is a diagnostic sink; a failure here may only warn.
			this.logger.warn(
				{ src: "agent", scope: entry.scope, err: streamErr },
				`[${entry.scope}] agent-event error stream forward failed`,
			);
		}
	}
	isEmbeddingGenerationDisabled(
		...args: Parameters<RuntimeEmbeddings["isEmbeddingGenerationDisabled"]>
	): ReturnType<RuntimeEmbeddings["isEmbeddingGenerationDisabled"]> {
		return this.embeddings.isEmbeddingGenerationDisabled(...args);
	}
	private disableEmbeddingGeneration(
		...args: Parameters<RuntimeEmbeddings["disableEmbeddingGeneration"]>
	): ReturnType<RuntimeEmbeddings["disableEmbeddingGeneration"]> {
		return this.embeddings.disableEmbeddingGeneration(...args);
	}
	private enableEmbeddingGeneration(
		...args: Parameters<RuntimeEmbeddings["enableEmbeddingGeneration"]>
	): ReturnType<RuntimeEmbeddings["enableEmbeddingGeneration"]> {
		return this.embeddings.enableEmbeddingGeneration(...args);
	}
	private warnEmbeddingGenerationSkipped(
		...args: Parameters<RuntimeEmbeddings["warnEmbeddingGenerationSkipped"]>
	): ReturnType<RuntimeEmbeddings["warnEmbeddingGenerationSkipped"]> {
		return this.embeddings.warnEmbeddingGenerationSkipped(...args);
	}
	ensureEmbeddingDimension(
		...args: Parameters<RuntimeEmbeddings["ensureEmbeddingDimension"]>
	): ReturnType<RuntimeEmbeddings["ensureEmbeddingDimension"]> {
		return this.embeddings.ensureEmbeddingDimension(...args);
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
		return this.adapter.getAgents();
	}
	async createAgent(agent: Partial<Agent>): Promise<boolean> {
		const ids = await this.adapter.createAgents([agent]);
		return ids.length > 0;
	}
	async updateAgent(agentId: UUID, agent: Partial<Agent>): Promise<boolean> {
		return this.adapter.updateAgents([{ agentId, agent }]);
	}
	async deleteAgent(agentId: UUID): Promise<boolean> {
		return this.adapter.deleteAgents([agentId]);
	}
	async countAgents(): Promise<number> {
		return this.adapter.countAgents();
	}
	async cleanupAgents(): Promise<void> {
		return this.adapter.cleanupAgents();
	}

	// Batch agent methods
	async getAgentsByIds(agentIds: UUID[]): Promise<Agent[]> {
		return this.adapter.getAgentsByIds(agentIds);
	}
	async createAgents(agents: Partial<Agent>[]): Promise<UUID[]> {
		return this.adapter.createAgents(agents);
	}
	async upsertAgents(agents: Partial<Agent>[]): Promise<void> {
		return this.adapter.upsertAgents(agents);
	}
	async updateAgents(
		updates: Array<{ agentId: UUID; agent: Partial<Agent> }>,
	): Promise<boolean> {
		return this.adapter.updateAgents(updates);
	}
	async deleteAgents(agentIds: UUID[]): Promise<boolean> {
		return this.adapter.deleteAgents(agentIds);
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
		if (!entities.length) return null;
		return entities[0];
	}

	async getEntitiesForRooms(
		roomIds: UUID[],
		includeComponents?: boolean,
	): Promise<import("./types/database").EntitiesForRoomsResult> {
		return this.adapter.getEntitiesForRooms(roomIds, includeComponents);
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
		this.invalidateTurnEntityDetails();
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
		await this.adapter.upsertEntities(entities);
		this.invalidateTurnEntityDetails();
	}

	async getComponents(
		entityId: UUID,
		worldId?: UUID,
		sourceEntityId?: UUID,
	): Promise<Component[]> {
		return this.adapter.getComponentsForEntities(
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
		return this.adapter.getComponentsByNaturalKeys(keys);
	}

	async getComponentsForEntities(
		entityIds: UUID[],
		worldId?: UUID,
		sourceEntityId?: UUID,
	): Promise<Component[]> {
		return this.adapter.getComponentsForEntities(
			entityIds,
			worldId,
			sourceEntityId,
		);
	}
	addEmbeddingToMemory(
		...args: Parameters<RuntimeEmbeddings["addEmbeddingToMemory"]>
	): ReturnType<RuntimeEmbeddings["addEmbeddingToMemory"]> {
		return this.embeddings.addEmbeddingToMemory(...args);
	}
	private reembedMemoriesByIds(
		...args: Parameters<RuntimeEmbeddings["reembedMemoriesByIds"]>
	): ReturnType<RuntimeEmbeddings["reembedMemoriesByIds"]> {
		return this.embeddings.reembedMemoriesByIds(...args);
	}
	queueEmbeddingGeneration(
		...args: Parameters<RuntimeEmbeddings["queueEmbeddingGeneration"]>
	): ReturnType<RuntimeEmbeddings["queueEmbeddingGeneration"]> {
		return this.embeddings.queueEmbeddingGeneration(...args);
	}
	async getMemories(params: {
		entityId?: UUID;
		authorEntityIds?: UUID[];
		agentId?: UUID;
		roomId?: UUID;
		excludeRoomIds?: UUID[];
		limit?: number;
		count?: number;
		offset?: number;
		cursor?: { createdAt: number; id: UUID };
		unique?: boolean;
		tableName: string;
		start?: number;
		end?: number;
		worldId?: UUID;
		metadata?: Record<string, unknown>;
		textContains?: string;
		orderBy?: "createdAt";
		orderDirection?: "asc" | "desc";
		includeEmbedding?: boolean;
		accessContext?: AccessContext;
	}): Promise<Memory[]> {
		const coalesced = this.coalesceRoomMessagesScan(params);
		if (coalesced) return coalesced;
		return this.adapter.getMemories({
			...params,
			limit: params.limit ?? params.count,
			tableName: params.tableName,
		});
	}

	/**
	 * Single-flight coalescing for the compose-time room messages-scan. Several
	 * providers issue the same newest-first `messages` window at different
	 * limits within one turn (RECENT_MESSAGES at conversationLength, FACTS at
	 * 10, ATTACHMENTS at ≤50, REPLY_CONTEXT's dedupe window); one superset
	 * fetch serves them all, sliced per caller. Only the exact newest-first
	 * room-scoped shape is eligible — any filter, ordering, pagination, or
	 * access-context variation falls through to the adapter untouched, so this
	 * can narrow no query's semantics.
	 *
	 * Slicing is exact, not approximate: the adapter orders newest-first
	 * (createdAt desc, id desc), so the superset's first `limit` rows are
	 * byte-identical to a direct `limit`-bounded query. A `start` bound (the
	 * compaction cutoff) is a pure suffix predicate on that ordering — every
	 * row ≥ start is newer than every row < start — so filtering the superset
	 * then slicing reproduces the adapter's start+limit result for any
	 * requested limit ≤ the fetched window. Requests larger than the window
	 * bypass the memo entirely rather than risk a truncated result.
	 *
	 * Returns null when the query shape is not eligible.
	 */
	private coalesceRoomMessagesScan(params: {
		entityId?: UUID;
		authorEntityIds?: UUID[];
		agentId?: UUID;
		roomId?: UUID;
		excludeRoomIds?: UUID[];
		limit?: number;
		count?: number;
		offset?: number;
		cursor?: { createdAt: number; id: UUID };
		unique?: boolean;
		tableName: string;
		start?: number;
		end?: number;
		worldId?: UUID;
		metadata?: Record<string, unknown>;
		textContains?: string;
		orderBy?: "createdAt";
		orderDirection?: "asc" | "desc";
		includeEmbedding?: boolean;
		accessContext?: AccessContext;
	}): Promise<Memory[]> | null {
		if (params.tableName !== "messages" || !params.roomId) return null;
		if (
			params.entityId !== undefined ||
			params.authorEntityIds !== undefined ||
			params.agentId !== undefined ||
			params.excludeRoomIds !== undefined ||
			params.worldId !== undefined ||
			params.unique ||
			(params.offset !== undefined && params.offset !== 0) ||
			params.cursor !== undefined ||
			params.end !== undefined ||
			params.metadata !== undefined ||
			params.textContains !== undefined ||
			params.orderDirection === "asc" ||
			// The coalesced superset scan omits includeEmbedding, so it can only serve
			// callers that don't pin the flag either way — a `true` caller would get
			// embedding-less rows from an adapter that honors it, a `false` caller would
			// get embeddings it asked to skip. Bypass the memo whenever it's set.
			params.includeEmbedding !== undefined ||
			params.accessContext !== undefined
		) {
			return null;
		}
		const requestedLimit = params.limit ?? params.count;
		// A caller that pins no limit asks for the room's complete retained
		// window — the shape the prompt-integrity providers (RECENT_MESSAGES,
		// FACTS, ATTACHMENTS) now use after they stopped capping model-facing
		// history. Treat it as an infinite request so it still coalesces: the
		// superset fetch drops the limit, `meta` records an unbounded window,
		// and no bounded cache entry can ever serve it (Infinity fails the
		// superset check), so coalescing can never shorten a complete read.
		const unbounded = requestedLimit === undefined;
		if (
			!unbounded &&
			(typeof requestedLimit !== "number" ||
				!Number.isFinite(requestedLimit) ||
				requestedLimit <= 0)
		) {
			return null;
		}
		const requested = unbounded
			? Number.POSITIVE_INFINITY
			: (requestedLimit as number);
		const roomId = params.roomId;
		const supersetLimit = unbounded
			? Number.POSITIVE_INFINITY
			: Math.max(
					requested,
					this.getConversationLength(),
					AgentRuntime.ROOM_MESSAGES_MEMO_MIN_WINDOW,
				);
		const cached = this.roomMessagesMemo.peek(roomId);
		const window =
			cached && cached.meta >= requested
				? cached.promise
				: this.roomMessagesMemo.put(
						roomId,
						supersetLimit,
						this.adapter.getMemories({
							tableName: "messages",
							roomId,
							...(unbounded ? {} : { limit: supersetLimit }),
							unique: false,
						}),
					);
		const start = params.start;
		return window.then((rows) => {
			const filtered =
				start !== undefined
					? rows.filter((row) => (row.createdAt ?? 0) >= start)
					: rows;
			// Fresh array per caller (consumers sort/filter in place); the Memory
			// objects themselves are shared read-only, like the turn state cache.
			return filtered.slice(0, requested);
		});
	}
	async getAllMemories(): Promise<Memory[]> {
		// Every partition the platform writes memory rows into. This list is a
		// load-bearing contract: the media GC builds its referenced-set from it
		// (packages/agent media-runtime), so a partition missing here makes that
		// partition's media references invisible to the sweep and its files get
		// deleted after the grace window — "transcripts" rows anchor retained
		// recordings via the audioUrl inside content.transcript (#14751). It also
		// bounds clearAllAgentMemories: an unlisted partition survives a wipe.
		const tables = [
			"memories",
			"messages",
			"facts",
			"documents",
			"transcripts",
		];
		const allMemories: Memory[] = [];

		for (const tableName of tables) {
			// Paginate until a short page: a single 10k-bounded read silently
			// truncates a larger partition, and the media GC would then delete
			// files referenced only by rows past the cap as "orphaned".
			//
			// Accepted race (wave-5 audit, W5-022): offset pagination is the only
			// mechanism the IDatabaseAdapter contract guarantees — it has no
			// unique-key cursor, and `createdAt` is optional and non-unique, so
			// keyset pagination cannot be expressed through the interface. A
			// `deleteMemory` racing the sweep shifts later pages up and can skip
			// a row; media referenced only by that row is then collected after
			// the grace window. The window is narrow (a delete must race the
			// daily task) and the grace window protects fresh media, so this is
			// documented rather than re-architected.
			for (let offset = 0; ; offset += GET_ALL_MEMORIES_PAGE_SIZE) {
				const memories = await this.adapter.getMemories({
					agentId: this.agentId,
					tableName,
					limit: GET_ALL_MEMORIES_PAGE_SIZE,
					offset,
				});
				allMemories.push(...memories);
				if (memories.length < GET_ALL_MEMORIES_PAGE_SIZE) break;
			}
		}

		return allMemories;
	}
	async getMemoriesByIds(ids: UUID[], tableName?: string): Promise<Memory[]> {
		return this.adapter.getMemoriesByIds(ids, tableName);
	}
	async getMemoriesByRoomIds(params: {
		tableName: string;
		roomIds: UUID[];
		limit?: number;
		offset?: number;
		textContains?: string;
		includeEmbedding?: boolean;
		accessContext?: AccessContext;
	}): Promise<Memory[]> {
		return this.adapter.getMemoriesByRoomIds(params);
	}
	async searchMessages(params: {
		roomIds: UUID[];
		query: string;
		tableName?: string;
		limit?: number;
		offset?: number;
		since?: number;
		until?: number;
		accessContext?: AccessContext;
	}): Promise<MessageSearchHit[]> {
		return this.adapter.searchMessages(params);
	}
	clearEmbeddingsOutsideActiveDimension(
		...args: Parameters<
			RuntimeEmbeddings["clearEmbeddingsOutsideActiveDimension"]
		>
	): ReturnType<RuntimeEmbeddings["clearEmbeddingsOutsideActiveDimension"]> {
		return this.embeddings.clearEmbeddingsOutsideActiveDimension(...args);
	}
	getCachedEmbeddings(
		...args: Parameters<RuntimeEmbeddings["getCachedEmbeddings"]>
	): ReturnType<RuntimeEmbeddings["getCachedEmbeddings"]> {
		return this.embeddings.getCachedEmbeddings(...args);
	}
	async searchMemories(params: {
		embedding: number[];
		query?: string;
		match_threshold?: number;
		count?: number;
		limit?: number;
		offset?: number;
		roomId?: UUID;
		unique?: boolean;
		worldId?: UUID;
		entityId?: UUID;
		tableName: string;
		accessContext?: AccessContext;
	}): Promise<Memory[]> {
		const memories = await this.adapter.searchMemories({
			...params,
			tableName: params.tableName,
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
		const rankedIndexes = new Set(results.map((result) => result.index));
		const rerankedMemories = results.map((result) => memories[result.index]);

		// BM25 is a reranker, not a filter. Keep zero-overlap vector hits
		// after scored matches so semantic recall cannot disappear.
		for (let index = 0; index < memories.length; index++) {
			if (!rankedIndexes.has(index)) {
				rerankedMemories.push(memories[index]);
			}
		}

		return rerankedMemories;
	}
	/**
	 * Get the secrets to redact from character settings.
	 * Returns an empty object if no secrets are configured.
	 */
	private getSecretsForRedaction(): Record<string, string> {
		const secrets = this.character.settings?.secrets;
		if (!secrets || typeof secrets !== "object") {
			return {};
		}
		// Preserve declared non-credential configuration in model context.
		// Other secret strings retain literal redaction and the pattern sweep.
		const result: Record<string, string> = {};
		for (const [key, value] of Object.entries(secrets)) {
			if (NON_CREDENTIAL_SECRET_KEYS.has(key.trim().toUpperCase())) continue;
			if (typeof value === "string" && value.length > 0) {
				result[key] = value;
			}
		}
		return result;
	}

	/**
	 * Redact secrets from text content.
	 * This prevents character secrets from appearing in outputs or memories.
	 *
	 * The pattern library runs even when the character configures no secrets:
	 * default/minimal characters are exactly the ones whose reported errors and
	 * provider texts can still carry credential-shaped values (API keys, Bearer
	 * tokens, URI userinfo). `redactWithSecrets` treats an empty secrets map as
	 * a no-op for the literal pass, and its pattern regexps are compiled once at
	 * module load, so the always-on scrub costs one pattern sweep per call.
	 */
	redactSecrets(text: string): string {
		if (!text) {
			return text;
		}
		const secrets = this.getSecretsForRedaction();
		return redactWithSecrets(text, { secrets, applyPatterns: true });
	}

	locateConfiguredSecretFragmentTaint(
		fragments: readonly SecretFragment[],
	): SecretFragmentTaintProfile {
		const secrets = this.getSecretsForRedaction();
		const signature = createHash("sha256")
			.update(
				JSON.stringify(
					[
						...new Set(
							Object.values(secrets).filter(
								(value) => value.length >= MIN_SECRET_LENGTH,
							),
						),
					].sort(),
				),
			)
			.digest("hex");
		if (signature !== this.secretRedactionProfileSignature) {
			this.secretRedactionProfileSignature = signature;
			this.secretRedactionProfileRevision += 1;
		}
		return {
			...locateConfiguredSecretFragmentTaint(fragments, secrets),
			profileRevision: this.secretRedactionProfileRevision,
		};
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
		this.roomMessagesMemo.invalidate();
		this.logger.info(
			{ src: "agent", agentId: this.agentId, count: memoryIds.length },
			"Memories cleared",
		);
	}
	async deleteAllMemories(roomIds: UUID[], tableName: string): Promise<void> {
		await this.adapter.deleteAllMemories(roomIds, tableName);
		if (tableName === "messages") {
			for (const roomId of roomIds) this.roomMessagesMemo.invalidate(roomId);
		}
	}
	async countMemories(
		roomIdOrParams:
			| UUID
			| {
					roomId?: UUID;
					/** The IAgentRuntime/adapter param form. The implementation
					 * previously read only `roomId` and silently dropped this,
					 * turning interface-correct room-scoped counts into TABLE-WIDE
					 * ones (/reset reported "cleared 31k message(s)" for a
					 * 40-message room). */
					roomIds?: UUID[];
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
			return this.adapter.countMemories({
				roomIds: [roomIdOrParams as UUID],
				unique,
				tableName: tableName ?? "messages",
			});
		}
		return this.adapter.countMemories({
			roomIds:
				roomIdOrParams.roomIds ??
				(roomIdOrParams.roomId ? [roomIdOrParams.roomId] : undefined),
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
		return this.adapter.getLogs(params);
	}
	// Batch log methods
	async getLogsByIds(logIds: UUID[]): Promise<Log[]> {
		return this.adapter.getLogsByIds(logIds);
	}

	async createLogs(
		params: Array<{
			body: LogBody;
			entityId: UUID;
			roomId: UUID;
			type: string;
		}>,
	): Promise<void> {
		return this.adapter.createLogs(params);
	}

	async updateLogs(
		logs: Array<{ id: UUID; updates: Partial<Log> }>,
	): Promise<void> {
		return this.adapter.updateLogs(logs);
	}

	async deleteLogs(logIds: UUID[]): Promise<void> {
		return this.adapter.deleteLogs(logIds);
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
		return this.adapter.getAllWorlds();
	}
	async updateWorld(world: World): Promise<void> {
		await this.adapter.updateWorlds([world]);
	}

	// Batch world methods
	async getWorldsByIds(worldIds: UUID[]): Promise<World[]> {
		return this.adapter.getWorldsByIds(worldIds);
	}
	async createWorlds(worlds: World[]): Promise<UUID[]> {
		return this.adapter.createWorlds(worlds);
	}
	async upsertWorlds(worlds: World[]): Promise<void> {
		return this.adapter.upsertWorlds(worlds);
	}
	async deleteWorlds(worldIds: UUID[]): Promise<void> {
		await this.adapter.deleteWorlds(worldIds);
	}
	async updateWorlds(worlds: World[]): Promise<void> {
		await this.adapter.updateWorlds(worlds);
	}

	async getRoom(roomId: UUID): Promise<Room | null> {
		// Coalesced: a Stage-1 compose resolves the same room several times in
		// parallel; share one in-flight adapter query. Room mutators below
		// invalidate the key, so a create/update/delete is visible immediately.
		const cached = this.roomReadMemo.peek(roomId);
		if (cached) return cached.promise;
		return this.roomReadMemo.put(
			roomId,
			undefined,
			(async () => {
				const rooms = await this.adapter.getRoomsByIds([roomId]);
				return rooms[0] ?? null;
			})(),
		);
	}

	async getRoomsByIds(roomIds: UUID[]): Promise<Room[]> {
		return this.adapter.getRoomsByIds(roomIds);
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
		// Bust a possibly-memoized null from a pre-creation lookup.
		this.roomReadMemo.invalidate(res[0]);
		if (id) this.roomReadMemo.invalidate(id);
		return res[0];
	}

	async createRooms(rooms: Room[]): Promise<UUID[]> {
		const ids = await this.adapter.createRooms(rooms);
		for (const roomId of ids) this.roomReadMemo.invalidate(roomId);
		return ids;
	}
	async upsertRooms(rooms: Room[]): Promise<void> {
		await this.adapter.upsertRooms(rooms);
		for (const room of rooms) {
			if (room.id) this.roomReadMemo.invalidate(room.id);
		}
	}

	async deleteRoomsByWorldId(worldId: UUID): Promise<void> {
		await this.adapter.deleteRoomsByWorldIds([worldId]);
		// Room ids under the world are unknown here; drop everything.
		this.roomReadMemo.invalidate();
		this.roomMessagesMemo.invalidate();
	}
	async getRoomsForParticipant(entityId: UUID): Promise<UUID[]> {
		return this.adapter.getRoomsForParticipants([entityId]);
	}

	async getRoomsForParticipants(entityIds: UUID[]): Promise<UUID[]> {
		return this.adapter.getRoomsForParticipants(entityIds);
	}

	// deprecate this one
	async getRooms(worldId: UUID): Promise<Room[]> {
		return this.adapter.getRoomsByWorlds([worldId]);
	}

	async getRoomsByWorld(worldId: UUID): Promise<Room[]> {
		return this.adapter.getRoomsByWorlds([worldId]);
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
		return this.adapter.getParticipantUserStates(pairs);
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
		return this.adapter.getRelationships({
			entityIds,
			tags: params.tags,
			limit: params.limit,
			offset: params.offset,
		});
	}
	// Batch cache methods
	async getCaches<T>(keys: string[]): Promise<Map<string, T>> {
		return this.adapter.getCaches<T>(keys);
	}

	async setCaches<T>(
		entries: Array<{ key: string; value: T }>,
	): Promise<boolean> {
		return this.adapter.setCaches<T>(entries);
	}

	async deleteCaches(keys: string[]): Promise<boolean> {
		return this.adapter.deleteCaches(keys);
	}

	async getTasks(params: {
		roomId?: UUID;
		worldId?: UUID;
		tags?: string[];
		entityId?: UUID;
		limit?: number;
		offset?: number;
	}): Promise<Task[]> {
		validateTaskQueryPagination(params);
		return this.adapter.getTasks({ ...params, agentIds: [this.agentId] });
	}
	async getTasksByName(name: string): Promise<Task[]> {
		return this.adapter.getTasksByName(name);
	}

	/** WHY fire-and-forget: Notify companion that tasks changed so it can poll/process; no need to block. */
	private _notifyCompanionTasksDirty(): void {
		if (!this.companionUrl) return;
		const url = `${this.companionUrl.replace(/\/$/, "")}/task-dirty`;
		void this.fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ agentId: this.agentId }),
		}).catch((err) =>
			// error-policy:J7 diagnostics-must-not-kill-the-loop — the notify is
			// fire-and-forget (no need to block), but a dead companion means tasks
			// stop being processed, so the failure must surface.
			this.reportError("AgentRuntime.companionTasksDirty", err, {
				url,
				agentId: this.agentId,
			}),
		);
	}

	/**
	 * Nudge the local TaskService (same process) so its dirty-gated tick re-queries the DB.
	 * WHY: the companion POST above only reaches a REMOTE receiver; without this, in-process
	 * task mutations never re-arm the tick and tasks created after boot are never seen.
	 */
	private _markLocalTasksDirty(): void {
		const taskService = this.getService<TaskService>(ServiceType.TASK);
		taskService?.markDirty();
	}

	async createTask(task: Task): Promise<UUID> {
		const ids = await this.adapter.createTasks([task]);
		this._markLocalTasksDirty();
		this._notifyCompanionTasksDirty();
		return ids[0];
	}

	async getTask(id: UUID): Promise<Task | null> {
		const tasks = await this.adapter.getTasksByIds([id]);
		return tasks[0] ?? null;
	}

	async updatePendingTask(id: UUID, task: Partial<Task>): Promise<boolean> {
		const updated =
			(await this.adapter.updatePendingTask?.call(this.adapter, id, task)) ??
			false;
		if (updated) {
			this._markLocalTasksDirty();
			this._notifyCompanionTasksDirty();
		}
		return updated;
	}

	async updateTask(id: UUID, task: Partial<Task>): Promise<void> {
		await this.adapter.updateTasks([{ id, task }]);
		this._markLocalTasksDirty();
		this._notifyCompanionTasksDirty();
	}

	async deleteTask(id: UUID): Promise<void> {
		await this.adapter.deleteTasks([id]);
		this._markLocalTasksDirty();
	}

	async log(params: {
		body: LogBody;
		entityId: UUID;
		roomId: UUID;
		type: string;
	}): Promise<void> {
		return this.adapter.createLogs([params]);
	}

	async deleteLog(logId: UUID): Promise<void> {
		return this.adapter.deleteLogs([logId]);
	}

	async getCache<T>(key: string): Promise<T | undefined> {
		const caches = await this.adapter.getCaches<T>([key]);
		return caches.get(key);
	}

	async setCache<T>(key: string, value: T): Promise<boolean> {
		return this.adapter.setCaches<T>([{ key, value }]);
	}

	async deleteCache(key: string): Promise<boolean> {
		return this.adapter.deleteCaches([key]);
	}

	/**
	 * Compare-and-swap a cache row under an optimistic revision; delegates to
	 * the adapter contract (see IDatabaseAdapter.compareAndSwapCache).
	 */
	async compareAndSwapCache<T>(
		key: string,
		expectedRevision: number | null,
		nextRevision: number,
		value: T,
	): Promise<boolean> {
    const adapter = this.adapter as {
      compareAndSwapCache?: <T>(
        key: string,
        expectedRevision: number | null,
        nextRevision: number,
        value: T,
      ) => Promise<boolean>;
    };
    if (typeof adapter.compareAndSwapCache !== "function") {
      throw new ElizaError(
        "Adapter does not support compare-and-swap cache operations",
        {
          code: "CONTENT_MANIFEST_CAS_UNSUPPORTED",
          context: { operation: "compareAndSwapCache" },
        },
      );
    }
    return adapter.compareAndSwapCache<T>(
			key,
			expectedRevision,
			nextRevision,
			value,
		);
	}

	// Batch task methods
	async createTasks(tasks: Task[]): Promise<UUID[]> {
		const ids = await this.adapter.createTasks(tasks);
		this._markLocalTasksDirty();
		this._notifyCompanionTasksDirty();
		return ids;
	}

	async getTasksByIds(taskIds: UUID[]): Promise<Task[]> {
		return this.adapter.getTasksByIds(taskIds);
	}

	async updateTasks(
		updates: Array<{ id: UUID; task: Partial<Task> }>,
	): Promise<void> {
		await this.adapter.updateTasks(updates);
		this._markLocalTasksDirty();
		this._notifyCompanionTasksDirty();
	}

	async deleteTasks(taskIds: UUID[]): Promise<void> {
		await this.adapter.deleteTasks(taskIds);
		this._markLocalTasksDirty();
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
		return this.adapter.transaction(callback, options);
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
		validateQueryEntitiesPagination(params);
		return this.adapter.queryEntities({
			...params,
			agentId: params.agentId ?? this.agentId,
		});
	}

	// Batch entity methods
	async getEntitiesByIds(entityIds: UUID[]): Promise<Entity[]> {
		return this.adapter.getEntitiesByIds(entityIds);
	}

	updateEntities(entities: Entity[]): Promise<void> {
		return this.dataMutations.updateEntities(entities);
	}

	deleteEntities(entityIds: UUID[]): Promise<void> {
		return this.dataMutations.deleteEntities(entityIds);
	}
	async searchEntitiesByName(params: {
		query: string;
		agentId?: UUID;
		limit?: number;
	}): Promise<Entity[]> {
		return this.adapter.searchEntitiesByName({
			query: params.query,
			agentId: params.agentId ?? this.agentId,
			limit: params.limit,
		});
	}
	async getEntitiesByNames(params: {
		names: string[];
		agentId?: UUID;
	}): Promise<Entity[]> {
		return this.adapter.getEntitiesByNames({
			names: params.names,
			agentId: params.agentId ?? this.agentId,
		});
	}

	// Single-item entity wrapper
	updateEntity(entity: Entity): Promise<void> {
		return this.dataMutations.updateEntity(entity);
	}

	// Batch component methods
	createComponents(components: Component[]): Promise<UUID[]> {
		return this.dataMutations.createComponents(components);
	}

	async getComponentsByIds(componentIds: UUID[]): Promise<Component[]> {
		return this.adapter.getComponentsByIds(componentIds);
	}

	updateComponents(components: Component[]): Promise<void> {
		return this.dataMutations.updateComponents(components);
	}

	deleteComponents(componentIds: UUID[]): Promise<void> {
		return this.dataMutations.deleteComponents(componentIds);
	}

	// Single-item component wrappers
	createComponent(component: Component): Promise<boolean> {
		return this.dataMutations.createComponent(component);
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

	updateComponent(component: Component): Promise<void> {
		return this.dataMutations.updateComponent(component);
	}

	deleteComponent(componentId: UUID): Promise<void> {
		return this.dataMutations.deleteComponent(componentId);
	}

	upsertComponent(component: Component): Promise<void> {
		return this.dataMutations.upsertComponent(component);
	}

	upsertComponents(
		components: Component[],
		options?: { entityContext?: UUID },
	): Promise<void> {
		return this.dataMutations.upsertComponents(components, options);
	}

	patchComponent(
		componentId: UUID,
		ops: PatchOp[],
		options?: { entityContext?: UUID },
	): Promise<void> {
		return this.dataMutations.patchComponent(componentId, ops, options);
	}

	patchComponents(
		updates: Array<{ componentId: UUID; ops: PatchOp[] }>,
		options?: { entityContext?: UUID },
	): Promise<void> {
		return this.dataMutations.patchComponents(updates, options);
	}

	patchComponentField(
		componentId: UUID,
		op: PatchOp,
		options?: { entityContext?: UUID },
	): Promise<void> {
		return this.dataMutations.patchComponentField(componentId, op, options);
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

	upsertMemory(
		memory: Memory,
		tableName: string,
		options?: { entityContext?: UUID },
	): Promise<void> {
		return this.dataMutations.upsertMemory(memory, tableName, options);
	}

	upsertMemories(
		memories: Array<{ memory: Memory; tableName: string }>,
		options?: { entityContext?: UUID },
	): Promise<void> {
		return this.dataMutations.upsertMemories(memories, options);
	}

	// Batch relationship methods
	createRelationships(
		relationships: Array<{
			sourceEntityId: UUID;
			targetEntityId: UUID;
			tags?: string[];
			metadata?: Metadata;
		}>,
	): Promise<UUID[]> {
		return this.dataMutations.createRelationships(relationships);
	}

	async getRelationshipsByIds(
		relationshipIds: UUID[],
	): Promise<Relationship[]> {
		return this.adapter.getRelationshipsByIds(relationshipIds);
	}

	async getRelationshipsByPairs(
		pairs: Array<{ sourceEntityId: UUID; targetEntityId: UUID }>,
	): Promise<(Relationship | null)[]> {
		return this.adapter.getRelationshipsByPairs(pairs);
	}

	updateRelationships(relationships: Relationship[]): Promise<void> {
		return this.dataMutations.updateRelationships(relationships);
	}

	deleteRelationships(relationshipIds: UUID[]): Promise<void> {
		return this.dataMutations.deleteRelationships(relationshipIds);
	}

	// Single-item relationship wrappers
	createRelationship(params: {
		sourceEntityId: UUID;
		targetEntityId: UUID;
		tags?: string[];
		metadata?: Metadata;
	}): Promise<boolean> {
		return this.dataMutations.createRelationship(params);
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

	updateRelationship(relationship: Relationship): Promise<void> {
		return this.dataMutations.updateRelationship(relationship);
	}

	// ── Batch memory passthroughs ────────────────────────────────────────
	// These go straight to the adapter with no transformation.
	// WHY no redaction here: batch callers are responsible for their own
	// content. The single-item createMemory() wrapper below handles
	// redaction for the common case.
	createMemories(
		memories: Array<{ memory: Memory; tableName: string; unique?: boolean }>,
	): Promise<UUID[]> {
		return this.dataMutations.createMemories(memories);
	}

	updateMemories(
		memories: Array<Partial<Memory> & { id: UUID; metadata?: MemoryMetadata }>,
	): Promise<void> {
		return this.dataMutations.updateMemories(memories);
	}

	deleteMemories(memoryIds: UUID[]): Promise<void> {
		return this.dataMutations.deleteMemories(memoryIds);
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
	createMemory(
		memory: Memory,
		tableName: string,
		unique?: boolean,
	): Promise<UUID> {
		return this.dataMutations.createMemory(memory, tableName, unique);
	}

	updateMemory(
		memory: Partial<Memory> & { id: UUID; metadata?: MemoryMetadata },
	): Promise<boolean> {
		return this.dataMutations.updateMemory(memory);
	}

	deleteMemory(memoryId: UUID): Promise<void> {
		return this.dataMutations.deleteMemory(memoryId);
	}

	// ── Participant passthroughs & wrappers ──────────────────────────────
	deleteParticipants(
		participants: Array<{ entityId: UUID; roomId: UUID }>,
	): Promise<boolean> {
		return this.dataMutations.deleteParticipants(participants);
	}

	updateParticipants(
		participants: Array<{
			entityId: UUID;
			roomId: UUID;
			updates: Partial<Participant>;
		}>,
	): Promise<void> {
		return this.dataMutations.updateParticipants(participants);
	}

	removeParticipant(entityId: UUID, roomId: UUID): Promise<boolean> {
		return this.dataMutations.removeParticipant(entityId, roomId);
	}

	// ── Room passthroughs & wrappers ────────────────────────────────────
	updateRooms(rooms: Room[]): Promise<void> {
		return this.dataMutations.updateRooms(rooms);
	}

	deleteRooms(roomIds: UUID[]): Promise<void> {
		return this.dataMutations.deleteRooms(roomIds);
	}

	// Single-item room wrappers
	updateRoom(room: Room): Promise<void> {
		return this.dataMutations.updateRoom(room);
	}

	deleteRoom(roomId: UUID): Promise<void> {
		return this.dataMutations.deleteRoom(roomId);
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
	registerSendHandler(
		...args: Parameters<RuntimeConnectorRegistry["registerSendHandler"]>
	): ReturnType<RuntimeConnectorRegistry["registerSendHandler"]> {
		return this.#connectorRegistry.registerSendHandler(...args);
	}
	registerInternalSendHandler(
		...args: Parameters<RuntimeConnectorRegistry["registerInternalSendHandler"]>
	): ReturnType<RuntimeConnectorRegistry["registerInternalSendHandler"]> {
		return this.#connectorRegistry.registerInternalSendHandler(...args);
	}
	registerMessageConnector(
		...args: Parameters<RuntimeConnectorRegistry["registerMessageConnector"]>
	): ReturnType<RuntimeConnectorRegistry["registerMessageConnector"]> {
		return this.#connectorRegistry.registerMessageConnector(...args);
	}
	unregisterMessageConnector(
		...args: Parameters<RuntimeConnectorRegistry["unregisterMessageConnector"]>
	): ReturnType<RuntimeConnectorRegistry["unregisterMessageConnector"]> {
		return this.#connectorRegistry.unregisterMessageConnector(...args);
	}
	getMessageConnectors(
		...args: Parameters<RuntimeConnectorRegistry["getMessageConnectors"]>
	): ReturnType<RuntimeConnectorRegistry["getMessageConnectors"]> {
		return this.#connectorRegistry.getMessageConnectors(...args);
	}
	registerPostConnector(
		...args: Parameters<RuntimeConnectorRegistry["registerPostConnector"]>
	): ReturnType<RuntimeConnectorRegistry["registerPostConnector"]> {
		return this.#connectorRegistry.registerPostConnector(...args);
	}
	unregisterPostConnector(
		...args: Parameters<RuntimeConnectorRegistry["unregisterPostConnector"]>
	): ReturnType<RuntimeConnectorRegistry["unregisterPostConnector"]> {
		return this.#connectorRegistry.unregisterPostConnector(...args);
	}
	getPostConnectors(
		...args: Parameters<RuntimeConnectorRegistry["getPostConnectors"]>
	): ReturnType<RuntimeConnectorRegistry["getPostConnectors"]> {
		return this.#connectorRegistry.getPostConnectors(...args);
	}
	sendMessageToTarget(
		...args: Parameters<RuntimeConnectorRegistry["sendMessageToTarget"]>
	): ReturnType<RuntimeConnectorRegistry["sendMessageToTarget"]> {
		return this.#connectorRegistry.sendMessageToTarget(...args);
	}
	editMessageOnTarget(
		...args: Parameters<RuntimeConnectorRegistry["editMessageOnTarget"]>
	): ReturnType<RuntimeConnectorRegistry["editMessageOnTarget"]> {
		return this.#connectorRegistry.editMessageOnTarget(...args);
	}
	sendTypingOnTarget(
		...args: Parameters<RuntimeConnectorRegistry["sendTypingOnTarget"]>
	): ReturnType<RuntimeConnectorRegistry["sendTypingOnTarget"]> {
		return this.#connectorRegistry.sendTypingOnTarget(...args);
	}
	stopTypingOnTarget(
		...args: Parameters<RuntimeConnectorRegistry["stopTypingOnTarget"]>
	): ReturnType<RuntimeConnectorRegistry["stopTypingOnTarget"]> {
		return this.#connectorRegistry.stopTypingOnTarget(...args);
	}
	createThreadOnTarget(
		...args: Parameters<RuntimeConnectorRegistry["createThreadOnTarget"]>
	): ReturnType<RuntimeConnectorRegistry["createThreadOnTarget"]> {
		return this.#connectorRegistry.createThreadOnTarget(...args);
	}
	postToThreadOnTarget(
		...args: Parameters<RuntimeConnectorRegistry["postToThreadOnTarget"]>
	): ReturnType<RuntimeConnectorRegistry["postToThreadOnTarget"]> {
		return this.#connectorRegistry.postToThreadOnTarget(...args);
	}
	addReactionOnTarget(
		...args: Parameters<RuntimeConnectorRegistry["addReactionOnTarget"]>
	): ReturnType<RuntimeConnectorRegistry["addReactionOnTarget"]> {
		return this.#connectorRegistry.addReactionOnTarget(...args);
	}

	async getMemoriesByWorldId(params: {
		worldId: UUID;
		limit?: number;
		tableName?: string;
	}): Promise<Memory[]> {
		return this.adapter.getMemoriesByWorldId(params);
	}
	async runMigrations(migrationsPaths?: string[]): Promise<void> {
		if (this.adapter.runMigrations) {
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
		return this.adapter.isReady();
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
		queries: import("./types/pairing").PairingRequestQuery[],
	): Promise<import("./types/database").PairingRequestsResult> {
		return this.adapter.getPairingRequests(queries);
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
		queries: import("./types/pairing").PairingAllowlistQuery[],
	): Promise<import("./types/database").PairingAllowlistsResult> {
		return this.adapter.getPairingAllowlists(queries);
	}

	// Batch pairing methods
	async createPairingRequests(requests: PairingRequest[]): Promise<UUID[]> {
		return this.adapter.createPairingRequests(requests);
	}

	async updatePairingRequests(requests: PairingRequest[]): Promise<void> {
		return this.adapter.updatePairingRequests(requests);
	}

	async deletePairingRequests(ids: UUID[]): Promise<void> {
		return this.adapter.deletePairingRequests(ids);
	}

	async createPairingAllowlistEntries(
		entries: PairingAllowlistEntry[],
	): Promise<UUID[]> {
		return this.adapter.createPairingAllowlistEntries(entries);
	}

	async updatePairingAllowlistEntries(
		entries: PairingAllowlistEntry[],
	): Promise<void> {
		return this.adapter.updatePairingAllowlistEntries(entries);
	}

	async deletePairingAllowlistEntries(ids: UUID[]): Promise<void> {
		return this.adapter.deletePairingAllowlistEntries(ids);
	}

	// Single-item pairing wrappers
	async createPairingRequest(request: PairingRequest): Promise<UUID> {
		const ids = await this.adapter.createPairingRequests([request]);
		return ids[0];
	}

	async updatePairingRequest(request: PairingRequest): Promise<void> {
		return this.adapter.updatePairingRequests([request]);
	}

	async deletePairingRequest(id: UUID): Promise<void> {
		return this.adapter.deletePairingRequests([id]);
	}

	async createPairingAllowlistEntry(
		entry: PairingAllowlistEntry,
	): Promise<UUID> {
		const ids = await this.adapter.createPairingAllowlistEntries([entry]);
		return ids[0];
	}

	async deletePairingAllowlistEntry(id: UUID): Promise<void> {
		return this.adapter.deletePairingAllowlistEntries([id]);
	}

	// Connector account storage passthroughs
	async listConnectorAccounts(
		params: ListConnectorAccountsParams = {},
	): Promise<ConnectorAccountRecord[]> {
		return this.adapter.listConnectorAccounts({
			...params,
			agentId: params.agentId ?? this.agentId,
		});
	}

	async getConnectorAccount(
		params: GetConnectorAccountParams,
	): Promise<ConnectorAccountRecord | null> {
		return this.adapter.getConnectorAccount({
			...params,
			agentId: params.id ? params.agentId : (params.agentId ?? this.agentId),
		});
	}

	async upsertConnectorAccount(
		params: UpsertConnectorAccountParams,
	): Promise<ConnectorAccountRecord> {
		return this.adapter.upsertConnectorAccount({
			...params,
			agentId: params.agentId ?? this.agentId,
		});
	}

	async deleteConnectorAccount(
		params: DeleteConnectorAccountParams,
	): Promise<boolean> {
		return this.adapter.deleteConnectorAccount({
			...params,
			agentId: params.id ? params.agentId : (params.agentId ?? this.agentId),
		});
	}

	async setConnectorAccountCredentialRef(
		params: SetConnectorAccountCredentialRefParams,
	): Promise<ConnectorAccountCredentialRefRecord> {
		return this.adapter.setConnectorAccountCredentialRef(params);
	}

	async getConnectorAccountCredentialRef(
		params: GetConnectorAccountCredentialRefParams,
	): Promise<ConnectorAccountCredentialRefRecord | null> {
		return this.adapter.getConnectorAccountCredentialRef(params);
	}

	async listConnectorAccountCredentialRefs(
		params: ListConnectorAccountCredentialRefsParams,
	): Promise<ConnectorAccountCredentialRefRecord[]> {
		return this.adapter.listConnectorAccountCredentialRefs(params);
	}

	async deleteConnectorAccountCredentialRefs(
		params: DeleteConnectorAccountCredentialRefsParams,
	): Promise<number> {
		return this.adapter.deleteConnectorAccountCredentialRefs(params);
	}

	async appendConnectorAccountAuditEvent(
		params: AppendConnectorAccountAuditEventParams,
	): Promise<ConnectorAccountAuditEventRecord> {
		return this.adapter.appendConnectorAccountAuditEvent({
			...params,
			agentId: params.agentId ?? this.agentId,
		});
	}

	async createOAuthFlowState(
		params: CreateOAuthFlowStateParams,
	): Promise<OAuthFlowRecord> {
		return this.adapter.createOAuthFlowState({
			...params,
			agentId: params.agentId ?? this.agentId,
		});
	}

	async consumeOAuthFlowState(
		params: ConsumeOAuthFlowStateParams,
	): Promise<OAuthFlowRecord | null> {
		return this.adapter.consumeOAuthFlowState({
			...params,
			agentId: params.agentId ?? this.agentId,
		});
	}

	async getOAuthFlowState(
		params: GetOAuthFlowStateParams,
	): Promise<OAuthFlowRecord | null> {
		return this.adapter.getOAuthFlowState({
			...params,
			agentId: params.agentId ?? this.agentId,
		});
	}

	async updateOAuthFlowState(
		params: UpdateOAuthFlowStateParams,
	): Promise<OAuthFlowRecord | null> {
		return this.adapter.updateOAuthFlowState({
			...params,
			agentId: params.agentId ?? this.agentId,
		});
	}

	async deleteOAuthFlowState(
		params: DeleteOAuthFlowStateParams,
	): Promise<boolean> {
		return this.adapter.deleteOAuthFlowState({
			...params,
			agentId: params.agentId ?? this.agentId,
		});
	}

	// ── Batch pass-throughs required by IDatabaseAdapter ────────────────

	deleteRoomsByWorldIds(worldIds: UUID[]): Promise<void> {
		return this.dataMutations.deleteRoomsByWorldIds(worldIds);
	}

	async getRoomsByWorlds(
		worldIds: UUID[],
		limit?: number,
		offset?: number,
	): Promise<Room[]> {
		return this.adapter.getRoomsByWorlds(worldIds, limit, offset);
	}

	async installRemotePlugin(
		_plugin: Plugin,
		_options?: RemotePluginInstallOptions,
	): Promise<RemotePluginInstanceHandle> {
		throw new Error(
			"installRemotePlugin requires a host with RemotePluginBridge wiring (see @elizaos/agent).",
		);
	}
}
