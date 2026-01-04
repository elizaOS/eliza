import type { Character } from './agent';
import type { Action, Evaluator, Provider, ActionResult } from './components';
import { HandlerCallback } from './components';
import type { IDatabaseAdapter } from './database';
import type { IElizaOS } from './elizaos';
import type { Entity, Room, World, ChannelType } from './environment';
import type { Logger } from '../logger';
import { Memory, MemoryMetadata } from './memory';
import type { SendHandlerFunction, TargetInfo } from './messaging';
import type { IMessageService } from '../services/message-service';
import type {
  ModelParamsMap,
  ModelResultMap,
  ModelTypeName,
  GenerateTextOptions,
  GenerateTextResult,
  GenerateTextParams,
  TextGenerationModelType,
} from './model';
import type { Plugin, RuntimeEventStorage, Route } from './plugin';
import type { Content, UUID } from './primitives';
import type { Service, ServiceTypeName } from './service';
import type { State } from './state';
import type { TaskWorker } from './task';
import type { EventPayloadMap, EventHandler, EventPayload } from './events';

/**
 * Represents the core runtime environment for an agent.
 * Defines methods for database interaction, plugin management, event handling,
 * state composition, model usage, and task management.
 */

export interface IAgentRuntime extends IDatabaseAdapter {
  // Properties
  agentId: UUID;
  character: Character;
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
  elizaOS?: IElizaOS;

  // Methods
  registerPlugin(plugin: Plugin): Promise<void>;

  initialize(options?: { skipMigrations?: boolean }): Promise<void>;

  getConnection(): Promise<unknown>;

  getService<T extends Service>(service: ServiceTypeName | string): T | null;

  getServicesByType<T extends Service>(service: ServiceTypeName | string): T[];

  getAllServices(): Map<ServiceTypeName, Service[]>;

  registerService(service: typeof Service): Promise<void>;

  getServiceLoadPromise(serviceType: ServiceTypeName): Promise<Service>;

  getRegisteredServiceTypes(): ServiceTypeName[];

  hasService(serviceType: ServiceTypeName | string): boolean;

  hasElizaOS(): this is IAgentRuntime & { elizaOS: IElizaOS };

  // Keep these methods for backward compatibility
  registerDatabaseAdapter(adapter: IDatabaseAdapter): void;

  setSetting(key: string, value: string | boolean | null, secret?: boolean): void;

  getSetting(key: string): string | boolean | number | null;

  getConversationLength(): number;

  processActions(
    message: Memory,
    responses: Memory[],
    state?: State,
    callback?: HandlerCallback,
    options?: { onStreamChunk?: (chunk: string, messageId?: UUID) => Promise<void> }
  ): Promise<void>;

  getActionResults(messageId: UUID): ActionResult[];

  evaluate(
    message: Memory,
    state?: State,
    didRespond?: boolean,
    callback?: HandlerCallback,
    responses?: Memory[]
  ): Promise<Evaluator[] | null>;

  registerProvider(provider: Provider): void;

  registerAction(action: Action): void;

  registerEvaluator(evaluator: Evaluator): void;

  ensureConnections(entities: Entity[], rooms: Room[], source: string, world: World): Promise<void>;
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
    metadata?: Record<string, unknown>;
  }): Promise<void>;

  ensureParticipantInRoom(entityId: UUID, roomId: UUID): Promise<void>;

  ensureWorldExists(world: World): Promise<void>;

  ensureRoomExists(room: Room): Promise<void>;

  composeState(
    message: Memory,
    includeList?: string[],
    onlyInclude?: boolean,
    skipCache?: boolean
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
    provider?: string
  ): Promise<string>;

  // Overload 2: Generic fallback for other model types
  useModel<T extends keyof ModelParamsMap, R = ModelResultMap[T]>(
    modelType: T,
    params: ModelParamsMap[T],
    provider?: string
  ): Promise<R>;

  generateText(input: string, options?: GenerateTextOptions): Promise<GenerateTextResult>;

  registerModel(
    modelType: ModelTypeName | string,
    handler: (runtime: IAgentRuntime, params: Record<string, unknown>) => Promise<unknown>,
    provider: string,
    priority?: number
  ): void;

  getModel(
    modelType: ModelTypeName | string
  ): ((runtime: IAgentRuntime, params: Record<string, unknown>) => Promise<unknown>) | undefined;

  registerEvent<T extends keyof EventPayloadMap>(event: T, handler: EventHandler<T>): void;
  registerEvent<P extends EventPayload = EventPayload>(
    event: string,
    handler: (params: P) => Promise<void>
  ): void;

  getEvent<T extends keyof EventPayloadMap>(event: T): EventHandler<T>[] | undefined;
  getEvent(event: string): ((params: EventPayload) => Promise<void>)[] | undefined;

  emitEvent<T extends keyof EventPayloadMap>(
    event: T | T[],
    params: EventPayloadMap[T]
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
  queueEmbeddingGeneration(memory: Memory, priority?: 'high' | 'normal' | 'low'): Promise<void>;

  getAllMemories(): Promise<Memory[]>;

  clearAllAgentMemories(): Promise<void>;

  updateMemory(memory: Partial<Memory> & { id: UUID; metadata?: MemoryMetadata }): Promise<boolean>;

  // Run tracking methods
  createRunId(): UUID;
  startRun(roomId?: UUID): UUID;
  endRun(): void;
  getCurrentRunId(): UUID;

  // easy/compat wrappers

  getEntityById(entityId: UUID): Promise<Entity | null>;
  getRoom(roomId: UUID): Promise<Room | null>;
  createEntity(entity: Entity): Promise<boolean>;
  createRoom({ id, name, source, type, channelId, messageServerId, worldId }: Room): Promise<UUID>;
  addParticipant(entityId: UUID, roomId: UUID): Promise<boolean>;
  getRooms(worldId: UUID): Promise<Room[]>;
  registerSendHandler(source: string, handler: SendHandlerFunction): void;
  sendMessageToTarget(target: TargetInfo, content: Content): Promise<void>;
  updateWorld(world: World): Promise<void>;
}
