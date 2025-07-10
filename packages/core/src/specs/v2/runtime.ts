import { ChannelType } from '../../types';
// Import types with the 'type' keyword
import type {
  Action,
  Agent,
  Character,
  Component,
  Content,
  Entity,
  Evaluator,
  HandlerCallback,
  IAgentRuntime,
  IDatabaseAdapter,
  Log,
  Memory,
  MemoryMetadata,
  ModelParamsMap,
  ModelResultMap,
  ModelTypeName,
  Participant,
  Plugin,
  Provider,
  Relationship,
  Room,
  Route,
  RuntimeSettings,
  SendHandlerFunction,
  Service,
  ServiceTypeName,
  State,
  TargetInfo,
  Task,
  TaskWorker,
  UUID,
  World,
} from './types';

import { AgentRuntime as coreAgentRuntime, Semaphore as coreSemaphore } from '../../runtime';

export class Semaphore {
  private _semphonre;
  constructor(count: number) {
    this._semphonre = new coreSemaphore(count);
  }

  async acquire(): Promise<void> {
    return this._semphonre.acquire();
  }

  release(): void {
    return this._semphonre.release();
  }
}

/**
 * Represents the runtime environment for an agent.
 * @class
 * @implements {IAgentRuntime}
 * @property { number } #conversationLength - The maximum length of a conversation.
 * @property { UUID } agentId - The unique identifier for the agent.
 * @property { Character } character - The character associated with the agent.
 * @property { IDatabaseAdapter } adapter - The adapter for interacting with the database.
 * @property {Action[]} actions - The list of actions available to the agent.
 * @property {Evaluator[]} evaluators - The list of evaluators for decision making.
 * @property {Provider[]} providers - The list of providers for external services.
 * @property {Plugin[]} plugins - The list of plugins to extend functionality.
 */
export class AgentRuntime implements IAgentRuntime {
  private _runtime;

  get services(): Map<ServiceTypeName, Service> {
    return this._runtime.services as any;
  }

  get events(): Map<string, ((params: any) => Promise<void>)[]> {
    // If _runtime.events is already a Map, just cast it
    if (this._runtime.events instanceof Map) {
      return this._runtime.events as Map<string, ((params: any) => Promise<void>)[]>;
    }

    // If it's an object that needs to be converted to a Map
    const eventsMap = new Map<string, ((params: any) => Promise<void>)[]>();

    // Convert object to Map if needed
    if (this._runtime.events && typeof this._runtime.events === 'object') {
      Object.entries(this._runtime.events).forEach(([key, handlers]) => {
        eventsMap.set(key, handlers as ((params: any) => Promise<void>)[]);
      });
    }

    return eventsMap;
  }

  get routes(): Route[] {
    return this._runtime.routes as any;
  }

  get agentId(): UUID {
    return this._runtime.agentId;
  }
  get character(): Character {
    return this._runtime.character as any;
  }
  get providers(): Provider[] {
    return this._runtime.providers as any;
  }
  get actions(): Action[] {
    return this._runtime.actions as any;
  }
  get evaluators(): Evaluator[] {
    return this._runtime.evaluators as any;
  }
  get plugins(): Plugin[] {
    return this._runtime.plugins as any;
  }
  get adapter(): IDatabaseAdapter {
    return this._runtime.adapter as any;
  }

  constructor(opts: {
    conversationLength?: number;
    agentId?: UUID;
    character?: Character;
    plugins?: Plugin[];
    fetch?: typeof fetch;
    adapter?: IDatabaseAdapter;
    settings?: RuntimeSettings;
    events?: { [key: string]: ((params: any) => void)[] };
  }) {
    this._runtime = new coreAgentRuntime(opts as any);
  }

  /**
   * Registers a plugin with the runtime and initializes its components
   * @param plugin The plugin to register
   */
  async registerPlugin(plugin: Plugin): Promise<void> {
    // Wrap the plugin to ensure it receives the v2 runtime instance
    const wrappedPlugin = {
      ...plugin,
      init: plugin.init
        ? async (config: Record<string, string>, _runtime: any) => {
            // Pass the v2 runtime instance (this) instead of the core runtime
            return plugin.init!(config, this);
          }
        : undefined,
    };
    return this._runtime.registerPlugin(wrappedPlugin as any);
  }

