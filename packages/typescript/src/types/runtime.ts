import type { Logger } from "../logger";
import type { Character } from "./agent";
import type {
  Action,
  ActionResult,
  Evaluator,
  HandlerCallback,
  Provider,
} from "./components";
import type { IDatabaseAdapter } from "./database";
import type { Entity, Room, World } from "./environment";
import type { EventHandler, EventPayload, EventPayloadMap } from "./events";
import type { Memory, MemoryMetadata } from "./memory";
import type { IMessageService } from "./message-service";
import type { SendHandlerFunction, TargetInfo } from "./messaging";
import type {
  GenerateTextOptions,
  GenerateTextParams,
  GenerateTextResult,
  ModelParamsMap,
  ModelResultMap,
  ModelTypeName,
  TextGenerationModelType,
} from "./model";
import type {
  Plugin,
  Route,
  RuntimeEventStorage,
  ServiceClass,
} from "./plugin";
import type { ChannelType, Content, UUID } from "./primitives";
import type { JsonValue } from "./proto.js";
import type { Service, ServiceTypeName } from "./service";
import type { State } from "./state";
import type { TaskWorker } from "./task";

/**
 * Represents the core runtime environment for an agent.
 * Defines methods for database interaction, plugin management, event handling,
 * state composition, model usage, and task management.
 */

export interface IAgentRuntime extends IDatabaseAdapter<object> {
  // Properties
  agentId: UUID;
  character: Character;
  enableAutonomy: boolean;
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

  // Methods
  registerPlugin(plugin: Plugin): Promise<void>;

  initialize(options?: { skipMigrations?: boolean }): Promise<void>;

  /** Get the underlying database connection. Type depends on the adapter implementation. */
  getConnection(): Promise<object>;

  getService<T extends Service>(service: ServiceTypeName | string): T | null;

  getServicesByType<T extends Service>(service: ServiceTypeName | string): T[];

  getAllServices(): Map<ServiceTypeName, Service[]>;

  registerService(service: ServiceClass): Promise<void>;

  getServiceLoadPromise(serviceType: ServiceTypeName): Promise<Service>;

  getRegisteredServiceTypes(): ServiceTypeName[];

  hasService(serviceType: ServiceTypeName | string): boolean;

  registerDatabaseAdapter(adapter: IDatabaseAdapter): void;

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
      onStreamChunk?: (chunk: string, messageId?: string) => Promise<void>;
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

  registerProvider(provider: Provider): void;

  registerAction(action: Action): void;

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
    userName?: string;
    name?: string;
    worldName?: string;
    source?: string;
    channelId?: string;
    messageServerId?: UUID;
    type?: ChannelType | string;
    worldId: UUID;
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
   * For text generation models (TEXT_SMALL, TEXT_LARGE, TEXT_REASONING_*):
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

  updateMemory(
    memory: Partial<Memory> & { id: UUID; metadata?: MemoryMetadata },
  ): Promise<boolean>;

  // Run tracking methods
  createRunId(): UUID;
  startRun(roomId?: UUID): UUID;
  endRun(): void;
  getCurrentRunId(): UUID;

  // easy/compat wrappers

  getEntityById(entityId: UUID): Promise<Entity | null>;
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
  getRooms(worldId: UUID): Promise<Room[]>;
  registerSendHandler(source: string, handler: SendHandlerFunction): void;
  sendMessageToTarget(target: TargetInfo, content: Content): Promise<void>;
  updateWorld(world: World): Promise<void>;
}
