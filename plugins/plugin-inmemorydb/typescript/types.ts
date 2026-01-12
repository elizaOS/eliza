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
}

export interface IVectorStorage {
  init(dimension: number): Promise<void>;
  add(id: string, vector: number[]): Promise<void>;
  remove(id: string): Promise<void>;
  search(query: number[], k: number, threshold?: number): Promise<VectorSearchResult[]>;
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
} as const;

export type CollectionName = (typeof COLLECTIONS)[keyof typeof COLLECTIONS];