  getAllServices(): Map<ServiceTypeName, Service> {
    return this._runtime.services as any;
  }

  async stop() {
    return this._runtime.stop();
  }

  async initialize() {
    return this._runtime.initialize();
  }

  async getConnection(): Promise<any> {
    return this._runtime.getConnection();
  }

  setSetting(key: string, value: string | boolean | null | any, secret = false) {
    return this._runtime.setSetting(key, value, secret);
  }

  getSetting(key: string): string | boolean | null | any {
    return this._runtime.getSetting(key);
  }

  /**
   * Get the number of messages that are kept in the conversation buffer.
   * @returns The number of recent messages to be kept in memory.
   */
  getConversationLength() {
    return this._runtime.getConversationLength();
  }

  registerDatabaseAdapter(adapter: IDatabaseAdapter) {
    return this._runtime.registerDatabaseAdapter(adapter as any);
  }

  /**
   * Register a provider for the agent to use.
   * @param provider The provider to register.
   */
  registerProvider(provider: Provider) {
    // Wrap the provider to ensure it receives the v2 runtime instance
    const wrappedProvider = {
      ...provider,
      get: async (_runtime: any, message: Memory, state: State) => {
        // Pass the v2 runtime instance (this) instead of the core runtime
        return provider.get(this, message, state);
      },
    };
    return this._runtime.registerProvider(wrappedProvider as any);
  }

  /**
   * Register an action for the agent to perform.
   * @param action The action to register.
   */
  registerAction(action: Action) {
    // Wrap the action to ensure its handler receives the v2 runtime instance
    const wrappedAction = {
      ...action,
      handler: async (
        _runtime: any,
        message: Memory,
        state: State,
        options: any,
        callback?: HandlerCallback,
        responses?: Memory[]
      ) => {
        // Pass the v2 runtime instance (this) instead of the core runtime
        return action.handler(this, message, state, options, callback, responses);
      },
    };
    return this._runtime.registerAction(wrappedAction as any);
  }

  /**
   * Register an evaluator to assess and guide the agent's responses.
   * @param evaluator The evaluator to register.
   */
  registerEvaluator(evaluator: Evaluator) {
    return this._runtime.registerEvaluator(evaluator as any);
  }

  /**
   * Process the actions of a message.
   * @param message The message to process.
   * @param responses The array of response memories to process actions from.
   * @param state Optional state object for the action processing.
   * @param callback Optional callback handler for action results.
   */
  async processActions(
    message: Memory,
    responses: Memory[],
    state?: State,
    callback?: HandlerCallback
  ): Promise<void> {
    return this._runtime.processActions(message, responses, state, callback);
  }

  /**
   * Evaluate the message and state using the registered evaluators.
   * @param message The message to evaluate.
   * @param state The state of the agent.
   * @param didRespond Whether the agent responded to the message.~
   * @param callback The handler callback
   * @returns The results of the evaluation.
   */
  async evaluate(
    message: Memory,
    state: State,
    didRespond?: boolean,
    callback?: HandlerCallback,
    responses?: Memory[]
  ) {
    return this._runtime.evaluate(message, state, didRespond, callback, responses) as any;
  }

  async ensureConnection({
    entityId,
    roomId,
    userName,
    name,
    source,
    type,
    channelId,
    serverId,
    worldId,
    userId,
  }: {
    entityId: UUID;
    roomId: UUID;
    userName?: string;
    name?: string;
    source?: string;
    type?: ChannelType;
    channelId?: string;
    serverId?: string;
    worldId?: UUID;
    userId?: UUID;
  }) {
    return this._runtime.ensureConnection({
      entityId,
      roomId,
      userName,
      name,
      source,
      type,
      channelId,
      serverId,
      worldId: worldId as UUID,
      userId,
    });
  }

