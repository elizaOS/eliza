import type { Agent } from "./agent";
import type {
  Component,
  Entity,
  Participant,
  Relationship,
  Room,
  World,
} from "./environment";
import type { Memory, MemoryMetadata } from "./memory";
import type { Metadata, UUID } from "./primitives";
import type {
  JsonValue,
  ActionLogBody as ProtoActionLogBody,
  ActionLogPrompt as ProtoActionLogPrompt,
  ActionLogResult as ProtoActionLogResult,
  AgentRunCounts as ProtoAgentRunCounts,
  AgentRunSummary as ProtoAgentRunSummary,
  AgentRunSummaryResult as ProtoAgentRunSummaryResult,
  BaseLogBody as ProtoBaseLogBody,
  DbRunStatus as ProtoDbRunStatus,
  EmbeddingLogBody as ProtoEmbeddingLogBody,
  EmbeddingSearchResult as ProtoEmbeddingSearchResult,
  EvaluatorLogBody as ProtoEvaluatorLogBody,
  Log as ProtoLog,
  MemoryRetrievalOptions as ProtoMemoryRetrievalOptions,
  MemorySearchOptions as ProtoMemorySearchOptions,
  ModelActionContext as ProtoModelActionContext,
  ModelLogBody as ProtoModelLogBody,
  MultiRoomMemoryOptions as ProtoMultiRoomMemoryOptions,
} from "./proto.js";
import type { Task } from "./task";

/**
 * Allowed value types for log body fields
 */
export type LogBodyValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | UUID
  | Error
  | LogBodyValue[]
  | { [key: string]: LogBodyValue };

/**
 * Base log body type with common properties
 */
export interface BaseLogBody
  extends Omit<ProtoBaseLogBody, "$typeName" | "$unknown" | "metadata"> {
  runId?: string | UUID;
  parentRunId?: string | UUID;
  messageId?: UUID;
  roomId?: UUID;
  entityId?: UUID;
  source?: string;
  startTime?: number | bigint;
  endTime?: number | bigint;
  duration?: number | bigint;
  metadata?: Record<string, LogBodyValue>;
}

/**
 * Action log content structure
 */
export interface ActionLogContent {
  actions?: string[];
  text?: string;
  thought?: string;
}

/**
 * Action result structure for logging
 */
export interface ActionLogResult
  extends Omit<
    ProtoActionLogResult,
    "$typeName" | "$unknown" | "data" | "error"
  > {
  data?: Record<string, LogBodyValue>;
  error?: string | Error;
}

/**
 * Prompt tracking for action logs
 */
export interface ActionLogPrompt
  extends Omit<ProtoActionLogPrompt, "$typeName" | "$unknown" | "timestamp"> {
  timestamp: number | bigint;
}

/**
 * Log body for action logs
 */
export interface ActionLogBody
  extends Omit<
      ProtoActionLogBody,
      | "$typeName"
      | "$unknown"
      | "base"
      | "state"
      | "responses"
      | "content"
      | "result"
      | "prompts"
    >,
    BaseLogBody {
  action?: string;
  actionName?: string;
  actionId?: UUID | string;
  message?: string;
  messageId?: UUID;
  state?: Record<string, LogBodyValue>;
  responses?: Array<Record<string, LogBodyValue>>;
  content?: ActionLogContent;
  result?: ActionLogResult;
  isVoidReturn?: boolean;
  prompts?: ActionLogPrompt[];
  promptCount?: number;
  planStep?: string;
  planThought?: string;
}

/**
 * Log body for evaluator logs
 */
export interface EvaluatorLogBody
  extends Omit<
      ProtoEvaluatorLogBody,
      "$typeName" | "$unknown" | "base" | "state"
    >,
    BaseLogBody {
  messageId?: UUID;
  state?: Record<string, LogBodyValue>;
}

/**
 * Action context for model logs
 */
export type ModelActionContext = Omit<
  ProtoModelActionContext,
  "$typeName" | "$unknown"
>;

/**
 * Log body for model logs
 */
