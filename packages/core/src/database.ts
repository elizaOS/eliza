import type {
	Agent,
	AppendConnectorAccountAuditEventParams,
	Component,
	ConnectorAccountAuditEventRecord,
	ConnectorAccountCredentialRefRecord,
	ConnectorAccountRecord,
	ConsumeOAuthFlowStateParams,
	CreateOAuthFlowStateParams,
	DeleteOAuthFlowStateParams,
	DeleteConnectorAccountParams,
	Entity,
	GetConnectorAccountCredentialRefParams,
	GetConnectorAccountParams,
	GetOAuthFlowStateParams,
	IDatabaseAdapter,
	JsonValue,
	ListConnectorAccountCredentialRefsParams,
	ListConnectorAccountsParams,
	Log,
	LogBody,
	Memory,
	MemoryMetadata,
	Metadata,
	PairingAllowlistEntry,
	PairingChannel,
	PairingRequest,
	Participant,
	ParticipantUpdateFields,
	ParticipantUserState,
	PatchOp,
	Relationship,
	Room,
	OAuthFlowRecord,
	SetConnectorAccountCredentialRefParams,
	Task,
	UpdateOAuthFlowStateParams,
	UpsertConnectorAccountParams,
	UUID,
	World,
} from "./types";

/**
 * Abstract base class for database adapters.
 *
 * WHY this exists as an abstract class (not just the IDatabaseAdapter interface):
 * - Provides a single place for JSDoc on every abstract method, so adapter
 *   authors get documentation in their IDE without reading the interface.
 * - Serves as the compile-time contract: if you extend this class and miss
 *   a method, TypeScript tells you immediately.
 * - Contains no persistence logic. Concrete adapters (plugin-sql's Drizzle
 *   adapters, InMemoryDatabaseAdapter, etc.) own storage behavior; unsupported
 *   optional domains throw a clear adapter-level error.
 *
 * All CRUD methods are batch-first (arrays in, arrays out). See
 * IDatabaseAdapter in types/database.ts for the full design rationale.
 *
 * @template DB - The type of the database instance (e.g. PgDatabase, BetterSQLite3Database).
 * @abstract
 */