  /**
   * Ensures a participant is added to a room, checking that the entity exists first
   */
  async ensureParticipantInRoom(entityId: UUID, roomId: UUID) {
    return this._runtime.ensureParticipantInRoom(entityId, roomId);
  }
  async removeParticipant(entityId: UUID, roomId: UUID): Promise<boolean> {
    return this._runtime.removeParticipant(entityId, roomId);
  }
  async getParticipantsForEntity(entityId: UUID): Promise<Participant[]> {
    return this._runtime.getParticipantsForEntity(entityId);
  }
  async getParticipantsForRoom(roomId: UUID): Promise<UUID[]> {
    return this._runtime.getParticipantsForRoom(roomId);
  }
  async addParticipant(entityId: UUID, roomId: UUID): Promise<boolean> {
    return this._runtime.addParticipant(entityId, roomId);
  }
  async addParticipantsRoom(entityIds: UUID[], roomId: UUID): Promise<boolean> {
    return this._runtime.addParticipantsRoom(entityIds, roomId);
  }

  /**
   * Ensure the existence of a world.
   */
  async ensureWorldExists({ id, name, serverId, metadata, agentId }: World) {
    return this._runtime.ensureWorldExists({
      id,
      name,
      serverId,
      metadata,
      agentId,
    });
  }

  /**
   * Ensure the existence of a room between the agent and a user. If no room exists, a new room is created and the user
   * and agent are added as participants. The room ID is returned.
   * @param entityId - The user ID to create a room with.
   * @returns The room ID of the room between the agent and the user.
   * @throws An error if the room cannot be created.
   */
  async ensureRoomExists({ id, name, source, type, channelId, serverId, worldId, metadata }: Room) {
    return this._runtime.ensureRoomExists({
      id,
      name,
      source,
      type,
      channelId,
      serverId,
      worldId,
      metadata,
    });
  }

  /**
   * Composes the agent's state by gathering data from enabled providers.
   * @param message - The message to use as context for state composition
   * @param includeList - Optional list of provider names to include, filtering out all others
   * @param onlyInclude - Whether to only include the specified providers
   * @param skipCache - Whether to skip the cache
   * @returns A State object containing provider data, values, and text
   */
  async composeState(
    message: Memory,
    includeList: string[] | null = null,
    onlyInclude = false,
    skipCache = false
  ): Promise<State> {
    return this._runtime.composeState(message, includeList, onlyInclude, skipCache);
  }

  getService<T extends Service>(service: ServiceTypeName): T | null {
    return this._runtime.getService(service) as any;
  }

  async registerService(service: typeof Service): Promise<void> {
    return this._runtime.registerService(service as any);
  }

  registerModel(
    modelType: ModelTypeName,
    handler: (runtime: IAgentRuntime, params: any) => Promise<any>,
    provider = 'v2'
  ) {
    // Wrap the handler to ensure it receives the v2 runtime instance
    const wrappedHandler = async (_runtime: any, params: any) => {
      // Pass the v2 runtime instance (this) instead of the core runtime
      return handler(this, params);
    };
    return this._runtime.registerModel(modelType, wrappedHandler, provider);
  }

  getModel(
    modelType: ModelTypeName
  ): ((runtime: IAgentRuntime, params: any) => Promise<any>) | undefined {
    return this._runtime.getModel(modelType) as any;
  }

  /**
   * Use a model with strongly typed parameters and return values based on model type
   * @template T - The model type to use
   * @template R - The expected return type, defaults to the type defined in ModelResultMap[T]
   * @param {T} modelType - The type of model to use
   * @param {ModelParamsMap[T] | any} params - The parameters for the model, typed based on model type
   * @returns {Promise<R>} - The model result, typed based on the provided generic type parameter
   */
  async useModel<T extends ModelTypeName, R = ModelResultMap[T]>(
    modelType: T,
    params: Omit<ModelParamsMap[T], 'runtime'> | any
  ): Promise<R> {
    return this._runtime.useModel(modelType, params) as any;
  }

  registerEvent(event: string, handler: (params: any) => Promise<void>) {
    return this._runtime.registerEvent(event, handler);
  }

  getEvent(event: string): ((params: any) => Promise<void>)[] | undefined {
    return this._runtime.getEvent(event);
  }

