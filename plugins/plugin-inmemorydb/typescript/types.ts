/**
 * Type definitions for plugin-inmemorydb
 *
 * Pure in-memory, ephemeral storage - no persistence
 */

/**
 * Storage interface for in-memory data
 */
export interface IStorage {
  /** Initialize the storage */
  init(): Promise<void>;

  /** Close the storage (clears all data) */
  close(): Promise<void>;

  /** Check if storage is ready */
  isReady(): Promise<boolean>;

  /** Get an item by collection and id */
  get<T>(collection: string, id: string): Promise<T | null>;

  /** Get all items in a collection */
  getAll<T>(collection: string): Promise<T[]>;

  /** Get items by a filter function */
  getWhere<T>(collection: string, predicate: (item: T) => boolean): Promise<T[]>;

  /** Set an item in a collection */
  set<T>(collection: string, id: string, data: T): Promise<void>;

  /** Delete an item from a collection */
  delete(collection: string, id: string): Promise<boolean>;

  /** Delete multiple items from a collection */
  deleteMany(collection: string, ids: string[]): Promise<void>;

  /** Delete all items in a collection matching a predicate */
  deleteWhere<T = Record<string, unknown>>(
    collection: string,
    predicate: (item: T) => boolean
  ): Promise<void>;

  /** Count items in a collection */
  count<T = Record<string, unknown>>(
    collection: string,
    predicate?: (item: T) => boolean
  ): Promise<number>;

  /** Clear all data from all collections */
  clear(): Promise<void>;
}

/**
 * Vector storage interface for HNSW-based similarity search
 */
export interface IVectorStorage {
  /** Initialize the vector storage */
  init(dimension: number): Promise<void>;

  /** Add a vector with associated id */
  add(id: string, vector: number[]): Promise<void>;

  /** Remove a vector by id */
  remove(id: string): Promise<void>;

  /** Search for nearest neighbors */
  search(query: number[], k: number, threshold?: number): Promise<VectorSearchResult[]>;

  /** Clear all vectors from the index */
  clear(): Promise<void>;
}

/**
 * Result of a vector similarity search
 */
export interface VectorSearchResult {
  id: string;
  distance: number;
  similarity: number;
}

/**
 * Collections used by the adapter
 */
export const COLLECTIONS = {
  AGENTS: "agents",
  ENTITIES: "entities",
  MEMORIES: "memories",
  ROOMS: "rooms",
  WORLDS: "worlds",
  COMPONENTS: "components",
  RELATIONSHIPS: "relationships",
  PARTICIPANTS: "participants",
  TASKS: "tasks",
  CACHE: "cache",
  LOGS: "logs",
  EMBEDDINGS: "embeddings",
} as const;

export type CollectionName = (typeof COLLECTIONS)[keyof typeof COLLECTIONS];
