import type {
  Agent,
  Component,
  Entity,
  IDatabaseAdapter,
  Log,
  Memory,
  MemoryMetadata,
  Participant,
  Relationship,
  Room,
  Task,
  UUID,
  World,
} from './types';

/**
 * An abstract class representing a database adapter for managing various entities
 * like entities, memories, entities, goals, and rooms.
 */
/**
 * Database adapter class to be extended by individual database adapters.
 *
 * @template DB - The type of the database instance.
 * @abstract
 * implements IDatabaseAdapter
 */
export abstract class DatabaseAdapter<DB = unknown> implements IDatabaseAdapter {
  /**
   * The database instance.
   */
  db!: DB;

  /**
   * Initialize the database adapter.
   * @returns A Promise that resolves when initialization is complete.
   */
  abstract initialize(config?: any): Promise<void>;

  /**
   * Initialize the database adapter.
   * @returns A Promise that resolves when initialization is complete.
   */
  abstract init(): Promise<void>;

  /**
   * Run database migrations
   * @param migrationsPaths Optional array of paths to migration folders
   * @returns A Promise that resolves when migrations are complete.
   */
  abstract runMigrations(migrationsPaths?: string[]): Promise<void>;

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
  abstract getConnection(): Promise<unknown>;

  /**
   * Retrieves an account by its ID.
   * @param entityIds The UUIDs of the user account to retrieve.
   * @returns A Promise that resolves to the Entity object or null if not found.
   */
  abstract getEntitiesByIds(entityIds: UUID[]): Promise<Entity[] | null>;

  abstract getEntitiesForRoom(roomId: UUID, includeComponents?: boolean): Promise<Entity[]>;

  /**
   * Creates a new entities in the database.
   * @param entities The entity objects to create.
   * @returns A Promise that resolves when the account creation is complete.
   */
  abstract createEntities(entities: Entity[]): Promise<boolean>;

  /**
   * Updates an existing entity in the database.
   * @param entity The entity object with updated properties.
   * @returns A Promise that resolves when the account update is complete.
   */
  abstract updateEntity(entity: Entity): Promise<void>;

  /**
   * Retrieves a single component by entity ID and type.
   * @param entityId The UUID of the entity the component belongs to
   * @param type The type identifier for the component
   * @param worldId Optional UUID of the world the component belongs to
   * @param sourceEntityId Optional UUID of the source entity
   * @returns Promise resolving to the Component if found, null otherwise
   */
  abstract getComponent(
    entityId: UUID,
    type: string,
    worldId?: UUID,
    sourceEntityId?: UUID
  ): Promise<Component | null>;

  /**
   * Retrieves all components for an entity.
   * @param entityId The UUID of the entity to get components for
   * @param worldId Optional UUID of the world to filter components by
   * @param sourceEntityId Optional UUID of the source entity to filter by
   * @returns Promise resolving to array of Component objects
   */
  abstract getComponents(
    entityId: UUID,
    worldId?: UUID,
    sourceEntityId?: UUID
  ): Promise<Component[]>;

  /**
   * Creates a new component in the database.
   * @param component The component object to create
   * @returns Promise resolving to true if creation was successful
   */
  abstract createComponent(component: Component): Promise<boolean>;

  /**
   * Updates an existing component in the database.
   * @param component The component object with updated properties
   * @returns Promise that resolves when the update is complete
   */
  abstract updateComponent(component: Component): Promise<void>;

  /**
   * Deletes a component from the database.
   * @param componentId The UUID of the component to delete
   * @returns Promise that resolves when the deletion is complete
   */
  abstract deleteComponent(componentId: UUID): Promise<void>;

  /**
   * Retrieves memories based on the specified parameters.
   * @param params An object containing parameters for the memory retrieval.
   * @returns A Promise that resolves to an array of Memory objects.
   */
  abstract getMemories(params: {
    entityId?: UUID;
    agentId?: UUID;
    count?: number;
    unique?: boolean;
    tableName: string;
    start?: number;
    end?: number;
    roomId?: UUID;
    worldId?: UUID;
  }): Promise<Memory[]>;

  abstract getMemoriesByRoomIds(params: {
    roomIds: UUID[];
    tableName: string;
    limit?: number;
  }): Promise<Memory[]>;

  abstract getMemoryById(id: UUID): Promise<Memory | null>;