  async emitEvent(event: string | string[], params: any) {
    return this._runtime.emitEvent(event, params);
  }

  async ensureEmbeddingDimension() {
    return this._runtime.ensureEmbeddingDimension();
  }

  registerTaskWorker(taskHandler: TaskWorker): void {
    return this._runtime.registerTaskWorker(taskHandler as any);
  }

  /**
   * Get a task worker by name
   */
  getTaskWorker(name: string): TaskWorker | undefined {
    return this._runtime.getTaskWorker(name) as any;
  }

  // Implement database adapter methods

  get db(): any {
    return this._runtime.db();
  }

  async init(): Promise<void> {
    return this._runtime.init();
  }

  async close(): Promise<void> {
    return this._runtime.close();
  }

  async getAgent(agentId: UUID): Promise<Agent | null> {
    return this._runtime.getAgent(agentId) as any;
  }

  async getAgents(): Promise<Agent[]> {
    return this._runtime.getAgents() as any;
  }

  async createAgent(agent: Partial<Agent>): Promise<boolean> {
    return this._runtime.createAgent(agent);
  }

  async updateAgent(agentId: UUID, agent: Partial<Agent>): Promise<boolean> {
    return this._runtime.updateAgent(agentId, agent);
  }

  async deleteAgent(agentId: UUID): Promise<boolean> {
    return this._runtime.deleteAgent(agentId);
  }

  async ensureAgentExists(agent: Partial<Agent>): Promise<Agent> {
    return this._runtime.ensureAgentExists(agent) as any;
  }

  async getEntityById(entityId: UUID): Promise<Entity | null> {
    return this._runtime.getEntityById(entityId);
  }

  async getEntitiesByIds(entityIds: UUID[]): Promise<Entity[] | null> {
    return this._runtime.getEntitiesByIds(entityIds);
  }

  async getEntitiesForRoom(roomId: UUID, includeComponents?: boolean): Promise<Entity[]> {
    return this._runtime.getEntitiesForRoom(roomId, includeComponents);
  }

  async createEntity(entity: Entity): Promise<boolean> {
    return this._runtime.createEntity(entity as any);
  }

  async createEntities(entities: Entity[]): Promise<boolean> {
    return this._runtime.createEntities(entities as any);
  }

  async updateEntity(entity: Entity): Promise<void> {
    return this._runtime.updateEntity(entity as any);
  }

  async getComponent(
    entityId: UUID,
    type: string,
    worldId?: UUID,
    sourceEntityId?: UUID
  ): Promise<Component | null> {
    return this._runtime.getComponent(entityId, type, worldId, sourceEntityId);
  }

  async getComponents(entityId: UUID, worldId?: UUID, sourceEntityId?: UUID): Promise<Component[]> {
    return this._runtime.getComponents(entityId, worldId, sourceEntityId);
  }

  async createComponent(component: Component): Promise<boolean> {
    return this._runtime.createComponent(component as any);
  }

  async updateComponent(component: Component): Promise<void> {
    return this._runtime.updateComponent(component as any);
  }

  async deleteComponent(componentId: UUID): Promise<void> {
    return this._runtime.deleteComponent(componentId);
  }

  async addEmbeddingToMemory(memory: Memory): Promise<Memory> {
    return this._runtime.addEmbeddingToMemory(memory);
  }

  async getAllMemories(): Promise<Memory[]> {
    return this._runtime.getAllMemories();
  }

  async clearAllAgentMemories(): Promise<void> {
    return this._runtime.clearAllAgentMemories();
  }

  async getMemories(params: {
    entityId?: UUID;
    agentId?: UUID;
    roomId?: UUID;
    count?: number;
    unique?: boolean;
    tableName: string;
    start?: number;
    end?: number;
  }): Promise<Memory[]> {
    return this._runtime.getMemories(params);
  }

  async getMemoryById(id: UUID): Promise<Memory | null> {
    return this._runtime.getMemoryById(id);
  }

  async getMemoriesByIds(ids: UUID[], tableName?: string): Promise<Memory[]> {
    return this._runtime.getMemoriesByIds(ids, tableName);
  }

