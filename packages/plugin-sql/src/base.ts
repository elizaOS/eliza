import {
  type Agent,
  ChannelType,
  type Component,
  DatabaseAdapter,
  type Entity,
  type Log,
  logger,
  type Memory,
  type MemoryMetadata,
  type Metadata,
  type Participant,
  type Relationship,
  type Room,
  type Task,
  type UUID,
  type World,
  type AgentRunSummaryResult,
  type RunStatus,
} from '@elizaos/core';
import type { DatabaseMigrationService } from './migration-service';
import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import { v4 } from 'uuid';
import { DIMENSION_MAP, type EmbeddingDimensionColumn } from './schema/embedding';
import {
  agentTable,
  channelParticipantsTable,
  channelTable,
  embeddingTable,
  logTable,
  memoryTable,
  messageServerTable,
  messageTable,
  participantTable,
  roomTable,
  messageServerAgentsTable,
} from './schema/index';
import type { DrizzleDatabase } from './types';
import {
  AgentStore,
  MemoryStore,
  RoomStore,
  ParticipantStore,
  EntityStore,
  ComponentStore,
  RelationshipStore,
  CacheStore,
  WorldStore,
  TaskStore,
  LogStore,
  type StoreContext,
} from './stores';

// Define the metadata type inline since we can't import it
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
export abstract class BaseDrizzleAdapter extends DatabaseAdapter<any> {
  protected readonly maxRetries: number = 3;
  protected readonly baseDelay: number = 1000;
  protected readonly maxDelay: number = 10000;
  protected readonly jitterMax: number = 1000;
  protected embeddingDimension: EmbeddingDimensionColumn = DIMENSION_MAP[384];
  protected migrationService?: DatabaseMigrationService;

  // Domain stores - initialized via initStores() after db is set
  protected agentStore!: AgentStore;
  protected memoryStore!: MemoryStore;
  protected roomStore!: RoomStore;
  protected participantStore!: ParticipantStore;
  protected entityStore!: EntityStore;
  protected componentStore!: ComponentStore;
  protected relationshipStore!: RelationshipStore;
  protected cacheStore!: CacheStore;
  protected worldStore!: WorldStore;
  protected taskStore!: TaskStore;
  protected logStore!: LogStore;

  protected abstract withDatabase<T>(operation: () => Promise<T>): Promise<T>;

  /**
   * Execute a callback with entity context for Entity RLS.
   * Must be implemented by concrete adapters to handle their specific RLS mechanisms.
   *
   * @param entityId - The entity UUID to set as context (or null for system operations)
   * @param callback - The database operations to execute with the entity context
   * @returns The result of the callback
   */
  public abstract withIsolationContext<T>(
    entityId: UUID | null,
    callback: (tx: DrizzleDatabase) => Promise<T>
  ): Promise<T>;

  public abstract init(): Promise<void>;
  public abstract close(): Promise<void>;

  /**
   * Initialize method that can be overridden by implementations
   */
  public async initialize(): Promise<void> {
    await this.init();
  }

  /**
   * Run plugin schema migrations for all registered plugins
   * @param plugins Array of plugins with their schemas
   * @param options Migration options (verbose, force, dryRun, etc.)
   */
  public async runPluginMigrations(
    plugins: Array<{ name: string; schema?: Record<string, unknown> }>,
    options?: {
      verbose?: boolean;
      force?: boolean;
      dryRun?: boolean;
    }
  ): Promise<void> {
    // Initialize migration service if not already done
    if (!this.migrationService) {
      const { DatabaseMigrationService } = await import('./migration-service');
      this.migrationService = new DatabaseMigrationService();
      await this.migrationService.initializeWithDatabase(this.db);
    }

    // Register plugin schemas
    for (const plugin of plugins) {
      if (plugin.schema) {
        this.migrationService.registerSchema(plugin.name, plugin.schema);
      }
    }

    // Run migrations with options
    await this.migrationService.runAllPluginMigrations(options);
  }

  /**
   * Get the underlying database instance for testing purposes
   */
  public getDatabase(): unknown {
    return this.db;
  }

  protected agentId: UUID;

  /**
   * Constructor for creating a new instance of Agent with the specified agentId.
   *
   * @param {UUID} agentId - The unique identifier for the agent.
   */
  constructor(agentId: UUID) {
    super();
    this.agentId = agentId;
  }

  /**
   * Initialize all domain stores. Must be called after this.db is set.
   * Child classes should call this at the end of their constructor.
   */
  protected initStores(): void {
    const ctx: StoreContext = {
      getDb: () => this.db,
      withRetry: (operation, _context) => this.withRetry(operation),
      withIsolationContext: (entityId, callback) => this.withIsolationContext(entityId, callback),
      agentId: this.agentId,
      getEmbeddingDimension: () => this.embeddingDimension,
    };

    this.agentStore = new AgentStore(ctx);
    this.memoryStore = new MemoryStore(ctx);
    this.roomStore = new RoomStore(ctx);
    this.participantStore = new ParticipantStore(ctx);
    this.entityStore = new EntityStore(ctx);
    this.componentStore = new ComponentStore(ctx);
    this.relationshipStore = new RelationshipStore(ctx);
    this.cacheStore = new CacheStore(ctx);
    this.worldStore = new WorldStore(ctx);
    this.taskStore = new TaskStore(ctx);
    this.logStore = new LogStore(ctx);
  }

