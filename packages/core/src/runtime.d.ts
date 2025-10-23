import type { IMessageService } from './services/message-service';
import { ChannelType, type Content, type MemoryMetadata, type Character, type Action, type Evaluator, type Provider, type HandlerCallback, type IDatabaseAdapter, type Entity, type Room, type World, type SendHandlerFunction, type TargetInfo, type ModelParamsMap, type ModelResultMap, type ModelTypeName, type Plugin, type PluginEvents, type Route, type UUID, type Service, type ServiceTypeName, type State, type TaskWorker, type Agent, type Log, type Participant, type Relationship, type Task, type Memory, type ModelHandler, type RuntimeSettings, type Component, IAgentRuntime, type ActionResult, type GenerateTextOptions, type GenerateTextResult } from './types';
export declare class Semaphore {
    private permits;
    private waiting;
    constructor(count: number);
    acquire(): Promise<void>;
    release(): void;
}
export declare class AgentRuntime implements IAgentRuntime {
    #private;
    readonly agentId: UUID;
    readonly character: Character;
    adapter: IDatabaseAdapter;
    readonly actions: Action[];
    readonly evaluators: Evaluator[];
    readonly providers: Provider[];
    readonly plugins: Plugin[];
    events: PluginEvents;
    stateCache: Map<string, State>;
    readonly fetch: typeof fetch;
    services: Map<ServiceTypeName, Service[]>;
    private serviceTypes;
    models: Map<string, ModelHandler[]>;
    routes: Route[];
    private taskWorkers;
    private sendHandlers;
    private eventHandlers;
    private allAvailablePlugins;
    private characterPlugins;
    logger: import("./logger").Logger;
    private settings;
    private servicePromiseHandlers;
    private servicePromises;
    private serviceRegistrationStatus;
    initPromise: Promise<void>;
    private initResolver;
    private initRejecter;
    private migratedPlugins;
    private currentRunId?;
    private currentActionContext?;
    private maxWorkingMemoryEntries;
    messageService: IMessageService | null;
    constructor(opts: {
        conversationLength?: number;
        agentId?: UUID;
        character?: Character;
        plugins?: Plugin[];
        fetch?: typeof fetch;
        adapter?: IDatabaseAdapter;
        settings?: RuntimeSettings;
        allAvailablePlugins?: Plugin[];
    });
    /**
     * Create a new run ID for tracking a sequence of model calls
     */
    createRunId(): UUID;
    /**
     * Start a new run for tracking prompts
     */
    startRun(): UUID;
    /**
     * End the current run
     */
    endRun(): void;
    /**
     * Get the current run ID (creates one if it doesn't exist)
     */
    getCurrentRunId(): UUID;
    registerPlugin(plugin: Plugin): Promise<void>;
    getAllServices(): Map<ServiceTypeName, Service[]>;
    stop(): Promise<void>;
    initialize(): Promise<void>;
    runPluginMigrations(): Promise<void>;
    getConnection(): Promise<unknown>;
    setSetting(key: string, value: string | boolean | null | any, secret?: boolean): void;
    getSetting(key: string): string | boolean | null | any;
    getConversationLength(): number;
    registerDatabaseAdapter(adapter: IDatabaseAdapter): void;
    registerProvider(provider: Provider): void;
    registerAction(action: Action): void;
    registerEvaluator(evaluator: Evaluator): void;
    private updateActionPlan;
    private updateActionStep;
    processActions(message: Memory, responses: Memory[], state?: State, callback?: HandlerCallback): Promise<void>;
    getActionResults(messageId: UUID): ActionResult[];
    evaluate(message: Memory, state: State, didRespond?: boolean, callback?: HandlerCallback, responses?: Memory[]): Promise<Evaluator[]>;
    ensureConnections(entities: any[], rooms: any[], source: string, world: any): Promise<void>;
    ensureConnection({ entityId, roomId, worldId, worldName, userName, name, source, type, channelId, serverId, userId, metadata, }: {
        entityId: UUID;
        roomId: UUID;
        worldId: UUID;
        worldName?: string;
        userName?: string;
        name?: string;
        source?: string;
        type?: ChannelType;
        channelId?: string;
        serverId?: string;
        userId?: UUID;
        metadata?: Record<string, any>;
    }): Promise<void>;
    ensureParticipantInRoom(entityId: UUID, roomId: UUID): Promise<void>;
    removeParticipant(entityId: UUID, roomId: UUID): Promise<boolean>;
    getParticipantsForEntity(entityId: UUID): Promise<Participant[]>;
    getParticipantsForRoom(roomId: UUID): Promise<UUID[]>;
    addParticipant(entityId: UUID, roomId: UUID): Promise<boolean>;
    addParticipantsRoom(entityIds: UUID[], roomId: UUID): Promise<boolean>;
    /**
     * Ensure the existence of a world.
     */
    ensureWorldExists({ id, name, serverId, metadata }: World): Promise<void>;
    ensureRoomExists({ id, name, source, type, channelId, serverId, worldId, metadata }: Room): Promise<void>;
    composeState(message: Memory, includeList?: string[] | null, onlyInclude?: boolean, skipCache?: boolean): Promise<State>;
    getService<T extends Service = Service>(serviceName: ServiceTypeName | string): T | null;
    /**
     * Type-safe service getter that ensures the correct service type is returned
     * @template T - The expected service class type
     * @param serviceName - The service type name
     * @returns The service instance with proper typing, or null if not found
     */
    getTypedService<T extends Service = Service>(serviceName: ServiceTypeName | string): T | null;
    /**
     * Get all services of a specific type
     * @template T - The expected service class type
     * @param serviceName - The service type name
     * @returns Array of service instances with proper typing
     */
    getServicesByType<T extends Service = Service>(serviceName: ServiceTypeName | string): T[];
    /**
     * Get all registered service types
     * @returns Array of registered service type names
     */
    getRegisteredServiceTypes(): ServiceTypeName[];
    /**
     * Check if a service type is registered
     * @param serviceType - The service type to check
     * @returns true if the service is registered
     */
    hasService(serviceType: ServiceTypeName | string): boolean;
    /**
     * Get the registration status of a service
     * @param serviceType - The service type to check
     * @returns the current registration status
     */
    getServiceRegistrationStatus(serviceType: ServiceTypeName | string): 'pending' | 'registering' | 'registered' | 'failed' | 'unknown';
    /**
     * Get service health information
     * @returns Object containing service health status
     */
    getServiceHealth(): Record<string, {
        status: 'pending' | 'registering' | 'registered' | 'failed' | 'unknown';
        instances: number;
        hasPromise: boolean;
    }>;
    registerService(serviceDef: typeof Service): Promise<void>;
    private _createServiceResolver;
    getServiceLoadPromise(serviceType: ServiceTypeName): Promise<Service>;
    registerModel(modelType: ModelTypeName, handler: (params: any) => Promise<any>, provider: string, priority?: number): void;
    getModel(modelType: ModelTypeName, provider?: string): ((runtime: IAgentRuntime, params: any) => Promise<any>) | undefined;
    /**
     * Retrieves model configuration settings from character settings with support for
     * model-specific overrides and default fallbacks.
     *
     * Precedence order (highest to lowest):
     * 1. Model-specific settings (e.g., TEXT_SMALL_TEMPERATURE)
     * 2. Default settings (e.g., DEFAULT_TEMPERATURE)
     * 3. Legacy settings for backwards compatibility (e.g., MODEL_TEMPERATURE)
     *
     * @param modelType The specific model type to get settings for
     * @returns Object containing model parameters if they exist, or null if no settings are configured
     */
    private getModelSettings;
    useModel<T extends ModelTypeName, R = ModelResultMap[T]>(modelType: T, params: Omit<ModelParamsMap[T], 'runtime'> | any, provider?: string): Promise<R>;
    /**
     * Simplified text generation with optional character context.
     */
    generateText(input: string, options?: GenerateTextOptions): Promise<GenerateTextResult>;
    registerEvent(event: string, handler: (params: any) => Promise<void>): void;
    getEvent(event: string): ((params: any) => Promise<void>)[] | undefined;
    emitEvent(event: string | string[], params: any): Promise<void>;
    ensureEmbeddingDimension(): Promise<void>;
    registerTaskWorker(taskHandler: TaskWorker): void;
    getTaskWorker(name: string): TaskWorker | undefined;
    get db(): any;
    init(): Promise<void>;
    close(): Promise<void>;
    getAgent(agentId: UUID): Promise<Agent | null>;
    getAgents(): Promise<Partial<Agent>[]>;
    createAgent(agent: Partial<Agent>): Promise<boolean>;
    updateAgent(agentId: UUID, agent: Partial<Agent>): Promise<boolean>;
    deleteAgent(agentId: UUID): Promise<boolean>;
    ensureAgentExists(agent: Partial<Agent>): Promise<Agent>;
    getEntityById(entityId: UUID): Promise<Entity | null>;
    getEntitiesByIds(entityIds: UUID[]): Promise<Entity[] | null>;
    getEntitiesForRoom(roomId: UUID, includeComponents?: boolean): Promise<Entity[]>;
    createEntity(entity: Entity): Promise<boolean>;
    createEntities(entities: Entity[]): Promise<boolean>;
    updateEntity(entity: Entity): Promise<void>;
    getComponent(entityId: UUID, type: string, worldId?: UUID, sourceEntityId?: UUID): Promise<Component | null>;
    getComponents(entityId: UUID, worldId?: UUID, sourceEntityId?: UUID): Promise<Component[]>;
    createComponent(component: Component): Promise<boolean>;
    updateComponent(component: Component): Promise<void>;
    deleteComponent(componentId: UUID): Promise<void>;
    addEmbeddingToMemory(memory: Memory): Promise<Memory>;
    queueEmbeddingGeneration(memory: Memory, priority?: 'high' | 'normal' | 'low'): Promise<void>;
    getMemories(params: {
        entityId?: UUID;
        agentId?: UUID;
        roomId?: UUID;
        count?: number;
        unique?: boolean;
        tableName: string;
        start?: number;
        end?: number;
    }): Promise<Memory[]>;
    getAllMemories(): Promise<Memory[]>;
    getMemoryById(id: UUID): Promise<Memory | null>;
    getMemoriesByIds(ids: UUID[], tableName?: string): Promise<Memory[]>;
    getMemoriesByRoomIds(params: {
        tableName: string;
        roomIds: UUID[];
        limit?: number;
    }): Promise<Memory[]>;
    getCachedEmbeddings(params: {
        query_table_name: string;
        query_threshold: number;
        query_input: string;
        query_field_name: string;
        query_field_sub_name: string;
        query_match_count: number;
    }): Promise<{
        embedding: number[];
        levenshtein_score: number;
    }[]>;
    log(params: {
        body: {
            [key: string]: unknown;
        };
        entityId: UUID;
        roomId: UUID;
        type: string;
    }): Promise<void>;
    searchMemories(params: {
        embedding: number[];
        query?: string;
        match_threshold?: number;
        count?: number;
        roomId?: UUID;
        unique?: boolean;
        worldId?: UUID;
        entityId?: UUID;
        tableName: string;
    }): Promise<Memory[]>;
    rerankMemories(query: string, memories: Memory[]): Promise<Memory[]>;
    createMemory(memory: Memory, tableName: string, unique?: boolean): Promise<UUID>;
    updateMemory(memory: Partial<Memory> & {
        id: UUID;
        metadata?: MemoryMetadata;
    }): Promise<boolean>;
    deleteMemory(memoryId: UUID): Promise<void>;
    deleteManyMemories(memoryIds: UUID[]): Promise<void>;
    clearAllAgentMemories(): Promise<void>;
    deleteAllMemories(roomId: UUID, tableName: string): Promise<void>;
    countMemories(roomId: UUID, unique?: boolean, tableName?: string): Promise<number>;
    getLogs(params: {
        entityId: UUID;
        roomId?: UUID;
        type?: string;
        count?: number;
        offset?: number;
    }): Promise<Log[]>;
    deleteLog(logId: UUID): Promise<void>;
    createWorld(world: World): Promise<UUID>;
    getWorld(id: UUID): Promise<World | null>;
    removeWorld(worldId: UUID): Promise<void>;
    getAllWorlds(): Promise<World[]>;
    updateWorld(world: World): Promise<void>;
    getRoom(roomId: UUID): Promise<Room | null>;
    getRoomsByIds(roomIds: UUID[]): Promise<Room[] | null>;
    createRoom({ id, name, source, type, channelId, serverId, worldId }: Room): Promise<UUID>;
    createRooms(rooms: Room[]): Promise<UUID[]>;
    deleteRoom(roomId: UUID): Promise<void>;
    deleteRoomsByWorldId(worldId: UUID): Promise<void>;
    updateRoom(room: Room): Promise<void>;
    getRoomsForParticipant(entityId: UUID): Promise<UUID[]>;
    getRoomsForParticipants(userIds: UUID[]): Promise<UUID[]>;
    getRooms(worldId: UUID): Promise<Room[]>;
    getRoomsByWorld(worldId: UUID): Promise<Room[]>;
    getParticipantUserState(roomId: UUID, entityId: UUID): Promise<'FOLLOWED' | 'MUTED' | null>;
    setParticipantUserState(roomId: UUID, entityId: UUID, state: 'FOLLOWED' | 'MUTED' | null): Promise<void>;
    createRelationship(params: {
        sourceEntityId: UUID;
        targetEntityId: UUID;
        tags?: string[];
        metadata?: {
            [key: string]: any;
        };
    }): Promise<boolean>;
    updateRelationship(relationship: Relationship): Promise<void>;
    getRelationship(params: {
        sourceEntityId: UUID;
        targetEntityId: UUID;
    }): Promise<Relationship | null>;
    getRelationships(params: {
        entityId: UUID;
        tags?: string[];
    }): Promise<Relationship[]>;
    getCache<T>(key: string): Promise<T | undefined>;
    setCache<T>(key: string, value: T): Promise<boolean>;
    deleteCache(key: string): Promise<boolean>;
    createTask(task: Task): Promise<UUID>;
    getTasks(params: {
        roomId?: UUID;
        tags?: string[];
        entityId?: UUID;
    }): Promise<Task[]>;
    getTask(id: UUID): Promise<Task | null>;
    getTasksByName(name: string): Promise<Task[]>;
    updateTask(id: UUID, task: Partial<Task>): Promise<void>;
    deleteTask(id: UUID): Promise<void>;
    on(event: string, callback: (data: any) => void): void;
    off(event: string, callback: (data: any) => void): void;
    emit(event: string, data: any): void;
    sendControlMessage(params: {
        roomId: UUID;
        action: 'enable_input' | 'disable_input';
        target?: string;
    }): Promise<void>;
    registerSendHandler(source: string, handler: SendHandlerFunction): void;
    sendMessageToTarget(target: TargetInfo, content: Content): Promise<void>;
    getMemoriesByWorldId(params: {
        worldId: UUID;
        count?: number;
        tableName?: string;
    }): Promise<Memory[]>;
    runMigrations(migrationsPaths?: string[]): Promise<void>;
    isReady(): Promise<boolean>;
}
//# sourceMappingURL=runtime.d.ts.map