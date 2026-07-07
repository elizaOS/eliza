/**
 * `BaseDrizzleAdapter` is the shared `IDatabaseAdapter` implementation that
 * `PgDatabaseAdapter` and `PgliteDatabaseAdapter` both extend: every runtime
 * persistence operation (agents, entities, rooms, memories, relationships,
 * tasks, logs, cache, connector accounts/OAuth flow state, pairing) is
 * implemented once here against Drizzle, backend-agnostically, with
 * `withDatabase`/`withEntityContext` retry and Row Level Security wiring
 * left to the concrete Postgres/PGlite subclasses.
 */
import {
  type AccessContext,
  type Agent,
  type AgentRunCounts,
  type AgentRunSummary,
  type AgentRunSummaryResult,
  type AppendConnectorAccountAuditEventParams,
  ChannelType,
  type Component,
  type ConnectorAccountAuditEventRecord,
  type ConnectorAccountCredentialRefRecord,
  type ConnectorAccountRecord,
  type ConnectorOwnerBindingLookup,
  type ConnectorOwnerBindingRecord,
  type ConsumeOAuthFlowStateParams,
  type CreateOAuthFlowStateParams,
  DatabaseAdapter,
  type DeleteConnectorAccountParams,
  ElizaError,
  type EntitiesForRoomsResult,
  type Entity,
  type GetConnectorAccountCredentialRefParams,
  type GetConnectorAccountParams,
  type IDatabaseAdapter,
  type JsonValue,
  type ListConnectorAccountCredentialRefsParams,
  type ListConnectorAccountsParams,
  type Log,
  type LogBody,
  logger,
  type Memory,
  type MemoryMetadata,
  type MessageSearchHit,
  type Metadata,
  type OAuthFlowRecord,
  type PairingAllowlistEntry,
  type PairingAllowlistsResult,
  type PairingChannel,
  type PairingRequest,
  type PairingRequestsResult,
  type Participant,
  type ParticipantsForRoomsResult,
  type ParticipantUpdateFields,
  type ParticipantUserState,
  type PatchOp,
  type Relationship,
  type Room,
  type RunStatus,
  type SetConnectorAccountCredentialRefParams,
  type Task,
  type TaskMetadata,
  type UpsertConnectorAccountParams,
  type UUID,
  type World,
} from "@elizaos/core";

function agentBioRowsFromDb(bio: unknown): string[] {
  if (bio == null) return [];
  if (Array.isArray(bio)) return bio.map((entry) => String(entry));
  if (typeof bio === "string") return bio.trim() === "" ? [] : [bio];
  return [];
}

interface GetOAuthFlowStateParams {
  state?: string;
  stateHash?: string;
  flowId?: string;
  agentId?: string;
  provider?: string;
  includeConsumed?: boolean;
  includeExpired?: boolean;
  now?: number | Date;
}

function applyPatchOp(target: Record<string, unknown>, op: PatchOp): void {
  if (!op.path) return;
  const parts = op.path.split(".");
  const last = parts.pop();
  if (last === undefined) return;

  let parent: Record<string, unknown> = target;
  for (const segment of parts) {
    const next = parent[segment];
    if (next === null || typeof next !== "object") {
      const created: Record<string, unknown> = {};
      parent[segment] = created;
      parent = created;
    } else {
      parent = next as Record<string, unknown>;
    }
  }

  switch (op.op) {
    case "set":
      parent[last] = op.value;
      break;
    case "remove":
      delete parent[last];
      break;
    case "push": {
      const existing = parent[last];
      if (Array.isArray(existing)) {
        existing.push(op.value);
      } else {
        parent[last] = [op.value];
      }
      break;
    }
    case "increment": {
      const existing = parent[last];
      const delta = typeof op.value === "number" ? op.value : 1;
      parent[last] = typeof existing === "number" ? existing + delta : delta;
      break;
    }
  }
}

interface UpdateOAuthFlowStateParams {
  state?: string;
  stateHash?: string;
  flowId?: string;
  agentId?: string;
  provider?: string;
  accountId?: string | null;
  redirectUri?: string | null;
  codeVerifierRef?: string | null;
  scopes?: string[];
  metadata?: Record<string, JsonValue>;
  expiresAt?: number | Date;
  consumedAt?: number | Date | null;
  consumedBy?: string | null;
}

interface DeleteOAuthFlowStateParams {
  state?: string;
  stateHash?: string;
  flowId?: string;
  agentId?: string;
  provider?: string;
}

function asRawMessage(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function asMetadata(value: unknown): Metadata | undefined {
  return (value ?? undefined) as Metadata | undefined;
}

function normalizeAgentBio(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  if (typeof value === "string" && value.trim()) return [value];
  return undefined;
}

/** Escape an ILIKE literal so user keywords match literally (no `%`/`_` wildcards). */
function escapeIlikeLiteral(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function isMessageSearchObjectsMissing(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const layer = current as {
      code?: unknown;
      message?: unknown;
      cause?: unknown;
    };
    const message = typeof layer.message === "string" ? layer.message : "";
    if (
      (layer.code === "42703" || layer.code === "42883" || /does not exist/i.test(message)) &&
      /message_search_document|eliza_search_fold|eliza_search_like_pattern/i.test(message)
    ) {
      return true;
    }
    current = layer.cause;
  }
  return false;
}

type CountMemoriesParams = {
  roomIds?: UUID[];
  unique?: boolean;
  tableName?: string;
  entityId?: UUID;
  agentId?: UUID;
  metadata?: Record<string, unknown>;
};

import {
  and,
  asc,
  cosineDistance,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lt,
  lte,
  or,
  type SQL,
  sql,
} from "drizzle-orm";

const v4 = () => crypto.randomUUID();

/**
 * Detects whether an error is a postgres `unique_violation` (SQLState 23505),
 * walking the Error.cause chain because drizzle-orm rewraps the underlying
 * node-postgres / pglite error and the SQLState code lives on `error.cause`,
 * not on the outer Error. Also matches the legacy human-readable patterns
 * for callers that fabricate generic Errors.
 */
function isDuplicateKeyError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const layer = current as {
      code?: unknown;
      message?: unknown;
      cause?: unknown;
    };
    if (layer.code === "23505") return true;
    if (typeof layer.message === "string" && /duplicate key|already exists/i.test(layer.message)) {
      return true;
    }
    current = layer.cause;
  }
  return false;
}

import type { DatabaseBackend, DatabaseMigrationService } from "./migration-service";
import { DIMENSION_MAP, type EmbeddingDimensionColumn } from "./schema/embedding";
import {
  agentTable,
  cacheTable,
  channelParticipantsTable,
  channelTable,
  componentTable,
  embeddingTable,
  entityTable,
  logTable,
  memoryTable,
  messageServerAgentsTable,
  messageServerTable,
  messageTable,
  pairingAllowlistTable,
  pairingRequestTable,
  participantTable,
  relationshipTable,
  roomTable,
  taskTable,
  worldTable,
} from "./schema/index";

type AgentRow = typeof agentTable.$inferSelect;
type AgentMessageExamples = NonNullable<Agent["messageExamples"]>;
type AgentKnowledge = NonNullable<Agent["knowledge"]>;

function normalizeAgentMessageExamples(messageExamples: unknown): AgentMessageExamples {
  if (!Array.isArray(messageExamples) || messageExamples.length === 0) {
    return [];
  }
  return messageExamples.flatMap((entry): AgentMessageExamples => {
    if (Array.isArray(entry)) {
      return [{ examples: entry }];
    }
    if (
      entry &&
      typeof entry === "object" &&
      Array.isArray((entry as { examples?: unknown }).examples)
    ) {
      return [entry as AgentMessageExamples[number]];
    }
    return [];
  });
}

function normalizeAgentKnowledge(knowledge: AgentRow["knowledge"]): AgentKnowledge {
  return knowledge.flatMap((item): AgentKnowledge => {
    if (typeof item === "string") {
      return [{ item: { case: "path", value: item } }];
    }
    if (item && typeof item === "object" && typeof item.path === "string") {
      return [{ item: { case: "path", value: item.path } }];
    }
    return [];
  });
}

