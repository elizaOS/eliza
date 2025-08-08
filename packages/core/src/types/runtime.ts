import type { Character } from './agent';
import type { Action, Evaluator, Provider } from './components';
import { HandlerCallback } from './components';
import type { IDatabaseAdapter } from './database';
import type { Entity, Room, World } from './environment';
import { Memory } from './memory';
import type { SendHandlerFunction, TargetInfo } from './messaging';
import type { ModelParamsMap, ModelResultMap, ModelTypeName } from './model';
import type { Plugin, Route } from './plugin';
import type { Content, UUID } from './primitives';
import type { Service, ServiceTypeName } from './service';
import type { State } from './state';
import type { TaskWorker } from './task';

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
  services: Map<ServiceTypeName, Service[]>;
  events: Map<string, ((params: any) => Promise<void>)[]>;
  fetch?: typeof fetch | null;
  routes: Route[];
  logger: any;

  // Methods
  registerPlugin(plugin: Plugin): Promise<void>;

  initialize(): Promise<void>;

  getConnection(): Promise<any>;

  getService<T extends Service>(service: ServiceTypeName | string): T | null;

  getServicesByType<T extends Service>(service: ServiceTypeName | string): T[];

  getAllServices(): Map<ServiceTypeName, Service[]>;

  registerService(service: typeof Service): Promise<void>;

  getRegisteredServiceTypes(): ServiceTypeName[];

  hasService(serviceType: ServiceTypeName | string): boolean;

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

  registerSendHandler(source: string, handler: SendHandlerFunction): void;

  sendMessageToTarget(target: TargetInfo, content: Content): Promise<void>;
}
