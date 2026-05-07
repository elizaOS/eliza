import type { Logger } from "../logger";
import type { ContextRegistry } from "../runtime/context-registry";
import type { PromptBatcher } from "../utils/prompt-batcher";
import type { Agent, Character } from "./agent";
import type {
	Action,
	ActionMode,
	ActionResult,
	AgentContext,
	Evaluator,
	HandlerCallback,
	Provider,
	StreamChunkCallback,
} from "./components";
import type { IDatabaseAdapter, LogBody, PatchOp } from "./database";
import type {
	Component,
	Entity,
	Metadata,
	Relationship,
	Room,
	World,
} from "./environment";
import type { EventHandler, EventPayload, EventPayloadMap } from "./events";
import type { Memory, MemoryMetadata } from "./memory";
import type { IMessageService } from "./message-service";
import type {
	IMessagingAdapter,
	SendHandlerFunction,
	TargetInfo,
} from "./messaging";
import type {
	GenerateTextOptions,
	GenerateTextParams,
	GenerateTextResult,
	ModelParamsMap,
	ModelResultMap,
	ModelTypeName,
	TextGenerationModelType,
} from "./model";
import type { PairingAllowlistEntry, PairingRequest } from "./pairing";
import type {
	Plugin,
	PluginOwnership,
	Route,
	RuntimeEventStorage,
	ServiceClass,
} from "./plugin";
import type { ChannelType, Content, UUID } from "./primitives";
import type { JsonValue } from "./proto.js";
import type {
	SearchCategoryEnumerationOptions,
	SearchCategoryLookupOptions,
	SearchCategoryRegistration,
} from "./search";
import type { Service, ServiceTypeName } from "./service";
import type { State } from "./state";
import type { Task, TaskWorker } from "./task";
import type { ToolPolicyConfig, ToolProfileId } from "./tools";

export {
	type SearchCategoryEnumerationOptions,
	type SearchCategoryFilter,
	type SearchCategoryFilterOption,
	type SearchCategoryFilterType,
	type SearchCategoryLookupOptions,
	type SearchCategoryRegistration,
	SearchCategoryRegistryError,
	type SearchCategoryRegistryErrorCode,
} from "./search";

export type MessageTargetKind =
	| "room"
	| "channel"
	| "thread"
	| "user"
	| "contact"
	| "group"
	| "server"
	| "email"
	| "phone"
	| (string & {});

export type MessageConnectorCapability = "send_message" | (string & {});

export interface MessageConnectorQueryContext {
	runtime: IAgentRuntime;
	roomId?: UUID;
	entityId?: UUID;
	source?: string;
	target?: TargetInfo;
	contexts?: AgentContext[];
	metadata?: Metadata;
}

export interface MessageConnectorTarget {
	target: TargetInfo;
	label?: string;
	kind?: MessageTargetKind;
	description?: string;
	score?: number;
	contexts?: AgentContext[];
	metadata?: Metadata;
}

export interface MessageConnectorChatMessageContext {
	entityId?: UUID;
	name?: string;
	text: string;
	timestamp?: number;
	metadata?: Metadata;
}

export interface MessageConnectorChatContext {
	target: TargetInfo;
	label?: string;
	summary?: string;
	recentMessages?: MessageConnectorChatMessageContext[];
	metadata?: Metadata;
}

export interface MessageConnectorUserContext {
	entityId: UUID | string;
	label?: string;
	aliases?: string[];
	handles?: Record<string, string>;
	metadata?: Metadata;
}

export interface MessageConnector {
	source: string;
	label: string;
	capabilities: MessageConnectorCapability[];
	supportedTargetKinds: MessageTargetKind[];
	description?: string;
	contexts: AgentContext[];
	metadata?: Metadata;
	resolveTargets?: (
		query: string,
		context: MessageConnectorQueryContext,
	) => Promise<MessageConnectorTarget[]> | MessageConnectorTarget[];
	listRecentTargets?: (
		context: MessageConnectorQueryContext,
	) => Promise<MessageConnectorTarget[]> | MessageConnectorTarget[];
	listRooms?: (
		context: MessageConnectorQueryContext,
	) => Promise<MessageConnectorTarget[]> | MessageConnectorTarget[];
	getChatContext?: (
		target: TargetInfo,
		context: MessageConnectorQueryContext,
	) =>
		| Promise<MessageConnectorChatContext | null>
		| MessageConnectorChatContext
		| null;
	getUserContext?: (
		entityId: UUID | string,
		context: MessageConnectorQueryContext,
	) =>
		| Promise<MessageConnectorUserContext | null>
		| MessageConnectorUserContext
		| null;
}