export interface ModelLogBody
  extends Omit<
      ProtoModelLogBody,
      | "$typeName"
      | "$unknown"
      | "base"
      | "params"
      | "response"
      | "actionContext"
      | "timestamp"
      | "executionTime"
    >,
    BaseLogBody {
  params?: Record<string, LogBodyValue>;
  actionContext?: ModelActionContext;
  timestamp?: number | bigint;
  executionTime?: number | bigint;
  response?: JsonValue;
}

/**
 * Log body for embedding logs
 */
export interface EmbeddingLogBody
  extends Omit<
      ProtoEmbeddingLogBody,
      "$typeName" | "$unknown" | "base" | "duration"
    >,
    BaseLogBody {
  duration?: number | bigint;
  error?: string | Error;
}

/**
 * Union type for all possible log body types
 */
export type LogBody =
  | BaseLogBody
  | ActionLogBody
  | EvaluatorLogBody
  | ModelLogBody
  | EmbeddingLogBody;

/**
 * Represents a log entry
 */
export interface Log
  extends Omit<
    ProtoLog,
    "$typeName" | "$unknown" | "body" | "createdAt" | "entityId" | "roomId"
  > {
  entityId: UUID;
  roomId?: UUID;
  body: LogBody;
  createdAt: Date;
}

export type RunStatus = "started" | "completed" | "timeout" | "error";

export interface AgentRunCounts
  extends Omit<ProtoAgentRunCounts, "$typeName" | "$unknown"> {}

export interface AgentRunSummary
  extends Omit<
    ProtoAgentRunSummary,
    | "$typeName"
    | "$unknown"
    | "status"
    | "startedAt"
    | "endedAt"
    | "durationMs"
    | "metadata"
  > {
  status: RunStatus | ProtoDbRunStatus;
  startedAt: number | bigint | null;
  endedAt: number | bigint | null;
  durationMs: number | bigint | null;
  metadata?: Record<string, JsonValue>;
}

export interface AgentRunSummaryResult
  extends Omit<ProtoAgentRunSummaryResult, "$typeName" | "$unknown"> {}

/**
 * Interface for database operations
 */
export interface IDatabaseAdapter<DB extends object = object> {
  /** Database instance */
  db: DB;

  /** Initialize database connection */
  initialize(
    config?: Record<string, string | number | boolean | null>,
  ): Promise<void>;

  /** Initialize database connection */
  init(): Promise<void>;

  /**
   * Run plugin schema migrations for all registered plugins
   * @param plugins Array of plugins with their schemas
   * @param options Migration options (verbose, force, dryRun, etc.)
   */
  runPluginMigrations?(
    plugins: Array<{
      name: string;
      schema?: Record<string, JsonValue | object>;
    }>,
    options?: {
      verbose?: boolean;
      force?: boolean;
      dryRun?: boolean;
    },
  ): Promise<void>;

  /**
   * Run database migrations from migration files
   * @param migrationsPaths Optional array of migration file paths
   */
  runMigrations?(migrationsPaths?: string[]): Promise<void>;

  /** Check if the database connection is ready */
  isReady(): Promise<boolean>;

  /** Close database connection */
  close(): Promise<void>;

  getConnection(): Promise<DB>;

  /**
   * Execute a callback with entity context for Entity RLS
   * @param entityId - The entity ID to set as context
   * @param callback - The callback to execute within the entity context
   * @returns The result of the callback
   */
  withEntityContext?<T>(
    entityId: UUID | null,
    callback: () => Promise<T>,
  ): Promise<T>;

  getAgent(agentId: UUID): Promise<Agent | null>;

  /** Get all agents */
  getAgents(): Promise<Partial<Agent>[]>;

  createAgent(agent: Partial<Agent>): Promise<boolean>;

  updateAgent(agentId: UUID, agent: Partial<Agent>): Promise<boolean>;

  deleteAgent(agentId: UUID): Promise<boolean>;

  ensureEmbeddingDimension(dimension: number): Promise<void>;

  /** Get entity by IDs */
  getEntitiesByIds(entityIds: UUID[]): Promise<Entity[] | null>;