  /**
   * Executes the given operation with retry logic.
   * @template T
   * @param {() => Promise<T>} operation - The operation to be executed.
   * @returns {Promise<T>} A promise that resolves with the result of the operation.
   */
  protected async withRetry<T>(operation: () => Promise<T>): Promise<T> {
    let lastError: Error = new Error('Unknown error');

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error as Error;

        if (attempt < this.maxRetries) {
          const backoffDelay = Math.min(this.baseDelay * 2 ** (attempt - 1), this.maxDelay);

          const jitter = Math.random() * this.jitterMax;
          const delay = backoffDelay + jitter;

          logger.warn(
            {
              src: 'plugin:sql',
              attempt,
              maxRetries: this.maxRetries,
              error: error instanceof Error ? error.message : String(error),
            },
            'Database operation failed, retrying'
          );

          await new Promise((resolve) => setTimeout(resolve, delay));
        } else {
          logger.error(
            {
              src: 'plugin:sql',
              totalAttempts: attempt,
              error: error instanceof Error ? error.message : String(error),
            },
            'Max retry attempts reached'
          );
          throw error instanceof Error ? error : new Error(String(error));
        }
      }
    }

    throw lastError;
  }

  /**
   * Asynchronously ensures that the given embedding dimension is valid for the agent.
   *
   * @param {number} dimension - The dimension to ensure for the embedding.
   * @returns {Promise<void>} - Resolves once the embedding dimension is ensured.
   */
  async ensureEmbeddingDimension(dimension: number) {
    return this.withDatabase(async () => {
      const existingMemory = await this.db
        .select()
        .from(memoryTable)
        .innerJoin(embeddingTable, eq(embeddingTable.memoryId, memoryTable.id))
        .where(eq(memoryTable.agentId, this.agentId))
        .limit(1);

      if (existingMemory.length > 0) {
        // The join result includes both memoryTable and embeddingTable columns
        // Access embedding columns directly from the joined result
        interface JoinedMemoryResult {
          memories: typeof memoryTable.$inferSelect;
          embeddings: typeof embeddingTable.$inferSelect;
        }
        const joinedResult = existingMemory[0] as JoinedMemoryResult;
        Object.entries(DIMENSION_MAP).find(([_, colName]) => {
          const embeddingCol = colName as keyof typeof embeddingTable.$inferSelect;
          return joinedResult.embeddings[embeddingCol] !== null;
        });
        // We don't actually need to use usedDimension for now, but it's good to know it's there.
      }

      this.embeddingDimension = DIMENSION_MAP[dimension];
    });
  }

  /**
   * Asynchronously retrieves an agent by their ID from the database.
   * @param {UUID} agentId - The ID of the agent to retrieve.
   * @returns {Promise<Agent | null>} A promise that resolves to the retrieved agent or null if not found.
   */
  async getAgent(agentId: UUID): Promise<Agent | null> {
    return this.withDatabase(() => this.agentStore.get(agentId));
  }

  /**
   * Asynchronously retrieves a list of agents from the database.
   *
   * @returns {Promise<Partial<Agent>[]>} A Promise that resolves to an array of Agent objects.
   */
  async getAgents(): Promise<Partial<Agent>[]> {
    return this.withDatabase(() => this.agentStore.getAll());
  }
  /**
   * Asynchronously creates a new agent record in the database.
   *
   * @param {Partial<Agent>} agent The agent object to be created.
   * @returns {Promise<boolean>} A promise that resolves to a boolean indicating the success of the operation.
   */
  async createAgent(agent: Agent): Promise<boolean> {
    return this.withDatabase(() => this.agentStore.create(agent));
  }

  /**
   * Updates an agent in the database with the provided agent ID and data.
   * @param {UUID} agentId - The unique identifier of the agent to update.
   * @param {Partial<Agent>} agent - The partial agent object containing the fields to update.
   * @returns {Promise<boolean>} - A boolean indicating if the agent was successfully updated.
   */
  async updateAgent(agentId: UUID, agent: Partial<Agent>): Promise<boolean> {
    return this.withDatabase(() => this.agentStore.update(agentId, agent));
  }

  /**
   * Asynchronously deletes an agent with the specified UUID and all related entries.
   *
   * @param {UUID} agentId - The UUID of the agent to be deleted.
   * @returns {Promise<boolean>} - A boolean indicating if the deletion was successful.
   */
  async deleteAgent(agentId: UUID): Promise<boolean> {
    return this.withDatabase(() => this.agentStore.delete(agentId));
  }

  /**
   * Count all agents in the database
   * Used primarily for maintenance and cleanup operations
   */
  /**
   * Asynchronously counts the number of agents in the database.
   * @returns {Promise<number>} A Promise that resolves to the number of agents in the database.
   */
  async countAgents(): Promise<number> {
    return this.withDatabase(() => this.agentStore.count());
  }

  /**
   * Clean up the agents table by removing all agents
   * This is used during server startup to ensure no orphaned agents exist
   * from previous crashes or improper shutdowns
   */
  async cleanupAgents(): Promise<void> {
    return this.withDatabase(async () => {
      try {
        await this.db.delete(agentTable);
      } catch (error) {
        logger.error(
          { src: 'plugin:sql', error: error instanceof Error ? error.message : String(error) },
          'Failed to clean up agent table'
        );
        throw error;
      }
    });
  }

  /**
   * Asynchronously retrieves an entity and its components by entity IDs.
   * @param {UUID[]} entityIds - The unique identifiers of the entities to retrieve.
   * @returns {Promise<Entity[] | null>} A Promise that resolves to the entity with its components if found, null otherwise.
   */
  async getEntitiesByIds(entityIds: UUID[]): Promise<Entity[] | null> {
    return this.withDatabase(() => this.entityStore.getByIds(entityIds));
  }

  async getEntitiesForRoom(roomId: UUID, includeComponents?: boolean): Promise<Entity[]> {
    return this.withDatabase(() => this.entityStore.getForRoom(roomId, includeComponents));
  }

  async createEntities(entities: Entity[]): Promise<boolean> {
    return this.withDatabase(() => this.entityStore.create(entities));
  }

  protected async ensureEntityExists(entity: Entity): Promise<boolean> {
    return this.entityStore.ensureExists(entity);
  }

  async updateEntity(entity: Entity): Promise<void> {
    return this.withDatabase(() => this.entityStore.update(entity));
  }

  async deleteEntity(entityId: UUID): Promise<void> {
    return this.withDatabase(() => this.entityStore.delete(entityId));
  }

  async getEntitiesByNames(params: { names: string[]; agentId: UUID }): Promise<Entity[]> {
    return this.withDatabase(() => this.entityStore.getByNames(params));
  }

  async searchEntitiesByName(params: {
    query: string;
    agentId: UUID;
    limit?: number;
  }): Promise<Entity[]> {
    return this.withDatabase(() => this.entityStore.searchByName(params));
  }

  async getComponent(
    entityId: UUID,
    type: string,
    worldId?: UUID,
    sourceEntityId?: UUID
  ): Promise<Component | null> {
    return this.withDatabase(() =>
      this.componentStore.get(entityId, type, worldId, sourceEntityId)
    );
  }

  async getComponents(entityId: UUID, worldId?: UUID, sourceEntityId?: UUID): Promise<Component[]> {
    return this.withDatabase(() => this.componentStore.getAll(entityId, worldId, sourceEntityId));
  }

  async createComponent(component: Component): Promise<boolean> {
    return this.withDatabase(() => this.componentStore.create(component));
  }

  async updateComponent(component: Component): Promise<void> {
    return this.withDatabase(() => this.componentStore.update(component));
  }

  async deleteComponent(componentId: UUID): Promise<void> {
    return this.withDatabase(() => this.componentStore.delete(componentId));
  }

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
  async getMemories(params: {
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
  }): Promise<Memory[]> {
    return this.withDatabase(() => this.memoryStore.get(params));
  }

  /**
   * Asynchronously retrieves memories from the database based on the provided parameters.
   * @param {Object} params - The parameters for retrieving memories.
   * @param {UUID[]} params.roomIds - The IDs of the rooms to retrieve memories for.
   * @param {string} params.tableName - The name of the table to retrieve memories from.
   * @param {number} [params.limit] - The maximum number of memories to retrieve.
   * @returns {Promise<Memory[]>} A Promise that resolves to an array of memories.
   */
  async getMemoriesByRoomIds(params: {
    roomIds: UUID[];
    tableName: string;
    limit?: number;
  }): Promise<Memory[]> {
    return this.withDatabase(() => this.memoryStore.getByRoomIds(params));
  }

  /**
   * Asynchronously retrieves a memory by its unique identifier.
   * @param {UUID} id - The unique identifier of the memory to retrieve.
   * @returns {Promise<Memory | null>} A Promise that resolves to the memory if found, null otherwise.
   */
  async getMemoryById(id: UUID): Promise<Memory | null> {
    return this.withDatabase(() => this.memoryStore.getById(id));
  }

  /**
   * Asynchronously retrieves memories from the database based on the provided parameters.
   * @param {Object} params - The parameters for retrieving memories.
   * @param {UUID[]} params.memoryIds - The IDs of the memories to retrieve.
   * @param {string} [params.tableName] - The name of the table to retrieve memories from.
   * @returns {Promise<Memory[]>} A Promise that resolves to an array of memories.
   */
  async getMemoriesByIds(memoryIds: UUID[], tableName?: string): Promise<Memory[]> {
    return this.withDatabase(() => this.memoryStore.getByIds(memoryIds, tableName));
  }

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
  async getCachedEmbeddings(opts: {
    query_table_name: string;
    query_threshold: number;
    query_input: string;
    query_field_name: string;
    query_field_sub_name: string;
    query_match_count: number;
  }): Promise<{ embedding: number[]; levenshtein_score: number }[]> {
    return this.withDatabase(async () => {
      try {
        // Drizzle database has execute method for raw SQL
        interface DrizzleDatabaseWithExecute {
          execute: (query: ReturnType<typeof sql>) => Promise<{ rows: Record<string, unknown>[] }>;
        }
        const results = await (this.db as DrizzleDatabaseWithExecute).execute(sql`
                    WITH content_text AS (
                        SELECT
                            m.id,
                            COALESCE(
                                m.content->>${opts.query_field_sub_name},
                                ''
                            ) as content_text
                        FROM memories m
                        WHERE m.type = ${opts.query_table_name}
                            AND m.content->>${opts.query_field_sub_name} IS NOT NULL
                    ),
                    embedded_text AS (
                        SELECT
                            ct.content_text,
                            COALESCE(
                                e.dim_384,
                                e.dim_512,
                                e.dim_768,
                                e.dim_1024,
                                e.dim_1536,
                                e.dim_3072
                            ) as embedding
                        FROM content_text ct
                        LEFT JOIN embeddings e ON e.memory_id = ct.id
                        WHERE e.memory_id IS NOT NULL
                    )
                    SELECT
                        embedding,
                        levenshtein(${opts.query_input}, content_text) as levenshtein_score
                    FROM embedded_text
                    WHERE levenshtein(${opts.query_input}, content_text) <= ${opts.query_threshold}
                    ORDER BY levenshtein_score
                    LIMIT ${opts.query_match_count}
                `);

        return results.rows
          .map((row) => ({
            embedding: Array.isArray(row.embedding)
              ? row.embedding
              : typeof row.embedding === 'string'
                ? JSON.parse(row.embedding)
                : [],
            levenshtein_score: Number(row.levenshtein_score),
          }))
          .filter((row) => Array.isArray(row.embedding));
      } catch (error) {
        logger.error(
          {
            src: 'plugin:sql',
            tableName: opts.query_table_name,
            fieldName: opts.query_field_name,
            error: error instanceof Error ? error.message : String(error),
          },
          'Failed to get cached embeddings'
        );
        if (
          error instanceof Error &&
          error.message === 'levenshtein argument exceeds maximum length of 255 characters'
        ) {
          return [];
        }
        throw error;
      }
    });
  }

  /**
   * Asynchronously logs an event in the database.
   * @param {Object} params - The parameters for logging an event.
   * @param {Object} params.body - The body of the event to log.
   * @param {UUID} params.entityId - The ID of the entity associated with the event.
   * @param {UUID} params.roomId - The ID of the room associated with the event.
   * @param {string} params.type - The type of the event to log.
   * @returns {Promise<void>} A Promise that resolves when the event is logged.
   */
  async log(params: {
    body: { [key: string]: unknown };
    entityId: UUID;
    roomId: UUID;
    type: string;
  }): Promise<void> {
    return this.withDatabase(async () => {
      try {
        // Sanitize JSON body to prevent Unicode escape sequence errors
        const sanitizedBody = this.sanitizeJsonObject(params.body);

        // Serialize to JSON string first for an additional layer of protection
        // This ensures any problematic characters are properly escaped during JSON serialization
        const jsonString = JSON.stringify(sanitizedBody);

        // Use withIsolationContext to set Entity RLS context before inserting
        // This ensures the log entry passes STRICT Entity RLS policy
        await this.withIsolationContext(params.entityId, async (tx) => {
          await tx.insert(logTable).values({
            body: sql`${jsonString}::jsonb`,
            entityId: params.entityId,
            roomId: params.roomId,
            type: params.type,
          });
        });
      } catch (error) {
        logger.error(
          {
            src: 'plugin:sql',
            type: params.type,
            roomId: params.roomId,
            entityId: params.entityId,
            error: error instanceof Error ? error.message : String(error),
          },
          'Failed to create log entry'
        );
        throw error;
      }
    });
  }

  /**
   * Sanitizes a JSON object by replacing problematic Unicode escape sequences
   * that could cause errors during JSON serialization/storage
   *
   * @param value - The value to sanitize
   * @returns The sanitized value
   */
  private sanitizeJsonObject(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
    if (value === null || value === undefined) {
      return value;
    }

    if (typeof value === 'string') {
      // Handle multiple cases that can cause PostgreSQL/PgLite JSON parsing errors:
      // 1. Remove null bytes (U+0000) which are not allowed in PostgreSQL text fields
      // 2. Escape single backslashes that might be interpreted as escape sequences
      // 3. Fix broken Unicode escape sequences (\u not followed by 4 hex digits)
      return value
        .replace(/\u0000/g, '') // Remove null bytes
        .replace(/\\(?!["\\/bfnrtu])/g, '\\\\') // Escape single backslashes not part of valid escape sequences
        .replace(/\\u(?![0-9a-fA-F]{4})/g, '\\\\u'); // Fix malformed Unicode escape sequences
    }

    if (typeof value === 'object') {
      if (seen.has(value as object)) {
        return null;
      } else {
        seen.add(value as object);
      }

      if (Array.isArray(value)) {
        return value.map((item) => this.sanitizeJsonObject(item, seen));
      } else {
        const result: Record<string, unknown> = {};
        for (const [key, val] of Object.entries(value)) {
          // Also sanitize object keys
          const sanitizedKey =
            typeof key === 'string'
              ? key.replace(/\u0000/g, '').replace(/\\u(?![0-9a-fA-F]{4})/g, '\\\\u')
              : key;
          result[sanitizedKey] = this.sanitizeJsonObject(val, seen);
        }
        return result;
      }
    }

    return value;
  }

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
  async getLogs(params: {
    entityId?: UUID;
    roomId?: UUID;
    type?: string;
    count?: number;
    offset?: number;
  }): Promise<Log[]> {
    return this.logStore.getMany(params);
  }

  async getAgentRunSummaries(
    params: {
      limit?: number;
      roomId?: UUID;
      status?: RunStatus | 'all';
      from?: number;
      to?: number;
      entityId?: UUID;
    } = {}
  ): Promise<AgentRunSummaryResult> {
    return this.logStore.getAgentRunSummaries(this.agentId, params);
  }

  async deleteLog(logId: UUID): Promise<void> {
    return this.withDatabase(() => this.logStore.delete(logId));
  }

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
  async searchMemories(params: {
    tableName: string;
    embedding: number[];
    match_threshold?: number;
    count?: number;
    unique?: boolean;
    query?: string;
    roomId?: UUID;
    worldId?: UUID;
    entityId?: UUID;
  }): Promise<Memory[]> {
    return await this.searchMemoriesByEmbedding(params.embedding, {
      match_threshold: params.match_threshold,
      count: params.count,
      // Pass direct scope fields down
      roomId: params.roomId,
      worldId: params.worldId,
      entityId: params.entityId,
      unique: params.unique,
      tableName: params.tableName,
    });
  }

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
  async searchMemoriesByEmbedding(
    embedding: number[],
    params: {
      match_threshold?: number;
      count?: number;
      roomId?: UUID;
      worldId?: UUID;
      entityId?: UUID;
      unique?: boolean;
      tableName: string;
    }
  ): Promise<Memory[]> {
    return this.withDatabase(() => this.memoryStore.searchByEmbedding(embedding, params));
  }

  /**
   * Asynchronously creates a new memory in the database.
   * @param {Memory & { metadata?: MemoryMetadata }} memory - The memory object to create.
   * @param {string} tableName - The name of the table to create the memory in.
   * @returns {Promise<UUID>} A Promise that resolves to the ID of the created memory.
   */
  async createMemory(
    memory: Memory & { metadata?: MemoryMetadata },
    tableName: string
  ): Promise<UUID> {
    return this.withDatabase(() => this.memoryStore.create(memory, tableName));
  }

  /**
   * Updates an existing memory in the database.
   * @param memory The memory object with updated content and optional embedding
   * @returns Promise resolving to boolean indicating success
   */
  async updateMemory(
    memory: Partial<Memory> & { id: UUID; metadata?: MemoryMetadata }
  ): Promise<boolean> {
    return this.withDatabase(() => this.memoryStore.update(memory));
  }

  /**
   * Asynchronously deletes a memory from the database based on the provided parameters.
   * @param {UUID} memoryId - The ID of the memory to delete.
   * @returns {Promise<void>} A Promise that resolves when the memory is deleted.
   */
  async deleteMemory(memoryId: UUID): Promise<void> {
    return this.withDatabase(() => this.memoryStore.delete(memoryId));
  }

  /**
   * Asynchronously deletes multiple memories from the database in a single batch operation.
   * @param {UUID[]} memoryIds - An array of UUIDs of the memories to delete.
   * @returns {Promise<void>} A Promise that resolves when all memories are deleted.
   */
  async deleteManyMemories(memoryIds: UUID[]): Promise<void> {
    return this.withDatabase(() => this.memoryStore.deleteMany(memoryIds));
  }

  /**
   * Asynchronously deletes all memories from the database based on the provided parameters.
   * @param {UUID} roomId - The ID of the room to delete memories from.
   * @param {string} tableName - The name of the table to delete memories from.
   * @returns {Promise<void>} A Promise that resolves when the memories are deleted.
   */
  async deleteAllMemories(roomId: UUID, tableName: string): Promise<void> {
    return this.withDatabase(() => this.memoryStore.deleteAllByRoom(roomId, tableName));
  }

  /**
   * Asynchronously counts the number of memories in the database based on the provided parameters.
   * @param {UUID} roomId - The ID of the room to count memories in.
   * @param {boolean} [unique] - Whether to count unique memories only.
   * @param {string} [tableName] - The name of the table to count memories in.
   * @returns {Promise<number>} A Promise that resolves to the number of memories.
   */
  async countMemories(roomId: UUID, unique = true, tableName = ''): Promise<number> {
    return this.withDatabase(() => this.memoryStore.count(roomId, unique, tableName));
  }

  /**
   * Asynchronously retrieves rooms from the database based on the provided parameters.
   * @param {UUID[]} roomIds - The IDs of the rooms to retrieve.
   * @returns {Promise<Room[] | null>} A Promise that resolves to the rooms if found, null otherwise.
   */
  async getRoomsByIds(roomIds: UUID[]): Promise<Room[] | null> {
    return this.withDatabase(() => this.roomStore.getByIds(roomIds));
  }

  /**
   * Asynchronously retrieves all rooms from the database based on the provided parameters.
   * @param {UUID} worldId - The ID of the world to retrieve rooms from.
   * @returns {Promise<Room[]>} A Promise that resolves to an array of rooms.
   */
  async getRoomsByWorld(worldId: UUID): Promise<Room[]> {
    return this.withDatabase(() => this.roomStore.getByWorld(worldId));
  }

  /**
   * Asynchronously updates a room in the database based on the provided parameters.
   * @param {Room} room - The room object to update.
   * @returns {Promise<void>} A Promise that resolves when the room is updated.
   */
  async updateRoom(room: Room): Promise<void> {
    return this.withDatabase(() => this.roomStore.update(room));
  }

  /**
   * Creates rooms in the database. Uses ON CONFLICT DO NOTHING for idempotency.
   *
   * @param rooms - Array of room objects to create.
   * @returns IDs of all rooms (both newly created and already existing).
   */
  async createRooms(rooms: Room[]): Promise<UUID[]> {
    return this.withDatabase(() => this.roomStore.create(rooms));
  }

  /**
   * Asynchronously deletes a room from the database based on the provided parameters.
   * @param {UUID} roomId - The ID of the room to delete.
   * @returns {Promise<void>} A Promise that resolves when the room is deleted.
   */
  async deleteRoom(roomId: UUID): Promise<void> {
    return this.withDatabase(() => this.roomStore.delete(roomId));
  }

  /**
   * Asynchronously retrieves all rooms for a participant from the database based on the provided parameters.
   * @param {UUID} entityId - The ID of the entity to retrieve rooms for.
   * @returns {Promise<UUID[]>} A Promise that resolves to an array of room IDs.
   */
  async getRoomsForParticipant(entityId: UUID): Promise<UUID[]> {
    return this.withDatabase(() => this.participantStore.getRoomsForEntity(entityId));
  }

  /**
   * Asynchronously retrieves all rooms for a list of participants from the database based on the provided parameters.
   * @param {UUID[]} entityIds - The IDs of the entities to retrieve rooms for.
   * @returns {Promise<UUID[]>} A Promise that resolves to an array of room IDs.
   */
  async getRoomsForParticipants(entityIds: UUID[]): Promise<UUID[]> {
    return this.withDatabase(() => this.participantStore.getRoomsForEntities(entityIds));
  }

  /**
   * Asynchronously adds a participant to a room in the database based on the provided parameters.
   * @param {UUID} entityId - The ID of the entity to add to the room.
   * @param {UUID} roomId - The ID of the room to add the entity to.
   * @returns {Promise<boolean>} A Promise that resolves to a boolean indicating whether the participant was added successfully.
   */
  async addParticipant(entityId: UUID, roomId: UUID): Promise<boolean> {
    return this.withDatabase(() => this.participantStore.add(entityId, roomId));
  }

  async addParticipantsRoom(entityIds: UUID[], roomId: UUID): Promise<boolean> {
    return this.withDatabase(() => this.participantStore.addMany(entityIds, roomId));
  }

  /**
   * Asynchronously removes a participant from a room in the database based on the provided parameters.
   * @param {UUID} entityId - The ID of the entity to remove from the room.
   * @param {UUID} roomId - The ID of the room to remove the entity from.
   * @returns {Promise<boolean>} A Promise that resolves to a boolean indicating whether the participant was removed successfully.
   */
  async removeParticipant(entityId: UUID, roomId: UUID): Promise<boolean> {
    return this.withDatabase(() => this.participantStore.remove(entityId, roomId));
  }

  /**
   * Asynchronously retrieves all participants for an entity from the database based on the provided parameters.
   * @param {UUID} entityId - The ID of the entity to retrieve participants for.
   * @returns {Promise<Participant[]>} A Promise that resolves to an array of participants.
   */
  async getParticipantsForEntity(entityId: UUID): Promise<Participant[]> {
    return this.withDatabase(async () => {
      const result = await this.db
        .select({
          id: participantTable.id,
          entityId: participantTable.entityId,
          roomId: participantTable.roomId,
        })
        .from(participantTable)
        .where(eq(participantTable.entityId, entityId));

      const entities = await this.getEntitiesByIds([entityId]);

      if (!entities || !entities.length) {
        return [];
      }

      return result.map((row) => ({
        id: row.id as UUID,
        entity: entities[0],
      }));
    });
  }

  /**
   * Asynchronously retrieves all participants for a room from the database based on the provided parameters.
   * @param {UUID} roomId - The ID of the room to retrieve participants for.
   * @returns {Promise<UUID[]>} A Promise that resolves to an array of entity IDs.
   */
  async getParticipantsForRoom(roomId: UUID): Promise<UUID[]> {
    return this.withDatabase(() => this.participantStore.getForRoom(roomId));
  }

  /**
   * Check if an entity is a participant in a specific room/channel.
   * More efficient than getParticipantsForRoom when only checking membership.
   * @param {UUID} roomId - The ID of the room to check.
   * @param {UUID} entityId - The ID of the entity to check.
   * @returns {Promise<boolean>} A Promise that resolves to true if entity is a participant.
   */
  async isRoomParticipant(roomId: UUID, entityId: UUID): Promise<boolean> {
    return this.withDatabase(() => this.participantStore.isParticipant(roomId, entityId));
  }

  /**
   * Asynchronously retrieves the user state for a participant in a room from the database based on the provided parameters.
   * @param {UUID} roomId - The ID of the room to retrieve the participant's user state for.
   * @param {UUID} entityId - The ID of the entity to retrieve the user state for.
   * @returns {Promise<"FOLLOWED" | "MUTED" | null>} A Promise that resolves to the participant's user state.
   */
  async getParticipantUserState(
    roomId: UUID,
    entityId: UUID
  ): Promise<'FOLLOWED' | 'MUTED' | null> {
    return this.withDatabase(() => this.participantStore.getUserState(roomId, entityId));
  }

  /**
   * Asynchronously sets the user state for a participant in a room in the database based on the provided parameters.
   * @param {UUID} roomId - The ID of the room to set the participant's user state for.
   * @param {UUID} entityId - The ID of the entity to set the user state for.
   * @param {string} state - The state to set the participant's user state to.
   * @returns {Promise<void>} A Promise that resolves when the participant's user state is set.
   */
  async setParticipantUserState(
    roomId: UUID,
    entityId: UUID,
    state: 'FOLLOWED' | 'MUTED' | null
  ): Promise<void> {
    return this.withDatabase(() => this.participantStore.setUserState(roomId, entityId, state));
  }

  /**
   * Asynchronously creates a new relationship in the database based on the provided parameters.
   * @param {Object} params - The parameters for creating a new relationship.
   * @param {UUID} params.sourceEntityId - The ID of the source entity.
   * @param {UUID} params.targetEntityId - The ID of the target entity.
   * @param {string[]} [params.tags] - The tags for the relationship.
   * @param {Object} [params.metadata] - The metadata for the relationship.
   * @returns {Promise<boolean>} A Promise that resolves to a boolean indicating whether the relationship was created successfully.
   */
  async createRelationship(params: {
    sourceEntityId: UUID;
    targetEntityId: UUID;
    tags?: string[];
    metadata?: { [key: string]: unknown };
  }): Promise<boolean> {
    return this.withDatabase(() => this.relationshipStore.create(params));
  }

  /**
   * Asynchronously updates an existing relationship in the database based on the provided parameters.
   * @param {Relationship} relationship - The relationship object to update.
   * @returns {Promise<void>} A Promise that resolves when the relationship is updated.
   */
  async updateRelationship(relationship: Relationship): Promise<void> {
    return this.withDatabase(() => this.relationshipStore.update(relationship));
  }

  /**
   * Asynchronously retrieves a relationship from the database based on the provided parameters.
   * @param {Object} params - The parameters for retrieving a relationship.
   * @param {UUID} params.sourceEntityId - The ID of the source entity.
   * @param {UUID} params.targetEntityId - The ID of the target entity.
   * @returns {Promise<Relationship | null>} A Promise that resolves to the relationship if found, null otherwise.
   */
  async getRelationship(params: {
    sourceEntityId: UUID;
    targetEntityId: UUID;
  }): Promise<Relationship | null> {
    return this.withDatabase(() => this.relationshipStore.get(params));
  }

  /**
   * Asynchronously retrieves relationships from the database based on the provided parameters.
   * @param {Object} params - The parameters for retrieving relationships.
   * @param {UUID} params.entityId - The ID of the entity to retrieve relationships for.
   * @param {string[]} [params.tags] - The tags to filter relationships by.
   * @returns {Promise<Relationship[]>} A Promise that resolves to an array of relationships.
   */
  async getRelationships(params: { entityId: UUID; tags?: string[] }): Promise<Relationship[]> {
    return this.withDatabase(() => this.relationshipStore.getAll(params));
  }

  /**
   * Asynchronously retrieves a cache value from the database based on the provided key.
   * @param {string} key - The key to retrieve the cache value for.
   * @returns {Promise<T | undefined>} A Promise that resolves to the cache value if found, undefined otherwise.
   */
  async getCache<T>(key: string): Promise<T | undefined> {
    return this.withDatabase(() => this.cacheStore.get<T>(key));
  }

  /**
   * Asynchronously sets a cache value in the database based on the provided key and value.
   * @param {string} key - The key to set the cache value for.
   * @param {T} value - The value to set in the cache.
   * @returns {Promise<boolean>} A Promise that resolves to a boolean indicating whether the cache value was set successfully.
   */
  async setCache<T>(key: string, value: T): Promise<boolean> {
    return this.withDatabase(() => this.cacheStore.set<T>(key, value));
  }

  /**
   * Asynchronously deletes a cache value from the database based on the provided key.
   * @param {string} key - The key to delete the cache value for.
   * @returns {Promise<boolean>} A Promise that resolves to a boolean indicating whether the cache value was deleted successfully.
   */
  async deleteCache(key: string): Promise<boolean> {
    return this.withDatabase(() => this.cacheStore.delete(key));
  }

  /**
   * Asynchronously creates a new world in the database based on the provided parameters.
   * @param {World} world - The world object to create.
   * @returns {Promise<UUID>} A Promise that resolves to the ID of the created world.
   */
  async createWorld(world: World): Promise<UUID> {
    return this.withDatabase(() => this.worldStore.create(world));
  }

  async getWorld(id: UUID): Promise<World | null> {
    return this.withDatabase(() => this.worldStore.get(id));
  }

  async getAllWorlds(): Promise<World[]> {
    return this.withDatabase(() => this.worldStore.getAll());
  }

  async updateWorld(world: World): Promise<void> {
    return this.withDatabase(() => this.worldStore.update(world));
  }

  async removeWorld(id: UUID): Promise<void> {
    return this.withDatabase(() => this.worldStore.remove(id));
  }

  async createTask(task: Task): Promise<UUID> {
    return this.withDatabase(() => this.taskStore.create(task));
  }

  async getTasks(params: { roomId?: UUID; tags?: string[]; entityId?: UUID }): Promise<Task[]> {
    return this.withDatabase(() => this.taskStore.getAll(params));
  }

  async getTasksByName(name: string): Promise<Task[]> {
    return this.withDatabase(() => this.taskStore.getByName(name));
  }

  async getTask(id: UUID): Promise<Task | null> {
    return this.withDatabase(() => this.taskStore.get(id));
  }

  async updateTask(id: UUID, task: Partial<Task>): Promise<void> {
    return this.withDatabase(() => this.taskStore.update(id, task));
  }

  async deleteTask(id: UUID): Promise<void> {
    return this.withDatabase(() => this.taskStore.delete(id));
  }

  async getMemoriesByWorldId(params: {
    worldId: UUID;
    count?: number;
    tableName?: string;
  }): Promise<Memory[]> {
    return this.withDatabase(async () => {
      // First, get all rooms for the given worldId
      const rooms = await this.db
        .select({ id: roomTable.id })
        .from(roomTable)
        .where(and(eq(roomTable.worldId, params.worldId), eq(roomTable.agentId, this.agentId)));

      if (rooms.length === 0) {
        return [];
      }

      const roomIds = rooms.map((room) => room.id as UUID);

      const memories = await this.getMemoriesByRoomIds({
        roomIds,
        tableName: params.tableName || 'messages',
        limit: params.count,
      });

      return memories;
    });
  }

  async deleteRoomsByWorldId(worldId: UUID): Promise<void> {
    return this.withDatabase(async () => {
      const rooms = await this.db
        .select({ id: roomTable.id })
        .from(roomTable)
        .where(and(eq(roomTable.worldId, worldId), eq(roomTable.agentId, this.agentId)));

      if (rooms.length === 0) {
        return;
      }

      const roomIds = rooms.map((room) => room.id as UUID);

      if (roomIds.length > 0) {
        await this.db.delete(logTable).where(inArray(logTable.roomId, roomIds));
        await this.db.delete(participantTable).where(inArray(participantTable.roomId, roomIds));

        const memoriesInRooms = await this.db
          .select({ id: memoryTable.id })
          .from(memoryTable)
          .where(inArray(memoryTable.roomId, roomIds));
        const memoryIdsInRooms = memoriesInRooms.map((m) => m.id as UUID);

        if (memoryIdsInRooms.length > 0) {
          await this.db
            .delete(embeddingTable)
            .where(inArray(embeddingTable.memoryId, memoryIdsInRooms));
          await this.db.delete(memoryTable).where(inArray(memoryTable.id, memoryIdsInRooms));
        }

        await this.db.delete(roomTable).where(inArray(roomTable.id, roomIds));

        logger.debug(
          {
            src: 'plugin:sql',
            worldId,
            roomsDeleted: roomIds.length,
            memoriesDeleted: memoryIdsInRooms.length,
          },
          'World cleanup completed'
        );
      }
    });
  }

  // Message Server Database Operations

  /**
   * Creates a new message server in the central database
   */
  async createMessageServer(data: {
    id?: UUID; // Allow passing a specific ID
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
  }> {
    return this.withDatabase(async () => {
      const newId = data.id || (v4() as UUID);
      const now = new Date();
      const serverToInsert = {
        id: newId,
        name: data.name,
        sourceType: data.sourceType,
        sourceId: data.sourceId,
        metadata: data.metadata,
        createdAt: now,
        updatedAt: now,
      };

      await this.db.insert(messageServerTable).values(serverToInsert).onConflictDoNothing();

      // If server already existed, fetch it
      if (data.id) {
        const existing = await this.db
          .select()
          .from(messageServerTable)
          .where(eq(messageServerTable.id, data.id))
          .limit(1);
        if (existing.length > 0) {
          return {
            id: existing[0].id as UUID,
            name: existing[0].name,
            sourceType: existing[0].sourceType,
            sourceId: existing[0].sourceId || undefined,
            metadata: existing[0].metadata || undefined,
            createdAt: existing[0].createdAt,
            updatedAt: existing[0].updatedAt,
          };
        }
      }

      return serverToInsert;
    });
  }

  /**
   * Gets all message servers
   */
  async getMessageServers(): Promise<
    Array<{
      id: UUID;
      name: string;
      sourceType: string;
      sourceId?: string;
      metadata?: Metadata;
      createdAt: Date;
      updatedAt: Date;
    }>
  > {
    const result = await this.withDatabase(async () => {
      const results = await this.db.select().from(messageServerTable);
      return results.map((r) => ({
        id: r.id as UUID,
        name: r.name,
        sourceType: r.sourceType,
        sourceId: r.sourceId || undefined,
        metadata: r.metadata || undefined,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      }));
    });
    // Guard against null return
    return result || [];
  }

  /**
   * Gets a message server by ID
   */
  async getMessageServerById(serverId: UUID): Promise<{
    id: UUID;
    name: string;
    sourceType: string;
    sourceId?: string;
    metadata?: Metadata;
    createdAt: Date;
    updatedAt: Date;
  } | null> {
    return this.withDatabase(async () => {
      const results = await this.db
        .select()
        .from(messageServerTable)
        .where(eq(messageServerTable.id, serverId))
        .limit(1);
      return results.length > 0
        ? {
            id: results[0].id as UUID,
            name: results[0].name,
            sourceType: results[0].sourceType,
            sourceId: results[0].sourceId || undefined,
            metadata: results[0].metadata || undefined,
            createdAt: results[0].createdAt,
            updatedAt: results[0].updatedAt,
          }
        : null;
    });
  }

  /**
   * Gets a message server by RLS server_id
   * Note: server_id column only exists when RLS is enabled (added dynamically by RLS setup)
   * This is used to find the message_server linked to a specific RLS server instance
   */
  async getMessageServerByRlsServerId(rlsServerId: UUID): Promise<{
    id: UUID;
    name: string;
    sourceType: string;
    sourceId?: string;
    metadata?: Metadata;
    createdAt: Date;
    updatedAt: Date;
  } | null> {
    return this.withDatabase(async () => {
      // Use raw SQL since server_id column is dynamically added by RLS and not in Drizzle schema
      const results = await this.db.execute(sql`
        SELECT id, name, source_type, source_id, metadata, created_at, updated_at
        FROM message_servers
        WHERE server_id = ${rlsServerId}
        LIMIT 1
      `);

      const rows = results.rows || results;
      return rows.length > 0
        ? {
            id: rows[0].id as UUID,
            name: rows[0].name,
            sourceType: rows[0].source_type,
            sourceId: rows[0].source_id || undefined,
            metadata: rows[0].metadata || undefined,
            createdAt: new Date(rows[0].created_at),
            updatedAt: new Date(rows[0].updated_at),
          }
        : null;
    });
  }

  /**
   * Creates a new channel
   */
  async createChannel(
    data: {
      id?: UUID; // Allow passing a specific ID
      messageServerId: UUID;
      name: string;
      type: string;
      sourceType?: string;
      sourceId?: string;
      topic?: string;
      metadata?: Metadata;
    },
    participantIds?: UUID[]
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
  }> {
    return this.withDatabase(async () => {
      const newId = data.id || (v4() as UUID);
      const now = new Date();
      const channelToInsert = {
        id: newId,
        messageServerId: data.messageServerId,
        name: data.name,
        type: data.type,
        sourceType: data.sourceType,
        sourceId: data.sourceId,
        topic: data.topic,
        metadata: data.metadata,
        createdAt: now,
        updatedAt: now,
      };

      // UPSERT: insert channel, ignore if already exists
      await this.db.insert(channelTable).values(channelToInsert).onConflictDoNothing();

      // UPSERT: insert participants, ignore duplicates
      if (participantIds && participantIds.length > 0) {
        const participantValues = participantIds.map((entityId) => ({
          channelId: newId,
          entityId: entityId,
        }));
        await this.db
          .insert(channelParticipantsTable)
          .values(participantValues)
          .onConflictDoNothing();
      }

      return channelToInsert;
    });
  }

  /**
   * Gets channels for a message server
   */
  async getChannelsForMessageServer(messageServerId: UUID): Promise<
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
  > {
    return this.withDatabase(async () => {
      const results = await this.db
        .select()
        .from(channelTable)
        .where(eq(channelTable.messageServerId, messageServerId));
      return results.map((r) => ({
        id: r.id as UUID,
        messageServerId: r.messageServerId as UUID,
        name: r.name,
        type: r.type,
        sourceType: r.sourceType || undefined,
        sourceId: r.sourceId || undefined,
        topic: r.topic || undefined,
        metadata: r.metadata || undefined,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      }));
    });
  }

  /**
   * Gets channel details
   */
  async getChannelDetails(channelId: UUID): Promise<{
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
  } | null> {
    return this.withDatabase(async () => {
      const results = await this.db
        .select()
        .from(channelTable)
        .where(eq(channelTable.id, channelId))
        .limit(1);
      return results.length > 0
        ? {
            id: results[0].id as UUID,
            messageServerId: results[0].messageServerId as UUID,
            name: results[0].name,
            type: results[0].type,
            sourceType: results[0].sourceType || undefined,
            sourceId: results[0].sourceId || undefined,
            topic: results[0].topic || undefined,
            metadata: results[0].metadata || undefined,
            createdAt: results[0].createdAt,
            updatedAt: results[0].updatedAt,
          }
        : null;
    });
  }

  /**
   * Creates a message
   */
  async createMessage(data: {
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
  }> {
    return this.withDatabase(async () => {
      const newId = data.messageId || (v4() as UUID);
      const now = new Date();
      const messageToInsert = {
        id: newId,
        channelId: data.channelId,
        authorId: data.authorId,
        content: data.content,
        rawMessage: data.rawMessage,
        sourceType: data.sourceType,
        sourceId: data.sourceId,
        metadata: data.metadata,
        inReplyToRootMessageId: data.inReplyToRootMessageId,
        createdAt: now,
        updatedAt: now,
      };

      await this.db.insert(messageTable).values(messageToInsert);
      return messageToInsert;
    });
  }

  async getMessageById(id: UUID): Promise<{
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
  }> {
    return this.withDatabase(async () => {
      const rows = await this.db
        .select()
        .from(messageTable)
        .where(eq(messageTable.id, id))
        .limit(1);
      return rows?.[0] ?? null;
    });
  }

  async updateMessage(
    id: UUID,
    patch: {
      content?: string;
      rawMessage?: Record<string, unknown>;
      sourceType?: string;
      sourceId?: string;
      metadata?: Metadata;
      inReplyToRootMessageId?: UUID;
    }
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
  } | null> {
    return this.withDatabase(async () => {
      const existing = await this.getMessageById(id);
      if (!existing) return null;

      const updatedAt = new Date();
      const next = {
        content: patch.content ?? existing.content,
        rawMessage: patch.rawMessage ?? existing.rawMessage,
        sourceType: patch.sourceType ?? existing.sourceType,
        sourceId: patch.sourceId ?? existing.sourceId,
        metadata: patch.metadata ?? existing.metadata,
        inReplyToRootMessageId: patch.inReplyToRootMessageId ?? existing.inReplyToRootMessageId,
        updatedAt,
      };

      await this.db.update(messageTable).set(next).where(eq(messageTable.id, id));

      // Return merged object
      return {
        ...existing,
        ...next,
      };
    });
  }

  /**
   * Gets messages for a channel
   */
  async getMessagesForChannel(
    channelId: UUID,
    limit: number = 50,
    beforeTimestamp?: Date
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
  > {
    return this.withDatabase(async () => {
      const conditions = [eq(messageTable.channelId, channelId)];
      if (beforeTimestamp) {
        conditions.push(lt(messageTable.createdAt, beforeTimestamp));
      }

      const query = this.db
        .select()
        .from(messageTable)
        .where(and(...conditions))
        .orderBy(desc(messageTable.createdAt))
        .limit(limit);

      const results = await query;
      return results.map((r) => ({
        id: r.id as UUID,
        channelId: r.channelId as UUID,
        authorId: r.authorId as UUID,
        content: r.content,
        rawMessage: r.rawMessage || undefined,
        sourceType: r.sourceType || undefined,
        sourceId: r.sourceId || undefined,
        metadata: r.metadata || undefined,
        inReplyToRootMessageId: r.inReplyToRootMessageId as UUID | undefined,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      }));
    });
  }

  /**
   * Deletes a message
   */
  async deleteMessage(messageId: UUID): Promise<void> {
    return this.withDatabase(async () => {
      await this.db.delete(messageTable).where(eq(messageTable.id, messageId));
    });
  }

  /**
   * Updates a channel
   */
  async updateChannel(
    channelId: UUID,
    updates: { name?: string; participantCentralUserIds?: UUID[]; metadata?: Metadata }
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
  }> {
    return this.withDatabase(async () => {
      const now = new Date();

      // Wrap in transaction for atomicity (delete + insert participants must succeed together)
      await this.db.transaction(async (tx) => {
        // Update channel details
        const updateData: Record<string, unknown> = { updatedAt: now };
        if (updates.name !== undefined) updateData.name = updates.name;
        if (updates.metadata !== undefined) updateData.metadata = updates.metadata;

        await tx.update(channelTable).set(updateData).where(eq(channelTable.id, channelId));

        // Update participants if provided
        if (updates.participantCentralUserIds !== undefined) {
          // Remove existing participants
          await tx
            .delete(channelParticipantsTable)
            .where(eq(channelParticipantsTable.channelId, channelId));

          // Add new participants
          if (updates.participantCentralUserIds.length > 0) {
            const participantValues = updates.participantCentralUserIds.map((entityId) => ({
              channelId: channelId,
              entityId: entityId,
            }));
            await tx
              .insert(channelParticipantsTable)
              .values(participantValues)
              .onConflictDoNothing();
          }
        }
      });

      // Return updated channel details
      const updatedChannel = await this.getChannelDetails(channelId);
      if (!updatedChannel) {
        throw new Error(`Channel ${channelId} not found after update`);
      }
      return updatedChannel;
    });
  }

  /**
   * Deletes a channel and all its associated data
   */
  async deleteChannel(channelId: UUID): Promise<void> {
    return this.withDatabase(async () => {
      await this.db.transaction(async (tx) => {
        // Delete all messages in the channel (cascade delete will handle this, but explicit is better)
        await tx.delete(messageTable).where(eq(messageTable.channelId, channelId));

        // Delete all participants (cascade delete will handle this, but explicit is better)
        await tx
          .delete(channelParticipantsTable)
          .where(eq(channelParticipantsTable.channelId, channelId));

        // Delete the channel itself
        await tx.delete(channelTable).where(eq(channelTable.id, channelId));
      });
    });
  }

  /**
   * Adds participants to a channel
   */
  async addChannelParticipants(channelId: UUID, entityIds: UUID[]): Promise<void> {
    return this.withDatabase(async () => {
      if (!entityIds || entityIds.length === 0) return;

      const participantValues = entityIds.map((entityId) => ({
        channelId: channelId,
        entityId: entityId,
      }));

      await this.db
        .insert(channelParticipantsTable)
        .values(participantValues)
        .onConflictDoNothing();
    });
  }

  /**
   * Gets participants for a channel
   */
  async getChannelParticipants(channelId: UUID): Promise<UUID[]> {
    return this.withDatabase(async () => {
      const results = await this.db
        .select({ entityId: channelParticipantsTable.entityId })
        .from(channelParticipantsTable)
        .where(eq(channelParticipantsTable.channelId, channelId));

      return results.map((r) => r.entityId as UUID);
    });
  }

  /**
   * Check if an entity is a participant in a specific messaging channel.
   * @param {UUID} channelId - The ID of the channel to check.
   * @param {UUID} entityId - The ID of the entity to check.
   * @returns {Promise<boolean>} A Promise that resolves to true if entity is a participant.
   */
  async isChannelParticipant(channelId: UUID, entityId: UUID): Promise<boolean> {
    return this.withDatabase(async () => {
      const result = await this.db
        .select()
        .from(channelParticipantsTable)
        .where(
          and(
            eq(channelParticipantsTable.channelId, channelId),
            eq(channelParticipantsTable.entityId, entityId)
          )
        )
        .limit(1);

      return result.length > 0;
    });
  }

  /**
   * Adds an agent to a message server (Discord/Telegram server)
   */
  async addAgentToMessageServer(messageServerId: UUID, agentId: UUID): Promise<void> {
    return this.withDatabase(async () => {
      await this.db
        .insert(messageServerAgentsTable)
        .values({
          messageServerId,
          agentId,
        })
        .onConflictDoNothing();
    });
  }

  /**
   * Gets agents for a message server (Discord/Telegram server)
   */
  async getAgentsForMessageServer(messageServerId: UUID): Promise<UUID[]> {
    return this.withDatabase(async () => {
      const results = await this.db
        .select({ agentId: messageServerAgentsTable.agentId })
        .from(messageServerAgentsTable)
        .where(eq(messageServerAgentsTable.messageServerId, messageServerId));

      return results.map((r) => r.agentId as UUID);
    });
  }

  /**
   * Removes an agent from a message server (Discord/Telegram server)
   */
  async removeAgentFromMessageServer(messageServerId: UUID, agentId: UUID): Promise<void> {
    return this.withDatabase(async () => {
      await this.db
        .delete(messageServerAgentsTable)
        .where(
          and(
            eq(messageServerAgentsTable.messageServerId, messageServerId),
            eq(messageServerAgentsTable.agentId, agentId)
          )
        );
    });
  }

  /**
   * Finds or creates a DM channel between two users
   */
  async findOrCreateDmChannel(
    user1Id: UUID,
    user2Id: UUID,
    messageServerId: UUID
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
  }> {
    return this.withDatabase(async () => {
      const ids = [user1Id, user2Id].sort();
      const dmChannelName = `DM-${ids[0]}-${ids[1]}`;

      const existingChannels = await this.db
        .select()
        .from(channelTable)
        .where(
          and(
            eq(channelTable.type, ChannelType.DM),
            eq(channelTable.name, dmChannelName),
            eq(channelTable.messageServerId, messageServerId)
          )
        )
        .limit(1);

      if (existingChannels.length > 0) {
        return {
          id: existingChannels[0].id as UUID,
          messageServerId: existingChannels[0].messageServerId as UUID,
          name: existingChannels[0].name,
          type: existingChannels[0].type,
          sourceType: existingChannels[0].sourceType || undefined,
          sourceId: existingChannels[0].sourceId || undefined,
          topic: existingChannels[0].topic || undefined,
          metadata: existingChannels[0].metadata || undefined,
          createdAt: existingChannels[0].createdAt,
          updatedAt: existingChannels[0].updatedAt,
        };
      }

      // Create new DM channel
      return this.createChannel(
        {
          messageServerId,
          name: dmChannelName,
          type: ChannelType.DM,
          metadata: { user1: ids[0], user2: ids[1] },
        },
        ids
      );
    });
  }
}

// Import tables at the end to avoid circular dependencies