export type MessageConnectorMetadata = Partial<
	Omit<MessageConnector, "source" | "label">
> & {
	label?: string;
};

export type MessageConnectorRegistration = MessageConnectorMetadata & {
	source: string;
	sendHandler: SendHandlerFunction;
};

/**
 * Represents the core runtime environment for an agent.
 * Defines methods for database interaction, plugin management, event handling,
 * state composition, model usage, and task management.
 */

export interface IAgentRuntime extends IDatabaseAdapter<object> {
	// Properties
	/** Database adapter. Set in constructor; required. */
	adapter: IDatabaseAdapter;
	agentId: UUID;
	character: Character;
	enableAutonomy: boolean;
	/** When true, TaskService does not start a timer; host drives via runDueTasks(). WHY: no long-lived process in serverless. */
	serverless?: boolean;
	initPromise: Promise<void>;
	messageService: IMessageService | null;
	providers: Provider[];
	actions: Action[];
	evaluators: Evaluator[];
	plugins: Plugin[];
	services: Map<ServiceTypeName, Service[]>;
	events: RuntimeEventStorage;
	fetch?: typeof fetch | null;
	routes: Route[];
	logger: Logger;
	stateCache: Map<string, State>;
	/**
	 * Per-runtime registry of context definitions. Seeded at runtime start with
	 * the first-party taxonomy from PLAN.md §4.3 and extended by plugins via
	 * `runtime.contexts.tryRegister(...)`.
	 */
	contexts: ContextRegistry;
	promptBatcher?: PromptBatcher;
	/** Optional URL of a long-lived companion runtime for fire-and-forget embedding/task work. */
	companionUrl?: string;

	// Methods
	registerPlugin(plugin: Plugin): Promise<void>;
	unloadPlugin(pluginName: string): Promise<PluginOwnership | null>;
	reloadPlugin(plugin: Plugin): Promise<void>;
	applyPluginConfig(
		pluginName: string,
		config: Record<string, string>,
	): Promise<boolean>;
	getPluginOwnership(pluginName: string): PluginOwnership | null;
	getAllPluginOwnership(): PluginOwnership[];
	enableKnowledge(): Promise<void>;
	disableKnowledge(): Promise<void>;
	isKnowledgeEnabled(): boolean;
	enableRelationships(): Promise<void>;
	disableRelationships(): Promise<void>;
	isRelationshipsEnabled(): boolean;
	enableTrajectories(): Promise<void>;
	disableTrajectories(): Promise<void>;
	isTrajectoriesEnabled(): boolean;

	initialize(options?: { skipMigrations?: boolean }): Promise<void>;

	/** Get the underlying database connection. Type depends on the adapter implementation. */
	getConnection(): Promise<object>;

	getService<T extends Service>(service: ServiceTypeName | string): T | null;

	getServicesByType<T extends Service>(service: ServiceTypeName | string): T[];

	getAllServices(): Map<ServiceTypeName, Service[]>;

	registerService(service: ServiceClass): Promise<void>;

	getServiceLoadPromise(
		serviceType: ServiceTypeName | string,
	): Promise<Service>;

	getRegisteredServiceTypes(): ServiceTypeName[];

	hasService(serviceType: ServiceTypeName | string): boolean;

	/**
	 * Get the messaging adapter if the current database adapter supports it
	 *
	 * WHY: Messaging functionality is optional - only SQL adapters implement it.
	 * This method allows client plugins (Discord, Telegram) to check if messaging
	 * is available before using it.
	 *
	 * @returns IMessagingAdapter if supported, null otherwise
	 */
	getMessagingAdapter(): IMessagingAdapter | null;

	setSetting(
		key: string,
		value: string | boolean | null,
		secret?: boolean,
	): void;

	getSetting(key: string): string | boolean | number | null;

	getConversationLength(): number;