  async getMemoriesByRoomIds(params: {
    tableName: string;
    roomIds: UUID[];
    limit?: number;
  }): Promise<Memory[]> {
    return this._runtime.getMemoriesByRoomIds(params);
  }

  async getCachedEmbeddings(params: {
    query_table_name: string;
    query_threshold: number;
    query_input: string;
    query_field_name: string;
    query_field_sub_name: string;
    query_match_count: number;
  }): Promise<{ embedding: number[]; levenshtein_score: number }[]> {
    return this._runtime.getCachedEmbeddings(params);
  }

  async log(params: {
    body: { [key: string]: unknown };
    entityId: UUID;
    roomId: UUID;
    type: string;
  }): Promise<void> {
    return this._runtime.log(params);
  }

  async searchMemories(params: {
    embedding: number[];
    match_threshold?: number;
    count?: number;
    roomId?: UUID;
    unique?: boolean;
    tableName: string;
  }): Promise<Memory[]> {
    return this._runtime.searchMemories(params);
  }

  async createMemory(memory: Memory, tableName: string, unique?: boolean): Promise<UUID> {
    return this._runtime.createMemory(memory, tableName, unique);
  }

  async updateMemory(
    memory: Partial<Memory> & { id: UUID; metadata?: MemoryMetadata }
  ): Promise<boolean> {
    return this._runtime.updateMemory(memory);
  }

  async deleteMemory(memoryId: UUID): Promise<void> {
    return this._runtime.deleteMemory(memoryId);
  }

  async deleteManyMemories(memoryIds: UUID[]): Promise<void> {
    return this._runtime.deleteManyMemories(memoryIds);
  }

  async deleteAllMemories(roomId: UUID, tableName: string): Promise<void> {
    return this._runtime.deleteAllMemories(roomId, tableName);
  }

  async countMemories(roomId: UUID, unique?: boolean, tableName?: string): Promise<number> {
    return this._runtime.countMemories(roomId, unique, tableName);
  }

  async getLogs(params: {
    entityId: UUID;
    roomId?: UUID;
    type?: string;
    count?: number;
    offset?: number;
  }): Promise<Log[]> {
    return this._runtime.getLogs(params);
  }

  async deleteLog(logId: UUID): Promise<void> {
    return this._runtime.deleteLog(logId);
  }

  async createWorld(world: World): Promise<UUID> {
    return this._runtime.createWorld(world);
  }
  async getWorld(id: UUID): Promise<World | null> {
    return this._runtime.getWorld(id);
  }
  async removeWorld(worldId: UUID): Promise<void> {
    return this._runtime.removeWorld(worldId);
  }
  async getAllWorlds(): Promise<World[]> {
    return this._runtime.getAllWorlds();
  }
  async updateWorld(world: World): Promise<void> {
    return this._runtime.updateWorld(world);
  }

  async getRoom(roomId: UUID): Promise<Room | null> {
    return this._runtime.getRoom(roomId);
  }
  async getRoomsByIds(roomIds: UUID[]): Promise<Room[] | null> {
    return this._runtime.getRoomsByIds(roomIds);
  }
  async createRoom({ id, name, source, type, channelId, serverId, worldId }: Room): Promise<UUID> {
    return this._runtime.createRoom({
      id,
      name,
      source,
      type,
      channelId,
      serverId,
      worldId,
    });
  }
  async createRooms(rooms: Room[]): Promise<UUID[]> {
    return this._runtime.createRooms(rooms);
  }
  async deleteRoom(roomId: UUID): Promise<void> {
    return this._runtime.deleteRoom(roomId);
  }
  async deleteRoomsByWorldId(worldId: UUID): Promise<void> {
    return this._runtime.deleteRoomsByWorldId(worldId);
  }
  async updateRoom(room: Room): Promise<void> {
    return this._runtime.updateRoom(room);
  }

  async getRoomsForParticipant(entityId: UUID): Promise<UUID[]> {
    return this._runtime.getRoomsForParticipant(entityId);
  }

  async getRoomsForParticipants(userIds: UUID[]): Promise<UUID[]> {
    return this._runtime.getRoomsForParticipants(userIds);
  }

