/** Storage-backend contracts (`IStorage`, `IVectorStorage`) that `InMemoryDatabaseAdapter` is built against, plus the fixed set of collection names it operates on. */
export interface IStorage {
  init(): Promise<void>;
  close(): Promise<void>;
  isReady(): Promise<boolean>;
  get<T>(collection: string, id: string): Promise<T | null>;
  getAll<T>(collection: string): Promise<T[]>;
  getWhere<T>(collection: string, predicate: (item: T) => boolean): Promise<T[]>;
  set<T>(collection: string, id: string, data: T): Promise<void>;
  delete(collection: string, id: string): Promise<boolean>;
  deleteMany(collection: string, ids: string[]): Promise<void>;
  deleteWhere<T = Record<string, unknown>>(
    collection: string,
    predicate: (item: T) => boolean
  ): Promise<void>;
  count<T = Record<string, unknown>>(
    collection: string,
    predicate?: (item: T) => boolean
  ): Promise<number>;
  clear(): Promise<void>;
  /** Applies one collection mutation without exposing intermediate state. */
  applyBatch?(batch: {
    collection: string;
    deletes: string[];
    sets: Array<{ id: string; data: unknown }>;
  }): Promise<void>;
}

export interface IVectorStorage {
  init(dimension: number): Promise<void>;
  add(id: string, vector: number[]): Promise<void>;
  remove(id: string): Promise<void>;
  search(query: number[], k: number, threshold?: number): Promise<VectorSearchResult[]>;
  /**
   * Exhaustive nearest-neighbor scan over every indexed vector, ordered by
   * ascending cosine distance. Unlike `search`, which navigates the
   * approximate HNSW graph and may omit reachable-but-unvisited nodes, this
   * considers the entire index so callers that apply their own scope filter
   * afterwards get the true "top K among eligible" set instead of a global
   * top-K that can be starved by closer out-of-scope vectors.
   */
  searchExact(
    query: number[],
    k: number,
    threshold?: number,
    eligibleIds?: ReadonlySet<string>
  ): Promise<VectorSearchResult[]>;
  clear(): Promise<void>;
}

export interface VectorSearchResult {
  id: string;
  distance: number;
  similarity: number;
}

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
  PAIRING_REQUESTS: "pairing_requests",
  PAIRING_ALLOWLIST: "pairing_allowlist",
} as const;

export type CollectionName = (typeof COLLECTIONS)[keyof typeof COLLECTIONS];