	/**
	 * Check if action planning mode is enabled.
	 *
	 * When enabled (default), the agent can plan and execute multiple actions per response.
	 * When disabled, the agent executes only a single action per response - a performance
	 * optimization useful for game situations where state updates with every action.
	 *
	 * Priority: constructor option > character setting ACTION_PLANNING > default (true)
	 */
	isActionPlanningEnabled(): boolean;

	/**
	 * Get the LLM mode for model selection override.
	 *
	 * - `DEFAULT`: Use the model type specified in the useModel call (no override)
	 * - `SMALL`: Override all text generation model calls to use TEXT_SMALL
	 * - `LARGE`: Override all text generation model calls to use TEXT_LARGE
	 *
	 * This is useful for cost optimization (force SMALL) or quality (force LARGE).
	 *
	 * Priority: constructor option > character setting LLM_MODE > default (DEFAULT)
	 */
	getLLMMode(): import("./model").LLMModeType;

	/**
	 * Check if the shouldRespond evaluation is enabled.
	 *
	 * When enabled (default: true), the agent evaluates whether to respond to each message.
	 * When disabled, the agent always responds (ChatGPT mode) - useful for direct chat interfaces.
	 *
	 * Priority: constructor option > character setting CHECK_SHOULD_RESPOND > default (true)
	 */
	isCheckShouldRespondEnabled(): boolean;

	processActions(
		message: Memory,
		responses: Memory[],
		state?: State,
		callback?: HandlerCallback,
		options?: {
			onStreamChunk?: StreamChunkCallback;
		},
	): Promise<void>;

	getActionResults(messageId: UUID): ActionResult[];

	evaluate(
		message: Memory,
		state?: State,
		didRespond?: boolean,
		callback?: HandlerCallback,
		responses?: Memory[],
	): Promise<Evaluator[] | null>;

	/**
	 * Run actions whose `mode` matches one of the 9 hook positions
	 * (ALWAYS_x/CONTEXT_x/MESSAGE_x). The runtime fires this at fixed
	 * positions in the message pipeline. CONTEXT_x hooks are gated by
	 * `options.selectedContexts` overlapping the action's `contexts`.
	 * x_DURING modes execute handlers in parallel; all other hook modes
	 * run sequentially in `modePriority` order. ACTION_STARTED /
	 * ACTION_COMPLETED events fire so the v5 dashboard surfaces hook runs.
	 */
	runActionsByMode(
		mode: ActionMode,
		message: Memory,
		state?: State,
		options?: {
			didRespond?: boolean;
			callback?: HandlerCallback;
			responses?: Memory[];
			selectedContexts?: readonly AgentContext[];
		},
	): Promise<Action[]>;

	registerProvider(provider: Provider): void;

	registerAction(action: Action): void;

	/**
	 * Get all registered actions.
	 */
	getAllActions(): Action[];

	/**
	 * Get actions filtered by tool policy.
	 *
	 * @param context - Optional policy context for filtering
	 * @returns Filtered actions based on policy
	 */
	getFilteredActions(context?: {
		profile?: ToolProfileId;
		characterPolicy?: ToolPolicyConfig;
		channelPolicy?: ToolPolicyConfig;
		providerPolicy?: ToolPolicyConfig;
		worldPolicy?: ToolPolicyConfig;
		roomPolicy?: ToolPolicyConfig;
	}): Action[] | Promise<Action[]>;

	/**
	 * Check if a specific action is allowed by tool policy.
	 *
	 * @param actionName - The action name to check
	 * @param context - Optional policy context
	 * @returns Whether the action is allowed
	 */
	isActionAllowed(
		actionName: string,
		context?: {
			profile?: ToolProfileId;
			characterPolicy?: ToolPolicyConfig;
			channelPolicy?: ToolPolicyConfig;
			providerPolicy?: ToolPolicyConfig;
			worldPolicy?: ToolPolicyConfig;
			roomPolicy?: ToolPolicyConfig;
		},
	):
		| { allowed: boolean; reason: string }
		| Promise<{ allowed: boolean; reason: string }>;

	registerEvaluator(evaluator: Evaluator): void;

