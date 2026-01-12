export interface IStorage {
  saveRaw(filename: string, data: string): Promise<void>;
  loadRaw(filename: string): Promise<string | null>;
  init(): Promise<void>;
  close(): Promise<void>;
  isReady(): Promise<boolean>;
  get<T>(collection: string, id: string): Promise<T | null>;
  getAll<T>(collection: string): Promise<T[]>;
  getWhere<T>(collection: string, predicate: (item: T) => boolean): Promise<T[]>;
  set<T>(collection: string, id: string, data: T): Promise<void>;
  delete(collection: string, id: string): Promise<boolean>;
  deleteMany(collection: string, ids: string[]): Promise<void>;
  deleteWhere<T = Record<string, string | number | boolean | null | undefined | string[]>>(
    collection: string,
    predicate: (item: T) => boolean
  ): Promise<void>;
  count<T = Record<string, string | number | boolean | null | undefined | string[]>>(
    collection: string,
    predicate?: (item: T) => boolean
  ): Promise<number>;
}

export interface IVectorStorage {
  init(dimension: number): Promise<void>;
  add(id: string, vector: number[]): Promise<void>;
  remove(id: string): Promise<void>;
  search(query: number[], k: number, threshold?: number): Promise<VectorSearchResult[]>;
  save(): Promise<void>;
  load(): Promise<void>;
}

export interface VectorSearchResult {
  id: string;
  distance: number;
  similarity: number;
}

export interface StoredItem<T> {
  id: string;
  data: T;
  createdAt: number;
  updatedAt: number;
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
