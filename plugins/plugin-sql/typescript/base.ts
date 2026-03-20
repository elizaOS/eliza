import {
  type Agent,
  type AgentRunCounts,
  type AgentRunSummary,
  type AgentRunSummaryResult,
  type ChannelType,
  type Component,
  DatabaseAdapter,
  type Entity,
  type IMessagingAdapter,
  type Log,
  type LogBody,
  logger,
  type Memory,
  type MemoryMetadata,
  type MessageServer,
  type MessagingChannel,
  type MessagingMessage,
  type Metadata,
  type PairingAllowlistEntry,
  type PairingChannel,
  type PairingRequest,
  type Participant,
  type Relationship,
  type Room,
  type RunStatus,
  type Task,
  type TaskMetadata,
  type UUID,
  type IDatabaseAdapter,
  type World,
} from "@elizaos/core";

// JSON-serializable value type for metadata
type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

import * as stores from "./stores";
import type { DatabaseMigrationService } from "./migration-service";
import { DIMENSION_MAP, type EmbeddingDimensionColumn } from './tables';
import type { DrizzleDatabase } from "./types";

/**
 * PostgreSQL / PGLite Drizzle Adapter
 *
 * WHY this is the base class: PostgreSQL and PGLite share the same SQL dialect
 * and Drizzle schema. Only the connection manager differs (pg Pool vs PGLite).
 * Subclasses (PgDatabaseAdapter, PgliteDatabaseAdapter) provide the connection.
 *
 * WHY implements IMessagingAdapter: SQL adapters have messaging tables
 * (message_servers, channels, messages). In-memory adapters don't.
 * The runtime uses duck typing via getMessagingAdapter() to check support.
 *
 * DESIGN: All mutations delegate to domain-specific store functions in ./stores/.
 * Each store function takes a Drizzle db instance as first parameter, keeping
 * the adapter thin and the SQL logic testable in isolation.
 *
 * BATCH-FIRST: All create methods return UUID[], all update/delete return void
 * and throw on failure. This matches the IDatabaseAdapter contract.
 */