	ensureConnections(
		entities: Entity[],
		rooms: Room[],
		source: string,
		world: World,
	): Promise<void>;
	ensureConnection({
		entityId,
		roomId,
		roomName,
		metadata,
		userName,
		worldName,
		name,
		source,
		channelId,
		messageServerId,
		type,
		worldId,
		userId,
	}: {
		entityId: UUID;
		roomId: UUID;
		roomName?: string;
		userName?: string;
		name?: string;
		worldName?: string;
		source?: string;
		channelId?: string;
		messageServerId?: UUID;
		type?: ChannelType | string;
		worldId?: UUID;
		userId?: UUID;
		metadata?: Record<string, JsonValue>;
	}): Promise<void>;

	ensureParticipantInRoom(entityId: UUID, roomId: UUID): Promise<void>;

	ensureWorldExists(world: World): Promise<void>;

	ensureRoomExists(room: Room): Promise<void>;

	composeState(
		message: Memory,
		includeList?: string[],
		onlyInclude?: boolean,
		skipCache?: boolean,
	): Promise<State>;

	/**
	 * Use a model for inference with proper type inference based on parameters.
	 *
	 * For text generation models (nano/small/medium/large/mega, handler/planner,
	 * TEXT_REASONING_*, and TEXT_COMPLETION):
	 * - Always returns `string`
	 * - If streaming context is active, chunks are sent to callback automatically
	 *
	 * @example
	 * ```typescript
	 * // Simple usage - streaming happens automatically if context is active
	 * const text = await runtime.useModel(ModelType.TEXT_LARGE, { prompt: "Hello" });
	 * ```
	 */
	// Overload 1: Text generation → string (auto-streams via context)
	useModel(
		modelType: TextGenerationModelType,
		params: GenerateTextParams,
		provider?: string,
	): Promise<string>;

	// Overload 2: Generic fallback for other model types
	useModel<T extends keyof ModelParamsMap, R = ModelResultMap[T]>(
		modelType: T,
		params: ModelParamsMap[T],
		provider?: string,
	): Promise<R>;

	generateText(
		input: string,
		options?: GenerateTextOptions,
	): Promise<GenerateTextResult>;

	/**
	 * Register a model handler for a specific model type.
	 * Model handlers process inference requests for specific model types.
	 * @param modelType - The type of model to register
	 * @param handler - The handler function that processes model requests
	 * @param provider - The name of the provider (plugin) registering this handler
	 * @param priority - Optional priority for handler selection (higher = preferred)
	 */
	registerModel(
		modelType: ModelTypeName | string,
		handler: (
			runtime: IAgentRuntime,
			params: Record<string, JsonValue | object>,
		) => Promise<JsonValue | object>,
		provider: string,
		priority?: number,
	): void;

	/**
	 * Get the registered model handler for a specific model type.
	 * Returns the highest priority handler if multiple are registered.
	 * @param modelType - The type of model to retrieve
	 * @returns The model handler function or undefined if not found
	 */
	getModel(
		modelType: ModelTypeName | string,
	):
		| ((
				runtime: IAgentRuntime,
				params: Record<string, JsonValue | object>,
		  ) => Promise<JsonValue | object>)
		| undefined;

	registerEvent<T extends keyof EventPayloadMap>(
		event: T,
		handler: EventHandler<T>,
	): void;
	registerEvent<P extends EventPayload = EventPayload>(
		event: string,
		handler: (params: P) => Promise<void>,
	): void;

	unregisterEvent<T extends keyof EventPayloadMap>(
		event: T,
		handler: EventHandler<T>,
	): void;
	unregisterEvent<P extends EventPayload = EventPayload>(
		event: string,
		handler: (params: P) => Promise<void>,
	): void;

	getEvent<T extends keyof EventPayloadMap>(
		event: T,
	): EventHandler<T>[] | undefined;
	getEvent(
		event: string,
	): ((params: EventPayload) => Promise<void>)[] | undefined;

	emitEvent<T extends keyof EventPayloadMap>(
		event: T | T[],
		params: EventPayloadMap[T],
	): Promise<void>;
	emitEvent(event: string | string[], params: EventPayload): Promise<void>;

