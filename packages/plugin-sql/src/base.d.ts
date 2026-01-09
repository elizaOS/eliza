import {
  type Agent,
  type AgentRunSummaryResult,
  type Component,
  DatabaseAdapter,
  type Entity,
  type Log,
  type Memory,
  type MemoryMetadata,
  type Metadata,
  type Participant,
  type Relationship,
  type Room,
  type RunStatus,
  type Task,
  type UUID,
  type World,
} from "@elizaos/core";
import type { DatabaseMigrationService } from "./migration-service";
import { type EmbeddingDimensionColumn } from "./schema/embedding";
import type { DrizzleDatabase } from "./types";
/**
 * Represents metadata information about memory.
 * @typedef {Object} MemoryMetadata
 * @property {string} type - The type of memory.
 * @property {string} [source] - The source of the memory.
 * @property {UUID} [sourceId] - The ID of the source.
 * @property {string} [scope] - The scope of the memory.
 * @property {number} [timestamp] - The timestamp of the memory.
 * @property {string[]} [tags] - The tags associated with the memory.
 * @property {UUID} [documentId] - The ID of the document associated with the memory.
 * @property {number} [position] - The position of the memory.
 */
/**
 * Abstract class representing a base Drizzle adapter for working with databases.
 * This adapter provides a comprehensive set of methods for interacting with a database
 * using Drizzle ORM. It implements the DatabaseAdapter interface and handles operations
 * for various entity types including agents, entities, components, memories, rooms,
 * participants, relationships, tasks, and more.
 *
 * The adapter includes built-in retry logic for database operations, embedding dimension
 * management, and transaction support. Concrete implementations must provide the
 * withDatabase method to execute operations against their specific database.
 */