function mapAgentRow(row: AgentRow): Agent {
  const agent: Agent = {
    ...row,
    username: row.username || "",
    id: row.id as UUID,
    system: !row.system ? undefined : row.system,
    bio: normalizeAgentBio(row.bio),
    messageExamples: normalizeAgentMessageExamples(row.messageExamples),
    knowledge: normalizeAgentKnowledge(row.knowledge),
    settings: row.settings as Agent["settings"],
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
  return agent;
}

import {
  ConnectorAccountStore,
  type ListConnectorAccountAuditEventsParams,
} from "./stores/connectorAccount.store";
import type { StoreContext } from "./stores/types";
import type { DrizzleDatabase } from "./types";

export abstract class BaseDrizzleAdapter extends DatabaseAdapter<DrizzleDatabase> {
  protected readonly maxRetries: number = 3;
  protected readonly baseDelay: number = 1000;
  protected readonly maxDelay: number = 10000;
  protected readonly jitterMax: number = 1000;
  protected embeddingDimension: EmbeddingDimensionColumn = DIMENSION_MAP[384];
  protected readonly databaseBackend: DatabaseBackend = "unknown";
  protected migrationService?: DatabaseMigrationService;
  private migrationRunPromise: Promise<void> | null = null;
  private _connectorAccountStore?: ConnectorAccountStore;
  private messageSearchTrigramAvailable: boolean | null = null;

  protected getConnectorAccountStore(): ConnectorAccountStore {
    if (!this._connectorAccountStore) {
      const ctx: StoreContext = {
        getDb: () => this.db as DrizzleDatabase,
        withRetry: <T>(operation: () => Promise<T>) => this.withDatabase(operation),
        withIsolationContext: <T>(
          entityId: UUID | null,
          callback: (tx: DrizzleDatabase) => Promise<T>
        ) => this.withEntityContext(entityId, callback),
        agentId: this.agentId,
        getEmbeddingDimension: () => this.embeddingDimension,
      };
      this._connectorAccountStore = new ConnectorAccountStore(ctx);
    }
    return this._connectorAccountStore;
  }

  protected abstract withDatabase<T>(operation: () => Promise<T>): Promise<T>;

  public abstract withEntityContext<T>(
    entityId: UUID | null,
    callback: (tx: DrizzleDatabase) => Promise<T>
  ): Promise<T>;

  public abstract init(): Promise<void>;
  public abstract close(): Promise<void>;

  public async initialize(): Promise<void> {
    await this.init();
  }

  public async runPluginMigrations(
    plugins: Array<{ name: string; schema?: Record<string, unknown> }>,
    options?: {
      verbose?: boolean;
      force?: boolean;
      dryRun?: boolean;
    }
  ): Promise<void> {
    if (!this.migrationService) {
      const { DatabaseMigrationService } = await import("./migration-service");
      this.migrationService = new DatabaseMigrationService({
        databaseBackend: this.databaseBackend,
      });
      await this.migrationService.initializeWithDatabase(this.db as DrizzleDatabase);
    }

    for (const plugin of plugins) {
      if (plugin.schema) {
        this.migrationService.registerSchema(plugin.name, plugin.schema);
      }
    }

    if (this.migrationRunPromise) {
      logger.info(
        { src: "plugin:sql", pluginCount: plugins.length },
        "Plugin migrations already running in this process; joining active run"
      );
      await this.migrationRunPromise;
      return;
    }

    this.migrationRunPromise = this.migrationService.runAllPluginMigrations(options);
    try {
      await this.migrationRunPromise;
    } finally {
      this.migrationRunPromise = null;
    }
  }

  public getDatabase(): unknown {
    return this.db;
  }

  protected agentId: UUID;

  constructor(agentId: UUID) {
    super();
    this.agentId = agentId;
  }

  private normalizeEntityNames(names: unknown): string[] {
    if (names == null) {
      return [];
    }

    if (typeof names === "string") {
      return [names];
    }

    if (Array.isArray(names)) {
      return names.map(String);
    }

    if (names instanceof Set) {
      return Array.from(names).map(String);
    }

    if (typeof names === "object") {
      const iterableNames = names as { [Symbol.iterator]?: () => Iterator<unknown> };
      if (typeof iterableNames[Symbol.iterator] === "function") {
        return Array.from(names as Iterable<unknown>).map(String);
      }
    }

    return [String(names)];
  }

  private isValidUUID(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
  }

  private normalizeWorldData(
    world: Partial<World> & { serverId?: UUID | null }
  ): typeof worldTable.$inferInsert {
    const worldData: typeof worldTable.$inferInsert = {
      agentId: this.agentId,
      id: (world.id || v4()) as UUID,
      name: world.name || "",
      metadata: world.metadata || {},
    };

    const serverId = world.serverId ?? world.messageServerId;
    if (typeof serverId === "string" && this.isValidUUID(serverId)) {
      worldData.messageServerId = serverId;
    } else if (serverId) {
      logger.warn(
        { src: "plugin:sql", agentId: this.agentId, serverId },
        "Ignoring non-UUID message/server identifier for world"
      );
    }

    return worldData;
  }

  private mapWorldResult(world: unknown): World {
    const mappedWorld = world as Record<string, unknown>;
    const messageServerId = mappedWorld.messageServerId || mappedWorld.serverId;
    return {
      ...mappedWorld,
      ...(typeof messageServerId === "string"
        ? {
            messageServerId: messageServerId as UUID,
            serverId: messageServerId as UUID,
          }
        : {}),
    } as World;
  }

  /**
   * Executes the given operation with retry logic.
   * @template T
   * @param {() => Promise<T>} operation - The operation to be executed.
   * @returns {Promise<T>} A promise that resolves with the result of the operation.
   */
  protected async withRetry<T>(operation: () => Promise<T>): Promise<T> {
    let lastError: Error = new Error("Unknown error");

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      // error-policy:J2 context-adding rethrow — retries transient DB errors,
      // then rethrows the last error once attempts are exhausted (never swallows).
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
              src: "plugin:sql",
              attempt,
              maxRetries: this.maxRetries,
              error: error instanceof Error ? error.message : String(error),
            },
            "Database operation failed, retrying"
          );

          await new Promise((resolve) => setTimeout(resolve, delay));
        } else {
          logger.error(
            {
              src: "plugin:sql",
              totalAttempts: attempt,
              error: error instanceof Error ? error.message : String(error),
            },
            "Max retry attempts reached"
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
      const resolvedDimension = DIMENSION_MAP[dimension as keyof typeof DIMENSION_MAP];
      if (!resolvedDimension) {
        logger.warn(
          {
            src: "plugin:sql",
            agentId: this.agentId,
            requestedDimension: dimension,
            fallbackDimension: this.embeddingDimension,
          },
          "Unsupported embedding dimension requested; keeping current embedding column"
        );
        return;
      }

      this.embeddingDimension = resolvedDimension;
    });
  }

  /**
   * Delete every embedding row whose vector lives in a dimension column other
   * than the currently-active one, returning the ids of the memories left
   * without a vector so the caller can re-embed them at the active width.
   *
   * Each row populates exactly one `dimNNN` column (the others stay null), so
   * "not in the active dimension" is simply "active column IS NULL". This is the
   * store side of switching embedders — e.g. an agent moving off cloud 1536-dim
   * embeddings onto on-device gte-small (384-dim): the stale 1536 vectors would
   * otherwise sit unreadable by a 384-dim search forever. A no-op (returns `[]`)
   * once the store holds only active-dimension vectors, so it is safe to call on
   * every boot.
   */
  async clearEmbeddingsOutsideActiveDimension(): Promise<UUID[]> {
    return this.withDatabase(async () => {
      const agentMemoryIds = this.db
        .select({ id: memoryTable.id })
        .from(memoryTable)
        .where(eq(memoryTable.agentId, this.agentId));
      const cleared = await this.db
        .delete(embeddingTable)
        .where(
          and(
            isNull(embeddingTable[this.embeddingDimension]),
            inArray(embeddingTable.memoryId, agentMemoryIds)
          )
        )
        .returning();
      return cleared.map((row) => row.memoryId).filter((id): id is UUID => id !== null);
    });
  }

  /**
   * Asynchronously retrieves an agent by their ID from the database.
   * @param {UUID} agentId - The ID of the agent to retrieve.
   * @returns {Promise<Agent | null>} A promise that resolves to the retrieved agent or null if not found.
   */
  async getAgent(agentId: UUID): Promise<Agent | null> {
    return this.withDatabase(async () => {
      const rows = await this.db
        .select()
        .from(agentTable)
        .where(eq(agentTable.id, agentId))
        .limit(1);

      if (rows.length === 0) return null;

      return mapAgentRow(rows[0]);
    });
  }

  /**
   * Asynchronously retrieves a list of agents from the database.
   *
   * @returns {Promise<Partial<Agent>[]>} A Promise that resolves to an array of Agent objects.
   */
  async getAgents(): Promise<Partial<Agent>[]> {
    const result = await this.withDatabase(async () => {
      const rows = await this.db
        .select({
          id: agentTable.id,
          name: agentTable.name,
          bio: agentTable.bio,
        })
        .from(agentTable);
      return rows.map(
        (row) =>
          ({
            ...row,
            id: row.id as UUID,
            bio: agentBioRowsFromDb(row.bio),
          }) as Partial<Agent>
      );
    });
    // Guard against null return
    return result || [];
  }

  async getAgentsByIds(agentIds: UUID[]): Promise<Agent[]> {
    if (agentIds.length === 0) return [];
    return this.withDatabase(async () => {
      const rows = await this.db.select().from(agentTable).where(inArray(agentTable.id, agentIds));
      return rows.map((row) => mapAgentRow(row));
    });
  }

  async createAgents(agents: Partial<Agent>[]): Promise<UUID[]> {
    if (agents.length === 0) return [];
    return this.withDatabase(async () => {
      const ids: UUID[] = [];
      for (const agent of agents) {
        if (agent.id) {
          const success = await this.createAgent(agent as Agent);
          if (success) ids.push(agent.id);
        }
      }
      return ids;
    });
  }

  async updateAgents(updates: Array<{ agentId: UUID; agent: Partial<Agent> }>): Promise<boolean> {
    for (const { agentId, agent } of updates) {
      const success = await this.updateAgent(agentId, agent);
      if (!success) return false;
    }
    return true;
  }

  async upsertAgents(agents: Partial<Agent>[]): Promise<void> {
    for (const agent of agents) {
      if (!agent.id) continue;
      const existing = await this.getAgent(agent.id);
      if (existing) {
        await this.updateAgent(agent.id, agent);
      } else {
        await this.createAgent(agent as Agent);
      }
    }
  }

  async deleteAgents(agentIds: UUID[]): Promise<boolean> {
    if (agentIds.length === 0) return true;
    return this.withDatabase(async () => {
      // error-policy:J2 context-adding rethrow — a failed delete must not read
      // as "nothing matched" (both would return false); surface it as a typed error.
      try {
        await this.db.delete(agentTable).where(inArray(agentTable.id, agentIds));
        return true;
      } catch (error) {
        throw new ElizaError("deleteAgents failed", {
          code: "DB_DELETE_FAILED",
          cause: error,
          context: { table: "agents", agentIds },
        });
      }
    });
  }

  /**
   * Asynchronously creates a new agent record in the database.
   *
   * @param {Partial<Agent>} agent The agent object to be created.
   * @returns {Promise<boolean>} A promise that resolves to a boolean indicating the success of the operation.
   */
  async createAgent(agent: Agent): Promise<boolean> {
    return this.withDatabase(async () => {
      try {
        // Check for existing agent with the same ID only (names can be duplicated)
        if (agent.id) {
          const existing = await this.db
            .select({ id: agentTable.id })
            .from(agentTable)
            .where(eq(agentTable.id, agent.id))
            .limit(1);

          if (existing.length > 0) {
            logger.warn(
              { src: "plugin:sql", agentId: agent.id },
              "Attempted to create agent with duplicate ID"
            );
            return false;
          }
        }

        await this.db.transaction(async (tx) => {
          const agentData = {
            ...agent,
            createdAt: new Date(
              typeof agent.createdAt === "bigint"
                ? Number(agent.createdAt)
                : agent.createdAt || Date.now()
            ),
            updatedAt: new Date(
              typeof agent.updatedAt === "bigint"
                ? Number(agent.updatedAt)
                : agent.updatedAt || Date.now()
            ),
          };
          const sanitizedAgentData = Object.fromEntries(
            Object.entries(agentData).filter(([, value]) => value !== undefined)
          ) as typeof agentTable.$inferInsert;

          await tx.insert(agentTable).values(sanitizedAgentData);
        });

        return true;
      } catch (error) {
        // error-policy:J3 untrusted-input sanitizing — a duplicate id is the
        // typed "already exists" outcome (false), distinct from a write failure.
        if (isDuplicateKeyError(error)) {
          logger.warn(
            { src: "plugin:sql", agentId: agent.id },
            "Attempted to create agent with duplicate ID"
          );
          return false;
        }
        // error-policy:J2 context-adding rethrow — any other error is a real
        // write failure; surface it with context.
        throw new ElizaError("createAgent failed", {
          code: "DB_INSERT_FAILED",
          cause: error,
          context: { table: "agents", agentId: agent.id },
        });
      }
    });
  }

  /**
   * Updates an agent in the database with the provided agent ID and data.
   * @param {UUID} agentId - The unique identifier of the agent to update.
   * @param {Partial<Agent>} agent - The partial agent object containing the fields to update.
   * @returns {Promise<boolean>} - A boolean indicating if the agent was successfully updated.
   */
  async updateAgent(agentId: UUID, agent: Partial<Agent>): Promise<boolean> {
    return this.withDatabase(async () => {
      try {
        if (!agentId) {
          throw new Error("Agent ID is required for update");
        }

        await this.db.transaction(async (tx) => {
          // Handle settings update if present
          if (agent.settings) {
            agent.settings = await this.mergeAgentSettings(tx, agentId, agent.settings);
          }

          // Convert numeric timestamps to Date objects for database storage
          // The Agent interface uses numbers, but the database schema expects Date objects
          const updateData: Record<string, unknown> = { ...agent };

          if (updateData.createdAt) {
            if (typeof updateData.createdAt === "number") {
              updateData.createdAt = new Date(updateData.createdAt);
            } else {
              delete updateData.createdAt; // Don't update createdAt if it's not a valid timestamp
            }
          }
          if (updateData.updatedAt) {
            if (typeof updateData.updatedAt === "number") {
              updateData.updatedAt = new Date(updateData.updatedAt);
            } else {
              updateData.updatedAt = new Date(); // Use current time if invalid
            }
          } else {
            updateData.updatedAt = new Date(); // Always set updatedAt to current time
          }

          await tx.update(agentTable).set(updateData).where(eq(agentTable.id, agentId));
        });

        return true;
      } catch (error) {
        // error-policy:J2 context-adding rethrow — a failed update must not be
        // indistinguishable from a legitimate no-op; surface the failure.
        throw new ElizaError("updateAgent failed", {
          code: "DB_UPDATE_FAILED",
          cause: error,
          context: { table: "agents", agentId },
        });
      }
    });
  }

  /**
   * Merges updated agent settings with existing settings in the database,
   * with special handling for nested objects like secrets.
   * @param tx - The database transaction
   * @param agentId - The ID of the agent
   * @param updatedSettings - The settings object with updates
   * @returns The merged settings object
   * @private
   */
  private async mergeAgentSettings<T extends Record<string, unknown>>(
    tx: DrizzleDatabase,
    agentId: UUID,
    updatedSettings: T
  ): Promise<T> {
    // First get the current agent data
    const currentAgent = await tx
      .select({ settings: agentTable.settings })
      .from(agentTable)
      .where(eq(agentTable.id, agentId))
      .limit(1);

    const currentSettings =
      currentAgent.length > 0 && currentAgent[0].settings ? currentAgent[0].settings : {};

    const deepMerge = (
      target: Record<string, unknown> | unknown,
      source: Record<string, unknown>
    ): Record<string, unknown> | undefined => {
      // If source is explicitly null, it means the intention is to set this entire branch to null (or delete if top-level handled by caller).
      // For recursive calls, if a sub-object in source is null, it effectively means "remove this sub-object from target".
      // However, our primary deletion signal is a *property value* being null within an object.
      if (source === null) {
        // If the entire source for a given key is null, we treat it as "delete this key from target"
        // by returning undefined, which the caller can use to delete the key.
        return undefined;
      }

      // If source is an array or a primitive, it replaces the target value.
      if (Array.isArray(source) || typeof source !== "object") {
        return source;
      }

      // Initialize output. If target is not an object, start with an empty one to merge source into.
      const output: Record<string, unknown> =
        typeof target === "object" && target !== null && !Array.isArray(target)
          ? { ...(target as Record<string, unknown>) }
          : {};

      for (const key of Object.keys(source)) {
        // Iterate over source keys
        const sourceValue = source[key];

        if (sourceValue === null) {
          // If a value in source is null, delete the corresponding key from output.
          delete output[key];
        } else if (typeof sourceValue === "object" && !Array.isArray(sourceValue)) {
          // If value is an object, recurse.
          const nestedMergeResult = deepMerge(output[key], sourceValue as Record<string, unknown>);
          if (nestedMergeResult === undefined) {
            // If recursive merge resulted in undefined (meaning the nested object should be deleted)
            delete output[key];
          } else {
            output[key] = nestedMergeResult;
          }
        } else {
          // Primitive or array value from source, assign it.
          output[key] = sourceValue;
        }
      }

      // After processing all keys from source, check if output became empty.
      // An object is empty if all its keys were deleted or resulted in undefined.
      // This is a more direct check than iterating 'output' after building it.
      if (Object.keys(output).length === 0) {
        // If the source itself was not an explicitly empty object,
        // and the merge resulted in an empty object, signal deletion.
        if (!(typeof source === "object" && source !== null && Object.keys(source).length === 0)) {
          return undefined; // Signal to delete this (parent) key if it became empty.
        }
      }

      return output;
    }; // End of deepMerge

    const finalSettings = deepMerge(currentSettings, updatedSettings);
    // If the entire settings object becomes undefined (e.g. all keys removed),
    // return an empty object instead of undefined/null to keep the settings field present.
    return (finalSettings ?? {}) as T;
  }

  /**
   * Asynchronously deletes an agent with the specified UUID and all related entries.
   *
   * @param {UUID} agentId - The UUID of the agent to be deleted.
   * @returns {Promise<boolean>} - A boolean indicating if the deletion was successful.
   */
  async deleteAgent(agentId: UUID): Promise<boolean> {
    return this.withDatabase(async () => {
      try {
        // Simply delete the agent - all related data will be cascade deleted
        const result = await this.db
          .delete(agentTable)
          .where(eq(agentTable.id, agentId))
          .returning();

        // false is the typed "no agent matched" outcome, distinct from failure.
        if (result.length === 0) {
          logger.warn({ src: "plugin:sql", agentId }, "Agent not found for deletion");
          return false;
        }

        return true;
      } catch (error) {
        // error-policy:J2 context-adding rethrow — surface a real delete failure
        // with context (the not-found case already returned false above).
        throw new ElizaError("deleteAgent failed", {
          code: "DB_DELETE_FAILED",
          cause: error,
          context: { table: "agents", agentId },
        });
      }
    });
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
    return this.withDatabase(async () => {
      // "DB broken" must never read as "0 agents": both a query failure and a
      // missing count row surface as a typed DB_COUNT_FAILED. The aggregate
      // always returns exactly one row, so a missing count is a broken pipeline.
      let total: number | undefined;
      try {
        const result = await this.db.select({ count: count() }).from(agentTable);
        total = result[0]?.count;
      } catch (error) {
        // error-policy:J2 context-adding rethrow — surface a query failure as a
        // typed count error rather than letting a bare driver error escape.
        throw new ElizaError("countAgents query failed", {
          code: "DB_COUNT_FAILED",
          cause: error,
          context: { table: "agents" },
        });
      }
      if (typeof total !== "number") {
        throw new ElizaError("countAgents returned no count row", {
          code: "DB_COUNT_FAILED",
          context: { table: "agents" },
        });
      }
      return total;
    });
  }

  /**
   * Clean up the agents table by removing all agents
   * This is used during server startup to ensure no orphaned agents exist
   * from previous crashes or improper shutdowns
   */
  async cleanupAgents(): Promise<void> {
    // No catch: a delete failure propagates via withDatabase's retry layer; the
    // previous log-then-rethrow added no context the retry layer doesn't log.
    return this.withDatabase(async () => {
      await this.db.delete(agentTable);
    });
  }

  /**
   * Asynchronously retrieves an entity and its components by entity IDs.
   * @param {UUID[]} entityIds - The unique identifiers of the entities to retrieve.
   * @returns {Promise<Entity[]>} A Promise that resolves to the entity with its components.
   */
  async getEntitiesByIds(entityIds: UUID[]): Promise<Entity[]> {
    return this.withDatabase(async () => {
      const result = await this.db
        .select({
          entity: entityTable,
          components: componentTable,
        })
        .from(entityTable)
        .leftJoin(componentTable, eq(componentTable.entityId, entityTable.id))
        .where(inArray(entityTable.id, entityIds));

      if (result.length === 0) return [];

      // Group components by entity
      const entities: Record<UUID, Entity> = {};
      const entityComponents: Record<UUID, Entity["components"]> = {};
      for (const e of result) {
        const key = e.entity.id;
        entities[key] = e.entity;
        if (entityComponents[key] === undefined) entityComponents[key] = [];
        if (e.components) {
          // Handle both single component and array of components
          const componentsArray = Array.isArray(e.components) ? e.components : [e.components];
          entityComponents[key] = [...entityComponents[key], ...componentsArray];
        }
      }
      for (const k of Object.keys(entityComponents)) {
        entities[k].components = entityComponents[k];
      }

      return Object.values(entities);
    });
  }

  /**
   * Asynchronously retrieves all entities for a given room, optionally including their components.
   * @param {UUID} roomId - The unique identifier of the room to get entities for
   * @param {boolean} [includeComponents] - Whether to include component data for each entity
   * @returns {Promise<Entity[]>} A Promise that resolves to an array of entities in the room
   */
  async getEntitiesForRoom(roomId: UUID, includeComponents?: boolean): Promise<Entity[]> {
    return this.withDatabase(async () => {
      const query = this.db
        .select({
          entity: entityTable,
          ...(includeComponents && { components: componentTable }),
        })
        .from(participantTable)
        .leftJoin(
          entityTable,
          and(eq(participantTable.entityId, entityTable.id), eq(entityTable.agentId, this.agentId))
        );

      if (includeComponents) {
        query.leftJoin(componentTable, eq(componentTable.entityId, entityTable.id));
      }

      const result = await query.where(eq(participantTable.roomId, roomId));

      // Group components by entity if includeComponents is true
      const entitiesByIdMap = new Map<UUID, Entity>();

      for (const row of result) {
        if (!row.entity) continue;

        const entityId = row.entity.id as UUID;
        if (!entitiesByIdMap.has(entityId)) {
          const entity: Entity = {
            ...row.entity,
            id: entityId,
            agentId: row.entity.agentId as UUID,
            metadata: (row.entity.metadata || {}) as Metadata,
            components: includeComponents ? [] : undefined,
          };
          entitiesByIdMap.set(entityId, entity);
        }

        if (includeComponents && row.components) {
          const entity = entitiesByIdMap.get(entityId);
          if (entity) {
            if (!entity.components) {
              entity.components = [];
            }
            entity.components.push(row.components);
          }
        }
      }

      return Array.from(entitiesByIdMap.values());
    });
  }

  /**
   * Asynchronously creates new entities in the database.
   * @param {Entity[]} entities - The entity objects to be created.
   * @returns {Promise<UUID[]>} The IDs of the created entities.
   */
  async createEntities(entities: Entity[]): Promise<UUID[]> {
    return this.withDatabase(async () => {
      // Pre-assign IDs so duplicates (by id) can be reported as
      // already-created → success (idempotent create; see ON CONFLICT below).
      const normalizedEntities = entities.map((entity) => {
        const { names, metadata, ...normalizedEntity } = entity as Entity & {
          names?: unknown;
          metadata?: Metadata;
        };
        const id = (entity.id || v4()) as UUID;
        return {
          ...normalizedEntity,
          id,
          agentId: this.agentId,
          names: this.normalizeEntityNames(names),
          metadata: metadata || {},
        };
      });

      try {
        // ON CONFLICT DO NOTHING keeps the create idempotent per row: rows
        // whose id already exists are skipped (never clobbered — that's
        // upsertEntities' job) while the rest of the batch still lands. The
        // previous catch-on-duplicate approach rolled back the whole batch and
        // then claimed success for entities that were never written. Both of
        // entityTable's unique constraints (PK id, unique(id, agentId)) are
        // id-based, so any conflict here is a duplicate id.
        const inserted = await this.db
          .insert(entityTable)
          .values(normalizedEntities)
          .onConflictDoNothing()
          .returning();
        if (inserted.length < normalizedEntities.length) {
          logger.warn(
            {
              src: "plugin:sql",
              requested: normalizedEntities.length,
              inserted: inserted.length,
            },
            "Some entities already existed; treating them as created"
          );
        }
        return normalizedEntities.map((entity) => entity.id as UUID);
      } catch (error) {
        // error-policy:J2 context-adding rethrow — a failed batch insert must
        // not read as "created zero entities" (an empty return is a valid
        // success for an empty input); surface the write failure.
        throw new ElizaError("createEntities failed", {
          code: "DB_INSERT_FAILED",
          cause: error,
          context: { table: "entities", count: normalizedEntities.length },
        });
      }
    });
  }

  /**
   * Asynchronously ensures an entity exists, creating it if it doesn't
   * @param entity The entity to ensure exists
   * @returns Promise resolving to boolean indicating success
   */
  protected async ensureEntityExists(entity: Entity): Promise<boolean> {
    if (!entity.id) {
      throw new ElizaError("Entity ID is required for ensureEntityExists", {
        code: "DB_INVALID_ARGUMENT",
        context: { table: "entities" },
      });
    }

    // No catch: a lookup/insert failure propagates so callers see a broken
    // pipeline instead of a fabricated "could not ensure" (false).
    const existingEntities = await this.getEntitiesByIds([entity.id]);
    if (!existingEntities.length) {
      return (await this.createEntities([entity])).length > 0;
    }
    return true;
  }

  /**
   * Asynchronously updates an entity in the database.
   * @param {Entity} entity - The entity object to be updated.
   * @returns {Promise<void>} A Promise that resolves when the entity is updated.
   */
  async updateEntity(entity: Entity): Promise<void> {
    if (!entity.id) {
      throw new Error("Entity ID is required for update");
    }
    return this.withDatabase(async () => {
      // Normalize entity data to ensure names is a proper array
      const normalizedEntity = {
        ...entity,
        agentId: this.agentId,
        names: this.normalizeEntityNames(entity.names),
        metadata: entity.metadata || {},
      };

      await this.db
        .update(entityTable)
        .set(normalizedEntity)
        .where(eq(entityTable.id, entity.id as string));
    });
  }

  /**
   * Asynchronously deletes an entity from the database based on the provided ID.
   * @param {UUID} entityId - The ID of the entity to delete.
   * @returns {Promise<void>} A Promise that resolves when the entity is deleted.
   */
  async deleteEntity(entityId: UUID): Promise<void> {
    return this.withDatabase(async () => {
      await this.db.transaction(async (tx) => {
        // Delete related components first
        await tx
          .delete(componentTable)
          .where(
            or(eq(componentTable.entityId, entityId), eq(componentTable.sourceEntityId, entityId))
          );

        // Delete the entity
        await tx.delete(entityTable).where(eq(entityTable.id, entityId));
      });
    });
  }

  /**
   * Asynchronously retrieves entities by their names and agentId.
   * @param {Object} params - The parameters for retrieving entities.
   * @param {string[]} params.names - The names to search for.
   * @param {UUID} params.agentId - The agent ID to filter by.
   * @returns {Promise<Entity[]>} A Promise that resolves to an array of entities.
   */
  async getEntitiesByNames(params: { names: string[]; agentId: UUID }): Promise<Entity[]> {
    return this.withDatabase(async () => {
      const { names, agentId } = params;

      // Build a condition to match any of the names
      const nameConditions = names.map((name) => sql`${name} = ANY(${entityTable.names})`);

      const query = sql`
        SELECT * FROM ${entityTable}
        WHERE ${entityTable.agentId} = ${agentId}
        AND (${sql.join(nameConditions, sql` OR `)})
      `;

      const result = await this.db.execute(query);

      return result.rows.map((row: Record<string, unknown>) => ({
        id: row.id as UUID,
        agentId: row.agentId as UUID,
        names: (row.names || []) as string[],
        metadata: (row.metadata || {}) as Metadata,
      }));
    });
  }

  /**
   * Asynchronously searches for entities by name with fuzzy matching.
   * @param {Object} params - The parameters for searching entities.
   * @param {string} params.query - The search query.
   * @param {UUID} params.agentId - The agent ID to filter by.
   * @param {number} params.limit - The maximum number of results to return.
   * @returns {Promise<Entity[]>} A Promise that resolves to an array of entities.
   */
  async searchEntitiesByName(params: {
    query: string;
    agentId: UUID;
    limit?: number;
  }): Promise<Entity[]> {
    return this.withDatabase(async () => {
      const { query, agentId, limit = 10 } = params;

      // If query is empty, return all entities up to limit
      if (!query || query.trim() === "") {
        const result = await this.db
          .select()
          .from(entityTable)
          .where(eq(entityTable.agentId, agentId))
          .limit(limit);

        return result.map((row: Record<string, unknown>) => ({
          id: row.id as UUID,
          agentId: row.agentId as UUID,
          names: (row.names || []) as string[],
          metadata: (row.metadata || {}) as Metadata,
        }));
      }

      // Otherwise, search for entities with names containing the query (case-insensitive)
      const searchQuery = sql`
        SELECT * FROM ${entityTable}
        WHERE ${entityTable.agentId} = ${agentId}
        AND EXISTS (
          SELECT 1 FROM unnest(${entityTable.names}) AS name
          WHERE LOWER(name) LIKE LOWER(${`%${query}%`})
        )
        LIMIT ${limit}
      `;

      const result = await this.db.execute(searchQuery);

      return result.rows.map((row: Record<string, unknown>) => ({
        id: row.id as UUID,
        agentId: row.agentId as UUID,
        names: (row.names || []) as string[],
        metadata: (row.metadata || {}) as Metadata,
      }));
    });
  }

  async getComponent(
    entityId: UUID,
    type: string,
    worldId?: UUID,
    sourceEntityId?: UUID
  ): Promise<Component | null> {
    return this.withDatabase(async () => {
      const conditions = [eq(componentTable.entityId, entityId), eq(componentTable.type, type)];

      if (worldId) {
        conditions.push(eq(componentTable.worldId, worldId));
      }

      if (sourceEntityId) {
        conditions.push(eq(componentTable.sourceEntityId, sourceEntityId));
      }

      const result = await this.db
        .select()
        .from(componentTable)
        .where(and(...conditions));

      if (result.length === 0) return null;

      const component = result[0];

      return {
        ...component,
        id: component.id as UUID,
        entityId: component.entityId as UUID,
        agentId: component.agentId as UUID,
        roomId: component.roomId as UUID,
        worldId: (component.worldId ?? "") as UUID,
        sourceEntityId: (component.sourceEntityId ?? "") as UUID,
        data: component.data as Metadata,
        createdAt: component.createdAt.getTime(),
      };
    });
  }

  /**
   * Asynchronously retrieves all components for a given entity, optionally filtered by world and source entity.
   * @param {UUID} entityId - The unique identifier of the entity to retrieve components for
   * @param {UUID} [worldId] - Optional world ID to filter components by
   * @param {UUID} [sourceEntityId] - Optional source entity ID to filter components by
   * @returns {Promise<Component[]>} A Promise that resolves to an array of components
   */
  async getComponents(entityId: UUID, worldId?: UUID, sourceEntityId?: UUID): Promise<Component[]> {
    return this.withDatabase(async () => {
      const conditions = [eq(componentTable.entityId, entityId)];

      if (worldId) {
        conditions.push(eq(componentTable.worldId, worldId));
      }

      if (sourceEntityId) {
        conditions.push(eq(componentTable.sourceEntityId, sourceEntityId));
      }

      const result = await this.db
        .select({
          id: componentTable.id,
          entityId: componentTable.entityId,
          type: componentTable.type,
          data: componentTable.data,
          worldId: componentTable.worldId,
          agentId: componentTable.agentId,
          roomId: componentTable.roomId,
          sourceEntityId: componentTable.sourceEntityId,
          createdAt: componentTable.createdAt,
        })
        .from(componentTable)
        .where(and(...conditions));

      if (result.length === 0) return [];

      const components = result.map((component) => ({
        ...component,
        id: component.id as UUID,
        entityId: component.entityId as UUID,
        agentId: component.agentId as UUID,
        roomId: component.roomId as UUID,
        worldId: (component.worldId ?? "") as UUID,
        sourceEntityId: (component.sourceEntityId ?? "") as UUID,
        data: component.data as Metadata,
        createdAt: component.createdAt.getTime(),
      }));

      return components;
    });
  }

  /**
   * Asynchronously creates a new component in the database.
   * @param {Component} component - The component object to be created.
   * @returns {Promise<boolean>} A Promise that resolves to a boolean indicating the success of the operation.
   */
  async createComponent(component: Component): Promise<boolean> {
    return this.withDatabase(async () => {
      await this.db.insert(componentTable).values({
        ...component,
        createdAt: new Date(),
      });
      return true;
    });
  }

  /**
   * Asynchronously updates an existing component in the database.
   * @param {Component} component - The component object to be updated.
   * @returns {Promise<void>} A Promise that resolves when the component is updated.
   */
  async updateComponent(component: Component): Promise<void> {
    return this.withDatabase(async () => {
      try {
        // Convert createdAt from number to Date for database compatibility
        const { createdAt, ...rest } = component;
        await this.db
          .update(componentTable)
          .set({
            ...rest,
            createdAt: new Date(createdAt),
          })
          .where(eq(componentTable.id, component.id));
      } catch (error) {
        // error-policy:J2 context-adding rethrow — a swallowed update left the
        // component silently stale; surface the write failure instead.
        throw new ElizaError("updateComponent failed", {
          code: "DB_UPDATE_FAILED",
          cause: error,
          context: { table: "components", componentId: component.id },
        });
      }
    });
  }

  /**
   * Asynchronously deletes a component from the database.
   * @param {UUID} componentId - The unique identifier of the component to delete.
   * @returns {Promise<void>} A Promise that resolves when the component is deleted.
   */
  async deleteComponent(componentId: UUID): Promise<void> {
    return this.withDatabase(async () => {
      await this.db.delete(componentTable).where(eq(componentTable.id, componentId));
    });
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
    limit?: number;
    count?: number;
    offset?: number;
    unique?: boolean;
    tableName: string;
    start?: number;
    end?: number;
    roomId?: UUID;
    worldId?: UUID;
    textContains?: string;
    orderBy?: "createdAt";
    orderDirection?: "asc" | "desc";
    /**
     * When `false`, skip fetching/materializing the embedding vector. List and
     * browse callers discard embeddings, so fetching the 384-float column for
     * every row (via the embeddingTable join) is pure waste. Defaults to `true`
     * (embeddings included) to preserve existing behavior.
     */
    includeEmbedding?: boolean;
    accessContext?: AccessContext;
  }): Promise<Memory[]> {
    const { entityId, agentId, roomId, worldId, unique, start, end, offset } = params;
    const includeEmbedding = params.includeEmbedding !== false;
    const tableName = params.tableName;
    // tableName is required by the IDatabaseAdapter contract (there is no
    // default table for reads). Untyped callers that omit it must get a loud
    // error, not a silent empty result from `type = undefined`.
    if (!tableName) {
      throw new Error("getMemories requires tableName");
    }
    const textContains = params.textContains?.trim();
    // Honor either `limit` (canonical) or `count` (legacy) so callers that pass
    // only `limit` still get a LIMIT clause applied (see IDatabaseAdapter.getMemories).
    const effectiveLimit = params.limit ?? params.count;
    // Default newest-first; `orderDirection: "asc"` powers around-message paging
    // (load the messages immediately *after* an anchor, not the newest tail).
    const order =
      params.orderDirection === "asc"
        ? [asc(memoryTable.createdAt), asc(memoryTable.id)]
        : [desc(memoryTable.createdAt), desc(memoryTable.id)];

    if (offset !== undefined && offset < 0) {
      throw new Error("offset must be a non-negative number");
    }

    return this.withEntityContext(entityId ?? null, async (tx) => {
      const conditions = [eq(memoryTable.type, tableName)];

      if (start !== undefined) {
        conditions.push(gte(memoryTable.createdAt, new Date(start)));
      }

      // RLS handles access control - no explicit entityId filter needed

      if (roomId) {
        conditions.push(eq(memoryTable.roomId, roomId));
      }

      // Add worldId condition
      if (worldId) {
        conditions.push(eq(memoryTable.worldId, worldId));
      }

      if (end !== undefined) {
        conditions.push(lte(memoryTable.createdAt, new Date(end)));
      }

      if (unique) {
        conditions.push(eq(memoryTable.unique, true));
      }

      if (agentId) {
        conditions.push(eq(memoryTable.agentId, agentId));
      }

      if (textContains) {
        // Push the keyword filter into the store as a case-insensitive ILIKE;
        // user input is escaped so `%`/`_` match literally, not as wildcards.
        // This is a sequential filter over `content->>'text'`, not index-backed.
        // TODO(#9955): pg_trgm GIN index on content->>'text' for sub-linear
        // keyword search at scale.
        conditions.push(
          sql`(${memoryTable.content}->>'text') ILIKE ${`%${escapeIlikeLiteral(textContains)}%`} ESCAPE '\\'`
        );
      }

      const memorySelect = {
        id: memoryTable.id,
        type: memoryTable.type,
        createdAt: memoryTable.createdAt,
        content: memoryTable.content,
        entityId: memoryTable.entityId,
        agentId: memoryTable.agentId,
        roomId: memoryTable.roomId,
        worldId: memoryTable.worldId,
        unique: memoryTable.unique,
        metadata: memoryTable.metadata,
      };
      type SelectedMemory = {
        id: string;
        type: string;
        createdAt: Date;
        content: unknown;
        entityId: string | null;
        agentId: string;
        roomId: string | null;
        worldId: string | null;
        unique: boolean;
        metadata: unknown;
      };
      const mapRow = (m: SelectedMemory, embedding: ArrayLike<number> | null | undefined) => ({
        id: m.id as UUID,
        type: m.type,
        createdAt: m.createdAt.getTime(),
        content: typeof m.content === "string" ? JSON.parse(m.content) : m.content,
        entityId: m.entityId as UUID,
        agentId: m.agentId as UUID,
        roomId: m.roomId as UUID,
        // Include worldId (matching searchMemoriesByEmbedding): dropping it here
        // stripped the world association from every read — e.g. agent-export
        // round-trips silently lost memory→world links on restore.
        worldId: (m.worldId ?? undefined) as UUID | undefined,
        unique: m.unique,
        metadata: m.metadata as MemoryMetadata,
        embedding: embedding ? Array.from(embedding) : undefined,
      });

      if (includeEmbedding) {
        const baseQuery = tx
          .select({
            memory: memorySelect,
            embedding: embeddingTable[this.embeddingDimension],
          })
          .from(memoryTable)
          .leftJoin(embeddingTable, eq(embeddingTable.memoryId, memoryTable.id))
          .where(and(...conditions))
          .orderBy(...order);
        const rows = await (async () => {
          // Honor `effectiveLimit` (params.limit ?? params.count), matching the
          // no-embedding branch below. Gating the LIMIT on `params.count` alone
          // meant any caller passing only `limit` got NO limit clause and the
          // whole table back (e.g. evaluator recent-message fetches returning
          // thousands of rows instead of 10).
          if (effectiveLimit && offset !== undefined && offset > 0) {
            return baseQuery.limit(effectiveLimit).offset(offset);
          } else if (effectiveLimit) {
            return baseQuery.limit(effectiveLimit);
          } else if (offset !== undefined && offset > 0) {
            return baseQuery.offset(offset);
          } else {
            return baseQuery;
          }
        })();
        return rows.map((row) => mapRow(row.memory as SelectedMemory, row.embedding));
      }

      // includeEmbedding === false: skip the embeddingTable join + column. The
      // left join never filtered rows, so the result set is identical — only the
      // 384-float vector is omitted (callers that requested this discard it).
      const baseQuery = tx
        .select({ memory: memorySelect })
        .from(memoryTable)
        .where(and(...conditions))
        .orderBy(...order);
      const rows = await (async () => {
        if (effectiveLimit && offset !== undefined && offset > 0) {
          return baseQuery.limit(effectiveLimit).offset(offset);
        } else if (effectiveLimit) {
          return baseQuery.limit(effectiveLimit);
        } else if (offset !== undefined && offset > 0) {
          return baseQuery.offset(offset);
        } else {
          return baseQuery;
        }
      })();
      return rows.map((row) => mapRow(row.memory as SelectedMemory, undefined));
    });
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
    offset?: number;
    textContains?: string;
    includeEmbedding?: boolean;
    accessContext?: AccessContext;
  }): Promise<Memory[]> {
    return this.withDatabase(async () => {
      if (params.roomIds.length === 0) return [];

      const conditions = [
        eq(memoryTable.type, params.tableName),
        inArray(memoryTable.roomId, params.roomIds),
      ];

      conditions.push(eq(memoryTable.agentId, this.agentId));

      const textContains = params.textContains?.trim();
      if (textContains) {
        // Same case-insensitive keyword predicate as getMemories: a sequential
        // ILIKE over `content->>'text'` (not index-backed). Escaped so `%`/`_`
        // match literally. Scoping to roomIds first narrows the scan via the
        // (type, roomId) index. TODO(#9955): pg_trgm GIN index for scale.
        conditions.push(
          sql`(${memoryTable.content}->>'text') ILIKE ${`%${escapeIlikeLiteral(textContains)}%`} ESCAPE '\\'`
        );
      }

      const baseQuery = this.db
        .select({
          id: memoryTable.id,
          type: memoryTable.type,
          createdAt: memoryTable.createdAt,
          content: memoryTable.content,
          entityId: memoryTable.entityId,
          agentId: memoryTable.agentId,
          roomId: memoryTable.roomId,
          worldId: memoryTable.worldId,
          unique: memoryTable.unique,
          metadata: memoryTable.metadata,
        })
        .from(memoryTable)
        .where(and(...conditions))
        .orderBy(desc(memoryTable.createdAt));

      const { limit, offset } = params;
      const rows = await (async () => {
        if (limit !== undefined && offset !== undefined && offset > 0) {
          return baseQuery.limit(limit).offset(offset);
        } else if (limit !== undefined) {
          return baseQuery.limit(limit);
        } else if (offset !== undefined && offset > 0) {
          return baseQuery.offset(offset);
        }
        return baseQuery;
      })();

      return rows.map((row) => ({
        id: row.id as UUID,
        createdAt: row.createdAt.getTime(),
        content: typeof row.content === "string" ? JSON.parse(row.content) : row.content,
        entityId: row.entityId as UUID,
        agentId: row.agentId as UUID,
        roomId: row.roomId as UUID,
        worldId: (row.worldId ?? undefined) as UUID | undefined,
        unique: row.unique,
        metadata: row.metadata,
      })) as Memory[];
    });
  }

  /**
   * Corpus-wide full-text + trigram message search (#13534). Ranks in the store
   * with Postgres `ts_rank_cd` over a `websearch_to_tsquery` match (multi-word,
   * quoted phrases, `-negation`) plus a `pg_trgm`-accelerated `LIKE` fallback for
   * partial-word/typo/code/URL/emoji/CJK tokens the FTS lexer misses — both over
   * the GIN-indexed `eliza_message_search_document(content)` expression so the
   * plan is index-backed, not an O(n) `ILIKE` scan. The query and the stored
   * document are folded identically (`eliza_search_fold`: lowercase, strip
   * accents/apostrophes) so "café"/"cafe" and "don't"/"dont" agree. Room-scoping,
   * `agentId`, and LIMIT/OFFSET are all applied in SQL, after ranking, so a
   * relevant hit older than any recency window is still found and ordered.
   */
  async searchMessages(params: {
    roomIds: UUID[];
    query: string;
    tableName?: string;
    limit?: number;
    offset?: number;
    since?: number;
    until?: number;
    accessContext?: AccessContext;
  }): Promise<MessageSearchHit[]> {
    return this.withDatabase(async () => {
      if (params.roomIds.length === 0) return [];
      const tableName = params.tableName ?? "messages";
      const limit = params.limit ?? 20;
      const offset = params.offset ?? 0;
      // Inclusive created_at window, applied with the match predicate BEFORE
      // ranking and LIMIT/OFFSET so a "one year ago" window never loses hits to
      // a recency-truncated slice. Both branches below share these conditions.
      const timeConditions: SQL[] = [];
      if (typeof params.since === "number") {
        timeConditions.push(gte(memoryTable.createdAt, new Date(params.since)));
      }
      if (typeof params.until === "number") {
        timeConditions.push(lte(memoryTable.createdAt, new Date(params.until)));
      }
      const trigramAvailable = await this.isTrigramAvailable();

      // Fold the query in SQL with the same function the document is folded with.
      const foldedQuery = sql`eliza_search_fold(${params.query})`;
      // Read the pre-folded document from the STORED generated column rather than
      // recomputing the fold+attachment function per row — that materialization
      // is what keeps the trigram/LIKE fallback off the O(n)-recompute hot path.
      const document = sql`message_search_document`;
      const tsvector = sql`to_tsvector('english', ${document})`;
      const tsquery = sql`websearch_to_tsquery('english', ${foldedQuery})`;
      const ftsRankExpr = sql<number>`ts_rank_cd(${tsvector}, ${tsquery})`;
      // `similarity()` only exists when pg_trgm is installed; degrade to 0 so the
      // ORDER BY and DTO carry a real (extension-absent) signal, not a fake rank.
      const trigramExpr = trigramAvailable
        ? sql<number>`GREATEST(similarity(${document}, ${foldedQuery}), word_similarity(${foldedQuery}, ${document}))`
        : sql<number>`0`;
      const trigramMatch = trigramAvailable
        ? sql`NOT EXISTS (
            SELECT 1
            FROM unnest(regexp_split_to_array(${foldedQuery}, '[[:space:]]+')) AS query_terms(term)
            WHERE query_terms.term <> ''
              AND NOT (
                ${document} LIKE eliza_search_like_pattern(query_terms.term)
                OR word_similarity(query_terms.term, ${document}) >= 0.45
              )
          )`
        : sql`FALSE`;

      const conditions = [
        eq(memoryTable.type, tableName),
        eq(memoryTable.agentId, this.agentId),
        inArray(memoryTable.roomId, params.roomIds),
        ...timeConditions,
        sql`(${tsvector} @@ ${tsquery} OR ${document} LIKE eliza_search_like_pattern(${params.query}) OR ${trigramMatch})`,
      ];

      let rows: Array<{
        id: string;
        createdAt: Date;
        content: unknown;
        entityId: string | null;
        agentId: string;
        roomId: string | null;
        worldId: string | null;
        unique: boolean;
        metadata: unknown;
        ftsRank: unknown;
        trigramSimilarity: unknown;
      }>;
      try {
        rows = await this.db
          .select({
            id: memoryTable.id,
            createdAt: memoryTable.createdAt,
            content: memoryTable.content,
            entityId: memoryTable.entityId,
            agentId: memoryTable.agentId,
            roomId: memoryTable.roomId,
            worldId: memoryTable.worldId,
            unique: memoryTable.unique,
            metadata: memoryTable.metadata,
            ftsRank: ftsRankExpr.as("fts_rank"),
            trigramSimilarity: trigramExpr.as("trgm_sim"),
          })
          .from(memoryTable)
          .where(and(...conditions))
          .orderBy(
            sql`fts_rank DESC`,
            sql`trgm_sim DESC`,
            desc(memoryTable.createdAt),
            asc(memoryTable.id)
          )
          .limit(limit)
          .offset(offset);
      } catch (error) {
        if (!isMessageSearchObjectsMissing(error)) {
          throw error;
        }
        // error-policy:J4 production Postgres can deliberately skip the heavy
        // generated-column/index DDL at startup; until an operator applies it,
        // keep search functional with the older sequential text/attachment scan.
        logger.warn(
          {
            src: "plugin:sql",
            error: error instanceof Error ? error.message : String(error),
          },
          "[MessageSearch] search objects are missing; falling back to sequential message search"
        );
        rows = await this.db
          .select({
            id: memoryTable.id,
            createdAt: memoryTable.createdAt,
            content: memoryTable.content,
            entityId: memoryTable.entityId,
            agentId: memoryTable.agentId,
            roomId: memoryTable.roomId,
            worldId: memoryTable.worldId,
            unique: memoryTable.unique,
            metadata: memoryTable.metadata,
            ftsRank: sql<number>`0`.as("fts_rank"),
            trigramSimilarity: sql<number>`0`.as("trgm_sim"),
          })
          .from(memoryTable)
          .where(
            and(
              eq(memoryTable.type, tableName),
              eq(memoryTable.agentId, this.agentId),
              inArray(memoryTable.roomId, params.roomIds),
              ...timeConditions,
              or(
                sql`(${memoryTable.content}->>'text') ILIKE ${`%${escapeIlikeLiteral(params.query)}%`} ESCAPE '\\'`,
                sql`${memoryTable.content}::text ILIKE ${`%${escapeIlikeLiteral(params.query)}%`} ESCAPE '\\'`
              )
            )
          )
          .orderBy(desc(memoryTable.createdAt), asc(memoryTable.id))
          .limit(limit)
          .offset(offset);
      }

      return rows.map((row) => ({
        memory: {
          id: row.id as UUID,
          createdAt: row.createdAt.getTime(),
          content: typeof row.content === "string" ? JSON.parse(row.content) : row.content,
          entityId: row.entityId as UUID,
          agentId: row.agentId as UUID,
          roomId: row.roomId as UUID,
          worldId: (row.worldId ?? undefined) as UUID | undefined,
          unique: row.unique,
          metadata: row.metadata,
        } as Memory,
        ftsRank: Number(row.ftsRank),
        trigramSimilarity: Number(row.trigramSimilarity),
      }));
    });
  }

  /**
   * Whether `pg_trgm` is installed, memoized per adapter. Gates the `similarity`
   * ranking + gin_trgm_ops `LIKE` acceleration in {@link searchMessages}.
   */
  private async isTrigramAvailable(): Promise<boolean> {
    if (this.messageSearchTrigramAvailable !== null) {
      return this.messageSearchTrigramAvailable;
    }
    const result = await this.db.execute(
      sql`SELECT 1 AS ok FROM pg_extension WHERE extname = 'pg_trgm'`
    );
    const rows = (result as { rows?: unknown[] }).rows ?? result;
    this.messageSearchTrigramAvailable = Array.isArray(rows) && rows.length > 0;
    return this.messageSearchTrigramAvailable;
  }

  /**
   * Asynchronously retrieves a memory by its unique identifier.
   * @param {UUID} id - The unique identifier of the memory to retrieve.
   * @returns {Promise<Memory | null>} A Promise that resolves to the memory if found, null otherwise.
   */
  async getMemoryById(id: UUID): Promise<Memory | null> {
    return this.withDatabase(async () => {
      const result = await this.db
        .select({
          memory: memoryTable,
          embedding: embeddingTable[this.embeddingDimension],
        })
        .from(memoryTable)
        .leftJoin(embeddingTable, eq(memoryTable.id, embeddingTable.memoryId))
        .where(eq(memoryTable.id, id))
        .limit(1);

      if (result.length === 0) return null;

      const row = result[0];
      return {
        id: row.memory.id as UUID,
        createdAt: row.memory.createdAt.getTime(),
        content:
          typeof row.memory.content === "string"
            ? JSON.parse(row.memory.content)
            : row.memory.content,
        entityId: row.memory.entityId as UUID,
        agentId: row.memory.agentId as UUID,
        roomId: row.memory.roomId as UUID,
        worldId: (row.memory.worldId ?? undefined) as UUID | undefined,
        unique: row.memory.unique,
        metadata: row.memory.metadata as MemoryMetadata,
        embedding: row.embedding ?? undefined,
      };
    });
  }

  /**
   * Asynchronously retrieves memories from the database based on the provided parameters.
   * @param {Object} params - The parameters for retrieving memories.
   * @param {UUID[]} params.memoryIds - The IDs of the memories to retrieve.
   * @param {string} [params.tableName] - The name of the table to retrieve memories from.
   * @returns {Promise<Memory[]>} A Promise that resolves to an array of memories.
   */
  async getMemoriesByIds(memoryIds: UUID[], tableName?: string): Promise<Memory[]> {
    return this.withDatabase(async () => {
      if (memoryIds.length === 0) return [];

      const conditions = [inArray(memoryTable.id, memoryIds)];

      if (tableName) {
        conditions.push(eq(memoryTable.type, tableName));
      }

      const rows = await this.db
        .select({
          memory: memoryTable,
          embedding: embeddingTable[this.embeddingDimension],
        })
        .from(memoryTable)
        .leftJoin(embeddingTable, eq(embeddingTable.memoryId, memoryTable.id))
        .where(and(...conditions))
        .orderBy(desc(memoryTable.createdAt));

      return rows.map((row) => ({
        id: row.memory.id as UUID,
        createdAt: row.memory.createdAt.getTime(),
        content:
          typeof row.memory.content === "string"
            ? JSON.parse(row.memory.content)
            : row.memory.content,
        entityId: row.memory.entityId as UUID,
        agentId: row.memory.agentId as UUID,
        roomId: row.memory.roomId as UUID,
        worldId: (row.memory.worldId ?? undefined) as UUID | undefined,
        unique: row.memory.unique,
        metadata: row.memory.metadata as MemoryMetadata,
        embedding: row.embedding ?? undefined,
      }));
    });
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
                        levenshtein(CAST(${opts.query_input} AS text), content_text) as levenshtein_score
                    FROM embedded_text
                    WHERE levenshtein(CAST(${opts.query_input} AS text), content_text) <= ${opts.query_threshold}
                    ORDER BY levenshtein_score
                    LIMIT ${opts.query_match_count}
                `);

        return results.rows
          .map((row) => ({
            embedding: Array.isArray(row.embedding)
              ? row.embedding
              : typeof row.embedding === "string"
                ? JSON.parse(row.embedding)
                : [],
            levenshtein_score: Number(row.levenshtein_score),
          }))
          .filter((row) => Array.isArray(row.embedding));
      } catch (error) {
        // error-policy:J3 untrusted-input sanitizing — an over-long query
        // string exceeds levenshtein's 255-char ceiling, so no fuzzy cache
        // match can exist for it: an empty result is the correct typed answer,
        // not a masked failure. Every other error is a real fault → rethrow.
        if (
          error instanceof Error &&
          error.message === "levenshtein argument exceeds maximum length of 255 characters"
        ) {
          return [];
        }
        throw new ElizaError("getCachedEmbeddings failed", {
          code: "DB_QUERY_FAILED",
          cause: error,
          context: {
            table: opts.query_table_name,
            field: opts.query_field_name,
          },
        });
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
  async log(params: { body: LogBody; entityId: UUID; roomId: UUID; type: string }): Promise<void> {
    return this.withDatabase(async () => {
      try {
        // Sanitize JSON body to prevent Unicode escape sequence errors
        const sanitizedBody = this.sanitizeJsonObject(params.body);

        // Serialize to JSON string first for an additional layer of protection
        // This ensures any problematic characters are properly escaped during JSON serialization
        const jsonString = JSON.stringify(sanitizedBody);

        // Use withEntityContext to set Entity RLS context before inserting
        // This ensures the log entry passes STRICT Entity RLS policy
        await this.withEntityContext(params.entityId, async (tx) => {
          await tx.insert(logTable).values({
            body: sql`${jsonString}::jsonb`,
            entityId: params.entityId,
            roomId: params.roomId,
            type: params.type,
          });
        });
      } catch (error) {
        // error-policy:J2 context-adding rethrow — a swallowed insert dropped
        // the log entry silently; the caller decides whether a failed diagnostic
        // write should be tolerated (J7), not this deep adapter method.
        throw new ElizaError("log insert failed", {
          code: "DB_INSERT_FAILED",
          cause: error,
          context: {
            table: "logs",
            type: params.type,
            roomId: params.roomId,
            entityId: params.entityId,
          },
        });
      }
    });
  }

  /**
   * Sanitizes a JSON object for jsonb storage: strips NUL characters (which
   * PostgreSQL/PGlite jsonb rejects as the `\u0000` escape) and breaks
   * circular references.
   *
   * WHY nothing else is rewritten: the sanitized value is serialized with
   * JSON.stringify, which already escapes backslashes and control characters
   * correctly. This function used to ALSO double every backslash not followed
   * by ["\/bfnrtu] and mangle non-hex `\u` sequences, so a body value like
   * "C:\Users" was stored (and read back) as "C:\\Users" — silent data
   * corruption of any string containing a backslash.
   *
   * @param value - The value to sanitize
   * @returns The sanitized value
   */
  private sanitizeJsonObject(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
    if (value === null || value === undefined) {
      return value;
    }

    if (typeof value === "string") {
      return value.replace(new RegExp(String.fromCharCode(0), "g"), "");
    }

    if (typeof value === "object") {
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
            typeof key === "string"
              ? key.replace(new RegExp(String.fromCharCode(0), "g"), "")
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
   * @param {number} [params.limit] - The maximum number of logs to retrieve (`count` is a legacy alias).
   * @param {number} [params.offset] - The offset to retrieve logs from.
   * @returns {Promise<Log[]>} A Promise that resolves to an array of logs.
   */
  async getLogs(params: {
    entityId?: UUID;
    roomId?: UUID;
    type?: string;
    limit?: number;
    count?: number;
    offset?: number;
  }): Promise<Log[]> {
    const { entityId, roomId, type, offset } = params;
    // Honor `limit` (the IDatabaseAdapter contract param — see
    // types/database.ts getLogs) with `count` as a legacy alias, matching
    // getMemories. Reading only `count` meant every caller passing `limit`
    // (runtime.getLogs, agent-export's `getLogs({ limit: MAX_SAFE_INTEGER })`)
    // silently fell back to the default 10 rows.
    const effectiveLimit = params.limit ?? params.count ?? 10;

    // Use withEntityContext for RLS only when entityId is provided
    // Without entityId, bypass RLS to see all logs (for non-RLS mode)
    return this.withEntityContext(entityId ?? null, async (tx) => {
      const result = await tx
        .select()
        .from(logTable)
        .where(
          and(
            roomId ? eq(logTable.roomId, roomId) : undefined,
            type ? eq(logTable.type, type) : undefined
          )
        )
        .orderBy(desc(logTable.createdAt))
        .limit(effectiveLimit)
        .offset(offset ?? 0);

      const logs = result.map((log) => ({
        ...log,
        id: log.id as UUID,
        entityId: log.entityId as UUID,
        roomId: log.roomId as UUID,
        type: log.type as string,
        body: log.body as LogBody,
        createdAt: new Date(log.createdAt as string | number | Date),
      }));

      if (logs.length === 0) return [];

      return logs;
    });
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
    const limit = Math.min(Math.max(params.limit ?? 20, 1), 100);
    const fromDate = typeof params.from === "number" ? new Date(params.from) : undefined;
    const toDate = typeof params.to === "number" ? new Date(params.to) : undefined;

    // Use withEntityContext for RLS when entityId is provided
    return this.withEntityContext(params.entityId ?? null, async (tx) => {
      const runMap = new Map<string, AgentRunSummary>();

      const conditions: SQL<unknown>[] = [
        eq(logTable.type, "run_event"),
        sql`${logTable.body} ? 'runId'`,
        eq(roomTable.agentId, this.agentId),
      ];

      if (params.roomId) {
        conditions.push(eq(logTable.roomId, params.roomId));
      }
      if (fromDate) {
        conditions.push(gte(logTable.createdAt, fromDate));
      }
      if (toDate) {
        conditions.push(lte(logTable.createdAt, toDate));
      }

      const whereClause = and(...conditions);

      const eventLimit = Math.max(limit * 20, 200);

      const runEventRows = await tx
        .select({
          runId: sql<string>`(${logTable.body} ->> 'runId')`,
          status: sql<string | null>`(${logTable.body} ->> 'status')`,
          messageId: sql<string | null>`(${logTable.body} ->> 'messageId')`,
          rawBody: logTable.body,
          createdAt: logTable.createdAt,
          roomId: logTable.roomId,
          entityId: logTable.entityId,
        })
        .from(logTable)
        .innerJoin(roomTable, eq(roomTable.id, logTable.roomId))
        .where(whereClause)
        .orderBy(desc(logTable.createdAt))
        .limit(eventLimit);

      for (const row of runEventRows) {
        const runId = row.runId;
        if (!runId) continue;

        const summary: AgentRunSummary = runMap.get(runId) ?? {
          runId,
          status: "started",
          startedAt: null,
          endedAt: null,
          durationMs: null,
          messageId: undefined,
          roomId: undefined,
          entityId: undefined,
          metadata: {},
        };

        if (!summary.messageId && row.messageId) {
          summary.messageId = row.messageId as UUID;
        }
        if (!summary.roomId && row.roomId) {
          summary.roomId = row.roomId as UUID;
        }
        if (!summary.entityId && row.entityId) {
          summary.entityId = row.entityId as UUID;
        }

        const body = row.rawBody as Record<string, unknown> | undefined;
        if (body && typeof body === "object") {
          if (!summary.roomId && typeof body.roomId === "string") {
            summary.roomId = body.roomId as UUID;
          }
          if (!summary.entityId && typeof body.entityId === "string") {
            summary.entityId = body.entityId as UUID;
          }
          if (!summary.messageId && typeof body.messageId === "string") {
            summary.messageId = body.messageId as UUID;
          }
          if (!summary.metadata || Object.keys(summary.metadata).length === 0) {
            const metadata = (body.metadata as Record<string, unknown> | undefined) ?? undefined;
            summary.metadata = metadata ? ({ ...metadata } as Record<string, JsonValue>) : {};
          }
        }

        const createdAt = row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt);
        const timestamp = createdAt.getTime();
        const bodyStatus = body?.status;
        const eventStatus =
          (row.status as RunStatus | undefined) ?? (bodyStatus as RunStatus | undefined);

        if (eventStatus === "started") {
          const currentStartedAt =
            summary.startedAt === null
              ? null
              : typeof summary.startedAt === "bigint"
                ? Number(summary.startedAt)
                : summary.startedAt;
          summary.startedAt =
            currentStartedAt === null ? timestamp : Math.min(currentStartedAt, timestamp);
        } else if (
          eventStatus === "completed" ||
          eventStatus === "timeout" ||
          eventStatus === "error"
        ) {
          summary.status = eventStatus;
          summary.endedAt = timestamp;
          if (summary.startedAt !== null) {
            const startedAtNum =
              typeof summary.startedAt === "bigint" ? Number(summary.startedAt) : summary.startedAt;
            summary.durationMs = Math.max(timestamp - startedAtNum, 0);
          }
        }

        runMap.set(runId, summary);
      }

      let runs = Array.from(runMap.values());
      if (params.status && params.status !== "all") {
        runs = runs.filter((run) => run.status === params.status);
      }

      runs.sort((a, b) => {
        const aStarted =
          a.startedAt === null
            ? 0
            : typeof a.startedAt === "bigint"
              ? Number(a.startedAt)
              : a.startedAt;
        const bStarted =
          b.startedAt === null
            ? 0
            : typeof b.startedAt === "bigint"
              ? Number(b.startedAt)
              : b.startedAt;
        return bStarted - aStarted;
      });

      const total = runs.length;
      const limitedRuns = runs.slice(0, limit);
      const hasMore = total > limit;

      const runCounts = new Map<string, AgentRunCounts>();
      for (const run of limitedRuns) {
        runCounts.set(run.runId, {
          actions: 0,
          modelCalls: 0,
          errors: 0,
          evaluators: 0,
        });
      }

      const runIds = limitedRuns.map((run) => run.runId).filter(Boolean);

      if (runIds.length > 0) {
        const runIdArray = sql`array[${sql.join(
          runIds.map((id) => sql`${id}`),
          sql`, `
        )}]::text[]`;

        const actionSummary = await this.db.execute(sql`
          SELECT
            body->>'runId' as "runId",
            COUNT(*)::int as "actions",
            SUM(CASE WHEN COALESCE(body->'result'->>'success', 'true') = 'false' THEN 1 ELSE 0 END)::int as "errors",
            SUM(COALESCE((body->>'promptCount')::int, 0))::int as "modelCalls"
          FROM ${logTable}
          WHERE type = 'action'
            AND body->>'runId' = ANY(${runIdArray})
          GROUP BY body->>'runId'
        `);

        const actionRows = actionSummary.rows as Array<{
          runId: string;
          actions: number | string;
          errors: number | string;
          modelCalls: number | string;
        }>;

        for (const row of actionRows) {
          const counts = runCounts.get(row.runId);
          if (!counts) continue;
          counts.actions += Number(row.actions);
          counts.errors += Number(row.errors);
          counts.modelCalls += Number(row.modelCalls);
        }

        const evaluatorSummary = await this.db.execute(sql`
          SELECT
            body->>'runId' as "runId",
            COUNT(*)::int as "evaluators"
          FROM ${logTable}
          WHERE type = 'evaluator'
            AND body->>'runId' = ANY(${runIdArray})
          GROUP BY body->>'runId'
        `);

        const evaluatorRows = evaluatorSummary.rows as Array<{
          runId: string;
          evaluators: number | string;
        }>;

        for (const row of evaluatorRows) {
          const counts = runCounts.get(row.runId);
          if (!counts) continue;
          counts.evaluators += Number(row.evaluators);
        }

        const genericSummary = await this.db.execute(sql`
          SELECT
            body->>'runId' as "runId",
            COUNT(*) FILTER (WHERE type LIKE 'useModel:%')::int as "modelLogs",
            COUNT(*) FILTER (WHERE type = 'embedding_event' AND body->>'status' = 'failed')::int as "embeddingErrors"
          FROM ${logTable}
          WHERE (type LIKE 'useModel:%' OR type = 'embedding_event')
            AND body->>'runId' = ANY(${runIdArray})
          GROUP BY body->>'runId'
        `);

        const genericRows = genericSummary.rows as Array<{
          runId: string;
          modelLogs: number | string;
          embeddingErrors: number | string;
        }>;

        for (const row of genericRows) {
          const counts = runCounts.get(row.runId);
          if (!counts) continue;
          counts.modelCalls += Number(row.modelLogs);
          counts.errors += Number(row.embeddingErrors);
        }
      }

      for (const run of limitedRuns) {
        const counts = runCounts.get(run.runId) ?? {
          actions: 0,
          modelCalls: 0,
          errors: 0,
          evaluators: 0,
        };
        run.counts = counts;
      }

      return {
        runs: limitedRuns,
        total,
        hasMore,
      } as AgentRunSummaryResult;
    });
  }

  /**
   * Asynchronously deletes a log from the database based on the provided parameters.
   * @param {UUID} logId - The ID of the log to delete.
   * @returns {Promise<void>} A Promise that resolves when the log is deleted.
   */
  async deleteLog(logId: UUID): Promise<void> {
    return this.withDatabase(async () => {
      await this.db.delete(logTable).where(eq(logTable.id, logId));
    });
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
    limit?: number;
    unique?: boolean;
    query?: string;
    roomId?: UUID;
    worldId?: UUID;
    entityId?: UUID;
    accessContext?: AccessContext;
  }): Promise<Memory[]> {
    return await this.searchMemoriesByEmbedding(params.embedding, {
      match_threshold: params.match_threshold,
      // `limit` is the IDatabaseAdapter contract param; honour it (with `count`
      // as a legacy alias) instead of silently ignoring it and capping the
      // candidate pool at the default 10.
      count: params.count ?? params.limit,
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
    return this.withDatabase(async () => {
      const cleanVector = embedding.map((n) => (Number.isFinite(n) ? Number(n.toFixed(6)) : 0));

      const similarity = sql<number>`1 - (${cosineDistance(
        embeddingTable[this.embeddingDimension],
        cleanVector
      )})`;

      const conditions = [eq(memoryTable.type, params.tableName)];

      if (params.unique) {
        conditions.push(eq(memoryTable.unique, true));
      }

      conditions.push(eq(memoryTable.agentId, this.agentId));

      // Add filters based on direct params
      if (params.roomId) {
        conditions.push(eq(memoryTable.roomId, params.roomId));
      }
      if (params.worldId) {
        conditions.push(eq(memoryTable.worldId, params.worldId));
      }
      if (params.entityId) {
        conditions.push(eq(memoryTable.entityId, params.entityId));
      }

      if (params.match_threshold) {
        conditions.push(gte(similarity, params.match_threshold));
      }

      const results = await this.db
        .select({
          memory: memoryTable,
          similarity,
          embedding: embeddingTable[this.embeddingDimension],
        })
        .from(embeddingTable)
        .innerJoin(memoryTable, eq(memoryTable.id, embeddingTable.memoryId))
        .where(and(...conditions))
        .orderBy(desc(similarity))
        .limit(params.count ?? 10);

      return results.map((row) => ({
        id: row.memory.id as UUID,
        type: row.memory.type,
        createdAt: row.memory.createdAt.getTime(),
        content:
          typeof row.memory.content === "string"
            ? JSON.parse(row.memory.content)
            : row.memory.content,
        entityId: row.memory.entityId as UUID,
        agentId: row.memory.agentId as UUID,
        roomId: row.memory.roomId as UUID,
        worldId: row.memory.worldId as UUID | undefined, // Include worldId
        unique: row.memory.unique,
        metadata: row.memory.metadata as MemoryMetadata,
        embedding: row.embedding ?? undefined,
        similarity: row.similarity,
      }));
    });
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
    const memoryId = memory.id ?? (v4() as UUID);

    const existing = await this.getMemoryById(memoryId);
    if (existing) {
      return memoryId;
    }

    // only do costly check if we need to
    if (memory.unique === undefined) {
      memory.unique = true; // set default
      if (memory.embedding && Array.isArray(memory.embedding)) {
        const similarMemories = await this.searchMemoriesByEmbedding(memory.embedding, {
          tableName,
          // Use the scope fields from the memory object for similarity check
          roomId: memory.roomId,
          worldId: memory.worldId,
          entityId: memory.entityId,
          match_threshold: 0.95,
          count: 1,
        });
        memory.unique = similarMemories.length === 0;
      }
    }

    // Ensure we always pass a JSON string to the SQL bind parameter; if we pass an
    // object directly PG sees `[object Object]` and fails the `::jsonb` cast.
    const contentToInsert =
      typeof memory.content === "string" ? memory.content : JSON.stringify(memory.content);

    const metadataToInsert =
      typeof memory.metadata === "string" ? memory.metadata : JSON.stringify(memory.metadata ?? {});

    // Use withEntityContext to set Entity RLS context if needed
    // This delegates to the concrete adapter implementation (PostgreSQL or PGLite)
    await this.withEntityContext(memory.entityId, async (tx) => {
      await tx.insert(memoryTable).values([
        {
          id: memoryId,
          type: tableName,
          content: sql`${contentToInsert}::jsonb`,
          metadata: sql`${metadataToInsert}::jsonb`,
          entityId: memory.entityId,
          roomId: memory.roomId,
          worldId: memory.worldId, // Include worldId
          agentId: memory.agentId || this.agentId,
          unique: memory.unique,
          createdAt: memory.createdAt !== undefined ? new Date(memory.createdAt) : new Date(),
        },
      ]);

      if (memory.embedding && Array.isArray(memory.embedding)) {
        const expectedDimension = Number(this.embeddingDimension.replace(/^dim/, ""));
        if (memory.embedding.length !== expectedDimension) {
          // The runtime's TEXT_EMBEDDING provider returned a vector whose width
          // does not match the column this agent is configured to write to —
          // typically because a fallback provider (e.g. cloud at 1536 dims) ran
          // before the configured local model finished warmup. Persist the
          // memory itself; skip the embedding so a later write with the right
          // model can supply one.
          logger.warn(
            {
              src: "plugin:sql",
              agentId: this.agentId,
              expectedDimension,
              receivedDimension: memory.embedding.length,
              column: this.embeddingDimension,
            },
            "Skipping embedding insert: dimension mismatch with configured column"
          );
        } else {
          const embeddingValues: Record<string, unknown> = {
            id: v4(),
            memoryId: memoryId,
            createdAt: memory.createdAt !== undefined ? new Date(memory.createdAt) : new Date(),
          };

          const cleanVector = memory.embedding.map((n) =>
            Number.isFinite(n) ? Number(n.toFixed(6)) : 0
          );

          embeddingValues[this.embeddingDimension] = cleanVector;

          await tx.insert(embeddingTable).values([embeddingValues]);
        }
      }
    });

    return memoryId;
  }

  /**
   * Updates an existing memory in the database.
   * @param memory The memory object with updated content and optional embedding
   * @returns Promise resolving to boolean indicating success
   */
  async updateMemory(
    memory: Partial<Memory> & { id: UUID; metadata?: MemoryMetadata }
  ): Promise<boolean> {
    return this.withDatabase(async () => {
      try {
        await this.db.transaction(async (tx) => {
          // Update memory content if provided
          if (memory.content) {
            const contentToUpdate =
              typeof memory.content === "string" ? memory.content : JSON.stringify(memory.content);

            const metadataToUpdate =
              typeof memory.metadata === "string"
                ? memory.metadata
                : JSON.stringify(memory.metadata ?? {});

            await tx
              .update(memoryTable)
              .set({
                content: sql`${contentToUpdate}::jsonb`,
                ...(memory.metadata && {
                  metadata: sql`${metadataToUpdate}::jsonb`,
                }),
              })
              .where(eq(memoryTable.id, memory.id));
          } else if (memory.metadata) {
            // Update only metadata if content is not provided
            const metadataToUpdate =
              typeof memory.metadata === "string"
                ? memory.metadata
                : JSON.stringify(memory.metadata);

            await tx
              .update(memoryTable)
              .set({
                metadata: sql`${metadataToUpdate}::jsonb`,
              })
              .where(eq(memoryTable.id, memory.id));
          }

          // Update embedding if provided
          if (memory.embedding && Array.isArray(memory.embedding)) {
            const expectedDimension = Number(this.embeddingDimension.replace(/^dim/, ""));
            if (memory.embedding.length !== expectedDimension) {
              logger.warn(
                {
                  src: "plugin:sql",
                  agentId: this.agentId,
                  memoryId: memory.id,
                  expectedDimension,
                  receivedDimension: memory.embedding.length,
                  column: this.embeddingDimension,
                },
                "Skipping embedding update: dimension mismatch with configured column"
              );
            } else {
              const cleanVector = memory.embedding.map((n) =>
                Number.isFinite(n) ? Number(n.toFixed(6)) : 0
              );

              // Check if embedding exists
              const existingEmbedding = await tx
                .select({ id: embeddingTable.id })
                .from(embeddingTable)
                .where(eq(embeddingTable.memoryId, memory.id))
                .limit(1);

              if (existingEmbedding.length > 0) {
                // Update existing embedding
                const updateValues: Record<string, unknown> = {};
                updateValues[this.embeddingDimension] = cleanVector;

                await tx
                  .update(embeddingTable)
                  .set(updateValues)
                  .where(eq(embeddingTable.memoryId, memory.id));
              } else {
                // Create new embedding
                const embeddingValues: Record<string, unknown> = {
                  id: v4(),
                  memoryId: memory.id,
                };
                embeddingValues[this.embeddingDimension] = cleanVector;

                await tx.insert(embeddingTable).values([embeddingValues]);
              }
            }
          }
        });

        return true;
      } catch (error) {
        // error-policy:J2 context-adding rethrow — a failed memory update must
        // not read as a benign false; surface the write failure.
        throw new ElizaError("updateMemory failed", {
          code: "DB_UPDATE_FAILED",
          cause: error,
          context: { table: "memories", memoryId: memory.id },
        });
      }
    });
  }

  /**
   * Asynchronously deletes a memory from the database based on the provided parameters.
   * @param {UUID} memoryId - The ID of the memory to delete.
   * @returns {Promise<void>} A Promise that resolves when the memory is deleted.
   */
  async deleteMemory(memoryId: UUID): Promise<void> {
    return this.withDatabase(async () => {
      await this.db.transaction(async (tx) => {
        // See if there are any fragments that we need to delete
        await this.deleteMemoryFragments(tx, memoryId);

        // Then delete the embedding for the main memory
        await tx.delete(embeddingTable).where(eq(embeddingTable.memoryId, memoryId));

        // Finally delete the memory itself
        await tx.delete(memoryTable).where(eq(memoryTable.id, memoryId));
      });
    });
  }

  /**
   * Asynchronously deletes multiple memories from the database in a single batch operation.
   * @param {UUID[]} memoryIds - An array of UUIDs of the memories to delete.
   * @returns {Promise<void>} A Promise that resolves when all memories are deleted.
   */
  async deleteManyMemories(memoryIds: UUID[]): Promise<void> {
    if (memoryIds.length === 0) {
      return;
    }

    return this.withDatabase(async () => {
      await this.db.transaction(async (tx) => {
        // Process in smaller batches to avoid query size limits
        const BATCH_SIZE = 100;
        for (let i = 0; i < memoryIds.length; i += BATCH_SIZE) {
          const batch = memoryIds.slice(i, i + BATCH_SIZE);

          // Delete any fragments for document memories in this batch
          await Promise.all(
            batch.map(async (memoryId) => {
              await this.deleteMemoryFragments(tx, memoryId);
            })
          );

          // Delete embeddings for the batch
          await tx.delete(embeddingTable).where(inArray(embeddingTable.memoryId, batch));

          // Delete the memories themselves
          await tx.delete(memoryTable).where(inArray(memoryTable.id, batch));
        }
      });
    });
  }

  /**
   * Deletes all memory fragments that reference a specific document memory
   * @param tx The database transaction
   * @param documentId The UUID of the document memory whose fragments should be deleted
   * @private
   */
  private async deleteMemoryFragments(tx: DrizzleDatabase, documentId: UUID): Promise<void> {
    const fragmentsToDelete = await this.getMemoryFragments(tx, documentId);

    if (fragmentsToDelete.length > 0) {
      const fragmentIds = fragmentsToDelete.map((f) => f.id) as UUID[];

      // Delete embeddings for fragments
      await tx.delete(embeddingTable).where(inArray(embeddingTable.memoryId, fragmentIds));

      // Delete the fragments
      await tx.delete(memoryTable).where(inArray(memoryTable.id, fragmentIds));
    }
  }

  /**
   * Retrieves all memory fragments that reference a specific document memory
   * @param tx The database transaction
   * @param documentId The UUID of the document memory whose fragments should be retrieved
   * @returns An array of memory fragments
   * @private
   */
  private async getMemoryFragments(tx: DrizzleDatabase, documentId: UUID): Promise<{ id: UUID }[]> {
    const fragments = await tx
      .select({ id: memoryTable.id })
      .from(memoryTable)
      .where(
        and(
          eq(memoryTable.agentId, this.agentId),
          sql`${memoryTable.metadata}->>'documentId' = ${documentId}`
        )
      );

    return fragments.map((f) => ({ id: f.id as UUID }));
  }

  /**
   * Asynchronously deletes all memories from the database based on the provided parameters.
   * @param {UUID[]} roomIds - The IDs of the rooms to delete memories from.
   * @param {string} tableName - The name of the table to delete memories from.
   * @returns {Promise<void>} A Promise that resolves when the memories are deleted.
   */
  async deleteAllMemories(roomIds: UUID[], tableName: string): Promise<void>;
  async deleteAllMemories(roomId: UUID, tableName: string): Promise<void>;
  async deleteAllMemories(roomIdsOrRoomId: UUID[] | UUID, tableName: string): Promise<void> {
    return this.withDatabase(async () => {
      const roomIds = Array.isArray(roomIdsOrRoomId) ? roomIdsOrRoomId : [roomIdsOrRoomId];

      if (roomIds.length === 0) {
        return;
      }

      await this.db.transaction(async (tx) => {
        // 1) fetch all memory IDs for the requested rooms + table
        const rows = await tx
          .select({ id: memoryTable.id })
          .from(memoryTable)
          .where(
            and(
              inArray(memoryTable.roomId, roomIds),
              eq(memoryTable.type, tableName),
              eq(memoryTable.agentId, this.agentId)
            )
          );

        const ids = rows.map((r) => r.id);
        logger.debug(
          { src: "plugin:sql", roomIds, tableName, memoryCount: ids.length },
          "Deleting all memories"
        );

        if (ids.length === 0) {
          return;
        }

        // 2) delete any fragments for "document" memories & their embeddings
        await Promise.all(
          ids.map(async (memoryId) => {
            await this.deleteMemoryFragments(tx, memoryId);
            await tx.delete(embeddingTable).where(eq(embeddingTable.memoryId, memoryId));
          })
        );

        // 3) delete the memories themselves
        await tx
          .delete(memoryTable)
          .where(
            and(
              inArray(memoryTable.roomId, roomIds),
              eq(memoryTable.type, tableName),
              eq(memoryTable.agentId, this.agentId)
            )
          );
      });
    });
  }

  /**
   * Count memories using the current object-based adapter contract while preserving
   * the legacy positional signature used by older tests and callers.
   * @returns {Promise<number>} A Promise that resolves to the number of memories.
   */
  async countMemories(params: CountMemoriesParams): Promise<number>;
  async countMemories(roomId: UUID, unique?: boolean, tableName?: string): Promise<number>;
  async countMemories(
    paramsOrRoomId: CountMemoriesParams | UUID,
    unique = true,
    tableName?: string
  ): Promise<number> {
    const params: CountMemoriesParams =
      typeof paramsOrRoomId === "string"
        ? {
            roomIds: [paramsOrRoomId],
            unique,
            tableName: tableName ?? "messages",
          }
        : {
            ...paramsOrRoomId,
            tableName: paramsOrRoomId.tableName ?? "messages",
            unique: paramsOrRoomId.unique ?? false,
          };

    return this.withDatabase(async () => {
      const tableName = params.tableName ?? "messages";
      const conditions = [eq(memoryTable.type, tableName)];

      if (params.roomIds && params.roomIds.length > 0) {
        conditions.push(inArray(memoryTable.roomId, params.roomIds));
      }
      if (params.entityId) {
        conditions.push(eq(memoryTable.entityId, params.entityId));
      }
      if (params.agentId) {
        conditions.push(eq(memoryTable.agentId, params.agentId));
      }
      if (params.unique) {
        conditions.push(eq(memoryTable.unique, true));
      }

      const result = await this.db
        .select({ count: sql<number>`count(*)` })
        .from(memoryTable)
        .where(and(...conditions));

      const result0 = result[0];
      return Number(result0?.count);
    });
  }

  /**
   * Asynchronously retrieves rooms from the database based on the provided parameters.
   * @param {UUID[]} roomIds - The IDs of the rooms to retrieve.
   * @returns {Promise<Room[] | null>} A Promise that resolves to the rooms if found, null otherwise.
   */
  async getRoomsByIds(roomIds: UUID[]): Promise<Room[]> {
    return this.withDatabase(async () => {
      const result = await this.db
        .select({
          id: roomTable.id,
          name: roomTable.name, // Added name
          channelId: roomTable.channelId,
          agentId: roomTable.agentId,
          messageServerId: roomTable.messageServerId,
          worldId: roomTable.worldId,
          type: roomTable.type,
          source: roomTable.source,
          metadata: roomTable.metadata, // Added metadata
        })
        .from(roomTable)
        .where(and(inArray(roomTable.id, roomIds), eq(roomTable.agentId, this.agentId)));

      // Map the result to properly typed Room objects
      const rooms = result.map((room) => ({
        ...room,
        id: room.id as UUID,
        name: room.name ?? undefined,
        agentId: room.agentId as UUID,
        messageServerId: room.messageServerId as UUID,
        serverId: room.messageServerId as UUID, // Backward compatibility alias
        worldId: room.worldId as UUID,
        channelId: room.channelId as UUID,
        type: room.type as ChannelType,
        metadata: room.metadata as Metadata,
      }));

      return rooms;
    });
  }

  /**
   * Asynchronously retrieves all rooms from the database based on the provided parameters.
   * @param {UUID} worldId - The ID of the world to retrieve rooms from.
   * @returns {Promise<Room[]>} A Promise that resolves to an array of rooms.
   */
  async getRoomsByWorld(worldId: UUID): Promise<Room[]> {
    return this.withDatabase(async () => {
      const result = await this.db.select().from(roomTable).where(eq(roomTable.worldId, worldId));
      const rooms = result.map((room) => ({
        ...room,
        id: room.id as UUID,
        name: room.name ?? undefined,
        agentId: room.agentId as UUID,
        messageServerId: room.messageServerId as UUID,
        serverId: room.messageServerId as UUID, // Backward compatibility alias
        worldId: room.worldId as UUID,
        channelId: room.channelId as UUID,
        type: room.type as ChannelType,
        metadata: room.metadata as Metadata,
      }));
      return rooms;
    });
  }

  /**
   * Asynchronously updates a room in the database based on the provided parameters.
   * @param {Room} room - The room object to update.
   * @returns {Promise<void>} A Promise that resolves when the room is updated.
   */
  async updateRoom(room: Room): Promise<void> {
    return this.withDatabase(async () => {
      await this.db
        .update(roomTable)
        .set({ ...room, agentId: this.agentId })
        .where(eq(roomTable.id, room.id));
    });
  }

  /**
   * Asynchronously creates a new room in the database based on the provided parameters.
   * @param {Room} room - The room object to create.
   * @returns {Promise<UUID>} A Promise that resolves to the ID of the created room.
   */
  async createRooms(rooms: Room[]): Promise<UUID[]> {
    return this.withDatabase(async () => {
      const roomsWithIds = rooms.map((room) => ({
        ...room,
        agentId: this.agentId,
        id: room.id || v4(), // ensure each room has a unique ID
      }));

      const insertedRooms = await this.db
        .insert(roomTable)
        .values(roomsWithIds)
        .onConflictDoNothing()
        .returning();
      const insertedIds = insertedRooms.map((r) => r.id as UUID);
      return insertedIds;
    });
  }

  /**
   * Asynchronously deletes a room from the database based on the provided parameters.
   * @param {UUID} roomId - The ID of the room to delete.
   * @returns {Promise<void>} A Promise that resolves when the room is deleted.
   */
  async deleteRoom(roomId: UUID): Promise<void> {
    if (!roomId) throw new Error("Room ID is required");
    return this.withDatabase(async () => {
      await this.db.transaction(async (tx) => {
        await tx.delete(roomTable).where(eq(roomTable.id, roomId));
      });
    });
  }

  /**
   * Asynchronously retrieves all rooms for a participant from the database based on the provided parameters.
   * @param {UUID} entityId - The ID of the entity to retrieve rooms for.
   * @returns {Promise<UUID[]>} A Promise that resolves to an array of room IDs.
   */
  async getRoomsForParticipant(entityId: UUID): Promise<UUID[]> {
    return this.withDatabase(async () => {
      const result = await this.db
        .select({ roomId: participantTable.roomId })
        .from(participantTable)
        .innerJoin(roomTable, eq(participantTable.roomId, roomTable.id))
        .where(and(eq(participantTable.entityId, entityId), eq(roomTable.agentId, this.agentId)));

      return result.map((row) => row.roomId as UUID);
    });
  }

  /**
   * Asynchronously retrieves all rooms for a list of participants from the database based on the provided parameters.
   * @param {UUID[]} entityIds - The IDs of the entities to retrieve rooms for.
   * @returns {Promise<UUID[]>} A Promise that resolves to an array of room IDs.
   */
  async getRoomsForParticipants(entityIds: UUID[]): Promise<UUID[]> {
    return this.withDatabase(async () => {
      const result = await this.db
        .selectDistinct({ roomId: participantTable.roomId })
        .from(participantTable)
        .innerJoin(roomTable, eq(participantTable.roomId, roomTable.id))
        .where(
          and(inArray(participantTable.entityId, entityIds), eq(roomTable.agentId, this.agentId))
        );

      return result.map((row) => row.roomId as UUID);
    });
  }

  /**
   * Asynchronously adds a participant to a room in the database based on the provided parameters.
   * @param {UUID} entityId - The ID of the entity to add to the room.
   * @param {UUID} roomId - The ID of the room to add the entity to.
   * @returns {Promise<boolean>} A Promise that resolves to a boolean indicating whether the participant was added successfully.
   */
  async addParticipant(entityId: UUID, roomId: UUID): Promise<boolean> {
    return this.withDatabase(async () => {
      try {
        const existing = await this.db
          .select({ id: participantTable.id })
          .from(participantTable)
          .where(
            and(
              eq(participantTable.entityId, entityId),
              eq(participantTable.roomId, roomId),
              eq(participantTable.agentId, this.agentId)
            )
          )
          .limit(1);
        if (existing.length === 0) {
          await this.db.insert(participantTable).values({
            entityId,
            roomId,
            agentId: this.agentId,
          });
        }
        return true;
      } catch (error) {
        // error-policy:J2 context-adding rethrow — insert-if-absent only ever
        // returns true on success, so false here masked a real write failure.
        throw new ElizaError("addParticipant failed", {
          code: "DB_INSERT_FAILED",
          cause: error,
          context: { table: "participants", entityId, roomId, agentId: this.agentId },
        });
      }
    });
  }

  async addParticipantsRoom(entityIds: UUID[], roomId: UUID): Promise<boolean> {
    return this.withDatabase(async () => {
      try {
        for (const id of entityIds) {
          const existing = await this.db
            .select({ id: participantTable.id })
            .from(participantTable)
            .where(
              and(
                eq(participantTable.entityId, id),
                eq(participantTable.roomId, roomId),
                eq(participantTable.agentId, this.agentId)
              )
            )
            .limit(1);
          if (existing.length === 0) {
            await this.db.insert(participantTable).values({
              entityId: id,
              roomId,
              agentId: this.agentId,
            });
          }
        }
        return true;
      } catch (error) {
        // error-policy:J2 context-adding rethrow — insert-if-absent only ever
        // returns true on success, so false here masked a real write failure.
        throw new ElizaError("addParticipantsRoom failed", {
          code: "DB_INSERT_FAILED",
          cause: error,
          context: {
            table: "participants",
            roomId,
            agentId: this.agentId,
            count: entityIds.length,
          },
        });
      }
    });
  }

  /**
   * Asynchronously removes a participant from a room in the database based on the provided parameters.
   * @param {UUID} entityId - The ID of the entity to remove from the room.
   * @param {UUID} roomId - The ID of the room to remove the entity from.
   * @returns {Promise<boolean>} A Promise that resolves to a boolean indicating whether the participant was removed successfully.
   */
  async removeParticipant(entityId: UUID, roomId: UUID): Promise<boolean> {
    return this.withDatabase(async () => {
      try {
        const result = await this.db.transaction(async (tx) => {
          return await tx
            .delete(participantTable)
            .where(
              and(eq(participantTable.entityId, entityId), eq(participantTable.roomId, roomId))
            )
            .returning();
        });

        const removed = result.length > 0;
        return removed;
      } catch (error) {
        // error-policy:J2 context-adding rethrow — false is the typed "no row
        // matched" signal; a delete failure must not collapse into it.
        throw new ElizaError("removeParticipant failed", {
          code: "DB_DELETE_FAILED",
          cause: error,
          context: { table: "participants", entityId, roomId },
        });
      }
    });
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

      if (!entities.length) {
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
    return this.withDatabase(async () => {
      const result = await this.db
        .select({ entityId: participantTable.entityId })
        .from(participantTable)
        .where(eq(participantTable.roomId, roomId));

      return result.map((row) => row.entityId as UUID);
    });
  }

  /**
   * Check if an entity is a participant in a specific room/channel.
   * More efficient than getParticipantsForRoom when only checking membership.
   * @param {UUID} roomId - The ID of the room to check.
   * @param {UUID} entityId - The ID of the entity to check.
   * @returns {Promise<boolean>} A Promise that resolves to true if entity is a participant.
   */
  async isRoomParticipant(roomId: UUID, entityId: UUID): Promise<boolean> {
    return this.withDatabase(async () => {
      const result = await this.db
        .select()
        .from(participantTable)
        .where(and(eq(participantTable.roomId, roomId), eq(participantTable.entityId, entityId)))
        .limit(1);

      return result.length > 0;
    });
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
  ): Promise<"FOLLOWED" | "MUTED" | null> {
    return this.withDatabase(async () => {
      const result = await this.db
        .select({ roomState: participantTable.roomState })
        .from(participantTable)
        .where(
          and(
            eq(participantTable.roomId, roomId),
            eq(participantTable.entityId, entityId),
            eq(participantTable.agentId, this.agentId)
          )
        )
        .limit(1);

      const result0 = result[0];
      return (result0?.roomState as "FOLLOWED" | "MUTED" | null) ?? null;
    });
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
    state: "FOLLOWED" | "MUTED" | null
  ): Promise<void> {
    return this.withDatabase(async () => {
      try {
        await this.db.transaction(async (tx) => {
          await tx
            .update(participantTable)
            .set({ roomState: state })
            .where(
              and(
                eq(participantTable.roomId, roomId),
                eq(participantTable.entityId, entityId),
                eq(participantTable.agentId, this.agentId)
              )
            );
        });
      } catch (error) {
        // error-policy:J2 context-adding rethrow — attach the participant/state
        // context to the surfaced failure.
        throw new ElizaError("setParticipantUserState failed", {
          code: "DB_UPDATE_FAILED",
          cause: error,
          context: { table: "participants", roomId, entityId, state },
        });
      }
    });
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
    return this.withDatabase(async () => {
      const id = v4();
      const saveParams = {
        id,
        sourceEntityId: params.sourceEntityId,
        targetEntityId: params.targetEntityId,
        agentId: this.agentId,
        tags: params.tags || [],
        metadata: params.metadata || {},
      };
      try {
        const inserted = await this.db
          .insert(relationshipTable)
          .values(saveParams)
          .onConflictDoNothing()
          .returning();
        return inserted.length > 0;
      } catch (error) {
        // error-policy:J2 context-adding rethrow — false is the typed "already
        // existed (onConflictDoNothing)" signal; an insert failure must not
        // collapse into it.
        throw new ElizaError("createRelationship failed", {
          code: "DB_INSERT_FAILED",
          cause: error,
          context: {
            table: "relationships",
            agentId: this.agentId,
            sourceEntityId: params.sourceEntityId,
            targetEntityId: params.targetEntityId,
          },
        });
      }
    });
  }

  /**
   * Asynchronously updates an existing relationship in the database based on the provided parameters.
   * @param {Relationship} relationship - The relationship object to update.
   * @returns {Promise<void>} A Promise that resolves when the relationship is updated.
   */
  async updateRelationship(relationship: Relationship): Promise<void> {
    return this.withDatabase(async () => {
      try {
        await this.db
          .update(relationshipTable)
          .set({
            tags: relationship.tags || [],
            metadata: relationship.metadata || {},
          })
          .where(eq(relationshipTable.id, relationship.id));
      } catch (error) {
        // error-policy:J2 context-adding rethrow — attach relationship context.
        throw new ElizaError("updateRelationship failed", {
          code: "DB_UPDATE_FAILED",
          cause: error,
          context: {
            table: "relationships",
            agentId: this.agentId,
            relationshipId: relationship.id,
          },
        });
      }
    });
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
    return this.withDatabase(async () => {
      const { sourceEntityId, targetEntityId } = params;
      const result = await this.db
        .select()
        .from(relationshipTable)
        .where(
          and(
            eq(relationshipTable.sourceEntityId, sourceEntityId),
            eq(relationshipTable.targetEntityId, targetEntityId)
          )
        );
      if (result.length === 0) return null;
      const relationship = result[0];
      return {
        ...relationship,
        id: relationship.id as UUID,
        sourceEntityId: relationship.sourceEntityId as UUID,
        targetEntityId: relationship.targetEntityId as UUID,
        agentId: relationship.agentId as UUID,
        tags: (relationship.tags ?? []) as string[],
        metadata: (relationship.metadata ?? {}) as Metadata,
        createdAt: relationship.createdAt.toISOString(),
      };
    });
  }

  /**
   * Asynchronously retrieves relationships from the database based on the provided parameters.
   * @param {Object} params - The parameters for retrieving relationships.
   * @param {UUID[]} [params.entityIds] - Entity IDs to retrieve relationships for.
   * @param {UUID} [params.entityId] - Legacy single-entity alias.
   * @param {string[]} [params.tags] - The tags to filter relationships by.
   * @returns {Promise<Relationship[]>} A Promise that resolves to an array of relationships.
   */
  async getRelationships(params: {
    entityIds?: UUID[];
    entityId?: UUID;
    tags?: string[];
    limit?: number;
    offset?: number;
  }): Promise<Relationship[]> {
    return this.withDatabase(async () => {
      const { entityIds: rawEntityIds, entityId, tags, limit, offset } = params;
      const entityIds = (
        rawEntityIds && rawEntityIds.length > 0 ? rawEntityIds : entityId ? [entityId] : []
      ).filter((id): id is UUID => typeof id === "string" && id.trim().length > 0);

      if (entityIds.length === 0) {
        return [];
      }

      const entityFilter = sql.join(
        entityIds.map(
          (id) =>
            sql`(${relationshipTable.sourceEntityId} = ${id} OR ${relationshipTable.targetEntityId} = ${id})`
        ),
        sql` OR `
      );
      let query = sql`
        SELECT * FROM ${relationshipTable}
        WHERE (${entityFilter})
      `;

      if (tags && tags.length > 0) {
        query = sql`
          ${query}
          AND ${relationshipTable.tags} && CAST(ARRAY[${sql.join(tags, sql`, `)}] AS text[])
        `;
      }

      if (typeof limit === "number") {
        query = sql`${query} LIMIT ${limit}`;
      }

      if (typeof offset === "number" && offset > 0) {
        query = sql`${query} OFFSET ${offset}`;
      }

      const result = await this.db.execute(query);

      return result.rows.map((relationship: Record<string, unknown>) => ({
        ...relationship,
        id: relationship.id as UUID,
        sourceEntityId: (relationship.source_entity_id || relationship.sourceEntityId) as UUID,
        targetEntityId: (relationship.target_entity_id || relationship.targetEntityId) as UUID,
        agentId: (relationship.agent_id || relationship.agentId) as UUID,
        tags: (relationship.tags ?? []) as string[],
        metadata: (relationship.metadata ?? {}) as Metadata,
        createdAt:
          relationship.created_at || relationship.createdAt
            ? (relationship.created_at || relationship.createdAt) instanceof Date
              ? ((relationship.created_at || relationship.createdAt) as Date).toISOString()
              : new Date(
                  (relationship.created_at as string) || (relationship.createdAt as string)
                ).toISOString()
            : new Date().toISOString(),
      }));
    });
  }

  /**
   * Asynchronously retrieves a cache value from the database based on the provided key.
   * @param {string} key - The key to retrieve the cache value for.
   * @returns {Promise<T | undefined>} A Promise that resolves to the cache value if found, undefined otherwise.
   */
  async getCache<T>(key: string): Promise<T | undefined> {
    return this.withDatabase(async () => {
      try {
        const result = await this.db
          .select({ value: cacheTable.value })
          .from(cacheTable)
          .where(and(eq(cacheTable.agentId, this.agentId), eq(cacheTable.key, key)))
          .limit(1);

        if (result && result.length > 0 && result[0]) {
          return result[0].value as T | undefined;
        }

        return undefined;
      } catch (error) {
        // error-policy:J2 context-adding rethrow — undefined is the typed cache
        // miss; a query failure must not read as "not cached".
        throw new ElizaError("getCache failed", {
          code: "DB_QUERY_FAILED",
          cause: error,
          context: { table: "cache", agentId: this.agentId, key },
        });
      }
    });
  }

  /**
   * Asynchronously sets a cache value in the database based on the provided key and value.
   * @param {string} key - The key to set the cache value for.
   * @param {T} value - The value to set in the cache.
   * @returns {Promise<boolean>} A Promise that resolves to a boolean indicating whether the cache value was set successfully.
   */
  async setCache<T>(key: string, value: T): Promise<boolean> {
    return this.withDatabase(async () => {
      try {
        await this.db
          .insert(cacheTable)
          .values({
            key: key,
            agentId: this.agentId,
            value: value,
          })
          .onConflictDoUpdate({
            target: [cacheTable.key, cacheTable.agentId],
            set: {
              value: value,
            },
          });

        return true;
      } catch (error) {
        // error-policy:J2 context-adding rethrow — setCache only returns true on
        // success, so false here masked a real write failure.
        throw new ElizaError("setCache failed", {
          code: "DB_UPSERT_FAILED",
          cause: error,
          context: { table: "cache", agentId: this.agentId, key },
        });
      }
    });
  }

  /**
   * Asynchronously deletes a cache value from the database based on the provided key.
   * @param {string} key - The key to delete the cache value for.
   * @returns {Promise<boolean>} A Promise that resolves to a boolean indicating whether the cache value was deleted successfully.
   */
  async deleteCache(key: string): Promise<boolean> {
    return this.withDatabase(async () => {
      try {
        await this.db.transaction(async (tx) => {
          await tx
            .delete(cacheTable)
            .where(and(eq(cacheTable.agentId, this.agentId), eq(cacheTable.key, key)));
        });
        return true;
      } catch (error) {
        // error-policy:J2 context-adding rethrow — deleteCache only returns true
        // on success, so false here masked a real delete failure.
        throw new ElizaError("deleteCache failed", {
          code: "DB_DELETE_FAILED",
          cause: error,
          context: { table: "cache", agentId: this.agentId, key },
        });
      }
    });
  }

  /**
   * Asynchronously creates a new world in the database based on the provided parameters.
   * @param {World} world - The world object to create.
   * @returns {Promise<UUID>} A Promise that resolves to the ID of the created world.
   */
  async createWorld(world: World): Promise<UUID> {
    return this.withDatabase(async () => {
      const normalizedWorld = this.normalizeWorldData(world);
      const newWorldId = normalizedWorld.id as UUID;

      await this.db.insert(worldTable).values(normalizedWorld);
      return newWorldId;
    });
  }

  /**
   * Asynchronously retrieves a world from the database based on the provided parameters.
   * @param {UUID} id - The ID of the world to retrieve.
   * @returns {Promise<World | null>} A Promise that resolves to the world if found, null otherwise.
   */
  async getWorld(id: UUID): Promise<World | null> {
    return this.withDatabase(async () => {
      const result = await this.db.select().from(worldTable).where(eq(worldTable.id, id));
      return result.length > 0 ? this.mapWorldResult(result[0]) : null;
    });
  }

  /**
   * Asynchronously retrieves all worlds from the database based on the provided parameters.
   * @returns {Promise<World[]>} A Promise that resolves to an array of worlds.
   */
  async getAllWorlds(): Promise<World[]> {
    return this.withDatabase(async () => {
      const result = await this.db
        .select()
        .from(worldTable)
        .where(eq(worldTable.agentId, this.agentId));
      return result.map((world) => this.mapWorldResult(world));
    });
  }

  /**
   * Asynchronously updates an existing world in the database based on the provided parameters.
   * @param {World} world - The world object to update.
   * @returns {Promise<void>} A Promise that resolves when the world is updated.
   */
  async updateWorld(world: World): Promise<void> {
    return this.withDatabase(async () => {
      const normalizedWorld = this.normalizeWorldData(world);
      delete normalizedWorld.id;
      await this.db
        .update(worldTable)
        .set(normalizedWorld)
        .where(and(eq(worldTable.id, world.id), eq(worldTable.agentId, this.agentId)));
    });
  }

  /**
   * Asynchronously removes a world from the database based on the provided parameters.
   * @param {UUID} id - The ID of the world to remove.
   * @returns {Promise<void>} A Promise that resolves when the world is removed.
   */
  async removeWorld(id: UUID): Promise<void> {
    return this.withDatabase(async () => {
      await this.db.delete(worldTable).where(eq(worldTable.id, id));
    });
  }

  /**
   * Asynchronously creates a new task in the database based on the provided parameters.
   * @param {Task} task - The task object to create.
   * @returns {Promise<UUID>} A Promise that resolves to the ID of the created task.
   */
  async createTask(task: Task): Promise<UUID> {
    // Default worldId to agentId for agent-internal tasks
    if (!task.worldId) {
      task = { ...task, worldId: this.agentId as UUID };
    }
    return this.withRetry(async () => {
      return this.withDatabase(async () => {
        const now = new Date();
        const metadata = task.metadata || {};

        const values = {
          // Only include id when provided; otherwise let the DB use its
          // gen_random_uuid() DEFAULT — passing undefined explicitly causes
          // Drizzle to insert NULL which violates the NOT NULL constraint.
          ...(task.id ? { id: task.id as UUID } : {}),
          name: task.name,
          description: task.description,
          roomId: task.roomId as UUID,
          worldId: task.worldId as UUID,
          tags: task.tags,
          metadata: metadata,
          createdAt: now,
          updatedAt: now,
          agentId: this.agentId as UUID,
        };

        const result = await this.db.insert(taskTable).values(values).returning();

        return result[0].id as UUID;
      });
    });
  }

  /**
   * Asynchronously retrieves tasks based on specified parameters.
   * @param params Object containing optional roomId, tags, and entityId to filter tasks
   * @returns Promise resolving to an array of Task objects
   */
  async getTasks(params: {
    roomId?: UUID;
    tags?: string[];
    entityId?: UUID; // Added entityId parameter
  }): Promise<Task[]> {
    return this.withRetry(async () => {
      return this.withDatabase(async () => {
        const result = await this.db
          .select()
          .from(taskTable)
          .where(
            and(
              eq(taskTable.agentId, this.agentId),
              ...(params.roomId ? [eq(taskTable.roomId, params.roomId)] : []),
              ...(params.tags && params.tags.length > 0
                ? [
                    sql`${taskTable.tags} @> ARRAY[${sql.join(
                      params.tags.map((t) => sql`${t}`),
                      sql`, `
                    )}]::text[]`,
                  ]
                : [])
            )
          );

        return result.map((row) => ({
          id: row.id as UUID,
          agentId: row.agentId as UUID,
          name: row.name,
          description: row.description ?? "",
          roomId: row.roomId as UUID,
          worldId: row.worldId as UUID,
          tags: row.tags || [],
          metadata: row.metadata as TaskMetadata,
        }));
      });
    });
  }

  /**
   * Asynchronously retrieves a specific task by its name.
   * @param name The name of the task to retrieve
   * @returns Promise resolving to the Task object if found, null otherwise
   */
  async getTasksByName(name: string): Promise<Task[]> {
    return this.withRetry(async () => {
      return this.withDatabase(async () => {
        const result = await this.db
          .select()
          .from(taskTable)
          .where(and(eq(taskTable.name, name), eq(taskTable.agentId, this.agentId)));

        return result.map((row) => ({
          id: row.id as UUID,
          agentId: row.agentId as UUID,
          name: row.name,
          description: row.description ?? "",
          roomId: row.roomId as UUID,
          worldId: row.worldId as UUID,
          tags: row.tags || [],
          metadata: (row.metadata || {}) as TaskMetadata,
        }));
      });
    });
  }

  /**
   * Asynchronously retrieves a specific task by its ID.
   * @param id The UUID of the task to retrieve
   * @returns Promise resolving to the Task object if found, null otherwise
   */
  async getTask(id: UUID): Promise<Task | null> {
    return this.withRetry(async () => {
      return this.withDatabase(async () => {
        const result = await this.db
          .select()
          .from(taskTable)
          .where(and(eq(taskTable.id, id), eq(taskTable.agentId, this.agentId)))
          .limit(1);

        if (result.length === 0) {
          return null;
        }

        const row = result[0];
        return {
          id: row.id as UUID,
          agentId: row.agentId as UUID,
          name: row.name,
          description: row.description ?? "",
          roomId: row.roomId as UUID,
          worldId: row.worldId as UUID,
          tags: row.tags || [],
          metadata: (row.metadata || {}) as TaskMetadata,
        };
      });
    });
  }

  /**
   * Asynchronously updates an existing task in the database.
   * @param id The UUID of the task to update
   * @param task Partial Task object containing the fields to update
   * @returns Promise resolving when the update is complete
   */
  async updateTask(id: UUID, task: Partial<Task>): Promise<void> {
    await this.withRetry(async () => {
      await this.withDatabase(async () => {
        const updateValues: Partial<typeof taskTable.$inferInsert> = {};

        // Add fields to update if they exist in the partial task object
        if (task.name !== undefined) updateValues.name = task.name;
        if (task.description !== undefined) updateValues.description = task.description;
        if (task.roomId !== undefined) updateValues.roomId = task.roomId;
        if (task.worldId !== undefined) updateValues.worldId = task.worldId;
        if (task.tags !== undefined) updateValues.tags = task.tags;
        if (task.metadata !== undefined)
          updateValues.metadata = task.metadata as typeof taskTable.$inferInsert.metadata;
        // Handle createdAt if present in the task object (using type assertion for compatibility)
        const taskWithCreatedAt = task as {
          createdAt?: number | bigint | null;
        };
        if (taskWithCreatedAt.createdAt !== undefined && taskWithCreatedAt.createdAt !== null) {
          const createdAtValue = taskWithCreatedAt.createdAt;
          updateValues.createdAt = new Date(
            typeof createdAtValue === "bigint" ? Number(createdAtValue) : createdAtValue
          );
        }

        // Always update the updatedAt timestamp as a Date (schema uses Date, not number)
        const dbUpdateValues: Partial<typeof taskTable.$inferInsert> = {
          ...updateValues,
          updatedAt: new Date(),
        };

        // Handle metadata updates - just set it directly without merging
        if (task.metadata !== undefined) {
          dbUpdateValues.metadata = task.metadata;
        }

        await this.db
          .update(taskTable)
          // createdAt is hella borked, number / Date
          .set(dbUpdateValues)
          .where(and(eq(taskTable.id, id), eq(taskTable.agentId, this.agentId)));
      });
    });
  }

  /**
   * Asynchronously deletes a task from the database.
   * @param id The UUID of the task to delete
   * @returns Promise resolving when the deletion is complete
   */
  async deleteTask(id: UUID): Promise<void> {
    return this.withDatabase(async () => {
      await this.db.delete(taskTable).where(eq(taskTable.id, id));
    });
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
        tableName: params.tableName || "messages",
        limit: params.count,
      });

      return memories;
    });
  }

  async getMemoriesByServerId(params: {
    serverId: UUID;
    count?: number;
    tableName?: string;
  }): Promise<Memory[]> {
    return this.withDatabase(async () => {
      const rooms = await this.db
        .select({ id: roomTable.id })
        .from(roomTable)
        .where(
          and(eq(roomTable.messageServerId, params.serverId), eq(roomTable.agentId, this.agentId))
        );

      if (rooms.length === 0) {
        return [];
      }

      return this.getMemoriesByRoomIds({
        roomIds: rooms.map((room) => room.id as UUID),
        tableName: params.tableName || "messages",
        limit: params.count,
      });
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
            src: "plugin:sql",
            worldId,
            roomsDeleted: roomIds.length,
            memoriesDeleted: memoryIdsInRooms.length,
          },
          "World cleanup completed"
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

      await this.db.insert(messageServerTable).values(serverToInsert).onConflictDoNothing(); // In case the ID already exists

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
            metadata: (existing[0].metadata || undefined) as Metadata | undefined,
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
        metadata: (r.metadata || undefined) as Metadata | undefined,
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
            metadata: (results[0].metadata || undefined) as Metadata | undefined,
            createdAt: results[0].createdAt,
            updatedAt: results[0].updatedAt,
          }
        : null;
    });
  }

  /**
   * Gets a message server by RLS server_id.
   * The server_id column is added dynamically when RLS is enabled.
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
      return (rows as Record<string, unknown>[]).length > 0
        ? {
            id: (rows as Record<string, unknown>[])[0].id as UUID,
            name: (rows as Record<string, unknown>[])[0].name as string,
            sourceType: (rows as Record<string, unknown>[])[0].source_type as string,
            sourceId: ((rows as Record<string, unknown>[])[0].source_id || undefined) as
              | string
              | undefined,
            metadata: ((rows as Record<string, unknown>[])[0].metadata || undefined) as
              | Metadata
              | undefined,
            createdAt: new Date((rows as Record<string, unknown>[])[0].created_at as string),
            updatedAt: new Date((rows as Record<string, unknown>[])[0].updated_at as string),
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

      await this.db.transaction(async (tx) => {
        await tx.insert(channelTable).values(channelToInsert);

        if (participantIds && participantIds.length > 0) {
          const participantValues = participantIds.map((entityId) => ({
            channelId: newId,
            entityId: entityId,
          }));
          await tx.insert(channelParticipantsTable).values(participantValues).onConflictDoNothing();
        }
      });

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
        metadata: (r.metadata || undefined) as Metadata | undefined,
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
            metadata: (results[0].metadata || undefined) as Metadata | undefined,
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
  } | null> {
    return this.withDatabase(async () => {
      const rows = await this.db
        .select()
        .from(messageTable)
        .where(eq(messageTable.id, id))
        .limit(1);
      if (!rows || rows.length === 0) return null;
      const row = rows[0];
      return {
        id: row.id as UUID,
        channelId: row.channelId as UUID,
        authorId: row.authorId as UUID,
        content: row.content,
        rawMessage: asRawMessage(row.rawMessage),
        sourceType: row.sourceType || undefined,
        sourceId: row.sourceId || undefined,
        metadata: (row.metadata || undefined) as Metadata | undefined,
        inReplyToRootMessageId: (row.inReplyToRootMessageId || undefined) as UUID | undefined,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      };
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
        rawMessage: asRawMessage(r.rawMessage),
        sourceType: r.sourceType || undefined,
        sourceId: r.sourceId || undefined,
        metadata: asMetadata(r.metadata),
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
    return this.withDatabase(async () => {
      const now = new Date();

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
          metadata: (existingChannels[0].metadata || undefined) as Metadata | undefined,
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

  // ===============================
  // Pairing Methods
  // ===============================

  /**
   * Get all pending pairing requests for a channel and agent.
   */
  async getPairingRequests(
    queries: Array<{ channel: PairingChannel; agentId: UUID }>
  ): Promise<PairingRequestsResult> {
    return this.withDatabase(async () => {
      if (queries.length === 0) {
        return [];
      }

      return Promise.all(
        queries.map(async ({ channel, agentId }) => {
          const results = await this.db
            .select()
            .from(pairingRequestTable)
            .where(
              and(
                eq(pairingRequestTable.channel, channel),
                eq(pairingRequestTable.agentId, agentId)
              )
            )
            .orderBy(pairingRequestTable.createdAt);

          return {
            channel,
            agentId,
            requests: results.map((row) => ({
              id: row.id as UUID,
              channel: row.channel as PairingChannel,
              senderId: row.senderId,
              code: row.code,
              createdAt: row.createdAt,
              lastSeenAt: row.lastSeenAt,
              metadata: (row.metadata as Record<string, string>) || undefined,
              agentId: row.agentId as UUID,
            })),
          };
        })
      );
    });
  }

  /**
   * Create a new pairing request.
   */
  async createPairingRequest(request: PairingRequest): Promise<UUID> {
    return this.withDatabase(async () => {
      const id = request.id || (v4() as UUID);
      await this.db.insert(pairingRequestTable).values({
        id,
        channel: request.channel,
        senderId: request.senderId,
        code: request.code,
        createdAt: request.createdAt,
        lastSeenAt: request.lastSeenAt,
        metadata: request.metadata || {},
        agentId: request.agentId,
      });
      return id;
    });
  }

  /**
   * Update an existing pairing request.
   */
  async updatePairingRequest(request: PairingRequest): Promise<void> {
    return this.withDatabase(async () => {
      await this.db
        .update(pairingRequestTable)
        .set({
          lastSeenAt: request.lastSeenAt,
          metadata: request.metadata || {},
        })
        .where(eq(pairingRequestTable.id, request.id));
    });
  }

  /**
   * Delete a pairing request by ID.
   */
  async deletePairingRequest(id: UUID): Promise<void> {
    return this.withDatabase(async () => {
      await this.db.delete(pairingRequestTable).where(eq(pairingRequestTable.id, id));
    });
  }

  /**
   * Get the allowlist for a channel and agent.
   */
  async getPairingAllowlist(
    channel: PairingChannel,
    agentId: UUID
  ): Promise<PairingAllowlistEntry[]> {
    return this.withDatabase(async () => {
      const results = await this.db
        .select()
        .from(pairingAllowlistTable)
        .where(
          and(
            eq(pairingAllowlistTable.channel, channel),
            eq(pairingAllowlistTable.agentId, agentId)
          )
        )
        .orderBy(pairingAllowlistTable.createdAt);

      return results.map((row) => ({
        id: row.id as UUID,
        channel: row.channel as PairingChannel,
        senderId: row.senderId,
        createdAt: row.createdAt,
        metadata: (row.metadata as Record<string, string>) || undefined,
        agentId: row.agentId as UUID,
      }));
    });
  }

  /**
   * Create a new allowlist entry.
   */
  async createPairingAllowlistEntry(entry: PairingAllowlistEntry): Promise<UUID> {
    return this.withDatabase(async () => {
      const id = entry.id || (v4() as UUID);
      await this.db
        .insert(pairingAllowlistTable)
        .values({
          id,
          channel: entry.channel,
          senderId: entry.senderId,
          createdAt: entry.createdAt,
          metadata: entry.metadata || {},
          agentId: entry.agentId,
        })
        .onConflictDoNothing();
      return id;
    });
  }

  /**
   * Delete an allowlist entry by ID.
   */
  async deletePairingAllowlistEntry(id: UUID): Promise<void> {
    return this.withDatabase(async () => {
      await this.db.delete(pairingAllowlistTable).where(eq(pairingAllowlistTable.id, id));
    });
  }

  // ── Lifecycle methods ─────────────────────────────────────────────────

  async isReady(): Promise<boolean> {
    // error-policy:J4 explicit availability probe — false IS the designed answer
    // to "can the DB serve a query?"; a failing SELECT 1 means not-ready.
    try {
      await this.db.execute(sql`SELECT 1`);
      return true;
    } catch {
      return false;
    }
  }

  async getConnection(): Promise<DrizzleDatabase> {
    return this.db;
  }

  async transaction<T>(
    callback: (tx: IDatabaseAdapter<DrizzleDatabase>) => Promise<T>,
    _options?: { entityContext?: UUID }
  ): Promise<T> {
    // Delegate to the callback with this adapter as the transaction context.
    // True DB-level transactions are handled by drizzle's this.db.transaction() in individual methods.
    return callback(this as IDatabaseAdapter<DrizzleDatabase>);
  }

  // ── Component batch methods ───────────────────────────────────────────

  async getComponentsByNaturalKeys(
    keys: Array<{
      entityId: UUID;
      type: string;
      worldId?: UUID;
      sourceEntityId?: UUID;
    }>
  ): Promise<(Component | null)[]> {
    if (keys.length === 0) return [];
    const results: (Component | null)[] = [];
    for (const key of keys) {
      const component = await this.getComponent(
        key.entityId,
        key.type,
        key.worldId,
        key.sourceEntityId
      );
      results.push(component);
    }
    return results;
  }

  async getComponentsForEntities(
    entityIds: UUID[],
    worldId?: UUID,
    sourceEntityId?: UUID
  ): Promise<Component[]> {
    if (entityIds.length === 0) return [];
    return this.withDatabase(async () => {
      const conditions: SQL[] = [inArray(componentTable.entityId, entityIds)];
      if (worldId) {
        conditions.push(eq(componentTable.worldId, worldId));
      }
      if (sourceEntityId) {
        conditions.push(eq(componentTable.sourceEntityId, sourceEntityId));
      }
      const result = await this.db
        .select()
        .from(componentTable)
        .where(and(...conditions));
      return result.map((component) => ({
        ...component,
        id: component.id as UUID,
        entityId: component.entityId as UUID,
        agentId: component.agentId as UUID,
        roomId: component.roomId as UUID,
        worldId: (component.worldId ?? "") as UUID,
        sourceEntityId: (component.sourceEntityId ?? "") as UUID,
        data: component.data as Metadata,
        createdAt: component.createdAt.getTime(),
      }));
    });
  }

  async createComponents(components: Component[]): Promise<UUID[]> {
    if (components.length === 0) return [];
    return this.withDatabase(async () => {
      const ids: UUID[] = [];
      for (const component of components) {
        const success = await this.createComponent(component);
        if (success) ids.push(component.id);
      }
      return ids;
    });
  }

  async getComponentsByIds(componentIds: UUID[]): Promise<Component[]> {
    if (componentIds.length === 0) return [];
    return this.withDatabase(async () => {
      const result = await this.db
        .select()
        .from(componentTable)
        .where(inArray(componentTable.id, componentIds));
      return result.map((component) => ({
        ...component,
        id: component.id as UUID,
        entityId: component.entityId as UUID,
        agentId: component.agentId as UUID,
        roomId: component.roomId as UUID,
        worldId: (component.worldId ?? "") as UUID,
        sourceEntityId: (component.sourceEntityId ?? "") as UUID,
        data: component.data as Metadata,
        createdAt: component.createdAt.getTime(),
      }));
    });
  }

  async updateComponents(components: Component[]): Promise<void> {
    for (const component of components) {
      await this.updateComponent(component);
    }
  }

  async deleteComponents(componentIds: UUID[]): Promise<void> {
    if (componentIds.length === 0) return;
    return this.withDatabase(async () => {
      await this.db.delete(componentTable).where(inArray(componentTable.id, componentIds));
    });
  }

  async upsertComponents(
    components: Component[],
    _options?: { entityContext?: UUID }
  ): Promise<void> {
    for (const component of components) {
      const existing = await this.getComponent(
        component.entityId,
        component.type,
        component.worldId,
        component.sourceEntityId
      );
      if (existing) {
        await this.updateComponent({ ...component, id: existing.id });
      } else {
        await this.createComponent(component);
      }
    }
  }

  async patchComponents(
    updates: Array<{ componentId: UUID; ops: PatchOp[] }>,
    _options?: { entityContext?: UUID }
  ): Promise<void> {
    for (const update of updates) {
      const rows = await this.withDatabase(async () =>
        this.db.select().from(componentTable).where(eq(componentTable.id, update.componentId))
      );
      const row = rows[0];
      if (!row) continue;

      const data = { ...((row.data ?? {}) as Record<string, unknown>) };
      for (const op of update.ops) {
        applyPatchOp(data, op);
      }

      await this.withDatabase(async () => {
        await this.db
          .update(componentTable)
          .set({ data })
          .where(eq(componentTable.id, update.componentId));
      });
    }
  }

  // ── Entity batch methods ──────────────────────────────────────────────

  async upsertEntities(entities: Entity[]): Promise<void> {
    for (const entity of entities) {
      if (!entity.id) {
        await this.createEntities([entity]);
        continue;
      }
      const existing = await this.getEntitiesByIds([entity.id]);
      if (existing.length > 0) {
        await this.updateEntity(entity);
      } else {
        await this.createEntities([entity]);
      }
    }
  }

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
    // If specific entityIds are provided, delegate to getEntitiesByIds
    if (params.entityIds?.length) {
      const entities = await this.getEntitiesByIds(params.entityIds);
      return entities || [];
    }

    return this.withDatabase(async () => {
      const conditions: SQL[] = [];

      if (params.agentId) {
        conditions.push(eq(entityTable.agentId, params.agentId));
      }

      // Build a single EXISTS subquery when filtering by componentType,
      // component data, and/or worldId.
      // Both predicates apply to the component table so they share one subquery.
      if (params.componentType || params.componentDataFilter || params.worldId) {
        const subConditions: SQL[] = [sql`${componentTable.entityId} = ${entityTable.id}`];
        if (params.componentType) {
          subConditions.push(sql`${componentTable.type} = ${params.componentType}`);
        }
        if (params.componentDataFilter) {
          subConditions.push(
            sql`${componentTable.data} @> ${JSON.stringify(params.componentDataFilter)}::jsonb`
          );
        }
        if (params.worldId) {
          subConditions.push(sql`${componentTable.worldId} = ${params.worldId}`);
        }
        const subquery = sql`EXISTS (
          SELECT 1 FROM ${componentTable}
          WHERE ${sql.join(subConditions, sql` AND `)}
        )`;
        conditions.push(subquery);
      }

      let query = this.db
        .select()
        .from(entityTable)
        .where(conditions.length > 0 ? and(...conditions) : undefined);

      if (params.limit) {
        query = query.limit(params.limit) as typeof query;
      }
      if (params.offset) {
        query = query.offset(params.offset) as typeof query;
      }

      const result = await query;

      const entities: Entity[] = result.map((row) => ({
        ...row,
        id: row.id as UUID,
        agentId: row.agentId as UUID,
        names: (row.names || []) as string[],
        metadata: (row.metadata || {}) as Metadata,
      }));

      // Load components for returned entities when requested
      if (params.includeAllComponents && entities.length > 0) {
        const entityIds = entities.flatMap((entity) => (entity.id ? [entity.id] : []));
        const components = await this.getComponentsForEntities(entityIds, params.worldId);
        const componentsByEntity = new Map<UUID, Component[]>();
        for (const comp of components) {
          const list = componentsByEntity.get(comp.entityId) ?? [];
          list.push(comp);
          componentsByEntity.set(comp.entityId, list);
        }
        for (const entity of entities) {
          entity.components = entity.id ? (componentsByEntity.get(entity.id) ?? []) : [];
        }
      }

      return entities;
    });
  }

  async updateEntities(entities: Entity[]): Promise<void> {
    for (const entity of entities) {
      await this.updateEntity(entity);
    }
  }

  async deleteEntities(entityIds: UUID[]): Promise<void> {
    for (const entityId of entityIds) {
      await this.deleteEntity(entityId);
    }
  }

  async getEntitiesForRooms(
    roomIds: UUID[],
    includeComponents?: boolean
  ): Promise<EntitiesForRoomsResult> {
    const result: EntitiesForRoomsResult = [];
    for (const roomId of roomIds) {
      const entities = await this.getEntitiesForRoom(roomId, includeComponents);
      result.push({ roomId, entities });
    }
    return result;
  }

  // ── Log batch methods ─────────────────────────────────────────────────

  async createLogs(
    params: Array<{
      body: LogBody;
      entityId: UUID;
      roomId: UUID;
      type: string;
    }>
  ): Promise<void> {
    for (const param of params) {
      await this.log(param);
    }
  }

  async getLogsByIds(logIds: UUID[]): Promise<Log[]> {
    if (logIds.length === 0) return [];
    return this.withDatabase(async () => {
      const result = await this.db.select().from(logTable).where(inArray(logTable.id, logIds));
      return result.map((log) => ({
        ...log,
        id: log.id as UUID,
        entityId: log.entityId as UUID,
        roomId: log.roomId as UUID,
        type: log.type as string,
        body: log.body as LogBody,
        createdAt: new Date(log.createdAt as string | number | Date),
      }));
    });
  }

  async updateLogs(logs: Array<{ id: UUID; updates: Partial<Log> }>): Promise<void> {
    return this.withDatabase(async () => {
      for (const { id, updates } of logs) {
        const setValues: Record<string, unknown> = {};
        if (updates.body !== undefined) setValues.body = updates.body;
        if (updates.type !== undefined) setValues.type = updates.type;
        if (Object.keys(setValues).length > 0) {
          await this.db.update(logTable).set(setValues).where(eq(logTable.id, id));
        }
      }
    });
  }

  async deleteLogs(logIds: UUID[]): Promise<void> {
    if (logIds.length === 0) return;
    return this.withDatabase(async () => {
      await this.db.delete(logTable).where(inArray(logTable.id, logIds));
    });
  }

  // ── Memory batch methods ──────────────────────────────────────────────

  async createMemories(
    memories: Array<{ memory: Memory; tableName: string; unique?: boolean }>
  ): Promise<UUID[]> {
    const ids: UUID[] = [];
    for (const { memory, tableName, unique } of memories) {
      const memoryWithUnique = unique !== undefined ? { ...memory, unique } : memory;
      const id = await this.createMemory(memoryWithUnique, tableName);
      ids.push(id);
    }
    return ids;
  }

  async updateMemories(
    memories: Array<Partial<Memory> & { id: UUID; metadata?: MemoryMetadata }>
  ): Promise<void> {
    for (const memory of memories) {
      await this.updateMemory(memory);
    }
  }

  async upsertMemories(
    memories: Array<{ memory: Memory; tableName: string }>,
    _options?: { entityContext?: UUID }
  ): Promise<void> {
    for (const { memory, tableName } of memories) {
      if (memory.id) {
        const existing = await this.getMemoryById(memory.id);
        if (existing) {
          await this.updateMemory(memory as Partial<Memory> & { id: UUID });
          continue;
        }
      }
      await this.createMemory(memory, tableName);
    }
  }

  async deleteMemories(memoryIds: UUID[]): Promise<void> {
    await this.deleteManyMemories(memoryIds);
  }

  // ── World batch methods ───────────────────────────────────────────────

  async getWorldsByIds(worldIds: UUID[]): Promise<World[]> {
    if (worldIds.length === 0) return [];
    return this.withDatabase(async () => {
      const result = await this.db
        .select()
        .from(worldTable)
        .where(inArray(worldTable.id, worldIds));
      return result.map((world) => this.mapWorldResult(world));
    });
  }

  async createWorlds(worlds: World[]): Promise<UUID[]> {
    const ids: UUID[] = [];
    for (const world of worlds) {
      const id = await this.createWorld(world);
      ids.push(id);
    }
    return ids;
  }

  async deleteWorlds(worldIds: UUID[]): Promise<void> {
    for (const id of worldIds) {
      await this.removeWorld(id);
    }
  }

  async updateWorlds(worlds: World[]): Promise<void> {
    for (const world of worlds) {
      await this.updateWorld(world);
    }
  }

  async upsertWorlds(worlds: World[]): Promise<void> {
    for (const world of worlds) {
      const existing = await this.getWorld(world.id);
      if (existing) {
        await this.updateWorld(world);
      } else {
        await this.createWorld(world);
      }
    }
  }

  // ── Room batch methods ────────────────────────────────────────────────

  async deleteRoomsByWorldIds(worldIds: UUID[]): Promise<void> {
    for (const worldId of worldIds) {
      await this.deleteRoomsByWorldId(worldId);
    }
  }

  async getRoomsByWorlds(worldIds: UUID[], limit?: number, offset?: number): Promise<Room[]> {
    if (worldIds.length === 0) return [];
    return this.withDatabase(async () => {
      const conditions = [
        inArray(roomTable.worldId, worldIds),
        eq(roomTable.agentId, this.agentId),
      ];
      let query = this.db
        .select()
        .from(roomTable)
        .where(and(...conditions));
      if (offset) {
        query = query.offset(offset) as typeof query;
      }
      if (limit) {
        query = query.limit(limit) as typeof query;
      }
      const result = await query;
      return result.map((room) => ({
        ...room,
        id: room.id as UUID,
        name: room.name ?? undefined,
        agentId: room.agentId as UUID,
        messageServerId: room.messageServerId as UUID,
        serverId: room.messageServerId as UUID,
        worldId: room.worldId as UUID,
        channelId: room.channelId as UUID,
        type: room.type as ChannelType,
        metadata: room.metadata as Metadata,
      }));
    });
  }

  async upsertRooms(rooms: Room[]): Promise<void> {
    for (const room of rooms) {
      const existing = await this.getRoomsByIds([room.id]);
      if (existing && existing.length > 0) {
        await this.updateRoom(room);
      } else {
        await this.createRooms([room]);
      }
    }
  }

  async createRoomParticipants(entityIds: UUID[], roomId: UUID): Promise<UUID[]> {
    const ids: UUID[] = [];
    for (const entityId of entityIds) {
      const success = await this.addParticipant(entityId, roomId);
      if (success) {
        ids.push(`${roomId}:${entityId}` as UUID);
      }
    }
    return ids;
  }

  async deleteParticipants(
    participants: Array<{ entityId: UUID; roomId: UUID }>
  ): Promise<boolean> {
    for (const { entityId, roomId } of participants) {
      const success = await this.removeParticipant(entityId, roomId);
      if (!success) return false;
    }
    return true;
  }

  async updateParticipants(
    participants: Array<{
      entityId: UUID;
      roomId: UUID;
      updates: ParticipantUpdateFields;
    }>
  ): Promise<void> {
    for (const { entityId, roomId, updates } of participants) {
      if (updates.roomState !== undefined) {
        await this.setParticipantUserState(roomId, entityId, updates.roomState);
      }
    }
  }

  async updateRooms(rooms: Room[]): Promise<void> {
    for (const room of rooms) {
      await this.updateRoom(room);
    }
  }

  async deleteRooms(roomIds: UUID[]): Promise<void> {
    for (const roomId of roomIds) {
      await this.deleteRoom(roomId);
    }
  }

  // ── Participant batch methods ─────────────────────────────────────────

  async getParticipantsForEntities(entityIds: UUID[]): Promise<Participant[]> {
    const result: Participant[] = [];
    for (const entityId of entityIds) {
      const participants = await this.getParticipantsForEntity(entityId);
      result.push(...participants);
    }
    return result;
  }

  async getParticipantsForRooms(roomIds: UUID[]): Promise<ParticipantsForRoomsResult> {
    const result: ParticipantsForRoomsResult = [];
    for (const roomId of roomIds) {
      const entityIds = await this.getParticipantsForRoom(roomId);
      result.push({ roomId, entityIds });
    }
    return result;
  }

  async areRoomParticipants(pairs: Array<{ roomId: UUID; entityId: UUID }>): Promise<boolean[]> {
    const results: boolean[] = [];
    for (const { roomId, entityId } of pairs) {
      const isParticipant = await this.isRoomParticipant(roomId, entityId);
      results.push(isParticipant);
    }
    return results;
  }

  async getParticipantUserStates(
    pairs: Array<{ roomId: UUID; entityId: UUID }>
  ): Promise<ParticipantUserState[]> {
    const results: ParticipantUserState[] = [];
    for (const { roomId, entityId } of pairs) {
      const state = await this.getParticipantUserState(roomId, entityId);
      results.push(state);
    }
    return results;
  }

  async updateParticipantUserStates(
    updates: Array<{
      roomId: UUID;
      entityId: UUID;
      state: ParticipantUserState;
    }>
  ): Promise<void> {
    for (const { roomId, entityId, state } of updates) {
      await this.setParticipantUserState(roomId, entityId, state);
    }
  }

  // ── Relationship batch methods ────────────────────────────────────────

  async getRelationshipsByPairs(
    pairs: Array<{ sourceEntityId: UUID; targetEntityId: UUID }>
  ): Promise<(Relationship | null)[]> {
    const results: (Relationship | null)[] = [];
    for (const pair of pairs) {
      const rel = await this.getRelationship(pair);
      results.push(rel);
    }
    return results;
  }

  async createRelationships(
    relationships: Array<{
      sourceEntityId: UUID;
      targetEntityId: UUID;
      tags?: string[];
      metadata?: Metadata;
    }>
  ): Promise<UUID[]> {
    const ids: UUID[] = [];
    for (const rel of relationships) {
      const id = v4() as UUID;
      const success = await this.createRelationship(rel);
      if (success) ids.push(id);
    }
    return ids;
  }

  async getRelationshipsByIds(relationshipIds: UUID[]): Promise<Relationship[]> {
    if (relationshipIds.length === 0) return [];
    return this.withDatabase(async () => {
      const result = await this.db
        .select()
        .from(relationshipTable)
        .where(inArray(relationshipTable.id, relationshipIds));
      return result.map((relationship) => ({
        ...relationship,
        id: relationship.id as UUID,
        sourceEntityId: relationship.sourceEntityId as UUID,
        targetEntityId: relationship.targetEntityId as UUID,
        agentId: relationship.agentId as UUID,
        tags: (relationship.tags ?? []) as string[],
        metadata: (relationship.metadata ?? {}) as Metadata,
        createdAt: relationship.createdAt.toISOString(),
      }));
    });
  }

  async updateRelationships(relationships: Relationship[]): Promise<void> {
    for (const relationship of relationships) {
      await this.updateRelationship(relationship);
    }
  }

  async deleteRelationships(relationshipIds: UUID[]): Promise<void> {
    if (relationshipIds.length === 0) return;
    return this.withDatabase(async () => {
      await this.db.delete(relationshipTable).where(inArray(relationshipTable.id, relationshipIds));
    });
  }

  // ── Cache batch methods ───────────────────────────────────────────────

  async getCaches<T>(keys: string[]): Promise<Map<string, T>> {
    const result = new Map<string, T>();
    for (const key of keys) {
      const value = await this.getCache<T>(key);
      if (value !== undefined) {
        result.set(key, value);
      }
    }
    return result;
  }

  async setCaches<T>(entries: Array<{ key: string; value: T }>): Promise<boolean> {
    for (const { key, value } of entries) {
      const success = await this.setCache(key, value);
      if (!success) return false;
    }
    return true;
  }

  async deleteCaches(keys: string[]): Promise<boolean> {
    for (const key of keys) {
      const success = await this.deleteCache(key);
      if (!success) return false;
    }
    return true;
  }

  // ── Task batch methods ────────────────────────────────────────────────

  async createTasks(tasks: Task[]): Promise<UUID[]> {
    const ids: UUID[] = [];
    for (const task of tasks) {
      const id = await this.createTask(task);
      ids.push(id);
    }
    return ids;
  }

  async getTasksByIds(taskIds: UUID[]): Promise<Task[]> {
    const tasks: Task[] = [];
    for (const taskId of taskIds) {
      const task = await this.getTask(taskId);
      if (task) tasks.push(task);
    }
    return tasks;
  }

  async updateTasks(updates: Array<{ id: UUID; task: Partial<Task> }>): Promise<void> {
    for (const { id, task } of updates) {
      await this.updateTask(id, task);
    }
  }

  async deleteTasks(taskIds: UUID[]): Promise<void> {
    for (const taskId of taskIds) {
      await this.deleteTask(taskId);
    }
  }

  // ── Pairing batch methods ─────────────────────────────────────────────

  async getPairingAllowlists(
    queries: Array<{ channel: PairingChannel; agentId: UUID }>
  ): Promise<PairingAllowlistsResult> {
    const result: PairingAllowlistsResult = [];
    for (const { channel, agentId } of queries) {
      const entries = await this.getPairingAllowlist(channel, agentId);
      result.push({ channel, agentId, entries });
    }
    return result;
  }

  async createPairingRequests(requests: PairingRequest[]): Promise<UUID[]> {
    const ids: UUID[] = [];
    for (const request of requests) {
      const id = await this.createPairingRequest(request);
      ids.push(id);
    }
    return ids;
  }

  async updatePairingRequests(requests: PairingRequest[]): Promise<void> {
    for (const request of requests) {
      await this.updatePairingRequest(request);
    }
  }

  async deletePairingRequests(ids: UUID[]): Promise<void> {
    for (const id of ids) {
      await this.deletePairingRequest(id);
    }
  }

  async createPairingAllowlistEntries(entries: PairingAllowlistEntry[]): Promise<UUID[]> {
    const ids: UUID[] = [];
    for (const entry of entries) {
      const id = await this.createPairingAllowlistEntry(entry);
      ids.push(id);
    }
    return ids;
  }

  async updatePairingAllowlistEntries(entries: PairingAllowlistEntry[]): Promise<void> {
    // The singular updatePairingAllowlistEntry doesn't exist in base.ts,
    // so we implement inline using the same pattern as the singular update.
    return this.withDatabase(async () => {
      for (const entry of entries) {
        if (!entry.id) continue;
        await this.db
          .update(pairingAllowlistTable)
          .set({
            metadata: entry.metadata || {},
          })
          .where(eq(pairingAllowlistTable.id, entry.id));
      }
    });
  }

  async deletePairingAllowlistEntries(ids: UUID[]): Promise<void> {
    for (const id of ids) {
      await this.deletePairingAllowlistEntry(id);
    }
  }

  // ── Connector account storage ────────────────────────────────────────

  async listConnectorAccounts(
    params?: ListConnectorAccountsParams
  ): Promise<ConnectorAccountRecord[]> {
    return this.getConnectorAccountStore().listAccounts(params ?? {});
  }

  async getConnectorAccount(
    params: GetConnectorAccountParams
  ): Promise<ConnectorAccountRecord | null> {
    return this.getConnectorAccountStore().getAccount(params);
  }

  async upsertConnectorAccount(
    params: UpsertConnectorAccountParams
  ): Promise<ConnectorAccountRecord> {
    return this.getConnectorAccountStore().upsertAccount(params);
  }

  async deleteConnectorAccount(params: DeleteConnectorAccountParams): Promise<boolean> {
    return this.getConnectorAccountStore().deleteAccount(params);
  }

  async findConnectorOwnerBinding(
    params: ConnectorOwnerBindingLookup
  ): Promise<ConnectorOwnerBindingRecord | null> {
    return this.getConnectorAccountStore().findOwnerBinding(params);
  }

  async setConnectorAccountCredentialRef(
    params: SetConnectorAccountCredentialRefParams
  ): Promise<ConnectorAccountCredentialRefRecord> {
    return this.getConnectorAccountStore().setCredentialRef(params);
  }

  async getConnectorAccountCredentialRef(
    params: GetConnectorAccountCredentialRefParams
  ): Promise<ConnectorAccountCredentialRefRecord | null> {
    return this.getConnectorAccountStore().getCredentialRef(params);
  }

  async listConnectorAccountCredentialRefs(
    params: ListConnectorAccountCredentialRefsParams
  ): Promise<ConnectorAccountCredentialRefRecord[]> {
    return this.getConnectorAccountStore().listCredentialRefs(params);
  }

  async appendConnectorAccountAuditEvent(
    params: AppendConnectorAccountAuditEventParams
  ): Promise<ConnectorAccountAuditEventRecord> {
    return this.getConnectorAccountStore().appendAuditEvent(params);
  }

  async listConnectorAccountAuditEvents(
    params: ListConnectorAccountAuditEventsParams = {}
  ): Promise<ConnectorAccountAuditEventRecord[]> {
    return this.getConnectorAccountStore().listAuditEvents(params);
  }

  async createOAuthFlowState(params: CreateOAuthFlowStateParams): Promise<OAuthFlowRecord> {
    return this.getConnectorAccountStore().createOAuthFlowState(params);
  }

  async consumeOAuthFlowState(
    params: ConsumeOAuthFlowStateParams
  ): Promise<OAuthFlowRecord | null> {
    return this.getConnectorAccountStore().consumeOAuthFlowState(params);
  }

  async getOAuthFlowState(params: GetOAuthFlowStateParams): Promise<OAuthFlowRecord | null> {
    return this.getConnectorAccountStore().getOAuthFlowState(params);
  }

  async updateOAuthFlowState(params: UpdateOAuthFlowStateParams): Promise<OAuthFlowRecord | null> {
    return this.getConnectorAccountStore().updateOAuthFlowState(params);
  }

  async deleteOAuthFlowState(params: DeleteOAuthFlowStateParams): Promise<boolean> {
    return this.getConnectorAccountStore().deleteOAuthFlowState(params);
  }
}

// Import tables at the end to avoid circular dependencies