  /**
   * Retrieves multiple memories by their IDs
   * @param memoryIds Array of UUIDs of the memories to retrieve
   * @param tableName Optional table name to filter memories by type
   * @returns Promise resolving to array of Memory objects
   */
  abstract getMemoriesByIds(memoryIds: UUID[], tableName?: string): Promise<Memory[]>;

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
   * Logs an event or action with the specified details.
   * @param params An object containing parameters for the log entry.
   * @returns A Promise that resolves when the log entry has been saved.
   */
  abstract log(params: {
    body: { [key: string]: unknown };
    entityId: UUID;
    roomId: UUID;
    type: string;
  }): Promise<void>;

  /**
   * Retrieves logs based on the specified parameters.
   * @param params An object containing parameters for the log retrieval.
   * @returns A Promise that resolves to an array of Log objects.
   */
  abstract getLogs(params: {
    entityId: UUID;
    roomId?: UUID;
    type?: string;
    count?: number;
    offset?: number;
  }): Promise<Log[]>;

  /**
   * Deletes a log from the database.
   * @param logId The UUID of the log to delete.
   * @returns A Promise that resolves when the log has been deleted.
   */
  abstract deleteLog(logId: UUID): Promise<void>;

  /**
   * Searches for memories based on embeddings and other specified parameters.
   * @param params An object containing parameters for the memory search.
   * @returns A Promise that resolves to an array of Memory objects.
   */
  abstract searchMemories(params: {
    tableName: string;
    embedding: number[];
    match_threshold?: number;
    count?: number;
    unique?: boolean;
    query?: string;
    roomId?: UUID;
    worldId?: UUID;
    entityId?: UUID;
  }): Promise<Memory[]>;

  /**
   * Creates a new memory in the database.
   * @param memory The memory object to create.
   * @param tableName The table where the memory should be stored.
   * @param unique Indicates if the memory should be unique.
   * @returns A Promise that resolves when the memory has been created.
   */
  abstract createMemory(memory: Memory, tableName: string, unique?: boolean): Promise<UUID>;

  /**
   * Updates an existing memory in the database.
   * @param memory The memory object with updated content and optional embedding
   * @returns Promise resolving to boolean indicating success
   */
  abstract updateMemory(
    memory: Partial<Memory> & { id: UUID; metadata?: MemoryMetadata }
  ): Promise<boolean>;

  /**
   * Removes a specific memory from the database.
   * @param memoryId The UUID of the memory to remove.
   * @returns A Promise that resolves when the memory has been removed.
   */
  abstract deleteMemory(memoryId: UUID): Promise<void>;

  /**
   * Removes multiple memories from the database in a single batch operation.
   * @param memoryIds An array of UUIDs of the memories to remove.
   * @returns A Promise that resolves when all memories have been removed.
   */
  abstract deleteManyMemories(memoryIds: UUID[]): Promise<void>;

  /**
   * Removes all memories associated with a specific room.
   * @param roomId The UUID of the room whose memories should be removed.
   * @param tableName The table from which the memories should be removed.
   * @returns A Promise that resolves when all memories have been removed.
   */
  abstract deleteAllMemories(roomId: UUID, tableName: string): Promise<void>;

  /**
   * Counts the number of memories in a specific room.
   * @param roomId The UUID of the room for which to count memories.
   * @param unique Specifies whether to count only unique memories.
   * @param tableName Optional table name to count memories from.
   * @returns A Promise that resolves to the number of memories.
   */
  abstract countMemories(roomId: UUID, unique?: boolean, tableName?: string): Promise<number>;

  /**
   * Retrieves a world by its ID.
   * @param id The UUID of the world to retrieve.
   * @returns A Promise that resolves to the World object or null if not found.
   */
  abstract getWorld(id: UUID): Promise<World | null>;

  /**
   * Retrieves all worlds for an agent.
   * @returns A Promise that resolves to an array of World objects.
   */
  abstract getAllWorlds(): Promise<World[]>;

  /**
   * Creates a new world in the database.
   * @param world The world object to create.
   * @returns A Promise that resolves to the UUID of the created world.
   */
  abstract createWorld(world: World): Promise<UUID>;

  /**
   * Updates an existing world in the database.
   * @param world The world object with updated properties.
   * @returns A Promise that resolves when the world has been updated.
   */
  abstract updateWorld(world: World): Promise<void>;

  /**
   * Removes a specific world from the database.
   * @param id The UUID of the world to remove.
   * @returns A Promise that resolves when the world has been removed.
   */
  abstract removeWorld(id: UUID): Promise<void>;