	// In-memory task definition methods
	registerTaskWorker(taskHandler: TaskWorker): void;
	getTaskWorker(name: string): TaskWorker | undefined;
	/**
	 * Remove a previously registered task worker by name. Returns true if
	 * a worker was removed, false if no worker with that name existed.
	 *
	 * Use this from plugin.dispose() to tear down task workers when the
	 * plugin is unloaded. Note: this only removes the in-memory worker
	 * function — any persisted `Task` rows in the adapter that reference
	 * this worker name must be deleted separately via `deleteTask()`.
	 */
	unregisterTaskWorker(name: string): boolean;

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
	 * 1. Validation codes: Injects UUID codes the LLM must echo back. If codes match,
	 *    we know the LLM actually read and followed the prompt.
	 * 2. Streaming with safety: Enables streaming while detecting truncation.
	 * 3. Performance tracking: Tracks success/failure rates per model+schema.
	 *
	 * VALIDATION LEVELS:
	 * - Level 0 (Trusted): No codes. Maximum speed. Use for reliable models.
	 * - Level 1 (Progressive): Per-field codes. Balance of safety + speed.
	 * - Level 2: Buffered validation. Optional checkpoint codes can validate the prompt envelope.
	 * - Level 3: Strict buffered validation. Optional checkpoint codes validate both ends.
	 *
	 * @param state - State object to inject into the prompt template
	 * @param params - LLM parameters with a prompt template
	 * @param schema - Array of field definitions for structured output
	 * @param options - Configuration (modelSize/modelType, validation level, streaming callbacks, etc.)
	 * @returns Parsed structured response object, or null on failure
	 */
	dynamicPromptExecFromState(args: {
		state?: State;
		params: Omit<GenerateTextParams, "prompt"> & {
			prompt: string | ((ctx: { state: State }) => string);
		};
		schema: import("./state").SchemaRow[];
		options?: {
			key?: string;
			/**
			 * Human-readable name for this prompt task, used as the optimization
			 * artifact lookup key. When provided, artifacts are stored/retrieved
			 * under this name (e.g. "shouldRespond"). When absent, the system
			 * uses an MD5 hash of the serialized schema instead.
			 *
			 * This is separate from `key` (which is used for response caching).
			 */
			promptName?: string;
			modelSize?: "nano" | "small" | "medium" | "large" | "mega";
			modelType?: TextGenerationModelType;
			model?: string;
			requiredFields?: string[];
			contextCheckLevel?: 0 | 1 | 2 | 3;
			checkpointCodes?: boolean;
			maxRetries?: number;
			retryBackoff?: number | import("./state").RetryBackoffConfig;
			disableCache?: boolean;
			cacheTTL?: number;
			onStreamChunk?: StreamChunkCallback;
			onStreamEvent?: (
				event: import("./state").StreamEvent,
				messageId?: string,
			) => void | Promise<void>;
			abortSignal?: AbortSignal;
		};
	}): Promise<Record<string, unknown> | null>;

	/**
	 * Enrich an in-flight execution trace with an additional score signal.
	 *
	 * Traces are keyed by runId and held in memory until finalization (e.g. RUN_ENDED
	 * in prompt-optimization plugins). Evaluators and actions can attach signals after DPE.
	 */
	enrichTrace(
		runId: string,
		signal: import("./prompt-optimization-trace").ScoreSignal,
	): void;

	/** Retrieve the most recent in-flight optimization trace for a runId. */
	getActiveTrace(
		runId: string,
	): import("./prompt-optimization-trace").ExecutionTrace | undefined;

	/** Retrieve all in-flight optimization traces for a runId (multiple DPE calls per run). */
	getActiveTracesForRun?(
		runId: string,
	): import("./prompt-optimization-trace").ExecutionTrace[];

	/** Remove all in-flight optimization traces for a runId after finalization. */
	deleteActiveTrace(runId: string): void;

	/** Remove a single in-flight trace by its unique trace id. */
	deleteActiveTraceById?(traceId: string): void;

	/**
	 * Register disk-backed or custom prompt optimization hooks (merge, registry, traces).
	 * When `null`, DPE performs no optimization I/O.
	 */
	registerPromptOptimizationHooks(
		hooks:
			| import("./prompt-optimization-hooks").PromptOptimizationRuntimeHooks
			| null,
	): void;

	getPromptOptimizationHooks():
		| import("./prompt-optimization-hooks").PromptOptimizationRuntimeHooks
		| null;

	/** Resolved `OPTIMIZATION_DIR` (see `getOptimizationRootDir`). */
	getOptimizationDir(): string;

	stop(): Promise<void>;

	addEmbeddingToMemory(memory: Memory): Promise<Memory>;