  /** Get entities for room */
  getEntitiesForRoom(
    roomId: UUID,
    includeComponents?: boolean,
  ): Promise<Entity[]>;

  /** Create new entities */
  createEntities(entities: Entity[]): Promise<boolean>;

  /** Update entity */
  updateEntity(entity: Entity): Promise<void>;

  /** Get component by ID */
  getComponent(
    entityId: UUID,
    type: string,
    worldId?: UUID,
    sourceEntityId?: UUID,
  ): Promise<Component | null>;

  /** Get all components for an entity */
  getComponents(
    entityId: UUID,
    worldId?: UUID,
    sourceEntityId?: UUID,
  ): Promise<Component[]>;

  /** Create component */
  createComponent(component: Component): Promise<boolean>;

  /** Update component */
  updateComponent(component: Component): Promise<void>;

  /** Delete component */
  deleteComponent(componentId: UUID): Promise<void>;

  /** Get memories matching criteria */
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
  }): Promise<{ embedding: number[]; levenshtein_score: number }[]>;

  log(params: {
    body: LogBody;
    entityId: UUID;
    roomId: UUID;
    type: string;
  }): Promise<void>;

  getLogs(params: {
    entityId?: UUID;
    roomId?: UUID;
    type?: string;
    count?: number;
    offset?: number;
  }): Promise<Log[]>;

  deleteLog(logId: UUID): Promise<void>;

  getAgentRunSummaries?(params: {
    limit?: number;
    roomId?: UUID;
    status?: RunStatus | "all";
    from?: number;
    to?: number;
    entityId?: UUID;
  }): Promise<AgentRunSummaryResult>;

  searchMemories(params: {
    embedding: number[];
    match_threshold?: number;
    count?: number;
    unique?: boolean;
    tableName: string;
    query?: string;
    roomId?: UUID;
    worldId?: UUID;
    entityId?: UUID;
  }): Promise<Memory[]>;

  createMemory(
    memory: Memory,
    tableName: string,
    unique?: boolean,
  ): Promise<UUID>;

  updateMemory(
    memory: Partial<Memory> & { id: UUID; metadata?: MemoryMetadata },
  ): Promise<boolean>;

  deleteMemory(memoryId: UUID): Promise<void>;

  deleteManyMemories(memoryIds: UUID[]): Promise<void>;

  deleteAllMemories(roomId: UUID, tableName: string): Promise<void>;

  countMemories(
    roomId: UUID,
    unique?: boolean,
    tableName?: string,
  ): Promise<number>;

  createWorld(world: World): Promise<UUID>;

  getWorld(id: UUID): Promise<World | null>;

  removeWorld(id: UUID): Promise<void>;

  getAllWorlds(): Promise<World[]>;

  updateWorld(world: World): Promise<void>;

  getRoomsByIds(roomIds: UUID[]): Promise<Room[] | null>;

  createRooms(rooms: Room[]): Promise<UUID[]>;

  deleteRoom(roomId: UUID): Promise<void>;

  deleteRoomsByWorldId(worldId: UUID): Promise<void>;

  updateRoom(room: Room): Promise<void>;

  getRoomsForParticipant(entityId: UUID): Promise<UUID[]>;

  getRoomsForParticipants(userIds: UUID[]): Promise<UUID[]>;

  getRoomsByWorld(worldId: UUID): Promise<Room[]>;

  removeParticipant(entityId: UUID, roomId: UUID): Promise<boolean>;

  getParticipantsForEntity(entityId: UUID): Promise<Participant[]>;

  getParticipantsForRoom(roomId: UUID): Promise<UUID[]>;

  isRoomParticipant(roomId: UUID, entityId: UUID): Promise<boolean>;

  addParticipantsRoom(entityIds: UUID[], roomId: UUID): Promise<boolean>;

  getParticipantUserState(
    roomId: UUID,
    entityId: UUID,
  ): Promise<"FOLLOWED" | "MUTED" | null>;

  setParticipantUserState(
    roomId: UUID,
    entityId: UUID,
    state: "FOLLOWED" | "MUTED" | null,
  ): Promise<void>;

  /**
   * Creates a new relationship between two entities.
   * @param params Object containing the relationship details
   * @returns Promise resolving to boolean indicating success
   */
  createRelationship(params: {
    sourceEntityId: UUID;
    targetEntityId: UUID;
    tags?: string[];
    metadata?: Metadata;
  }): Promise<boolean>;

  /**
   * Updates an existing relationship between two entities.
   * @param relationship The relationship object with updated data
   * @returns Promise resolving to void
   */
  updateRelationship(relationship: Relationship): Promise<void>;

  /**
   * Retrieves a relationship between two entities if it exists.
   * @param params Object containing the entity IDs and agent ID
   * @returns Promise resolving to the Relationship object or null if not found
   */
  getRelationship(params: {
    sourceEntityId: UUID;
    targetEntityId: UUID;
  }): Promise<Relationship | null>;

  /**
   * Retrieves all relationships for a specific entity.
   * @param params Object containing the user ID, agent ID and optional tags to filter by
   * @returns Promise resolving to an array of Relationship objects
   */
  getRelationships(params: {
    entityId: UUID;
    tags?: string[];
  }): Promise<Relationship[]>;

  getCache<T>(key: string): Promise<T | undefined>;
  setCache<T>(key: string, value: T): Promise<boolean>;
  deleteCache(key: string): Promise<boolean>;

  // Only task instance methods - definitions are in-memory
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

  getMemoriesByWorldId(params: {
    worldId: UUID;
    count?: number;
    tableName?: string;
  }): Promise<Memory[]>;
}