export declare abstract class BaseDrizzleAdapter extends DatabaseAdapter<any> {
  protected readonly maxRetries: number;
  protected readonly baseDelay: number;
  protected readonly maxDelay: number;
  protected readonly jitterMax: number;
  protected embeddingDimension: EmbeddingDimensionColumn;
  protected migrationService?: DatabaseMigrationService;
  protected abstract withDatabase<T>(operation: () => Promise<T>): Promise<T>;
  /**
   * Execute a callback with entity context for Entity RLS.
   * Must be implemented by concrete adapters to handle their specific RLS mechanisms.
   *
   * @param entityId - The entity UUID to set as context (or null for system operations)
   * @param callback - The database operations to execute with the entity context
   * @returns The result of the callback
   */
  abstract withEntityContext<T>(
    entityId: UUID | null,
    callback: (tx: DrizzleDatabase) => Promise<T>,
  ): Promise<T>;
  abstract init(): Promise<void>;
  abstract close(): Promise<void>;
  /**
   * Initialize method that can be overridden by implementations
   */
  initialize(): Promise<void>;
  /**
   * Run plugin schema migrations for all registered plugins
   * @param plugins Array of plugins with their schemas
   * @param options Migration options (verbose, force, dryRun, etc.)
   */
  runPluginMigrations(
    plugins: Array<{
      name: string;
      schema?: Record<string, unknown>;
    }>,
    options?: {
      verbose?: boolean;
      force?: boolean;
      dryRun?: boolean;
    },
  ): Promise<void>;
  /**
   * Get the underlying database instance for testing purposes
   */
  getDatabase(): unknown;
  protected agentId: UUID;
  /**
   * Constructor for creating a new instance of Agent with the specified agentId.
   *
   * @param {UUID} agentId - The unique identifier for the agent.
   */
  constructor(agentId: UUID);
  /**
   * Normalizes entity names to ensure they are always a proper array of strings.
   * Handles strings, Sets, Maps, iterables, and non-iterable values.
   * All array elements are converted to strings to prevent database errors.
   * @param {any} names - The names value to normalize
   * @returns {string[]} A proper array of string names
   * @private
   */
  private normalizeEntityNames;
  /**
   * Executes the given operation with retry logic.
   * @template T
   * @param {() => Promise<T>} operation - The operation to be executed.
   * @returns {Promise<T>} A promise that resolves with the result of the operation.
   */
  protected withRetry<T>(operation: () => Promise<T>): Promise<T>;
  /**
   * Asynchronously ensures that the given embedding dimension is valid for the agent.
   *
   * @param {number} dimension - The dimension to ensure for the embedding.
   * @returns {Promise<void>} - Resolves once the embedding dimension is ensured.
   */
  ensureEmbeddingDimension(dimension: number): Promise<void>;
  /**
   * Asynchronously retrieves an agent by their ID from the database.
   * @param {UUID} agentId - The ID of the agent to retrieve.
   * @returns {Promise<Agent | null>} A promise that resolves to the retrieved agent or null if not found.
   */
  getAgent(agentId: UUID): Promise<Agent | null>;
  /**
   * Asynchronously retrieves a list of agents from the database.
   *
   * @returns {Promise<Partial<Agent>[]>} A Promise that resolves to an array of Agent objects.
   */
  getAgents(): Promise<Partial<Agent>[]>;
  /**
   * Asynchronously creates a new agent record in the database.
   *
   * @param {Partial<Agent>} agent The agent object to be created.
   * @returns {Promise<boolean>} A promise that resolves to a boolean indicating the success of the operation.
   */
  createAgent(agent: Agent): Promise<boolean>;
  /**
   * Updates an agent in the database with the provided agent ID and data.
   * @param {UUID} agentId - The unique identifier of the agent to update.
   * @param {Partial<Agent>} agent - The partial agent object containing the fields to update.
   * @returns {Promise<boolean>} - A boolean indicating if the agent was successfully updated.
   */
  updateAgent(agentId: UUID, agent: Partial<Agent>): Promise<boolean>;
  /**
   * Merges updated agent settings with existing settings in the database,
   * with special handling for nested objects like secrets.
   * @param tx - The database transaction
   * @param agentId - The ID of the agent
   * @param updatedSettings - The settings object with updates
   * @returns The merged settings object
   * @private
   */
  private mergeAgentSettings;
  /**
   * Asynchronously deletes an agent with the specified UUID and all related entries.
   *
   * @param {UUID} agentId - The UUID of the agent to be deleted.
   * @returns {Promise<boolean>} - A boolean indicating if the deletion was successful.
   */
  deleteAgent(agentId: UUID): Promise<boolean>;
  /**
   * Count all agents in the database
   * Used primarily for maintenance and cleanup operations
   */
  /**
   * Asynchronously counts the number of agents in the database.
   * @returns {Promise<number>} A Promise that resolves to the number of agents in the database.
   */
  countAgents(): Promise<number>;
  /**
   * Clean up the agents table by removing all agents
   * This is used during server startup to ensure no orphaned agents exist
   * from previous crashes or improper shutdowns
   */
  cleanupAgents(): Promise<void>;
  /**
   * Asynchronously retrieves an entity and its components by entity IDs.
   * @param {UUID[]} entityIds - The unique identifiers of the entities to retrieve.
   * @returns {Promise<Entity[] | null>} A Promise that resolves to the entity with its components if found, null otherwise.
   */
  getEntitiesByIds(entityIds: UUID[]): Promise<Entity[] | null>;
  /**
   * Asynchronously retrieves all entities for a given room, optionally including their components.
   * @param {UUID} roomId - The unique identifier of the room to get entities for
   * @param {boolean} [includeComponents] - Whether to include component data for each entity
   * @returns {Promise<Entity[]>} A Promise that resolves to an array of entities in the room
   */
  getEntitiesForRoom(
    roomId: UUID,
    includeComponents?: boolean,
  ): Promise<Entity[]>;
  /**
   * Asynchronously creates new entities in the database.
   * @param {Entity[]} entities - The entity objects to be created.
   * @returns {Promise<boolean>} A Promise that resolves to a boolean indicating the success of the operation.
   */
  createEntities(entities: Entity[]): Promise<boolean>;
  /**
   * Asynchronously ensures an entity exists, creating it if it doesn't
   * @param entity The entity to ensure exists
   * @returns Promise resolving to boolean indicating success
   */
  protected ensureEntityExists(entity: Entity): Promise<boolean>;
  /**
   * Asynchronously updates an entity in the database.
   * @param {Entity} entity - The entity object to be updated.
   * @returns {Promise<void>} A Promise that resolves when the entity is updated.
   */
  updateEntity(entity: Entity): Promise<void>;
  /**
   * Asynchronously deletes an entity from the database based on the provided ID.
   * @param {UUID} entityId - The ID of the entity to delete.
   * @returns {Promise<void>} A Promise that resolves when the entity is deleted.
   */
  deleteEntity(entityId: UUID): Promise<void>;
  /**
   * Asynchronously retrieves entities by their names and agentId.
   * @param {Object} params - The parameters for retrieving entities.
   * @param {string[]} params.names - The names to search for.
   * @param {UUID} params.agentId - The agent ID to filter by.
   * @returns {Promise<Entity[]>} A Promise that resolves to an array of entities.
   */
  getEntitiesByNames(params: {
    names: string[];
    agentId: UUID;
  }): Promise<Entity[]>;
  /**
   * Asynchronously searches for entities by name with fuzzy matching.
   * @param {Object} params - The parameters for searching entities.
   * @param {string} params.query - The search query.
   * @param {UUID} params.agentId - The agent ID to filter by.
   * @param {number} params.limit - The maximum number of results to return.
   * @returns {Promise<Entity[]>} A Promise that resolves to an array of entities.
   */
  searchEntitiesByName(params: {
    query: string;
    agentId: UUID;
    limit?: number;
  }): Promise<Entity[]>;
  getComponent(
    entityId: UUID,
    type: string,
    worldId?: UUID,
    sourceEntityId?: UUID,
  ): Promise<Component | null>;
  /**
   * Asynchronously retrieves all components for a given entity, optionally filtered by world and source entity.
   * @param {UUID} entityId - The unique identifier of the entity to retrieve components for
   * @param {UUID} [worldId] - Optional world ID to filter components by
   * @param {UUID} [sourceEntityId] - Optional source entity ID to filter components by
   * @returns {Promise<Component[]>} A Promise that resolves to an array of components
   */
  getComponents(
    entityId: UUID,
    worldId?: UUID,
    sourceEntityId?: UUID,
  ): Promise<Component[]>;
  /**
   * Asynchronously creates a new component in the database.
   * @param {Component} component - The component object to be created.
   * @returns {Promise<boolean>} A Promise that resolves to a boolean indicating the success of the operation.
   */
  createComponent(component: Component): Promise<boolean>;
  /**
   * Asynchronously updates an existing component in the database.
   * @param {Component} component - The component object to be updated.
   * @returns {Promise<void>} A Promise that resolves when the component is updated.
   */
  updateComponent(component: Component): Promise<void>;
  /**
   * Asynchronously deletes a component from the database.
   * @param {UUID} componentId - The unique identifier of the component to delete.
   * @returns {Promise<void>} A Promise that resolves when the component is deleted.
   */
  deleteComponent(componentId: UUID): Promise<void>;
  /**
   * Asynchronously retrieves memories from the database based on the provided parameters.
   * @param {Object} params - The parameters for retrieving memories.
   * @param {UUID} params.roomId - The ID of the room to retrieve memories for.
   * @param {number} [params.count] - The maximum number of memories to retrieve.
   * @param {number} [params.offset] - The offset for pagination.
   * @param {boolean} [params.unique] - Whether to retrieve unique memories only.
   * @param {string} [params.tableName] - The name of the table to retrieve memories from.
   * @param {number} [params.start] - The start date to retrieve memories from.
   * @param {number} [params.end] - The end date to retrieve memories from.
   * @returns {Promise<Memory[]>} A Promise that resolves to an array of memories.
   */
  getMemories(params: {
    entityId?: UUID;
    agentId?: UUID;
    count?: number;
    offset?: number;
    unique?: boolean;
    tableName: string;
    start?: number;
    end?: number;
    roomId?: UUID;
    worldId?: UUID;
  }): Promise<Memory[]>;
  /**
   * Asynchronously retrieves memories from the database based on the provided parameters.
   * @param {Object} params - The parameters for retrieving memories.
   * @param {UUID[]} params.roomIds - The IDs of the rooms to retrieve memories for.
   * @param {string} params.tableName - The name of the table to retrieve memories from.
   * @param {number} [params.limit] - The maximum number of memories to retrieve.
   * @returns {Promise<Memory[]>} A Promise that resolves to an array of memories.
   */
  getMemoriesByRoomIds(params: {
    roomIds: UUID[];
    tableName: string;
    limit?: number;
  }): Promise<Memory[]>;
  /**
   * Asynchronously retrieves a memory by its unique identifier.
   * @param {UUID} id - The unique identifier of the memory to retrieve.
   * @returns {Promise<Memory | null>} A Promise that resolves to the memory if found, null otherwise.
   */
  getMemoryById(id: UUID): Promise<Memory | null>;
  /**
   * Asynchronously retrieves memories from the database based on the provided parameters.
   * @param {Object} params - The parameters for retrieving memories.
   * @param {UUID[]} params.memoryIds - The IDs of the memories to retrieve.
   * @param {string} [params.tableName] - The name of the table to retrieve memories from.
   * @returns {Promise<Memory[]>} A Promise that resolves to an array of memories.
   */
  getMemoriesByIds(memoryIds: UUID[], tableName?: string): Promise<Memory[]>;
  /**
   * Asynchronously retrieves cached embeddings from the database based on the provided parameters.
   * @param {Object} opts - The parameters for retrieving cached embeddings.
   * @param {string} opts.query_table_name - The name of the table to retrieve embeddings from.
   * @param {number} opts.query_threshold - The threshold for the levenshtein distance.
   * @param {string} opts.query_input - The input string to search for.
   * @param {string} opts.query_field_name - The name of the field to retrieve embeddings from.
   * @param {string} opts.query_field_sub_name - The name of the sub-field to retrieve embeddings from.
   * @param {number} opts.query_match_count - The maximum number of matches to retrieve.
   * @returns {Promise<{ embedding: number[]; levenshtein_score: number }[]>} A Promise that resolves to an array of cached embeddings.
   */
  getCachedEmbeddings(opts: {
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
   * Asynchronously logs an event in the database.
   * @param {Object} params - The parameters for logging an event.
   * @param {Object} params.body - The body of the event to log.
   * @param {UUID} params.entityId - The ID of the entity associated with the event.
   * @param {UUID} params.roomId - The ID of the room associated with the event.
   * @param {string} params.type - The type of the event to log.
   * @returns {Promise<void>} A Promise that resolves when the event is logged.
   */
  log(params: {
    body: {
      [key: string]: unknown;
    };
    entityId: UUID;
    roomId: UUID;
    type: string;
  }): Promise<void>;
  /**
   * Sanitizes a JSON object by replacing problematic Unicode escape sequences
   * that could cause errors during JSON serialization/storage
   *
   * @param value - The value to sanitize
   * @returns The sanitized value
   */
  private sanitizeJsonObject;
  /**
   * Asynchronously retrieves logs from the database based on the provided parameters.
   * @param {Object} params - The parameters for retrieving logs.
   * @param {UUID} params.entityId - The ID of the entity associated with the logs.
   * @param {UUID} [params.roomId] - The ID of the room associated with the logs.
   * @param {string} [params.type] - The type of the logs to retrieve.
   * @param {number} [params.count] - The maximum number of logs to retrieve.
   * @param {number} [params.offset] - The offset to retrieve logs from.
   * @returns {Promise<Log[]>} A Promise that resolves to an array of logs.
   */
  getLogs(params: {
    entityId?: UUID;
    roomId?: UUID;
    type?: string;
    count?: number;
    offset?: number;
  }): Promise<Log[]>;
  getAgentRunSummaries(params?: {
    limit?: number;
    roomId?: UUID;
    status?: RunStatus | "all";
    from?: number;
    to?: number;
    entityId?: UUID;
  }): Promise<AgentRunSummaryResult>;
  /**
   * Asynchronously deletes a log from the database based on the provided parameters.
   * @param {UUID} logId - The ID of the log to delete.
   * @returns {Promise<void>} A Promise that resolves when the log is deleted.
   */
  deleteLog(logId: UUID): Promise<void>;
  /**
   * Asynchronously searches for memories in the database based on the provided parameters.
   * @param {Object} params - The parameters for searching for memories.
   * @param {string} params.tableName - The name of the table to search for memories in.
   * @param {number[]} params.embedding - The embedding to search for.
   * @param {number} [params.match_threshold] - The threshold for the cosine distance.
   * @param {number} [params.count] - The maximum number of memories to retrieve.
   * @param {boolean} [params.unique] - Whether to retrieve unique memories only.
   * @param {string} [params.query] - Optional query string for potential reranking.
   * @param {UUID} [params.roomId] - Optional room ID to filter by.
   * @param {UUID} [params.worldId] - Optional world ID to filter by.
   * @param {UUID} [params.entityId] - Optional entity ID to filter by.
   * @returns {Promise<Memory[]>} A Promise that resolves to an array of memories.
   */
  searchMemories(params: {
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
   * Asynchronously searches for memories in the database based on the provided parameters.
   * @param {number[]} embedding - The embedding to search for.
   * @param {Object} params - The parameters for searching for memories.
   * @param {number} [params.match_threshold] - The threshold for the cosine distance.
   * @param {number} [params.count] - The maximum number of memories to retrieve.
   * @param {UUID} [params.roomId] - Optional room ID to filter by.
   * @param {UUID} [params.worldId] - Optional world ID to filter by.
   * @param {UUID} [params.entityId] - Optional entity ID to filter by.
   * @param {boolean} [params.unique] - Whether to retrieve unique memories only.
   * @param {string} [params.tableName] - The name of the table to search for memories in.
   * @returns {Promise<Memory[]>} A Promise that resolves to an array of memories.
   */
  searchMemoriesByEmbedding(
    embedding: number[],
    params: {
      match_threshold?: number;
      count?: number;
      roomId?: UUID;
      worldId?: UUID;
      entityId?: UUID;
      unique?: boolean;
      tableName: string;
    },
  ): Promise<Memory[]>;
  /**
   * Asynchronously creates a new memory in the database.
   * @param {Memory & { metadata?: MemoryMetadata }} memory - The memory object to create.
   * @param {string} tableName - The name of the table to create the memory in.
   * @returns {Promise<UUID>} A Promise that resolves to the ID of the created memory.
   */
  createMemory(
    memory: Memory & {
      metadata?: MemoryMetadata;
    },
    tableName: string,
  ): Promise<UUID>;
  /**
   * Updates an existing memory in the database.
   * @param memory The memory object with updated content and optional embedding
   * @returns Promise resolving to boolean indicating success
   */
  updateMemory(
    memory: Partial<Memory> & {
      id: UUID;
      metadata?: MemoryMetadata;
    },
  ): Promise<boolean>;
  /**
   * Asynchronously deletes a memory from the database based on the provided parameters.
   * @param {UUID} memoryId - The ID of the memory to delete.
   * @returns {Promise<void>} A Promise that resolves when the memory is deleted.
   */
  deleteMemory(memoryId: UUID): Promise<void>;
  /**
   * Asynchronously deletes multiple memories from the database in a single batch operation.
   * @param {UUID[]} memoryIds - An array of UUIDs of the memories to delete.
   * @returns {Promise<void>} A Promise that resolves when all memories are deleted.
   */
  deleteManyMemories(memoryIds: UUID[]): Promise<void>;
  /**
   * Deletes all memory fragments that reference a specific document memory
   * @param tx The database transaction
   * @param documentId The UUID of the document memory whose fragments should be deleted
   * @private
   */
  private deleteMemoryFragments;
  /**
   * Retrieves all memory fragments that reference a specific document memory
   * @param tx The database transaction
   * @param documentId The UUID of the document memory whose fragments should be retrieved
   * @returns An array of memory fragments
   * @private
   */
  private getMemoryFragments;
  /**
   * Asynchronously deletes all memories from the database based on the provided parameters.
   * @param {UUID} roomId - The ID of the room to delete memories from.
   * @param {string} tableName - The name of the table to delete memories from.
   * @returns {Promise<void>} A Promise that resolves when the memories are deleted.
   */
  deleteAllMemories(roomId: UUID, tableName: string): Promise<void>;
  /**
   * Asynchronously counts the number of memories in the database based on the provided parameters.
   * @param {UUID} roomId - The ID of the room to count memories in.
   * @param {boolean} [unique] - Whether to count unique memories only.
   * @param {string} [tableName] - The name of the table to count memories in.
   * @returns {Promise<number>} A Promise that resolves to the number of memories.
   */
  countMemories(
    roomId: UUID,
    unique?: boolean,
    tableName?: string,
  ): Promise<number>;
  /**
   * Asynchronously retrieves rooms from the database based on the provided parameters.
   * @param {UUID[]} roomIds - The IDs of the rooms to retrieve.
   * @returns {Promise<Room[] | null>} A Promise that resolves to the rooms if found, null otherwise.
   */
  getRoomsByIds(roomIds: UUID[]): Promise<Room[] | null>;
  /**
   * Asynchronously retrieves all rooms from the database based on the provided parameters.
   * @param {UUID} worldId - The ID of the world to retrieve rooms from.
   * @returns {Promise<Room[]>} A Promise that resolves to an array of rooms.
   */
  getRoomsByWorld(worldId: UUID): Promise<Room[]>;
  /**
   * Asynchronously updates a room in the database based on the provided parameters.
   * @param {Room} room - The room object to update.
   * @returns {Promise<void>} A Promise that resolves when the room is updated.
   */
  updateRoom(room: Room): Promise<void>;
  /**
   * Asynchronously creates a new room in the database based on the provided parameters.
   * @param {Room} room - The room object to create.
   * @returns {Promise<UUID>} A Promise that resolves to the ID of the created room.
   */
  createRooms(rooms: Room[]): Promise<UUID[]>;
  /**
   * Asynchronously deletes a room from the database based on the provided parameters.
   * @param {UUID} roomId - The ID of the room to delete.
   * @returns {Promise<void>} A Promise that resolves when the room is deleted.
   */
  deleteRoom(roomId: UUID): Promise<void>;
  /**
   * Asynchronously retrieves all rooms for a participant from the database based on the provided parameters.
   * @param {UUID} entityId - The ID of the entity to retrieve rooms for.
   * @returns {Promise<UUID[]>} A Promise that resolves to an array of room IDs.
   */
  getRoomsForParticipant(entityId: UUID): Promise<UUID[]>;
  /**
   * Asynchronously retrieves all rooms for a list of participants from the database based on the provided parameters.
   * @param {UUID[]} entityIds - The IDs of the entities to retrieve rooms for.
   * @returns {Promise<UUID[]>} A Promise that resolves to an array of room IDs.
   */
  getRoomsForParticipants(entityIds: UUID[]): Promise<UUID[]>;
  /**
   * Asynchronously adds a participant to a room in the database based on the provided parameters.
   * @param {UUID} entityId - The ID of the entity to add to the room.
   * @param {UUID} roomId - The ID of the room to add the entity to.
   * @returns {Promise<boolean>} A Promise that resolves to a boolean indicating whether the participant was added successfully.
   */
  addParticipant(entityId: UUID, roomId: UUID): Promise<boolean>;
  addParticipantsRoom(entityIds: UUID[], roomId: UUID): Promise<boolean>;
  /**
   * Asynchronously removes a participant from a room in the database based on the provided parameters.
   * @param {UUID} entityId - The ID of the entity to remove from the room.
   * @param {UUID} roomId - The ID of the room to remove the entity from.
   * @returns {Promise<boolean>} A Promise that resolves to a boolean indicating whether the participant was removed successfully.
   */
  removeParticipant(entityId: UUID, roomId: UUID): Promise<boolean>;
  /**
   * Asynchronously retrieves all participants for an entity from the database based on the provided parameters.
   * @param {UUID} entityId - The ID of the entity to retrieve participants for.
   * @returns {Promise<Participant[]>} A Promise that resolves to an array of participants.
   */
  getParticipantsForEntity(entityId: UUID): Promise<Participant[]>;
  /**
   * Asynchronously retrieves all participants for a room from the database based on the provided parameters.
   * @param {UUID} roomId - The ID of the room to retrieve participants for.
   * @returns {Promise<UUID[]>} A Promise that resolves to an array of entity IDs.
   */
  getParticipantsForRoom(roomId: UUID): Promise<UUID[]>;
  /**
   * Check if an entity is a participant in a specific room/channel.
   * More efficient than getParticipantsForRoom when only checking membership.
   * @param {UUID} roomId - The ID of the room to check.
   * @param {UUID} entityId - The ID of the entity to check.
   * @returns {Promise<boolean>} A Promise that resolves to true if entity is a participant.
   */
  isRoomParticipant(roomId: UUID, entityId: UUID): Promise<boolean>;
  /**
   * Asynchronously retrieves the user state for a participant in a room from the database based on the provided parameters.
   * @param {UUID} roomId - The ID of the room to retrieve the participant's user state for.
   * @param {UUID} entityId - The ID of the entity to retrieve the user state for.
   * @returns {Promise<"FOLLOWED" | "MUTED" | null>} A Promise that resolves to the participant's user state.
   */
  getParticipantUserState(
    roomId: UUID,
    entityId: UUID,
  ): Promise<"FOLLOWED" | "MUTED" | null>;
  /**
   * Asynchronously sets the user state for a participant in a room in the database based on the provided parameters.
   * @param {UUID} roomId - The ID of the room to set the participant's user state for.
   * @param {UUID} entityId - The ID of the entity to set the user state for.
   * @param {string} state - The state to set the participant's user state to.
   * @returns {Promise<void>} A Promise that resolves when the participant's user state is set.
   */
  setParticipantUserState(
    roomId: UUID,
    entityId: UUID,
    state: "FOLLOWED" | "MUTED" | null,
  ): Promise<void>;
  /**
   * Asynchronously creates a new relationship in the database based on the provided parameters.
   * @param {Object} params - The parameters for creating a new relationship.
   * @param {UUID} params.sourceEntityId - The ID of the source entity.
   * @param {UUID} params.targetEntityId - The ID of the target entity.
   * @param {string[]} [params.tags] - The tags for the relationship.
   * @param {Object} [params.metadata] - The metadata for the relationship.
   * @returns {Promise<boolean>} A Promise that resolves to a boolean indicating whether the relationship was created successfully.
   */
  createRelationship(params: {
    sourceEntityId: UUID;
    targetEntityId: UUID;
    tags?: string[];
    metadata?: {
      [key: string]: unknown;
    };
  }): Promise<boolean>;
  /**
   * Asynchronously updates an existing relationship in the database based on the provided parameters.
   * @param {Relationship} relationship - The relationship object to update.
   * @returns {Promise<void>} A Promise that resolves when the relationship is updated.
   */
  updateRelationship(relationship: Relationship): Promise<void>;
  /**
   * Asynchronously retrieves a relationship from the database based on the provided parameters.
   * @param {Object} params - The parameters for retrieving a relationship.
   * @param {UUID} params.sourceEntityId - The ID of the source entity.
   * @param {UUID} params.targetEntityId - The ID of the target entity.
   * @returns {Promise<Relationship | null>} A Promise that resolves to the relationship if found, null otherwise.
   */
  getRelationship(params: {
    sourceEntityId: UUID;
    targetEntityId: UUID;
  }): Promise<Relationship | null>;
  /**
   * Asynchronously retrieves relationships from the database based on the provided parameters.
   * @param {Object} params - The parameters for retrieving relationships.
   * @param {UUID} params.entityId - The ID of the entity to retrieve relationships for.
   * @param {string[]} [params.tags] - The tags to filter relationships by.
   * @returns {Promise<Relationship[]>} A Promise that resolves to an array of relationships.
   */
  getRelationships(params: {
    entityId: UUID;
    tags?: string[];
  }): Promise<Relationship[]>;
  /**
   * Asynchronously retrieves a cache value from the database based on the provided key.
   * @param {string} key - The key to retrieve the cache value for.
   * @returns {Promise<T | undefined>} A Promise that resolves to the cache value if found, undefined otherwise.
   */
  getCache<T>(key: string): Promise<T | undefined>;
  /**
   * Asynchronously sets a cache value in the database based on the provided key and value.
   * @param {string} key - The key to set the cache value for.
   * @param {T} value - The value to set in the cache.
   * @returns {Promise<boolean>} A Promise that resolves to a boolean indicating whether the cache value was set successfully.
   */
  setCache<T>(key: string, value: T): Promise<boolean>;
  /**
   * Asynchronously deletes a cache value from the database based on the provided key.
   * @param {string} key - The key to delete the cache value for.
   * @returns {Promise<boolean>} A Promise that resolves to a boolean indicating whether the cache value was deleted successfully.
   */
  deleteCache(key: string): Promise<boolean>;
  /**
   * Asynchronously creates a new world in the database based on the provided parameters.
   * @param {World} world - The world object to create.
   * @returns {Promise<UUID>} A Promise that resolves to the ID of the created world.
   */
  createWorld(world: World): Promise<UUID>;
  /**
   * Asynchronously retrieves a world from the database based on the provided parameters.
   * @param {UUID} id - The ID of the world to retrieve.
   * @returns {Promise<World | null>} A Promise that resolves to the world if found, null otherwise.
   */
  getWorld(id: UUID): Promise<World | null>;
  /**
   * Asynchronously retrieves all worlds from the database based on the provided parameters.
   * @returns {Promise<World[]>} A Promise that resolves to an array of worlds.
   */
  getAllWorlds(): Promise<World[]>;
  /**
   * Asynchronously updates an existing world in the database based on the provided parameters.
   * @param {World} world - The world object to update.
   * @returns {Promise<void>} A Promise that resolves when the world is updated.
   */
  updateWorld(world: World): Promise<void>;
  /**
   * Asynchronously removes a world from the database based on the provided parameters.
   * @param {UUID} id - The ID of the world to remove.
   * @returns {Promise<void>} A Promise that resolves when the world is removed.
   */
  removeWorld(id: UUID): Promise<void>;
  /**
   * Asynchronously creates a new task in the database based on the provided parameters.
   * @param {Task} task - The task object to create.
   * @returns {Promise<UUID>} A Promise that resolves to the ID of the created task.
   */
  createTask(task: Task): Promise<UUID>;
  /**
   * Asynchronously retrieves tasks based on specified parameters.
   * @param params Object containing optional roomId, tags, and entityId to filter tasks
   * @returns Promise resolving to an array of Task objects
   */
  getTasks(params: {
    roomId?: UUID;
    tags?: string[];
    entityId?: UUID;
  }): Promise<Task[]>;
  /**
   * Asynchronously retrieves a specific task by its name.
   * @param name The name of the task to retrieve
   * @returns Promise resolving to the Task object if found, null otherwise
   */
  getTasksByName(name: string): Promise<Task[]>;
  /**
   * Asynchronously retrieves a specific task by its ID.
   * @param id The UUID of the task to retrieve
   * @returns Promise resolving to the Task object if found, null otherwise
   */
  getTask(id: UUID): Promise<Task | null>;
  /**
   * Asynchronously updates an existing task in the database.
   * @param id The UUID of the task to update
   * @param task Partial Task object containing the fields to update
   * @returns Promise resolving when the update is complete
   */
  updateTask(id: UUID, task: Partial<Task>): Promise<void>;
  /**
   * Asynchronously deletes a task from the database.
   * @param id The UUID of the task to delete
   * @returns Promise resolving when the deletion is complete
   */
  deleteTask(id: UUID): Promise<void>;
  getMemoriesByWorldId(params: {
    worldId: UUID;
    count?: number;
    tableName?: string;
  }): Promise<Memory[]>;
  deleteRoomsByWorldId(worldId: UUID): Promise<void>;
  /**
   * Creates a new message server in the central database
   */
  createMessageServer(data: {
    id?: UUID;
    name: string;
    sourceType: string;
    sourceId?: string;
    metadata?: Metadata;
  }): Promise<{
    id: UUID;
    name: string;
    sourceType: string;
    sourceId?: string;
    metadata?: Metadata;
    createdAt: Date;
    updatedAt: Date;
  }>;
  /**
   * Gets all message servers
   */
  getMessageServers(): Promise<
    Array<{
      id: UUID;
      name: string;
      sourceType: string;
      sourceId?: string;
      metadata?: Metadata;
      createdAt: Date;
      updatedAt: Date;
    }>
  >;
  /**
   * Gets a message server by ID
   */
  getMessageServerById(serverId: UUID): Promise<{
    id: UUID;
    name: string;
    sourceType: string;
    sourceId?: string;
    metadata?: Metadata;
    createdAt: Date;
    updatedAt: Date;
  } | null>;
  /**
   * Gets a message server by RLS server_id
   * Note: server_id column only exists when RLS is enabled (added dynamically by RLS setup)
   * This is used to find the message_server linked to a specific RLS server instance
   */
  getMessageServerByRlsServerId(rlsServerId: UUID): Promise<{
    id: UUID;
    name: string;
    sourceType: string;
    sourceId?: string;
    metadata?: Metadata;
    createdAt: Date;
    updatedAt: Date;
  } | null>;
  /**
   * Creates a new channel
   */
  createChannel(
    data: {
      id?: UUID;
      messageServerId: UUID;
      name: string;
      type: string;
      sourceType?: string;
      sourceId?: string;
      topic?: string;
      metadata?: Metadata;
    },
    participantIds?: UUID[],
  ): Promise<{
    id: UUID;
    messageServerId: UUID;
    name: string;
    type: string;
    sourceType?: string;
    sourceId?: string;
    topic?: string;
    metadata?: Metadata;
    createdAt: Date;
    updatedAt: Date;
  }>;
  /**
   * Gets channels for a message server
   */
  getChannelsForMessageServer(messageServerId: UUID): Promise<
    Array<{
      id: UUID;
      messageServerId: UUID;
      name: string;
      type: string;
      sourceType?: string;
      sourceId?: string;
      topic?: string;
      metadata?: Metadata;
      createdAt: Date;
      updatedAt: Date;
    }>
  >;
  /**
   * Gets channel details
   */
  getChannelDetails(channelId: UUID): Promise<{
    id: UUID;
    messageServerId: UUID;
    name: string;
    type: string;
    sourceType?: string;
    sourceId?: string;
    topic?: string;
    metadata?: Metadata;
    createdAt: Date;
    updatedAt: Date;
  } | null>;
  /**
   * Creates a message
   */
  createMessage(data: {
    channelId: UUID;
    authorId: UUID;
    content: string;
    rawMessage?: Record<string, unknown>;
    sourceType?: string;
    sourceId?: string;
    metadata?: Metadata;
    inReplyToRootMessageId?: UUID;
    messageId?: UUID;
  }): Promise<{
    id: UUID;
    channelId: UUID;
    authorId: UUID;
    content: string;
    rawMessage?: Record<string, unknown>;
    sourceType?: string;
    sourceId?: string;
    metadata?: Metadata;
    inReplyToRootMessageId?: UUID;
    createdAt: Date;
    updatedAt: Date;
  }>;
  getMessageById(id: UUID): Promise<{
    id: UUID;
    channelId: UUID;
    authorId: UUID;
    content: string;
    rawMessage?: Record<string, unknown>;
    sourceType?: string;
    sourceId?: string;
    metadata?: Metadata;
    inReplyToRootMessageId?: UUID;
    createdAt: Date;
    updatedAt: Date;
  }>;
  updateMessage(
    id: UUID,
    patch: {
      content?: string;
      rawMessage?: Record<string, unknown>;
      sourceType?: string;
      sourceId?: string;
      metadata?: Metadata;
      inReplyToRootMessageId?: UUID;
    },
  ): Promise<{
    id: UUID;
    channelId: UUID;
    authorId: UUID;
    content: string;
    rawMessage?: Record<string, unknown>;
    sourceType?: string;
    sourceId?: string;
    metadata?: Metadata;
    inReplyToRootMessageId?: UUID;
    createdAt: Date;
    updatedAt: Date;
  } | null>;
  /**
   * Gets messages for a channel
   */
  getMessagesForChannel(
    channelId: UUID,
    limit?: number,
    beforeTimestamp?: Date,
  ): Promise<
    Array<{
      id: UUID;
      channelId: UUID;
      authorId: UUID;
      content: string;
      rawMessage?: Record<string, unknown>;
      sourceType?: string;
      sourceId?: string;
      metadata?: Metadata;
      inReplyToRootMessageId?: UUID;
      createdAt: Date;
      updatedAt: Date;
    }>
  >;
  /**
   * Deletes a message
   */
  deleteMessage(messageId: UUID): Promise<void>;
  /**
   * Updates a channel
   */
  updateChannel(
    channelId: UUID,
    updates: {
      name?: string;
      participantCentralUserIds?: UUID[];
      metadata?: Metadata;
    },
  ): Promise<{
    id: UUID;
    messageServerId: UUID;
    name: string;
    type: string;
    sourceType?: string;
    sourceId?: string;
    topic?: string;
    metadata?: Metadata;
    createdAt: Date;
    updatedAt: Date;
  }>;
  /**
   * Deletes a channel and all its associated data
   */
  deleteChannel(channelId: UUID): Promise<void>;
  /**
   * Adds participants to a channel
   */
  addChannelParticipants(channelId: UUID, entityIds: UUID[]): Promise<void>;
  /**
   * Gets participants for a channel
   */
  getChannelParticipants(channelId: UUID): Promise<UUID[]>;
  /**
   * Check if an entity is a participant in a specific messaging channel.
   * @param {UUID} channelId - The ID of the channel to check.
   * @param {UUID} entityId - The ID of the entity to check.
   * @returns {Promise<boolean>} A Promise that resolves to true if entity is a participant.
   */
  isChannelParticipant(channelId: UUID, entityId: UUID): Promise<boolean>;
  /**
   * Adds an agent to a message server (Discord/Telegram server)
   */
  addAgentToMessageServer(messageServerId: UUID, agentId: UUID): Promise<void>;
  /**
   * Gets agents for a message server (Discord/Telegram server)
   */
  getAgentsForMessageServer(messageServerId: UUID): Promise<UUID[]>;
  /**
   * Removes an agent from a message server (Discord/Telegram server)
   */
  removeAgentFromMessageServer(
    messageServerId: UUID,
    agentId: UUID,
  ): Promise<void>;
  /**
   * Finds or creates a DM channel between two users
   */
  findOrCreateDmChannel(
    user1Id: UUID,
    user2Id: UUID,
    messageServerId: UUID,
  ): Promise<{
    id: UUID;
    messageServerId: UUID;
    name: string;
    type: string;
    sourceType?: string;
    sourceId?: string;
    topic?: string;
    metadata?: Metadata;
    createdAt: Date;
    updatedAt: Date;
  }>;
}
//# sourceMappingURL=base.d.ts.map