export abstract class DatabaseAdapter<DB extends object = object>
	implements IDatabaseAdapter<DB>
{
	/**
	 * The database instance.
	 */
	db!: DB;

	/**
	 * Initialize the database adapter.
	 * @param config - Optional configuration object
	 * @returns A Promise that resolves when initialization is complete.
	 */
	abstract initialize(
		config?: Record<string, string | number | boolean | null>,
	): Promise<void>;

	/**
	 * Initialize the database adapter.
	 * @returns A Promise that resolves when initialization is complete.
	 */

	/**
	 * Run plugin schema migrations for all registered plugins
	 * @param plugins Array of plugins with their schemas
	 * @param options Migration options (verbose, force, dryRun, etc.)
	 * @returns A Promise that resolves when migrations are complete.
	 */
	abstract runPluginMigrations(
		plugins: Array<{
			name: string;
			schema?: Record<string, JsonValue>;
		}>,
		options?: {
			verbose?: boolean;
			force?: boolean;
			dryRun?: boolean;
		},
	): Promise<void>;

	/**
	 * Check if the database connection is ready.
	 * @returns A Promise that resolves to true if the database is ready, false otherwise.
	 */
	abstract isReady(): Promise<boolean>;

	/**
	 * Optional close method for the database adapter.
	 * @returns A Promise that resolves when closing is complete.
	 */
	abstract close(): Promise<void>;

	/**
	 * Retrieves a connection to the database.
	 * @returns A Promise that resolves to the database connection.
	 */
	abstract getConnection(): Promise<DB>;

	/**
	 * Execute a callback within a database transaction.
	 * InMemory adapter runs the callback directly without atomicity guarantees.
	 * @param options.entityContext When set (Postgres + ENABLE_DATA_ISOLATION), runs under RLS for this entity.
	 */
	abstract transaction<T>(
		callback: (tx: IDatabaseAdapter<DB>) => Promise<T>,
		options?: { entityContext?: UUID },
	): Promise<T>;

	abstract getEntitiesForRooms(
		roomIds: UUID[],
		includeComponents?: boolean,
	): Promise<import("./types").EntitiesForRoomsResult>;

	/**
	 * Creates a new entities in the database.
	 * @param entities The entity objects to create.
	 * @returns A Promise that resolves when the account creation is complete.
	 */
	abstract createEntities(entities: Entity[]): Promise<UUID[]>;

	/**
	 * Upsert entities (insert or update by ID).
	 * @param entities - An array of entities to upsert (ID required for each).
	 * @returns A Promise that resolves when the upsert is complete.
	 */
	abstract upsertEntities(entities: Entity[]): Promise<void>;

	/**
	 * Search entities by name substring match.
	 * @param params - Search parameters (query, agentId, limit).
	 * @returns A Promise that resolves to matching entities.
	 */
	abstract searchEntitiesByName(params: {
		query: string;
		agentId: UUID;
		limit?: number;
	}): Promise<Entity[]>;

	/**
	 * Get entities by exact name match.
	 * @param params - Lookup parameters (names array, agentId).
	 * @returns A Promise that resolves to matching entities.
	 */
	abstract getEntitiesByNames(params: {
		names: string[];
		agentId: UUID;
	}): Promise<Entity[]>;

	/**
	 * Query entities by component type and optional JSONB data filter.
	 * @param params.entityContext RLS only: when set (Postgres + ENABLE_DATA_ISOLATION), query runs under this entity context. WHY optional: adapters that don't support RLS accept and ignore it.
	 */
	abstract queryEntities(params: {
		componentType?: string;
		componentDataFilter?: Record<string, unknown>;
		agentId?: UUID;
		entityIds?: UUID[];
		worldId?: UUID;
		limit?: number;
		offset?: number;
		includeAllComponents?: boolean;
		entityContext?: UUID;
	}): Promise<Entity[]>;

	abstract getComponentsByNaturalKeys(
		keys: Array<{
			entityId: UUID;
			type: string;
			worldId?: UUID;
			sourceEntityId?: UUID;
		}>,
	): Promise<(Component | null)[]>;

	abstract getComponentsForEntities(
		entityIds: UUID[],
		worldId?: UUID,
		sourceEntityId?: UUID,
	): Promise<Component[]>;

	// ── Entity CRUD (batch-only) ─────────────────────────────────────────
	abstract getEntitiesByIds(entityIds: UUID[]): Promise<Entity[]>;
	abstract updateEntities(entities: Entity[]): Promise<void>;
	abstract deleteEntities(entityIds: UUID[]): Promise<void>;

	// ── Component CRUD (batch-only) ────────────────────────────────────
	abstract createComponents(components: Component[]): Promise<UUID[]>;
	abstract getComponentsByIds(componentIds: UUID[]): Promise<Component[]>;
	abstract updateComponents(components: Component[]): Promise<void>;
	abstract deleteComponents(componentIds: UUID[]): Promise<void>;

	/**
	 * Upsert components (insert or update by natural key).
	 * @param options.entityContext When set (Postgres + ENABLE_DATA_ISOLATION), runs under RLS for this entity.
	 */
	abstract upsertComponents(
		components: Component[],
		options?: { entityContext?: UUID },
	): Promise<void>;

	abstract patchComponents(
		updates: Array<{ componentId: UUID; ops: PatchOp[] }>,
		options?: { entityContext?: UUID },
	): Promise<void>;

	/**
	 * Retrieves memories based on the specified parameters.
	 * @param params An object containing parameters for the memory retrieval.
	 * @returns A Promise that resolves to an array of Memory objects.
	 */
	abstract getMemories(params: {
		entityId?: UUID;
		agentId?: UUID;
		limit?: number;
		count?: number;
		offset?: number;
		unique?: boolean;
		tableName: string;
		start?: number;
		end?: number;
		roomId?: UUID;
		worldId?: UUID;
		metadata?: Record<string, unknown>;
	}): Promise<Memory[]>;

	abstract getMemoriesByRoomIds(params: {
		roomIds: UUID[];
		tableName: string;
		limit?: number;
	}): Promise<Memory[]>;

	/**
	 * Retrieves multiple memories by their IDs
	 * @param memoryIds Array of UUIDs of the memories to retrieve
	 * @param tableName Optional table name to filter memories by type
	 * @returns Promise resolving to array of Memory objects
	 */
	abstract getMemoriesByIds(
		memoryIds: UUID[],
		tableName?: string,
	): Promise<Memory[]>;

	/**
	 * Retrieves cached embeddings based on the specified query parameters.
	 * @param params An object containing parameters for the embedding retrieval.
	 * @returns A Promise that resolves to an array of objects containing embeddings and levenshtein scores.
	 */
	abstract getCachedEmbeddings({
		query_table_name,
		query_threshold,
		query_input,
		query_field_name,
		query_field_sub_name,
		query_match_count,
	}: {
		query_table_name: string;
		query_threshold: number;
		query_input: string;
		query_field_name: string;
		query_field_sub_name: string;
		query_match_count: number;
	}): Promise<
		{
			embedding: number[];
			levenshtein_score: number;
		}[]
	>;

	/**
	 * Retrieves logs based on the specified parameters.
	 * @param params An object containing parameters for the log retrieval.
	 * @returns A Promise that resolves to an array of Log objects.
	 */
	abstract getLogs(params: {
		entityId?: UUID;
		roomId?: UUID;
		type?: string;
		limit?: number;
		offset?: number;
	}): Promise<Log[]>;

	// ── Log CRUD (batch-only) ────────────────────────────────────────────
	abstract createLogs(
		params: Array<{
			body: LogBody;
			entityId: UUID;
			roomId: UUID;
			type: string;
		}>,
	): Promise<void>;
	abstract getLogsByIds(logIds: UUID[]): Promise<Log[]>;
	abstract updateLogs(
		logs: Array<{ id: UUID; updates: Partial<Log> }>,
	): Promise<void>;
	abstract deleteLogs(logIds: UUID[]): Promise<void>;

	/**
	 * Searches for memories based on embeddings and other specified parameters.
	 * @param params An object containing parameters for the memory search.
	 * @returns A Promise that resolves to an array of Memory objects.
	 */
	abstract searchMemories(params: {
		tableName: string;
		embedding: number[];
		match_threshold?: number;
		limit?: number;
		unique?: boolean;
		query?: string;
		roomId?: UUID;
		worldId?: UUID;
		entityId?: UUID;
	}): Promise<Memory[]>;

	// ── Memory CRUD (batch-only) ─────────────────────────────────────────
	abstract createMemories(
		memories: Array<{ memory: Memory; tableName: string; unique?: boolean }>,
	): Promise<UUID[]>;
	abstract updateMemories(
		memories: Array<Partial<Memory> & { id: UUID; metadata?: MemoryMetadata }>,
	): Promise<void>;
	/**
	 * Upsert memories (insert or update by ID).
	 * @param options.entityContext When set (Postgres + ENABLE_DATA_ISOLATION), runs under RLS for this entity.
	 */
	abstract upsertMemories(
		memories: Array<{ memory: Memory; tableName: string }>,
		options?: { entityContext?: UUID },
	): Promise<void>;
	abstract deleteMemories(memoryIds: UUID[]): Promise<void>;

	abstract deleteAllMemories(roomIds: UUID[], tableName: string): Promise<void>;

	abstract countMemories(params: {
		roomIds?: UUID[];
		unique?: boolean;
		tableName?: string;
		entityId?: UUID;
		agentId?: UUID;
		metadata?: Record<string, unknown>;
	}): Promise<number>;

	/**
	 * Retrieves all worlds for an agent.
	 * @returns A Promise that resolves to an array of World objects.
	 */
	abstract getAllWorlds(): Promise<World[]>;

	// ── World CRUD (batch-only) ──────────────────────────────────────────
	abstract getWorldsByIds(worldIds: UUID[]): Promise<World[]>;
	abstract createWorlds(worlds: World[]): Promise<UUID[]>;
	abstract deleteWorlds(worldIds: UUID[]): Promise<void>;
	abstract updateWorlds(worlds: World[]): Promise<void>;

	/**
	 * Upsert worlds (insert or update by ID).
	 * @param worlds - An array of worlds to upsert (ID required for each).
	 * @returns A Promise that resolves when the upsert is complete.
	 */
	abstract upsertWorlds(worlds: World[]): Promise<void>;

	/**
	 * Retrieves the room ID for a given room, if it exists.
	 * @param roomIds The UUIDs of the rooms to retrieve.
	 * @returns A Promise that resolves to the room ID or null if not found.
	 */
	abstract getRoomsByIds(roomIds: UUID[]): Promise<Room[]>;

	abstract deleteRoomsByWorldIds(worldIds: UUID[]): Promise<void>;

	abstract getRoomsForParticipants(entityIds: UUID[]): Promise<UUID[]>;

	abstract getRoomsByWorlds(
		worldIds: UUID[],
		limit?: number,
		offset?: number,
	): Promise<Room[]>;

	/**
	 * Creates new rooms in the database.
	 * @param rooms Array of Room objects to create.
	 * @returns A Promise that resolves to the UUIDs of the created rooms.
	 */
	abstract createRooms(rooms: Room[]): Promise<UUID[]>;

	/**
	 * Upsert rooms (insert or update by ID).
	 * @param rooms - An array of rooms to upsert (ID required for each).
	 * @returns A Promise that resolves when the upsert is complete.
	 */
	abstract upsertRooms(rooms: Room[]): Promise<void>;

	/**
	 * Creates room participants for the specified entities.
	 * @param entityIds The UUIDs of the entities to add as participants.
	 * @param roomId The UUID of the room to which the entities will be added.
	 * @returns A Promise that resolves to the UUIDs of the created participant records.
	 */
	abstract createRoomParticipants(
		entityIds: UUID[],
		roomId: UUID,
	): Promise<UUID[]>;

	// ── Participant mutations (batch-only) ───────────────────────────────
	/** WHY boolean: Callers need success/failure for error handling/UX; see IDatabaseAdapter in types/database.ts. */
	abstract deleteParticipants(
		participants: Array<{ entityId: UUID; roomId: UUID }>,
	): Promise<boolean>;
	abstract updateParticipants(
		participants: Array<{
			entityId: UUID;
			roomId: UUID;
			updates: ParticipantUpdateFields;
		}>,
	): Promise<void>;

	// ── Room CRUD (batch-only) ─────────────────────────────────────────
	abstract updateRooms(rooms: Room[]): Promise<void>;
	abstract deleteRooms(roomIds: UUID[]): Promise<void>;

	abstract getParticipantsForEntities(
		entityIds: UUID[],
	): Promise<Participant[]>;

	abstract getParticipantsForRooms(
		roomIds: UUID[],
	): Promise<import("./types").ParticipantsForRoomsResult>;

	abstract areRoomParticipants(
		pairs: Array<{ roomId: UUID; entityId: UUID }>,
	): Promise<boolean[]>;

	abstract getParticipantUserStates(
		pairs: Array<{ roomId: UUID; entityId: UUID }>,
	): Promise<ParticipantUserState[]>;

	abstract updateParticipantUserStates(
		updates: Array<{
			roomId: UUID;
			entityId: UUID;
			state: ParticipantUserState;
		}>,
	): Promise<void>;

	abstract getRelationshipsByPairs(
		pairs: Array<{ sourceEntityId: UUID; targetEntityId: UUID }>,
	): Promise<(Relationship | null)[]>;

	abstract getRelationships(params: {
		entityIds?: UUID[];
		tags?: string[];
		limit?: number;
		offset?: number;
	}): Promise<Relationship[]>;

	// ── Relationship CRUD (batch-only) ──────────────────────────────────
	abstract createRelationships(
		relationships: Array<{
			sourceEntityId: UUID;
			targetEntityId: UUID;
			tags?: string[];
			metadata?: Metadata;
		}>,
	): Promise<UUID[]>;
	abstract getRelationshipsByIds(
		relationshipIds: UUID[],
	): Promise<Relationship[]>;
	abstract updateRelationships(relationships: Relationship[]): Promise<void>;
	abstract deleteRelationships(relationshipIds: UUID[]): Promise<void>;

	/**
	 * Retrieves all agents from the database.
	 * @returns A Promise that resolves to an array of Agent objects.
	 */
	abstract getAgents(): Promise<Partial<Agent>[]>;

	// ── Agent CRUD (batch-only) ──────────────────────────────────────────
	abstract getAgentsByIds(agentIds: UUID[]): Promise<Agent[]>;
	abstract createAgents(agents: Partial<Agent>[]): Promise<UUID[]>;
	/** WHY boolean: Success/failure signal for callers; see IDatabaseAdapter in types/database.ts. */
	abstract updateAgents(
		updates: Array<{ agentId: UUID; agent: Partial<Agent> }>,
	): Promise<boolean>;
	abstract upsertAgents(agents: Partial<Agent>[]): Promise<void>;
	/** WHY boolean: Success/failure signal for callers; see IDatabaseAdapter in types/database.ts. */
	abstract deleteAgents(agentIds: UUID[]): Promise<boolean>;
	abstract countAgents(): Promise<number>;
	abstract cleanupAgents(): Promise<void>;

	/**
	 * Ensures an embedding dimension exists in the database.
	 * @param dimension The dimension to ensure exists.
	 * @returns A Promise that resolves when the embedding dimension has been ensured to exist.
	 */
	abstract ensureEmbeddingDimension(dimension: number): Promise<void>;

	// ── Cache CRUD (batch-only) ──────────────────────────────────────────
	abstract getCaches<T>(keys: string[]): Promise<Map<string, T>>;
	abstract setCaches<T>(
		entries: Array<{ key: string; value: T }>,
	): Promise<boolean>;
	abstract deleteCaches(keys: string[]): Promise<boolean>;

	/**
	 * Retrieves tasks based on specified parameters.
	 * @param params Object containing optional roomId and tags to filter tasks
	 * @returns Promise resolving to an array of Task objects
	 */
	abstract getTasks(params: {
		roomId?: UUID;
		tags?: string[];
		entityId?: UUID;
		agentIds: UUID[];
		limit?: number;
		offset?: number;
	}): Promise<Task[]>;

	/**
	 * Retrieves a specific task by its name.
	 * @param name The name of the task to retrieve
	 * @returns Promise resolving to the Task object if found, null otherwise
	 */
	abstract getTasksByName(name: string): Promise<Task[]>;

	// ── Task CRUD (batch-only) ───────────────────────────────────────────
	abstract createTasks(tasks: Task[]): Promise<UUID[]>;
	abstract getTasksByIds(taskIds: UUID[]): Promise<Task[]>;
	abstract updateTasks(
		updates: Array<{ id: UUID; task: Partial<Task> }>,
	): Promise<void>;
	abstract deleteTasks(taskIds: UUID[]): Promise<void>;

	abstract getMemoriesByWorldId(params: {
		worldIds?: UUID[];
		limit?: number;
		tableName?: string;
	}): Promise<Memory[]>;

	// ── Pairing CRUD (batch-only for mutations) ─────────────────────────
	abstract getPairingRequests(
		queries: Array<{ channel: PairingChannel; agentId: UUID }>,
	): Promise<import("./types").PairingRequestsResult>;

	abstract getPairingAllowlists(
		queries: Array<{ channel: PairingChannel; agentId: UUID }>,
	): Promise<import("./types").PairingAllowlistsResult>;

	abstract createPairingRequests(requests: PairingRequest[]): Promise<UUID[]>;
	abstract updatePairingRequests(requests: PairingRequest[]): Promise<void>;
	abstract deletePairingRequests(ids: UUID[]): Promise<void>;
	abstract createPairingAllowlistEntries(
		entries: PairingAllowlistEntry[],
	): Promise<UUID[]>;
	abstract updatePairingAllowlistEntries(
		entries: PairingAllowlistEntry[],
	): Promise<void>;
	abstract deletePairingAllowlistEntries(ids: UUID[]): Promise<void>;

	protected unsupportedConnectorAccountStorage(): never {
		throw new Error(
			"Database adapter does not support connector account storage",
		);
	}

	// ── Connector account storage ────────────────────────────────────────
	listConnectorAccounts(
		_params?: ListConnectorAccountsParams,
	): Promise<ConnectorAccountRecord[]> {
		this.unsupportedConnectorAccountStorage();
	}

	getConnectorAccount(
		_params: GetConnectorAccountParams,
	): Promise<ConnectorAccountRecord | null> {
		this.unsupportedConnectorAccountStorage();
	}

	upsertConnectorAccount(
		_params: UpsertConnectorAccountParams,
	): Promise<ConnectorAccountRecord> {
		this.unsupportedConnectorAccountStorage();
	}

	deleteConnectorAccount(
		_params: DeleteConnectorAccountParams,
	): Promise<boolean> {
		this.unsupportedConnectorAccountStorage();
	}

	setConnectorAccountCredentialRef(
		_params: SetConnectorAccountCredentialRefParams,
	): Promise<ConnectorAccountCredentialRefRecord> {
		this.unsupportedConnectorAccountStorage();
	}

	getConnectorAccountCredentialRef(
		_params: GetConnectorAccountCredentialRefParams,
	): Promise<ConnectorAccountCredentialRefRecord | null> {
		this.unsupportedConnectorAccountStorage();
	}

	listConnectorAccountCredentialRefs(
		_params: ListConnectorAccountCredentialRefsParams,
	): Promise<ConnectorAccountCredentialRefRecord[]> {
		this.unsupportedConnectorAccountStorage();
	}

	appendConnectorAccountAuditEvent(
		_params: AppendConnectorAccountAuditEventParams,
	): Promise<ConnectorAccountAuditEventRecord> {
		this.unsupportedConnectorAccountStorage();
	}

	createOAuthFlowState(
		_params: CreateOAuthFlowStateParams,
	): Promise<OAuthFlowRecord> {
		this.unsupportedConnectorAccountStorage();
	}

	consumeOAuthFlowState(
		_params: ConsumeOAuthFlowStateParams,
	): Promise<OAuthFlowRecord | null> {
		this.unsupportedConnectorAccountStorage();
	}

	getOAuthFlowState(
		_params: GetOAuthFlowStateParams,
	): Promise<OAuthFlowRecord | null> {
		this.unsupportedConnectorAccountStorage();
	}

	updateOAuthFlowState(
		_params: UpdateOAuthFlowStateParams,
	): Promise<OAuthFlowRecord | null> {
		this.unsupportedConnectorAccountStorage();
	}

	deleteOAuthFlowState(_params: DeleteOAuthFlowStateParams): Promise<boolean> {
		this.unsupportedConnectorAccountStorage();
	}
}