  /**
   * Retrieves the room ID for a given room, if it exists.
   * @param roomIds The UUIDs of the rooms to retrieve.
   * @returns A Promise that resolves to the room ID or null if not found.
   */
  abstract getRoomsByIds(roomIds: UUID[]): Promise<Room[] | null>;

  /**
   * Retrieves all rooms for a given world.
   * @param worldId The UUID of the world to retrieve rooms for.
   * @returns A Promise that resolves to an array of Room objects.
   */
  abstract getRoomsByWorld(worldId: UUID): Promise<Room[]>;

  /**
   * Creates new rooms in the database.
   * @param rooms Array of Room objects to create.
   * @returns A Promise that resolves to the UUIDs of the created rooms.
   */
  abstract createRooms(rooms: Room[]): Promise<UUID[]>;

  /**
   * Updates a specific room in the database.
   * @param room The room object with updated properties.
   * @returns A Promise that resolves when the room has been updated.
   */
  abstract updateRoom(room: Room): Promise<void>;

  /**
   * Removes a specific room from the database.
   * @param roomId The UUID of the room to remove.
   * @returns A Promise that resolves when the room has been removed.
   */
  abstract deleteRoom(roomId: UUID): Promise<void>;

  /**
   * Retrieves room IDs for which a specific user is a participant.
   * @param entityId The UUID of the user.
   * @returns A Promise that resolves to an array of room IDs.
   */
  abstract getRoomsForParticipant(entityId: UUID): Promise<UUID[]>;

  /**
   * Retrieves room IDs for which specific users are participants.
   * @param userIds An array of UUIDs of the users.
   * @returns A Promise that resolves to an array of room IDs.
   */
  abstract getRoomsForParticipants(userIds: UUID[]): Promise<UUID[]>;

  /**
   * Adds users as a participant to a specific room.
   * @param entityIds The UUIDs of the users to add as a participant.
   * @param roomId The UUID of the room to which the user will be added.
   * @returns A Promise that resolves to a boolean indicating success or failure.
   */
  abstract addParticipantsRoom(entityIds: UUID[], roomId: UUID): Promise<boolean>;

  /**
   * Removes a user as a participant from a specific room.
   * @param entityId The UUID of the user to remove as a participant.
   * @param roomId The UUID of the room from which the user will be removed.
   * @returns A Promise that resolves to a boolean indicating success or failure.
   */
  abstract removeParticipant(entityId: UUID, roomId: UUID): Promise<boolean>;

  /**
   * Retrieves participants associated with a specific account.
   * @param entityId The UUID of the account.
   * @returns A Promise that resolves to an array of Participant objects.
   */
  abstract getParticipantsForEntity(entityId: UUID): Promise<Participant[]>;

  /**
   * Retrieves participants for a specific room.
   * @param roomId The UUID of the room for which to retrieve participants.
   * @returns A Promise that resolves to an array of UUIDs representing the participants.
   */
  abstract getParticipantsForRoom(roomId: UUID): Promise<UUID[]>;

  abstract getParticipantUserState(
    roomId: UUID,
    entityId: UUID
  ): Promise<'FOLLOWED' | 'MUTED' | null>;

  abstract setParticipantUserState(
    roomId: UUID,
    entityId: UUID,
    state: 'FOLLOWED' | 'MUTED' | null
  ): Promise<void>;

  /**
   * Creates a new relationship between two users.
   * @param params Object containing the relationship details including entity IDs, agent ID, optional tags and metadata
   * @returns A Promise that resolves to a boolean indicating success or failure of the creation.
   */
  abstract createRelationship(params: {
    sourceEntityId: UUID;
    targetEntityId: UUID;
    tags?: string[];
    metadata?: Record<string, unknown>;
  }): Promise<boolean>;

  /**
   * Retrieves a relationship between two users if it exists.
   * @param params Object containing the entity IDs and agent ID
   * @returns A Promise that resolves to the Relationship object or null if not found.
   */
  abstract getRelationship(params: {
    sourceEntityId: UUID;
    targetEntityId: UUID;
  }): Promise<Relationship | null>;

  /**
   * Retrieves all relationships for a specific user.
   * @param params Object containing the user ID, agent ID and optional tags to filter by
   * @returns A Promise that resolves to an array of Relationship objects.
   */
  abstract getRelationships(params: { entityId: UUID; tags?: string[] }): Promise<Relationship[]>;