export abstract class BaseDrizzleAdapter 
  extends DatabaseAdapter<DrizzleDatabase> 
  implements IMessagingAdapter {
  protected readonly maxRetries: number = 3;
  protected readonly baseDelay: number = 1000;
  protected readonly maxDelay: number = 10000;
  protected readonly jitterMax: number = 1000;
  protected embeddingDimension: EmbeddingDimensionColumn = DIMENSION_MAP[384];
  protected migrationService?: DatabaseMigrationService;

  protected abstract withDatabase<T>(operation: () => Promise<T>): Promise<T>;

  public abstract withIsolationContext<T>(
    entityId: UUID | null,
    callback: (tx: DrizzleDatabase) => Promise<T>,
  ): Promise<T>;

  public abstract init(): Promise<void>;
  public abstract close(): Promise<void>;

  protected agentId: UUID;

  constructor(agentId: UUID) {
    super();
    this.agentId = agentId;
  }

  public async initialize(): Promise<void> {
    await this.init();
  }

  public async runPluginMigrations(
    plugins: Array<{ name: string; schema?: Record<string, unknown> }>,
    options?: {
      verbose?: boolean;
      force?: boolean;
      dryRun?: boolean;
    },
  ): Promise<void> {
    if (!this.migrationService) {
      const { DatabaseMigrationService } = await import("./migration-service");
      this.migrationService = new DatabaseMigrationService();
      await this.migrationService.initializeWithDatabase(
        this.db as DrizzleDatabase,
      );
    }

    for (const plugin of plugins) {
      if (plugin.schema) {
        this.migrationService.registerSchema(plugin.name, plugin.schema);
      }
    }

    await this.migrationService.runAllPluginMigrations(options);
  }

  public getDatabase(): unknown {
    return this.db;
  }

  /**
   * WHY error classification: the old code retried ALL errors, including
   * permanent ones (unique violations 23505, FK violations 23503, syntax
   * errors). This wasted ~7s of backoff on errors that will never succeed.
   * Now we only retry transient errors (deadlock, serialization, connection).
   */
  private static readonly TRANSIENT_PG_CODES = new Set([
    "40P01",      // deadlock_detected
    "40001",      // serialization_failure
    "57P01",      // admin_shutdown
    "57P03",      // cannot_connect_now
    "08006",      // connection_failure
    "08001",      // sqlclient_unable_to_establish_sqlconnection
    "08004",      // sqlserver_rejected_establishment_of_sqlconnection
  ]);

  private static readonly TRANSIENT_ERROR_PATTERNS = [
    "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE",
    "connection terminated", "connection reset",
    "the database system is shutting down",
  ];

  private isTransientError(error: unknown): boolean {
    if (!error || typeof error !== "object") return false;
    const code = (error as { code?: string }).code;
    if (code && BaseDrizzleAdapter.TRANSIENT_PG_CODES.has(code)) return true;
    const msg = (error as Error).message ?? "";
    return BaseDrizzleAdapter.TRANSIENT_ERROR_PATTERNS.some((p) => msg.includes(p));
  }

  protected async withRetry<T>(operation: () => Promise<T>): Promise<T> {
    let lastError: Error = new Error("Unknown error");

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error as Error;

        // Non-transient errors (constraint violations, syntax, etc.) fail immediately
        if (!this.isTransientError(error)) {
          throw error instanceof Error ? error : new Error(String(error));
        }

        if (attempt < this.maxRetries) {
          const backoffDelay = Math.min(this.baseDelay * 2 ** (attempt - 1), this.maxDelay);
          const jitter = Math.random() * this.jitterMax;
          const delay = backoffDelay + jitter;

          logger.warn(
            {
              src: "plugin:sql",
              attempt,
              maxRetries: this.maxRetries,
              error: error instanceof Error ? error.message : String(error),
            },
            "Transient database error, retrying"
          );

          await new Promise((resolve) => setTimeout(resolve, delay));
        } else {
          logger.error(
            {
              src: "plugin:sql",
              totalAttempts: attempt,
              error: error instanceof Error ? error.message : String(error),
            },
            "Max retry attempts reached for transient error"
          );
          throw error instanceof Error ? error : new Error(String(error));
        }
      }
    }

    throw lastError;
  }

  // WHY no withDatabase: this is a pure in-memory property assignment.
  async ensureEmbeddingDimension(dimension: number): Promise<void> {
    const mapped = DIMENSION_MAP[dimension as keyof typeof DIMENSION_MAP];
    if (!mapped) {
      const supported = Object.keys(DIMENSION_MAP).join(', ');
      throw new Error(
        `Unsupported embedding dimension: ${dimension}. Supported dimensions: ${supported}`
      );
    }
    this.embeddingDimension = mapped;
  }

  /**
   * Ensures the agent record exists in the database. Creates it if missing.
   *
   * WHY in base class: was duplicated identically in both PG and PGLite adapters.
   * WHY try-catch on create: handles concurrent agent creation (race condition)
   * by catching the duplicate key error and re-reading.
   */
  async ensureAgentExists(agent: Partial<Agent>): Promise<Agent> {
    const existing = await this.getAgentsByIds([this.agentId]);
    if (existing.length > 0) {
      return existing[0];
    }

    const newAgent: Agent = {
      id: this.agentId,
      name: agent.name || "Unknown Agent",
      username: agent.username,
      bio: (Array.isArray(agent.bio)
        ? agent.bio
        : agent.bio
          ? [agent.bio]
          : ["An AI agent"]) as string[],
      createdAt: agent.createdAt || Date.now(),
      updatedAt: agent.updatedAt || Date.now(),
    };

    try {
      await this.createAgents([newAgent]);
    } catch {
      // Concurrent creation race -- check if it exists now
      const retryExisting = await this.getAgentsByIds([this.agentId]);
      if (retryExisting.length > 0) {
        return retryExisting[0];
      }
      throw new Error("Failed to create agent");
    }

    return newAgent as Agent;
  }

  // ===============================
  // Agent Methods
  // ===============================

  async getAgents(): Promise<Partial<Agent>[]> {
    return this.withDatabase(() => stores.getAgents(this.db));
  }

  // Batch agent methods
  async getAgentsByIds(agentIds: UUID[]): Promise<Agent[]> {
    return this.withDatabase(() => stores.getAgentsByIds(this.db, agentIds));
  }

  /** Single-agent convenience; delegates to getAgentsByIds for compatibility with tests and callers. */
  async getAgent(agentId: UUID): Promise<Agent | null> {
    const agents = await this.getAgentsByIds([agentId]);
    return agents[0] ?? null;
  }

  async createAgents(agents: Partial<Agent>[]): Promise<UUID[]> {
    return this.withDatabase(() => stores.createAgents(this.db, agents as Agent[]));
  }

  /** Single-agent convenience; delegates to createAgents for compatibility with tests and callers. */
  async createAgent(agent: Partial<Agent>): Promise<boolean> {
    const ids = await this.createAgents([agent]);
    return ids.length > 0;
  }

  async upsertAgents(agents: Partial<Agent>[]): Promise<void> {
    return this.withDatabase(() => stores.upsertAgents(this.db, agents));
  }

  async updateAgents(updates: Array<{ agentId: UUID; agent: Partial<Agent> }>): Promise<boolean> {
    await this.withDatabase(() => stores.updateAgents(this.db, updates));
    return true;
  }

  /** Single-agent convenience; delegates to updateAgents for compatibility with tests and callers. */
  async updateAgent(agentId: UUID, agent: Partial<Agent>): Promise<boolean> {
    await this.updateAgents([{ agentId, agent }]);
    return true;
  }

  async deleteAgents(agentIds: UUID[]): Promise<boolean> {
    await this.withDatabase(() => stores.deleteAgents(this.db, agentIds));
    return true;
  }

  /** Single-agent convenience; delegates to deleteAgents for compatibility with tests and callers. */
  async deleteAgent(agentId: UUID): Promise<boolean> {
    await this.deleteAgents([agentId]);
    return true;
  }

  async countAgents(): Promise<number> {
    return this.withDatabase(() => stores.countAgents(this.db));
  }

  async cleanupAgents(): Promise<void> {
    return this.withDatabase(() => stores.cleanupAgents(this.db));
  }

  // ===============================
  // Entity Methods
  // ===============================

  async getEntitiesForRooms(
    roomIds: UUID[],
    includeComponents?: boolean,
  ): Promise<Array<{ roomId: UUID; entities: Entity[] }>> {
    return this.withDatabase(async () => {
      const result: Array<{ roomId: UUID; entities: Entity[] }> = [];
      for (const roomId of roomIds) {
        const entities = await stores.getEntitiesForRoom(
          this.db,
          this.agentId,
          roomId,
          includeComponents,
        );
        result.push({ roomId, entities });
      }
      return result;
    });
  }

  async createEntities(entities: Entity[]): Promise<UUID[]> {
    return this.withDatabase(() => stores.createEntities(this.db, entities));
  }

  async upsertEntities(entities: Entity[]): Promise<void> {
    return this.withDatabase(() => stores.upsertEntities(this.db, entities));
  }

  protected async ensureEntityExists(entity: Entity): Promise<boolean> {
    return this.withDatabase(() => stores.ensureEntityExists(this.db, entity));
  }

  async getEntitiesByNames(params: { names: string[]; agentId: UUID }): Promise<Entity[]> {
    return this.withDatabase(() => stores.getEntitiesByNames(this.db, params));
  }

  /**
   * Query entities by component type and optional filters.
   * WHY entityContext: When set (Postgres + ENABLE_DATA_ISOLATION), runs inside withIsolationContext
   * so RLS policies apply. We destructure entityContext out and pass only rest to the store—entityContext
   * is connection context, not a query filter; stores do not accept it.
   */
  async queryEntities(params: {
    componentType?: string;
    componentDataFilter?: Record<string, unknown>;
    agentId?: UUID;
    entityIds?: UUID[];
    worldId?: UUID;
    limit?: number;
    offset?: number;
    includeAllComponents?: boolean;
    entityContext?: UUID;
  }): Promise<Entity[]> {
    const { entityContext, ...rest } = params;
    if (entityContext != null) {
      return this.withIsolationContext(entityContext, (tx) =>
        stores.queryEntities(tx, rest)
      );
    }
    return this.withDatabase(() => stores.queryEntities(this.db, params));
  }

  // Batch entity methods
  async getEntitiesByIds(entityIds: UUID[]): Promise<Entity[]> {
    return this.withDatabase(() => stores.getEntitiesByIds(this.db, entityIds));
  }

  async updateEntities(entities: Entity[]): Promise<void> {
    return this.withDatabase(() => stores.updateEntities(this.db, entities));
  }

  /** Single-entity convenience; delegates to updateEntities for compatibility with tests and callers. */
  async updateEntity(entity: Entity): Promise<void> {
    return this.updateEntities([entity]);
  }

  async deleteEntities(entityIds: UUID[]): Promise<void> {
    return this.withDatabase(() => stores.deleteEntities(this.db, entityIds));
  }

  /** Single-entity convenience; delegates to deleteEntities for compatibility with tests and callers. */
  async deleteEntity(entityId: UUID): Promise<void> {
    return this.deleteEntities([entityId]);
  }

  async searchEntitiesByName(params: {
    query: string;
    agentId: UUID;
    limit?: number;
  }): Promise<Entity[]> {
    return this.withDatabase(() => stores.searchEntitiesByName(this.db, params));
  }

  // ===============================
  // Component Methods
  // ===============================

  async getComponentsByNaturalKeys(keys: Array<{
    entityId: UUID;
    type: string;
    worldId?: UUID;
    sourceEntityId?: UUID;
  }>): Promise<(Component | null)[]> {
    return this.withDatabase(async () => {
      const result: (Component | null)[] = [];
      for (const k of keys) {
        const c = await stores.getComponent(
          this.db,
          k.entityId,
          k.type,
          k.worldId,
          k.sourceEntityId,
        );
        result.push(c);
      }
      return result;
    });
  }

  async getComponentsForEntities(
    entityIds: UUID[],
    worldId?: UUID,
    sourceEntityId?: UUID,
  ): Promise<Component[]> {
    return this.withDatabase(async () => {
      const out: Component[] = [];
      for (const entityId of entityIds) {
        const comps = await stores.getComponents(
          this.db,
          entityId,
          worldId,
          sourceEntityId,
        );
        out.push(...comps);
      }
      return out;
    });
  }

  /** Single-component convenience for tests and callers. */
  async getComponent(
    entityId: UUID,
    type: string,
    worldId?: UUID,
    sourceEntityId?: UUID,
  ): Promise<Component | null> {
    const [c] = await this.getComponentsByNaturalKeys([
      { entityId, type, worldId, sourceEntityId },
    ]);
    return c ?? null;
  }

  /** Single-component convenience for tests and callers. */
  async getComponents(
    entityId: UUID,
    worldId?: UUID,
    sourceEntityId?: UUID,
  ): Promise<Component[]> {
    return this.getComponentsForEntities([entityId], worldId, sourceEntityId);
  }

  /** Single-patch convenience for tests and callers. */
  async patchComponent(
    componentId: UUID,
    ops: import("@elizaos/core").PatchOp[],
    options?: { entityContext?: UUID },
  ): Promise<void> {
    await this.patchComponents([{ componentId, ops }], options);
  }

  // Batch component methods
  async createComponents(components: Component[]): Promise<UUID[]> {
    return this.withDatabase(() => stores.createComponents(this.db, components));
  }

  /** Single-component convenience for tests and callers. */
  async createComponent(component: Component): Promise<UUID> {
    const ids = await this.createComponents([component]);
    if (ids.length === 0) throw new Error("createComponents returned no id");
    return ids[0];
  }

  async getComponentsByIds(componentIds: UUID[]): Promise<Component[]> {
    return this.withDatabase(() => stores.getComponentsByIds(this.db, componentIds));
  }

  async updateComponents(components: Component[]): Promise<void> {
    return this.withDatabase(() => stores.updateComponents(this.db, components));
  }

  /** Single-component convenience for tests and callers. */
  async updateComponent(component: Component): Promise<void> {
    return this.updateComponents([component]);
  }

  async deleteComponents(componentIds: UUID[]): Promise<void> {
    return this.withDatabase(() => stores.deleteComponents(this.db, componentIds));
  }

  /** Single-component convenience for tests and callers. */
  async deleteComponent(componentId: UUID): Promise<void> {
    return this.deleteComponents([componentId]);
  }

  /**
   * Upsert components (insert or update by natural key).
   * WHY entityContext: When set, runs inside withIsolationContext so RLS restricts which rows
   * are visible/updated. Only Postgres uses this; PGLite/MySQL adapters accept and ignore.
   */
  async upsertComponents(
    components: Component[],
    options?: { entityContext?: UUID },
  ): Promise<void> {
    if (options?.entityContext != null) {
      return this.withIsolationContext(options.entityContext, (tx) =>
        stores.upsertComponents(tx, components)
      );
    }
    return this.withDatabase(() => stores.upsertComponents(this.db, components));
  }

  /**
   * Batch patch components (JSON Patch ops per component). Runs in a single transaction.
   * WHY entityContext: Same as upsertComponents—scopes the patch to the entity when RLS is on.
   */
  async patchComponents(
    updates: Array<{ componentId: UUID; ops: import("@elizaos/core").PatchOp[] }>,
    options?: { entityContext?: UUID },
  ): Promise<void> {
    if (updates.length === 0) return;
    const run = (db: typeof this.db) =>
      Promise.all(
        updates.map((u) => stores.patchComponent(db, u.componentId, u.ops)),
      ).then(() => {});
    if (options?.entityContext != null) {
      return this.withIsolationContext(options.entityContext, run);
    }
    return this.withDatabase(() => run(this.db));
  }

  // ========================
  async getMemories(params: {
    entityId?: UUID;
    agentId?: UUID;
    count?: number;
    limit?: number;
    offset?: number;
    unique?: boolean;
    tableName: string;
    start?: number;
    end?: number;
    roomId?: UUID;
    worldId?: UUID;
    metadata?: Record<string, unknown>;
    orderBy?: 'createdAt';
    orderDirection?: 'asc' | 'desc';
  }): Promise<Memory[]> {
    return this.withIsolationContext(params.entityId ?? null, (tx) =>
      stores.getMemories(tx, this.embeddingDimension, params)
    );
  }

  async getMemoriesByRoomIds(params: {
    roomIds: UUID[];
    tableName: string;
    limit?: number;
  }): Promise<Memory[]> {
    return this.withDatabase(() =>
      stores.getMemoriesByRoomIds(this.db, this.agentId, params)
    );
  }

  async getMemoriesByIds(memoryIds: UUID[], tableName?: string): Promise<Memory[]> {
    return this.withDatabase(() =>
      stores.getMemoriesByIds(this.db, this.embeddingDimension, memoryIds, tableName)
    );
  }

  /** Single-memory convenience for tests and callers. */
  async getMemoryById(memoryId: UUID, tableName?: string): Promise<Memory | null> {
    const memories = await this.getMemoriesByIds([memoryId], tableName);
    return memories[0] ?? null;
  }

  async getCachedEmbeddings(opts: {
    query_table_name: string;
    query_threshold: number;
    query_input: string;
    query_field_name: string;
    query_field_sub_name: string;
    query_match_count: number;
  }): Promise<{ embedding: number[]; levenshtein_score: number }[]> {
    return this.withDatabase(() => stores.getCachedEmbeddings(this.db, opts));
  }

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
    return this.withDatabase(() =>
      stores.searchMemories(this.db, this.agentId, this.embeddingDimension, params)
    );
  }

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
    },
  ): Promise<Memory[]> {
    return this.withDatabase(() =>
      stores.searchMemoriesByEmbedding(
        this.db,
        this.agentId,
        this.embeddingDimension,
        embedding,
        params
      )
    );
  }

  // Batch memory methods
  async createMemories(memories: Array<{ memory: Memory; tableName: string; unique?: boolean }>): Promise<UUID[]> {
    return this.withDatabase(() =>
      stores.createMemories(this.db, this.agentId, this.embeddingDimension, memories)
    );
  }

  /** Single-memory convenience for tests and callers. */
  async createMemory(memory: Memory | Partial<Memory>, tableName: string, unique?: boolean): Promise<UUID> {
    const ids = await this.createMemories([{ memory: memory as Memory, tableName, unique }]);
    if (ids.length === 0) throw new Error("createMemories returned no id");
    return ids[0];
  }

  async updateMemories(memories: Array<Partial<Memory> & { id: UUID; metadata?: MemoryMetadata }>): Promise<void> {
    return this.withDatabase(() =>
      stores.updateMemories(this.db, this.embeddingDimension, memories)
    );
  }

  /** Single-memory convenience for tests and callers. */
  async updateMemory(memory: Partial<Memory> & { id: UUID; metadata?: MemoryMetadata }): Promise<void> {
    return this.updateMemories([memory]);
  }

  async deleteMemories(memoryIds: UUID[]): Promise<void> {
    return this.withDatabase(() =>
      stores.deleteMemories(this.db, memoryIds)
    );
  }

  /** Single-memory convenience for tests and callers. */
  async deleteMemory(memoryId: UUID): Promise<void> {
    return this.deleteMemories([memoryId]);
  }

  /**
   * Upsert memories (insert or update by ID).
   * WHY entityContext: When set, runs inside withIsolationContext so RLS restricts memory rows
   * to the current entity (e.g. user-scoped memories when ENABLE_DATA_ISOLATION=true).
   */
  async upsertMemories(
    memories: Array<{ memory: Memory; tableName: string }>,
    options?: { entityContext?: UUID },
  ): Promise<void> {
    if (options?.entityContext != null) {
      return this.withIsolationContext(options.entityContext, (tx) =>
        stores.upsertMemories(tx, this.agentId, this.embeddingDimension, memories)
      );
    }
    return this.withDatabase(() =>
      stores.upsertMemories(this.db, this.agentId, this.embeddingDimension, memories)
    );
  }

  async deleteAllMemories(roomIds: UUID[], tableName: string): Promise<void> {
    return this.withDatabase(async () => {
      for (const roomId of roomIds) {
        await stores.deleteAllMemories(this.db, this.agentId, roomId, tableName);
      }
    });
  }

  async countMemories(params: {
    roomIds?: UUID[];
    unique?: boolean;
    tableName?: string;
    entityId?: UUID;
    agentId?: UUID;
    metadata?: Record<string, unknown>;
  }): Promise<number> {
    return this.withDatabase(() =>
      stores.countMemories(this.db, params, undefined, undefined)
    );
  }