/**
 * Result interface for embedding similarity searches
 */
export interface EmbeddingSearchResult
  extends Omit<ProtoEmbeddingSearchResult, "levenshteinScore"> {
  levenshtein_score?: number;
}

/**
 * Options for memory retrieval operations
 */
export interface MemoryRetrievalOptions
  extends Omit<
    ProtoMemoryRetrievalOptions,
    "roomId" | "agentId" | "start" | "end"
  > {
  roomId: UUID;
  agentId?: UUID;
  start?: number | bigint;
  end?: number | bigint;
}

/**
 * Options for memory search operations
 */
export interface MemorySearchOptions
  extends Omit<
    ProtoMemorySearchOptions,
    "roomId" | "agentId" | "metadata" | "matchThreshold"
  > {
  roomId: UUID;
  agentId?: UUID;
  metadata?: Partial<MemoryMetadata>;
  match_threshold?: number;
}

/**
 * Options for multi-room memory retrieval
 */
export interface MultiRoomMemoryOptions
  extends Omit<ProtoMultiRoomMemoryOptions, "roomIds" | "agentId"> {
  roomIds: UUID[];
  agentId?: UUID;
}

/**
 * Standard options pattern for memory operations
 * Provides a simpler, more consistent interface
 */
export interface StandardMemoryOptions {
  roomId: UUID;
  limit?: number; // Standard naming (replacing 'count')
  agentId?: UUID; // Common optional parameter
  unique?: boolean; // Common flag for duplication control
  start?: number; // Pagination start
  end?: number; // Pagination end
}

/**
 * Specialized memory search options
 */
export interface MemorySearchParams extends StandardMemoryOptions {
  embedding: number[];
  similarity?: number; // Clearer name than 'match_threshold'
}

/**
 * Base interface for database connection objects.
 * Specific adapters should extend this with their connection type.
 *
 * @example
 * ```typescript
 * // In a PostgreSQL adapter:
 * interface PgConnection extends DbConnection {
 *   pool: Pool;
 *   query: <T>(sql: string, params?: unknown[]) => Promise<T>;
 * }
 * ```
 */
export interface DbConnection {
  /** Whether the connection is currently active */
  isConnected?: boolean;
  /** Close the connection */
  close?: () => Promise<void>;
}

// Allowable vector dimensions
export const VECTOR_DIMS = {
  SMALL: 384,
  MEDIUM: 512,
  LARGE: 768,
  XL: 1024,
  XXL: 1536,
  XXXL: 3072,
} as const;