  /**
   * Updates an existing relationship between two users.
   * @param params Object containing the relationship details to update including entity IDs, agent ID, optional tags and metadata
   * @returns A Promise that resolves to a boolean indicating success or failure of the update.
   */
  abstract updateRelationship(params: {
    sourceEntityId: UUID;
    targetEntityId: UUID;
    tags?: string[];
    metadata?: Record<string, unknown>;
  }): Promise<void>;

  /**
   * Retrieves an agent by its ID.
   * @param agentId The UUID of the agent to retrieve.
   * @returns A Promise that resolves to the Agent object or null if not found.
   */
  abstract getAgent(agentId: UUID): Promise<Agent | null>;

  /**
   * Retrieves all agents from the database.
   * @returns A Promise that resolves to an array of Agent objects.
   */
  abstract getAgents(): Promise<Partial<Agent>[]>;

  /**
   * Creates a new agent in the database.
   * @param agent The agent object to create.
   * @returns A Promise that resolves to a boolean indicating success or failure of the creation.
   */
  abstract createAgent(agent: Partial<Agent>): Promise<boolean>;

  /**
   * Updates an existing agent in the database.
   * @param agentId The UUID of the agent to update.
   * @param agent The agent object with updated properties.
   * @returns A Promise that resolves to a boolean indicating success or failure of the update.
   */
  abstract updateAgent(agentId: UUID, agent: Partial<Agent>): Promise<boolean>;

  /**
   * Deletes an agent from the database.
   * @param agentId The UUID of the agent to delete.
   * @returns A Promise that resolves to a boolean indicating success or failure of the deletion.
   */
  abstract deleteAgent(agentId: UUID): Promise<boolean>;

  /**
   * Ensures an embedding dimension exists in the database.
   * @param dimension The dimension to ensure exists.
   * @returns A Promise that resolves when the embedding dimension has been ensured to exist.
   */
  abstract ensureEmbeddingDimension(dimension: number): Promise<void>;

  /**
   * Retrieves a cached value by key from the database.
   * @param key The key to look up in the cache
   * @returns Promise resolving to the cached string value
   */
  abstract getCache<T>(key: string): Promise<T | undefined>;

  /**
   * Sets a value in the cache with the given key.
   * @param key The key to store the value under
   * @param value The value to cache
   * @returns Promise resolving to true if the cache was set successfully
   */
  abstract setCache<T>(key: string, value: T): Promise<boolean>;

  /**
   * Deletes a value from the cache by key.
   * @param key The key to delete from the cache
   * @returns Promise resolving to true if the value was successfully deleted
   */
  abstract deleteCache(key: string): Promise<boolean>;

  /**
   * Creates a new task instance in the database.
   * @param task The task object to create
   * @returns Promise resolving to the UUID of the created task
   */
  abstract createTask(task: Task): Promise<UUID>;

  /**
   * Retrieves tasks based on specified parameters.
   * @param params Object containing optional roomId and tags to filter tasks
   * @returns Promise resolving to an array of Task objects
   */
  abstract getTasks(params: { roomId?: UUID; tags?: string[]; entityId?: UUID }): Promise<Task[]>;

  /**
   * Retrieves a specific task by its ID.
   * @param id The UUID of the task to retrieve
   * @returns Promise resolving to the Task object if found, null otherwise
   */
  abstract getTask(id: UUID): Promise<Task | null>;

  /**
   * Retrieves a specific task by its name.
   * @param name The name of the task to retrieve
   * @returns Promise resolving to the Task object if found, null otherwise
   */
  abstract getTasksByName(name: string): Promise<Task[]>;

  /**
   * Updates an existing task in the database.
   * @param id The UUID of the task to update
   * @param task Partial Task object containing the fields to update
   * @returns Promise resolving when the update is complete
   */
  abstract updateTask(id: UUID, task: Partial<Task>): Promise<void>;

  /**
   * Deletes a task from the database.
   * @param id The UUID of the task to delete
   * @returns Promise resolving when the deletion is complete
   */
  abstract deleteTask(id: UUID): Promise<void>;

  abstract getMemoriesByWorldId(params: {
    worldId: UUID;
    count?: number;
    tableName?: string;
  }): Promise<Memory[]>;

  abstract deleteRoomsByWorldId(worldId: UUID): Promise<void>;
}