async getMemoriesByWorldIds(params: {
    worldIds: UUID[];
    tableName?: string;
    limit?: number;
  }): Promise<Memory[]> {
return this.withDatabase(() =>
      stores.getMemoriesByWorldIds(this.db, this.agentId, params)
    );
  }

  // ===============================
  // Log Methods
  // ===============================

  async getLogs(params: {
    entityId?: UUID;
    roomId?: UUID;
    type?: string;
    count?: number;
    offset?: number;
  }): Promise<Log[]> {
    return this.withIsolationContext(params.entityId ?? null, (tx) => stores.getLogs(tx, params));
  }

  async getAgentRunSummaries(
    params: {
      limit?: number;
      roomId?: UUID;
      status?: RunStatus | "all";
      from?: number;
      to?: number;
      entityId?: UUID;
    } = {}
  ): Promise<AgentRunSummaryResult> {
    return this.withIsolationContext(params.entityId ?? null, (tx) =>
      stores.getAgentRunSummaries(tx, this.agentId, params)
    );
  }

  // Batch log methods
  async getLogsByIds(logIds: UUID[]): Promise<Log[]> {
    return this.withDatabase(() => stores.getLogsByIds(this.db, logIds));
  }

  async createLogs(params: Array<{ body: LogBody; entityId: UUID; roomId: UUID; type: string }>): Promise<void> {
    return this.withDatabase(() => stores.createLogs(this.db, params));
  }

  /** Single-log convenience for tests and callers. */
  async log(params: { body: LogBody; entityId: UUID; roomId: UUID; type: string }): Promise<void> {
    return this.createLogs([params]);
  }

  async updateLogs(logs: Array<{ id: UUID; updates: Partial<Log> }>): Promise<void> {
    return this.withDatabase(() => stores.updateLogs(this.db, logs));
  }

  async deleteLogs(logIds: UUID[]): Promise<void> {
    return this.withDatabase(() => stores.deleteLogs(this.db, logIds));
  }

  /** Single-log convenience for tests and callers. */
  async deleteLog(logId: UUID): Promise<void> {
    return this.deleteLogs([logId]);
  }

  // ===============================
  // Room Methods
  // ===============================

  async getRoomsByIds(roomIds: UUID[]): Promise<Room[]> {
    return this.withDatabase(() => stores.getRoomsByIds(this.db, this.agentId, roomIds));
  }

  async getRoomsByWorlds(
    worldIds: UUID[],
    limit?: number,
    offset?: number,
  ): Promise<Room[]> {
    return this.withDatabase(async () => {
      let all: Room[] = [];
      for (const worldId of worldIds) {
        const rooms = await stores.getRoomsByWorld(this.db, worldId);
        all = all.concat(rooms);
      }
      if (offset != null) all = all.slice(offset);
      if (limit != null) all = all.slice(0, limit);
      return all;
    });
  }

  async deleteRoomsByWorldIds(worldIds: UUID[]): Promise<void> {
    return this.withDatabase(async () => {
      for (const worldId of worldIds) {
        await stores.deleteRoomsByWorldId(this.db, this.agentId, worldId);
      }
    });
  }

  async createRooms(rooms: Room[]): Promise<UUID[]> {
    return this.withDatabase(() => stores.createRooms(this.db, this.agentId, rooms));
  }

  async upsertRooms(rooms: Room[]): Promise<void> {
    return this.withDatabase(() => stores.upsertRooms(this.db, this.agentId, rooms));
  }

  // Batch room methods
  async updateRooms(rooms: Room[]): Promise<void> {
    return this.withDatabase(() => stores.updateRooms(this.db, this.agentId, rooms));
  }

  async deleteRooms(roomIds: UUID[]): Promise<void> {
    return this.withDatabase(() => stores.deleteRooms(this.db, this.agentId, roomIds));
  }

  /** Single-room convenience for tests and callers. */
  async deleteRoom(roomId: UUID): Promise<void> {
    return this.deleteRooms([roomId]);
  }

  /** Single-room convenience for tests and callers. */
  async updateRoom(room: Room): Promise<void> {
    return this.updateRooms([room]);
  }

  async getRoomsForParticipants(entityIds: UUID[]): Promise<UUID[]> {
    return this.withDatabase(() =>
      stores.getRoomsForParticipants(this.db, this.agentId, entityIds)
    );
  }

  // ===============================
  // Participant Methods
  // ===============================


  async createRoomParticipants(entityIds: UUID[], roomId: UUID): Promise<UUID[]> {
    return this.withDatabase(() =>
      stores.createRoomParticipants(this.db, this.agentId, entityIds, roomId)
    );
  }

  /** Single-participant convenience for tests and callers. */
  async addParticipant(entityId: UUID, roomId: UUID): Promise<UUID> {
    const ids = await this.createRoomParticipants([entityId], roomId);
    return ids[0] ?? entityId;
  }

  /** Alias for createRoomParticipants for tests and callers. */
  async addParticipantsRoom(entityIds: UUID[], roomId: UUID): Promise<UUID[]> {
    return this.createRoomParticipants(entityIds, roomId);
  }

  async getParticipantsForEntities(entityIds: UUID[]): Promise<Participant[]> {
    return this.withDatabase(async () => {
      const out: Participant[] = [];
      for (const entityId of entityIds) {
        const participants = await stores.getParticipantsForEntity(this.db, entityId);
        out.push(...participants);
      }
      return out;
    });
  }

  async getParticipantsForRooms(
    roomIds: UUID[],
  ): Promise<Array<{ roomId: UUID; entityIds: UUID[] }>> {
    return this.withDatabase(async () => {
      const result: Array<{ roomId: UUID; entityIds: UUID[] }> = [];
      for (const roomId of roomIds) {
        const entityIds = await stores.getParticipantsForRoom(this.db, roomId);
        result.push({ roomId, entityIds });
      }
      return result;
    });
  }

  async areRoomParticipants(
    pairs: Array<{ roomId: UUID; entityId: UUID }>,
  ): Promise<boolean[]> {
    return this.withDatabase(async () => {
      const result: boolean[] = [];
      for (const { roomId, entityId } of pairs) {
        const ok = await stores.isRoomParticipant(this.db, roomId, entityId);
        result.push(ok);
      }
      return result;
    });
  }

  async getParticipantUserStates(
    pairs: Array<{ roomId: UUID; entityId: UUID }>,
  ): Promise<("FOLLOWED" | "MUTED" | null)[]> {
    return this.withDatabase(async () => {
      const result: ("FOLLOWED" | "MUTED" | null)[] = [];
      for (const { roomId, entityId } of pairs) {
        const state = await stores.getParticipantUserState(
          this.db,
          this.agentId,
          roomId,
          entityId,
        );
        result.push(state);
      }
      return result;
    });
  }

  async updateParticipantUserStates(updates: Array<{
    roomId: UUID;
    entityId: UUID;
    state: "FOLLOWED" | "MUTED" | null;
  }>): Promise<void> {
    return this.withDatabase(async () => {
      for (const u of updates) {
        await stores.updateParticipantUserState(
          this.db,
          this.agentId,
          u.roomId,
          u.entityId,
          u.state,
        );
      }
    });
  }

  /** Single-id convenience for tests and callers. */
  async getParticipantUserState(
    roomId: UUID,
    entityId: UUID,
  ): Promise<"FOLLOWED" | "MUTED" | null> {
    const [state] = await this.getParticipantUserStates([{ roomId, entityId }]);
    return state ?? null;
  }

  /** Single-id convenience for tests and callers. */
  async updateParticipantUserState(
    roomId: UUID,
    entityId: UUID,
    state: "FOLLOWED" | "MUTED" | null,
  ): Promise<void> {
    await this.updateParticipantUserStates([{ roomId, entityId, state }]);
  }

  /** Alias for updateParticipantUserState for tests and callers. */
  async setParticipantUserState(
    roomId: UUID,
    entityId: UUID,
    state: "FOLLOWED" | "MUTED" | null,
  ): Promise<void> {
    await this.updateParticipantUserStates([{ roomId, entityId, state }]);
  }

  // Batch participant methods
  async deleteParticipants(participants: Array<{ entityId: UUID; roomId: UUID }>): Promise<boolean> {
    await this.withDatabase(() => stores.deleteParticipants(this.db, this.agentId, participants));
    return true;
  }

  /** Single-participant convenience for tests and callers. */
  async removeParticipant(entityId: UUID, roomId: UUID): Promise<boolean> {
    await this.deleteParticipants([{ entityId, roomId }]);
    return true;
  }

  async updateParticipants(participants: Array<{
    entityId: UUID;
    roomId: UUID;
    updates: Partial<Participant>;
  }>): Promise<void> {
    return this.withDatabase(() => stores.updateParticipants(this.db, this.agentId, participants));
  }

  // ===============================
  // Relationship Methods
  // ===============================

  async getRelationshipsByPairs(
    pairs: Array<{ sourceEntityId: UUID; targetEntityId: UUID }>,
  ): Promise<(Relationship | null)[]> {
    return this.withDatabase(async () => {
      const result: (Relationship | null)[] = [];
      for (const params of pairs) {
        const rel = await stores.getRelationship(this.db, params);
        result.push(rel);
      }
      return result;
    });
  }

  async getRelationships(params: {
    entityIds?: UUID[];
    tags?: string[];
    limit?: number;
    offset?: number;
  }): Promise<Relationship[]> {
    const ids = params.entityIds ?? [];
    if (ids.length === 0) return [];
    return this.withDatabase(async () => {
      const all: Relationship[] = [];
      for (const entityId of ids) {
        const rels = await stores.getRelationships(this.db, {
          entityId,
          tags: params.tags,
          limit: params.limit,
          offset: params.offset,
        });
        all.push(...rels);
      }
      return all;
    });
  }

  // Batch relationship methods
  async createRelationships(relationships: Array<{
    sourceEntityId: UUID;
    targetEntityId: UUID;
    tags?: string[];
    metadata?: Metadata;
  }>): Promise<UUID[]> {
    return this.withDatabase(() =>
      stores.createRelationships(this.db, this.agentId, relationships)
    );
  }

  /** Single-relationship convenience for tests and callers. */
  async createRelationship(rel: {
    sourceEntityId: UUID;
    targetEntityId: UUID;
    tags?: string[];
    metadata?: Metadata;
  }): Promise<UUID> {
    const ids = await this.createRelationships([rel]);
    if (ids.length === 0) throw new Error("createRelationships returned no id");
    return ids[0];
  }

  async getRelationshipsByIds(relationshipIds: UUID[]): Promise<Relationship[]> {
    return this.withDatabase(() => stores.getRelationshipsByIds(this.db, relationshipIds));
  }

  async updateRelationships(relationships: Relationship[]): Promise<void> {
    return this.withDatabase(() => stores.updateRelationships(this.db, relationships));
  }

  /** Single-relationship convenience for tests and callers. */
  async updateRelationship(relationship: Relationship): Promise<void> {
    return this.updateRelationships([relationship]);
  }

  async deleteRelationships(relationshipIds: UUID[]): Promise<void> {
    return this.withDatabase(() => stores.deleteRelationships(this.db, relationshipIds));
  }

  // ===============================
  // Cache Methods
  // ===============================

  // Batch cache methods
  async getCaches<T>(keys: string[]): Promise<Map<string, T>> {
    return this.withDatabase(() => stores.getCaches<T>(this.db, this.agentId, keys));
  }

  async setCaches<T>(entries: Array<{ key: string; value: T }>): Promise<boolean> {
    return this.withDatabase(() => stores.setCaches<T>(this.db, this.agentId, entries));
  }

  /** Single-cache convenience for tests and callers. */
  async setCache<T>(key: string, value: T): Promise<boolean> {
    return this.setCaches([{ key, value }]);
  }

  /** Single-cache convenience for tests and callers. */
  async getCache<T>(key: string): Promise<T | undefined> {
    const map = await this.getCaches<T>([key]);
    return map.get(key);
  }

  async deleteCaches(keys: string[]): Promise<boolean> {
    return this.withDatabase(() => stores.deleteCaches(this.db, this.agentId, keys));
  }

  /** Single-cache convenience for tests and callers. */
  async deleteCache(key: string): Promise<boolean> {
    return this.deleteCaches([key]);
  }

  // ===============================
  // World Methods
  // ===============================

  async getAllWorlds(): Promise<World[]> {
    return this.withDatabase(() => stores.getAllWorlds(this.db, this.agentId));
  }

  // Batch world methods
  async getWorldsByIds(worldIds: UUID[]): Promise<World[]> {
    return this.withDatabase(() => stores.getWorldsByIds(this.db, worldIds));
  }

  async createWorlds(worlds: World[]): Promise<UUID[]> {
    return this.withDatabase(() => stores.createWorlds(this.db, worlds));
  }

  async upsertWorlds(worlds: World[]): Promise<void> {
    return this.withDatabase(() => stores.upsertWorlds(this.db, worlds));
  }

  async deleteWorlds(worldIds: UUID[]): Promise<void> {
    return this.withDatabase(() => stores.deleteWorlds(this.db, worldIds));
  }

  async updateWorlds(worlds: World[]): Promise<void> {
    return this.withDatabase(() => stores.updateWorlds(this.db, worlds));
  }

  /** Single-world convenience; delegates to batch methods for compatibility with tests and callers. */
  async createWorld(world: World): Promise<UUID> {
    const ids = await this.createWorlds([world]);
    if (ids.length === 0) throw new Error("createWorlds returned no id");
    return ids[0];
  }

  async getWorld(id: UUID): Promise<World | null> {
    const worlds = await this.getWorldsByIds([id]);
    return worlds[0] ?? null;
  }

  async updateWorld(world: World): Promise<void> {
    return this.updateWorlds([world]);
  }

  async deleteWorld(worldId: UUID): Promise<void> {
    return this.deleteWorlds([worldId]);
  }

  /** Alias for deleteWorld for tests and callers. */
  async removeWorld(worldId: UUID): Promise<void> {
    return this.deleteWorld(worldId);
  }

  // ===============================
  // Task Methods
  // ===============================

  // WHY no withRetry wrapper: withDatabase already handles retries (PG's
  // withDatabase calls withRetry internally). The old code double-wrapped,
  // causing 3x3=9 retry attempts and ~30s wasted on transient failures.
  async getTasks(params: {
    roomId?: UUID;
    tags?: string[];
    entityId?: UUID;
    agentIds: UUID[];
    limit?: number;
    offset?: number;
  }): Promise<Task[]> {
    return this.withDatabase(() => stores.getTasks(this.db, params));
  }

  async getTasksByName(name: string): Promise<Task[]> {
    return this.withDatabase(() => stores.getTasksByName(this.db, this.agentId, name));
  }

  // Batch task methods
  async createTasks(tasks: Task[]): Promise<UUID[]> {
    return this.withDatabase(() => stores.createTasks(this.db, this.agentId, tasks));
  }

  /** Single-task convenience for tests and callers. */
  async createTask(task: Task): Promise<UUID> {
    const ids = await this.createTasks([task]);
    if (ids.length === 0) throw new Error("createTasks returned no id");
    return ids[0];
  }

  async getTasksByIds(taskIds: UUID[]): Promise<Task[]> {
    return this.withDatabase(() => stores.getTasksByIds(this.db, this.agentId, taskIds));
  }

  /** Single-task convenience for tests and callers. */
  async getTask(taskId: UUID): Promise<Task | null> {
    const tasks = await this.getTasksByIds([taskId]);
    return tasks[0] ?? null;
  }

  async updateTasks(updates: Array<{ id: UUID; task: Partial<Task> }>): Promise<void> {
    await this.withDatabase(() => stores.updateTasks(this.db, this.agentId, updates));
  }

  /** Single-task convenience for tests and callers. */
  async updateTask(taskId: UUID, task: Partial<Task>): Promise<void> {
    return this.updateTasks([{ id: taskId, task }]);
  }

  async deleteTasks(taskIds: UUID[]): Promise<void> {
    return this.withDatabase(() => stores.deleteTasks(this.db, taskIds));
  }

  /** Single-task convenience for tests and callers. */
  async deleteTask(taskId: UUID): Promise<void> {
    return this.deleteTasks([taskId]);
  }

  // ===============================
  // Message Server Methods
  // ===============================

  async createMessageServer(data: {
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
  }> {
    return this.withDatabase(() => stores.createMessageServer(this.db, data));
  }

  async getMessageServers(): Promise<MessageServer[]> {
    return this.withDatabase(() => stores.getMessageServers(this.db));
  }

  async getMessageServerById(serverId: UUID): Promise<MessageServer | null> {
    return this.withDatabase(() => stores.getMessageServerById(this.db, serverId));
  }

  async getMessageServerByRlsServerId(rlsServerId: UUID): Promise<MessageServer | null> {
    return this.withDatabase(() => stores.getMessageServerByRlsServerId(this.db, rlsServerId));
  }

  async addAgentToMessageServer(messageServerId: UUID, agentId: UUID): Promise<void> {
    return this.withDatabase(() =>
      stores.addAgentToMessageServer(this.db, messageServerId, agentId)
    );
  }

  async getAgentsForMessageServer(messageServerId: UUID): Promise<UUID[]> {
    return this.withDatabase(() =>
      stores.getAgentsForMessageServer(this.db, messageServerId)
    );
  }

  async removeAgentFromMessageServer(messageServerId: UUID, agentId: UUID): Promise<void> {
    return this.withDatabase(() =>
      stores.removeAgentFromMessageServer(this.db, messageServerId, agentId)
    );
  }

  // ===============================
  // Channel Methods
  // ===============================

  async createChannel(
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
  }> {
    return this.withDatabase(() => stores.createChannel(this.db, data, participantIds));
  }

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
    return this.withDatabase(() =>
      stores.getChannelsForMessageServer(this.db, messageServerId)
    );
  }

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
    return this.withDatabase(() => stores.getChannelDetails(this.db, channelId));
  }

  async updateChannel(
    channelId: UUID,
    updates: {
      name?: string;
      participantCentralUserIds?: UUID[];
      metadata?: Metadata;
    }
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
    return this.withDatabase(() => stores.updateChannel(this.db, channelId, updates));
  }

  async deleteChannel(channelId: UUID): Promise<void> {
    return this.withDatabase(() => stores.deleteChannel(this.db, channelId));
  }

  async addChannelParticipants(channelId: UUID, entityIds: UUID[]): Promise<void> {
    return this.withDatabase(() =>
      stores.addChannelParticipants(this.db, channelId, entityIds)
    );
  }

  async getChannelParticipants(channelId: UUID): Promise<UUID[]> {
    return this.withDatabase(() => stores.getChannelParticipants(this.db, channelId));
  }

  async isChannelParticipant(channelId: UUID, entityId: UUID): Promise<boolean> {
    return this.withDatabase(() =>
      stores.isChannelParticipant(this.db, channelId, entityId)
    );
  }

  // ===============================
  // Message Methods
  // ===============================

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
    return this.withDatabase(() => stores.createMessage(this.db, data));
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
  } | null> {
    return this.withDatabase(() => stores.getMessageById(this.db, id));
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
  } | null> {
    return this.withDatabase(() => stores.updateMessage(this.db, id, patch));
  }

  async getMessagesForChannel(
    channelId: UUID,
    limit: number = 50,
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
  > {
    return this.withDatabase(() =>
      stores.getMessagesForChannel(this.db, channelId, limit, beforeTimestamp)
    );
  }

  async deleteMessage(messageId: UUID): Promise<void> {
    return this.withDatabase(() => stores.deleteMessage(this.db, messageId));
  }

  async findOrCreateDmChannel(
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
  }> {
    return this.withDatabase(() =>
      stores.findOrCreateDmChannel(this.db, user1Id, user2Id, messageServerId)
    );
  }

  // ===============================
  // Pairing Methods
  // ===============================

  async getPairingRequests(
    queries: Array<{ channel: PairingChannel; agentId: UUID }>,
  ): Promise<Array<{ channel: PairingChannel; agentId: UUID; requests: PairingRequest[] }>> {
    return this.withDatabase(async () => {
      const result: Array<{ channel: PairingChannel; agentId: UUID; requests: PairingRequest[] }> = [];
      for (const { channel, agentId } of queries) {
        const requests = await stores.getPairingRequests(this.db, channel, agentId);
        result.push({ channel, agentId, requests });
      }
      return result;
    });
  }

  async getPairingAllowlists(
    queries: Array<{ channel: PairingChannel; agentId: UUID }>,
  ): Promise<Array<{ channel: PairingChannel; agentId: UUID; entries: PairingAllowlistEntry[] }>> {
    return this.withDatabase(async () => {
      const result: Array<{ channel: PairingChannel; agentId: UUID; entries: PairingAllowlistEntry[] }> = [];
      for (const { channel, agentId } of queries) {
        const entries = await stores.getPairingAllowlist(this.db, channel, agentId);
        result.push({ channel, agentId, entries });
      }
      return result;
    });
  }

  // Batch pairing methods
  async createPairingRequests(requests: PairingRequest[]): Promise<UUID[]> {
    return this.withDatabase(() => stores.createPairingRequests(this.db, requests));
  }

  async updatePairingRequests(requests: PairingRequest[]): Promise<void> {
    return this.withDatabase(() => stores.updatePairingRequests(this.db, requests));
  }

  async deletePairingRequests(ids: UUID[]): Promise<void> {
    return this.withDatabase(() => stores.deletePairingRequests(this.db, ids));
  }

  async createPairingAllowlistEntries(entries: PairingAllowlistEntry[]): Promise<UUID[]> {
    return this.withDatabase(() => stores.createPairingAllowlistEntries(this.db, entries));
  }

  async updatePairingAllowlistEntries(entries: PairingAllowlistEntry[]): Promise<void> {
    return this.withDatabase(() => stores.updatePairingAllowlistEntries(this.db, entries));
  }

  async deletePairingAllowlistEntries(ids: UUID[]): Promise<void> {
    return this.withDatabase(() => stores.deletePairingAllowlistEntries(this.db, ids));
  }

  // ===============================
  // Plugin Store Methods
  // ===============================

  async registerPluginSchema(schema: import("@elizaos/core").PluginSchema): Promise<void> {
    return this.withDatabase(() => stores.registerPluginSchema(this.db, schema));
  }

  getPluginStore(pluginName: string): import("@elizaos/core").IPluginStore | null {
    return new stores.SqlPluginStore(this.db, pluginName);
  }

  // ===============================
  // Transaction API
  // ===============================

  /**
   * Create a proxy adapter that uses the given db/transaction for all operations.
   * WHY shared helper: Both transaction() branches (with and without entityContext) must use
   * the same proxy shape so that nested proxy.transaction(innerCb) uses the same connection
   * (and thus the same app.entity_id when RLS is on). If we used a different code path for
   * the entityContext branch, nested transactions could lose RLS context.
   */
  private createProxyWithDb(dbOrTx: DrizzleDatabase): BaseDrizzleAdapter {
    const proxy = Object.create(this) as BaseDrizzleAdapter;
    proxy.db = dbOrTx as any;
    return proxy;
  }

  /**
   * Execute a callback within a database transaction using prototype proxy pattern.
   *
   * WHY prototype proxy: The tx parameter must route all adapter methods through
   * the Drizzle transaction context. Instead of manually wrapping all 100+ methods,
   * we create a proxy that inherits all methods and swaps only the db connection.
   *
   * WHY entityContext branch uses withIsolationContext (not this.db.transaction): When the
   * caller passes entityContext, we must run the callback on a connection that has
   * SET LOCAL app.entity_id applied. That connection is provided by withIsolationContext;
   * this.db.transaction would start a new transaction without that context and break RLS.
   *
   * NESTED TRANSACTIONS: Both branches use createProxyWithDb so nested proxy.transaction(innerCb)
   * uses the same connection (and same RLS context). Drizzle uses SAVEPOINTs for nesting.
   */
  async transaction<T>(
    callback: (tx: IDatabaseAdapter<DrizzleDatabase>) => Promise<T>,
    options?: { entityContext?: UUID },
  ): Promise<T> {
    if (options?.entityContext != null) {
      return this.withIsolationContext(options.entityContext, (tx) =>
        callback(this.createProxyWithDb(tx))
      );
    }
    return this.db.transaction(async (drizzleTx) => {
      return callback(this.createProxyWithDb(drizzleTx));
    });
  }
}
