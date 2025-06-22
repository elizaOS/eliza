import type { Character } from './agent';
import type { Action, Evaluator, Provider } from './components';
import { HandlerCallback } from './components';
import type { IDatabaseAdapter } from './database';
import type { Entity, Room, World, GetWorldsOptions } from './environment';
import { Memory } from './memory';
import type { SendHandlerFunction, TargetInfo } from './messaging';
import type { ModelParamsMap, ModelResultMap, ModelTypeName } from './model';
import type { Plugin, Route } from './plugin';
import type { Content, UUID } from './primitives';
import type { Service, ServiceTypeName } from './service';
import type { State } from './state';
import type { TaskWorker } from './task';
import type { ActionPlan, PlanningContext, PlanExecutionResult } from './planning';

/**
 * Represents the core runtime environment for an agent.
 * Defines methods for database interaction, plugin management, event handling,
 * state composition, model usage, and task management.
 */

export interface IAgentRuntime extends IDatabaseAdapter {
  // Properties
  agentId: UUID;
  character: Character;
  providers: Provider[];
  actions: Action[];
  evaluators: Evaluator[];
  plugins: Plugin[];
  services: Map<ServiceTypeName, Service>;
  events: Map<string, ((params: any) => Promise<void>)[]>;
  fetch?: typeof fetch | null;
  routes: Route[];

  // Methods
  registerPlugin(plugin: Plugin): Promise<void>;

  initialize(): Promise<void>;

  getConnection(): Promise<any>;

  getService<T extends Service>(service: ServiceTypeName | string): T | null;

  getAllServices(): Map<ServiceTypeName, Service>;

  registerService(service: typeof Service): Promise<void>;

  // Core interface providers
  getTrustProvider(): import('./trust').ITrustProvider | null;
  registerTrustProvider(provider: import('./trust').ITrustProvider): void;

  getIdentityManager(): import('./identity').IIdentityManager | null;
  registerIdentityManager(manager: import('./identity').IIdentityManager): void;

  getPaymentProvider(): import('./payment').IPaymentProvider | null;
  registerPaymentProvider(provider: import('./payment').IPaymentProvider): void;

  /**
   * Get the configuration manager for plugin component configuration
   */
  getConfigurationManager(): any; // Using 'any' to avoid circular import issues

  // Keep these methods for backward compatibility
  registerDatabaseAdapter(adapter: IDatabaseAdapter): void;

  setSetting(key: string, value: string | boolean | null | any, secret?: boolean): void;

  getSetting(key: string): string | boolean | null | any;

  getConversationLength(): number;

  processActions(
    message: Memory,
    responses: Memory[],
    state?: State,
    callback?: HandlerCallback
  ): Promise<void>;

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
    serverId,
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
    serverId?: string;
    type: any;
    worldId: UUID;
    userId?: UUID;
    metadata?: Record<string, any>;
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

  useModel<T extends ModelTypeName, R = ModelResultMap[T]>(
    modelType: T,
    params: Omit<ModelParamsMap[T], 'runtime'> | any
  ): Promise<R>;

  registerModel(
    modelType: ModelTypeName | string,
    handler: (params: any) => Promise<any>,
    provider: string,
    priority?: number
  ): void;

  getModel(
    modelType: ModelTypeName | string
  ): ((runtime: IAgentRuntime, params: any) => Promise<any>) | undefined;

  registerEvent(event: string, handler: (params: any) => Promise<void>): void;

  getEvent(event: string): ((params: any) => Promise<void>)[] | undefined;

  emitEvent(event: string | string[], params: any): Promise<void>;
  // In-memory task definition methods
  registerTaskWorker(taskHandler: TaskWorker): void;
  getTaskWorker(name: string): TaskWorker | undefined;

  stop(): Promise<void>;

  addEmbeddingToMemory(memory: Memory): Promise<Memory>;

  getAllMemories(): Promise<Memory[]>;

  clearAllAgentMemories(): Promise<void>;

  // Run tracking methods
  createRunId(): UUID;
  startRun(): UUID;
  endRun(): void;
  getCurrentRunId(): UUID;

  // easy/compat wrappers

  getEntityById(entityId: UUID): Promise<Entity | null>;
  getRoom(roomId: UUID): Promise<Room | null>;
  createEntity(entity: Entity): Promise<boolean>;
  createRoom({ id, name, source, type, channelId, serverId, worldId }: Room): Promise<UUID>;
  addParticipant(entityId: UUID, roomId: UUID): Promise<boolean>;
  getRooms(worldId: UUID): Promise<Room[]>;

  /**
   * Get all worlds associated with this agent
   * @param options Optional filtering and pagination options
   * @returns Promise resolving to an array of World objects
   */
  getWorlds(options?: GetWorldsOptions): Promise<World[]>;

  /**
   * Get all worlds without filtering - delegates to adapter.getAllWorlds()
   * @returns Promise resolving to an array of all World objects
   */
  getAllWorlds(): Promise<World[]>;

  registerSendHandler(source: string, handler: SendHandlerFunction): void;

  sendMessageToTarget(target: TargetInfo, content: Content): Promise<void>;

  /**
   * Generate an action plan based on the given message and context
   */
  generatePlan(message: Memory, context: PlanningContext): Promise<ActionPlan>;

  /**
   * Execute an action plan
   */
  executePlan(
    plan: ActionPlan,
    message: Memory,
    callback?: HandlerCallback
  ): Promise<PlanExecutionResult>;

  /**
   * Validate a plan
   */
  validatePlan(plan: ActionPlan): Promise<{ valid: boolean; issues: string[] }>;

  /**
   * Configure a plugin's components dynamically
   * Supports hot-swap enable/disable of components
   */
  configurePlugin(pluginName: string, config: any): Promise<void>;

  /**
   * Enable a specific component dynamically
   */
  enableComponent(
    pluginName: string,
    componentName: string,
    componentType: 'action' | 'provider' | 'evaluator' | 'service',
    component: any
  ): Promise<void>;

  /**
   * Disable a specific component dynamically
   */
  disableComponent(
    pluginName: string,
    componentName: string,
    componentType: 'action' | 'provider' | 'evaluator' | 'service'
  ): Promise<void>;
}
