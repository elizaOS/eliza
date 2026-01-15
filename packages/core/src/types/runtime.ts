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
    options?: { onStreamChunk?: (chunk: string, messageId?: string) => Promise<void> }
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

  /**
   * Execute a structured LLM prompt with validation and optional streaming.
   *
   * WHY: Raw LLM calls are unreliable. Context windows can be exhausted mid-response,
   * models can ignore schema requirements, and parsing can fail silently.
   * This method wraps useModel with validation codes, retry logic, and streaming
   * that respects validation state.
   *
   * STREAMING: Use onStreamChunk for real-time output. Behavior depends on
   * validation level:
   * - Level 0: Immediate streaming (fast, no safety)
   * - Level 1: Per-field streaming (stream as fields validate)
   * - Level 2-3: Buffered (stream only after full validation)
   *
   * CONSUMER PATTERNS:
   * - Simple: Just provide onStreamChunk. Gets auto-separator on retries.
   * - Rich: Provide both onStreamChunk and onStreamEvent for typed events.
   *
   * @returns Parsed response object, or null if all retries failed
   */
  dynamicPromptExecFromState(params: {
    state: State;
    params: Omit<GenerateTextParams, 'prompt'> & {
      /** Prompt template with Handlebars syntax. State values are injected. */
      prompt: string | ((ctx: { state: State }) => string);
    };
    /** Field definitions for structured output. See SchemaRow for hints. */
    schema: import('./state').SchemaRow[];
    options?: {
      /** Custom cache key (default: auto-generated from state+schema) */
      key?: string;
      /** Model size selection */
      modelSize?: 'small' | 'large';
      /** Override model provider (e.g., 'gpt-4', 'claude-3-opus') */
      model?: string;
      /** Output format preference (default: 'xml', better for streaming) */
      preferredEncapsulation?: 'json' | 'xml';
      /** Force output format (overrides preferredEncapsulation) */
      forceFormat?: 'json' | 'xml';
      /** Fields that must be present and non-empty in response */
      requiredFields?: string[];
      /**
       * Validation level for context checking:
       *
       * WHY: Different use cases need different safety/speed tradeoffs.
       *
       * - 0: Trusted - no codes, real-time streaming.
       *   WHY: Fastest. Use for reliable models, non-critical responses.
       *   Use validateField: true on specific fields to opt-in to validation.
       *
       * - 1: Progressive - per-field codes, stream as each field validates.
       *   WHY: Balance of safety + UX. User sees validated content in real-time.
       *   Use validateField: false on non-critical fields to reduce overhead.
       *
       * - 2: First checkpoint - codes at start only, buffered streaming.
       *   WHY: Catches "LLM ignored the prompt" failures. Good default.
       *
       * - 3: Full - codes at start AND end, buffered streaming.
       *   WHY: Maximum correctness. Use for critical operations, payments, etc.
       *
       * Default: 2 (or from VALIDATION_LEVEL env var)
       */
      contextCheckLevel?: 0 | 1 | 2 | 3;
      /** Max retry attempts on validation failure (default: from env or 1) */
      maxRetries?: number;
      /**
       * Backoff configuration for retries.
       *
       * WHY: Immediate retries often fail again. Backoff gives rate limits time
       * to reset and transient issues time to resolve.
       *
       * - number: Fixed delay in ms (e.g., 1000 = 1s between each retry)
       * - RetryBackoffConfig: Exponential (e.g., 1s → 2s → 4s → 8s, capped)
       * - undefined: No delay (default - retries immediately)
       */
      retryBackoff?: number | import('./state').RetryBackoffConfig;
      /** Disable prompt disk caching (default: false, cache enabled) */
      disableCache?: boolean;
      /** Cache time-to-live in ms (default: 5 minutes) */
      cacheTTL?: number;
      /**
       * Simple streaming callback - receives text chunks as they're validated.
       *
       * WHY: Users want to see responses as they're generated, not wait for
       * the full response. This callback enables real-time streaming.
       *
       * Note: On retry, simple consumers get an auto-separator:
       * "-- that's not right, let me start again:"
       * This prevents confusing concatenated output.
       */
      onStreamChunk?: (chunk: string, messageId?: string) => void | Promise<void>;
      /**
       * Rich event callback for sophisticated UIs.
       *
       * WHY: Simple consumers just need text. Advanced UIs want to know about
       * retries (show spinner), validation (mark content as final), errors
       * (display appropriately).
       *
       * Event types: 'chunk', 'field_validated', 'retry_start', 'retry_context',
       * 'error', 'complete'
       */
      onStreamEvent?: (
        event: import('./state').StreamEvent,
        messageId?: string
      ) => void | Promise<void>;
      /**
       * Abort signal for user-initiated cancellation.
       *
       * WHY: Long-running LLM calls should be cancellable. User might navigate
       * away, click "stop", or timeout. This integrates with standard AbortController.
       */
      abortSignal?: AbortSignal;
    };
  }): Promise<Record<string, any> | null>;

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