	/**
	 * Queue a memory for async embedding generation.
	 * This method is non-blocking and returns immediately.
	 * The embedding will be generated asynchronously via event handlers.
	 * @param memory The memory to generate embeddings for
	 * @param priority Priority level for the embedding generation
	 */
	queueEmbeddingGeneration(
		memory: Memory,
		priority?: "high" | "normal" | "low",
	): Promise<void>;

	getAllMemories(): Promise<Memory[]>;

	clearAllAgentMemories(): Promise<void>;

	// Run tracking methods
	createRunId(): UUID;
	startRun(roomId?: UUID): UUID;
	endRun(): void;
	getCurrentRunId(): UUID;

	registerSearchCategory(registration: SearchCategoryRegistration): void;
	getSearchCategories(
		options?: SearchCategoryEnumerationOptions,
	): SearchCategoryRegistration[];
	getSearchCategory(
		category: string,
		options?: SearchCategoryLookupOptions,
	): SearchCategoryRegistration;

	registerSendHandler(source: string, handler: SendHandlerFunction): void;
	registerMessageConnector(registration: MessageConnectorRegistration): void;
	getMessageConnectors(): MessageConnector[];
	sendMessageToTarget(target: TargetInfo, content: Content): Promise<void>;

	/**
	 * Pipeline hooks: register with `registerPipelineHook`, run with `applyPipelineHooks`.
	 * Same `id` replaces any prior registration (any phase). Outgoing phase always finishes with `redactSecrets` on `content.text`.
	 */
	registerPipelineHook(spec: import("./pipeline-hooks").PipelineHookSpec): void;
	unregisterPipelineHook(id: string): void;
	applyPipelineHooks(
		phase: import("./pipeline-hooks").PipelineHookPhase,
		ctx: import("./pipeline-hooks").PipelineHookContext,
		pipelineHookTelemetry?: boolean,
	): Promise<void>;

	/**
	 * Redact secrets from a text string.
	 * @param text - The text to redact secrets from
	 * @returns The text with secrets redacted
	 */
	redactSecrets(text: string): string;

	// ========================================================================
	// Single-item convenience wrappers
	//
	// WHY these exist: IAgentRuntime extends IDatabaseAdapter, so it inherits
	// all batch methods. But most call sites in plugins, event handlers, and
	// actions naturally deal with one item at a time -- one message to store,
	// one entity to look up, one task to create. Forcing every caller to
	// wrap in arrays ([item]) and unwrap ([0]) adds noise without value.
	//
	// These wrappers keep the common single-item case clean. They are NOT
	// deprecated -- they are the preferred API for single-item operations.
	// Use batch methods (createMemories, getAgentsByIds, etc.) when you
	// have multiple items or want to minimize round-trips.
	//
	// Implementation note: AgentRuntime implements these by delegating to
	// the corresponding batch adapter method. For example:
	//   getAgent(id) → (await this.adapter.getAgentsByIds([id]))[0] ?? null
	//   createMemory(mem, table) → this.adapter.createMemories([{mem, table}])
	//
	// The createMemory() wrapper is special: it also performs secret
	// redaction before delegating to the adapter. This is why runtime.ts
	// preserves createMemory() calls internally instead of going directly
	// to the adapter in security-sensitive paths.
	// ========================================================================

	getEntityById(entityId: UUID): Promise<Entity | null>;
	getEntitiesForRoom(
		roomId: UUID,
		includeComponents?: boolean,
	): Promise<import("./environment").Entity[]>;
	getRoom(roomId: UUID): Promise<Room | null>;
	createEntity(entity: Entity): Promise<boolean>;
	createRoom({
		id,
		name,
		source,
		type,
		channelId,
		messageServerId,
		worldId,
	}: Room): Promise<UUID>;
	addParticipant(entityId: UUID, roomId: UUID): Promise<boolean>;
	getParticipantsForRoom(roomId: UUID): Promise<UUID[]>;
	getParticipantUserState(
		roomId: UUID,
		entityId: UUID,
	): Promise<"FOLLOWED" | "MUTED" | null>;
	updateParticipantUserState(
		roomId: UUID,
		entityId: UUID,
		state: "FOLLOWED" | "MUTED" | null,
	): Promise<void>;
	getRoomsForParticipant(entityId: UUID): Promise<UUID[]>;
	getRooms(worldId: UUID): Promise<Room[]>;
	updateWorld(world: World): Promise<void>;