  async getRooms(worldId: UUID): Promise<Room[]> {
    return this._runtime.getRooms(worldId);
  }
  async getRoomsByWorld(worldId: UUID): Promise<Room[]> {
    return this._runtime.getRoomsByWorld(worldId);
  }

  async getParticipantUserState(
    roomId: UUID,
    entityId: UUID
  ): Promise<'FOLLOWED' | 'MUTED' | null> {
    return this._runtime.getParticipantUserState(roomId, entityId);
  }

  async setParticipantUserState(
    roomId: UUID,
    entityId: UUID,
    state: 'FOLLOWED' | 'MUTED' | null
  ): Promise<void> {
    return this._runtime.setParticipantUserState(roomId, entityId, state);
  }

  async createRelationship(params: {
    sourceEntityId: UUID;
    targetEntityId: UUID;
    tags?: string[];
    metadata?: { [key: string]: any };
  }): Promise<boolean> {
    return this._runtime.createRelationship(params);
  }

  async updateRelationship(relationship: Relationship): Promise<void> {
    return this._runtime.updateRelationship(relationship);
  }

  async getRelationship(params: {
    sourceEntityId: UUID;
    targetEntityId: UUID;
  }): Promise<Relationship | null> {
    return this._runtime.getRelationship(params);
  }

  async getRelationships(params: { entityId: UUID; tags?: string[] }): Promise<Relationship[]> {
    return this._runtime.getRelationships(params);
  }

  async getCache<T>(key: string): Promise<T | undefined> {
    return this._runtime.getCache(key);
  }

  async setCache<T>(key: string, value: T): Promise<boolean> {
    return this._runtime.setCache(key, value);
  }

  async deleteCache(key: string): Promise<boolean> {
    return this._runtime.deleteCache(key);
  }

  async createTask(task: Task): Promise<UUID> {
    return this._runtime.createTask(task);
  }

  async getTasks(params: { roomId?: UUID; tags?: string[] }): Promise<Task[]> {
    return this._runtime.getTasks(params);
  }

  async getTask(id: UUID): Promise<Task | null> {
    return this._runtime.getTask(id);
  }

  async getTasksByName(name: string): Promise<Task[]> {
    return this._runtime.getTasksByName(name);
  }

  async updateTask(id: UUID, task: Partial<Task>): Promise<void> {
    return this._runtime.updateTask(id, task);
  }

  async deleteTask(id: UUID): Promise<void> {
    return this._runtime.deleteTask(id);
  }

  // Event emitter methods
  on(event: string, callback: (data: any) => void): void {
    return this._runtime.on(event, callback);
  }

  off(event: string, callback: (data: any) => void): void {
    return this._runtime.off(event, callback);
  }

  emit(event: string, data: any): void {
    return this._runtime.emit(event, data);
  }

  async sendControlMessage(params: {
    roomId: UUID;
    action: 'enable_input' | 'disable_input';
    target?: string;
  }): Promise<void> {
    return this._runtime.sendControlMessage(params);
  }

  /**
   * Register a message send handler for a specific source
   * @param source - The source identifier (e.g., 'discord', 'telegram')
   * @param handler - The handler function to send messages
   */
  registerSendHandler(source: string, handler: SendHandlerFunction): void {
    this._runtime.registerSendHandler(source, handler);
  }

  /**
   * Send a message to a specific target
   * @param target - The target information including source and channel/user ID
   * @param content - The message content to send
   */
  async sendMessageToTarget(target: TargetInfo, content: Content): Promise<void> {
    return this._runtime.sendMessageToTarget(target, content);
  }

  async getMemoriesByWorldId(params: {
    worldId: UUID;
    count?: number;
    tableName?: string;
  }): Promise<Memory[]> {
    return this._runtime.getMemoriesByWorldId(params);
  }

  // Run tracking methods
  createRunId(): UUID {
    return this._runtime.createRunId();
  }

  startRun(): UUID {
    return this._runtime.startRun();
  }

  endRun(): void {
    return this._runtime.endRun();
  }

  getCurrentRunId(): UUID {
    return this._runtime.getCurrentRunId();
  }
}