	getAgent(agentId: UUID): Promise<Agent | null>;
	createAgent(agent: Partial<Agent>): Promise<boolean>;
	updateAgent(agentId: UUID, agent: Partial<Agent>): Promise<boolean>;
	deleteAgent(agentId: UUID): Promise<boolean>;

	getWorld(id: UUID): Promise<World | null>;
	createWorld(world: World): Promise<UUID>;
	deleteWorld(id: UUID): Promise<void>;

	createTask(task: Task): Promise<UUID>;
	getTask(id: UUID): Promise<Task | null>;
	updateTask(id: UUID, task: Partial<Task>): Promise<void>;
	deleteTask(id: UUID): Promise<void>;

	log(params: {
		body: LogBody;
		entityId: UUID;
		roomId: UUID;
		type: string;
	}): Promise<void>;
	deleteLog(logId: UUID): Promise<void>;

	getCache<T>(key: string): Promise<T | undefined>;
	setCache<T>(key: string, value: T): Promise<boolean>;
	deleteCache(key: string): Promise<boolean>;

	updateEntity(entity: Entity): Promise<void>;

	getComponents(
		entityId: UUID,
		worldId?: UUID,
		sourceEntityId?: UUID,
	): Promise<Component[]>;
	getComponent(
		entityId: UUID,
		type: string,
		worldId?: UUID,
		sourceEntityId?: UUID,
	): Promise<Component | null>;
	createComponent(component: Component): Promise<boolean>;
	patchComponent(
		componentId: UUID,
		ops: import("./database").PatchOp[],
		options?: { entityContext?: UUID },
	): Promise<void>;
	updateComponent(component: Component): Promise<void>;
	deleteComponent(componentId: UUID): Promise<void>;

	/**
	 * Upsert a single component (convenience wrapper for upsertComponents).
	 * WHY: Completes the singular convenience pattern (matches createComponent, updateComponent).
	 */
	upsertComponent(component: Component): Promise<void>;

	/**
	 * Patch a single field in component data (convenience wrapper for patchComponent).
	 * WHY: Common case is updating one field. Single-op wrapper saves boilerplate.
	 * @example runtime.patchComponentField(id, { op: 'increment', path: 'count', value: 1 })
	 */
	patchComponentField(componentId: UUID, op: PatchOp): Promise<void>;

	/**
	 * Get all components of a specific type (convenience wrapper for queryEntities).
	 * WHY: Common query pattern. Wraps queryEntities and extracts components from entities.
	 * @param type Component type to filter by
	 * @param agentId Optional agent scope
	 * @returns Array of components (without entity metadata)
	 */
	getComponentsByType(type: string, agentId?: UUID): Promise<Component[]>;

	/**
	 * Upsert a single memory (convenience wrapper for upsertMemories).
	 * WHY: Completes the singular convenience pattern for memory operations.
	 */
	upsertMemory(memory: Memory, tableName: string): Promise<void>;

	createRelationship(params: {
		sourceEntityId: UUID;
		targetEntityId: UUID;
		tags?: string[];
		metadata?: Metadata;
	}): Promise<boolean>;
	updateRelationship(relationship: Relationship): Promise<void>;

	getMemoryById(id: UUID): Promise<Memory | null>;
	createMemory(
		memory: Memory,
		tableName: string,
		unique?: boolean,
	): Promise<UUID>;
	updateMemory(
		memory: Partial<Memory> & { id: UUID; metadata?: MemoryMetadata },
	): Promise<boolean>;
	deleteMemory(memoryId: UUID): Promise<void>;

	removeParticipant(entityId: UUID, roomId: UUID): Promise<boolean>;
	updateRoom(room: Room): Promise<void>;
	deleteRoom(roomId: UUID): Promise<void>;

	createPairingRequest(request: PairingRequest): Promise<UUID>;
	updatePairingRequest(request: PairingRequest): Promise<void>;
	deletePairingRequest(id: UUID): Promise<void>;
	createPairingAllowlistEntry(entry: PairingAllowlistEntry): Promise<UUID>;
	deletePairingAllowlistEntry(id: UUID): Promise<void>;
}
