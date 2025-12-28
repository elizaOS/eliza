/**
 * CachedDatabaseAdapter - A caching wrapper for any IDatabaseAdapter
 *
 * This wrapper adds LRU caching with optional external cache support (Redis/Upstash)
 * for serverless environments. Cache invalidation happens automatically on mutations.
 *
 * Usage:
 * ```typescript
 * import { createDatabaseAdapter, CachedDatabaseAdapter } from '@elizaos/plugin-sql';
 *
 * const baseAdapter = createDatabaseAdapter(config, agentId);
 * const cachedAdapter = new CachedDatabaseAdapter(baseAdapter, {
 *   entityCacheSize: 500,
 *   roomCacheSize: 200,
 *   ttl: 5 * 60 * 1000, // 5 minutes
 * });
 * ```
 *
 * For serverless with external cache:
 * ```typescript
 * const cachedAdapter = new CachedDatabaseAdapter(baseAdapter, {
 *   externalCache: myUpstashAdapter,
 * });
 * ```
 */

import type {
  IDatabaseAdapter,
  UUID,
  Agent,
  Entity,
  Room,
  World,
  Memory,
  MemoryMetadata,
  Component,
  Participant,
  Relationship,
  Task,
  Log,
  AgentRunSummaryResult,
  RunStatus,
} from '@elizaos/core';

/**
 * Interface for external cache adapters (Redis, Upstash, etc.)
 */
export interface ExternalCacheAdapter {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T, ttl?: number): Promise<void>;
  delete(key: string): Promise<boolean>;
  clear(prefix?: string): Promise<void>;
  getMany?<T>(keys: string[]): Promise<Map<string, T>>;
  setMany?<T>(entries: [string, T][], ttl?: number): Promise<void>;
}

/**
 * Configuration options for the CachedDatabaseAdapter
 */
export interface CachedAdapterConfig {
  /** Maximum number of entities to cache (default: 500) */
  entityCacheSize?: number;
  /** Maximum number of rooms to cache (default: 200) */
  roomCacheSize?: number;
  /** Maximum number of worlds to cache (default: 50) */
  worldCacheSize?: number;
  /** Maximum number of agents to cache (default: 50) */
  agentCacheSize?: number;
  /** Maximum number of participant lists to cache (default: 200) */
  participantCacheSize?: number;
  /** Maximum number of components to cache (default: 500) */
  componentCacheSize?: number;
  /** Maximum number of relationships to cache (default: 200) */
  relationshipCacheSize?: number;
  /** Maximum number of tasks to cache (default: 100) */
  taskCacheSize?: number;
  /** Time-to-live for cache entries in milliseconds (default: 5 minutes) */
  ttl?: number;
  /** External cache adapter for serverless environments */
  externalCache?: ExternalCacheAdapter;
  /** Prefix for cache keys (useful when sharing external cache) */
  cacheKeyPrefix?: string;
}

/**
 * Simple in-memory LRU cache implementation
 */
class LRUCache<K, V> {
  private cache = new Map<K, { value: V; timestamp: number }>();
  private maxSize: number;
  private ttl: number | null;

  constructor(maxSize: number, ttl?: number) {
    this.maxSize = maxSize;
    this.ttl = ttl ?? null;
  }

  get(key: K): V | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;

    if (this.ttl !== null && Date.now() - entry.timestamp > this.ttl) {
      this.cache.delete(key);
      return undefined;
    }

    // Move to end (most recently used)
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.value;
  }

  set(key: K, value: V): void {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }
    this.cache.set(key, { value, timestamp: Date.now() });
  }

  delete(key: K): boolean {
    return this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }

  stats(): { size: number; maxSize: number; ttl: number | null } {
    return { size: this.cache.size, maxSize: this.maxSize, ttl: this.ttl };
  }
}

/**
 * Default cache configuration values
 */
const DEFAULT_CONFIG: Required<Omit<CachedAdapterConfig, 'externalCache' | 'cacheKeyPrefix'>> = {
  entityCacheSize: 500,
  roomCacheSize: 200,
  worldCacheSize: 50,
  agentCacheSize: 50,
  participantCacheSize: 200,
  componentCacheSize: 500,
  relationshipCacheSize: 200,
  taskCacheSize: 100,
  ttl: 5 * 60 * 1000, // 5 minutes
};

/**
 * CachedDatabaseAdapter wraps any IDatabaseAdapter with LRU caching.
 * Supports optional external cache (Redis/Upstash) for serverless environments.
 */
export class CachedDatabaseAdapter implements IDatabaseAdapter {
  private baseAdapter: IDatabaseAdapter;
  private config: Required<Omit<CachedAdapterConfig, 'externalCache' | 'cacheKeyPrefix'>>;
  private externalCache?: ExternalCacheAdapter;
  private cacheKeyPrefix: string;

  // In-memory LRU caches
  private entityCache: LRUCache<string, Entity>;
  private roomCache: LRUCache<string, Room>;
  private worldCache: LRUCache<string, World>;
  private agentCache: LRUCache<string, Agent>;
  private participantCache: LRUCache<string, UUID[]>;
  private componentCache: LRUCache<string, Component>;
  private relationshipCache: LRUCache<string, Relationship>;
  private taskCache: LRUCache<string, Task>;
  private roomsByWorldCache: LRUCache<string, Room[]>;
  private entitiesForRoomCache: LRUCache<string, Entity[]>;

  constructor(baseAdapter: IDatabaseAdapter, config?: CachedAdapterConfig) {
    this.baseAdapter = baseAdapter;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.externalCache = config?.externalCache;
    this.cacheKeyPrefix = config?.cacheKeyPrefix ?? 'eliza:cache:';

    // Initialize caches
    this.entityCache = new LRUCache(this.config.entityCacheSize, this.config.ttl);
    this.roomCache = new LRUCache(this.config.roomCacheSize, this.config.ttl);
    this.worldCache = new LRUCache(this.config.worldCacheSize, this.config.ttl);
    this.agentCache = new LRUCache(this.config.agentCacheSize, this.config.ttl);
    this.participantCache = new LRUCache(this.config.participantCacheSize, this.config.ttl);
    this.componentCache = new LRUCache(this.config.componentCacheSize, this.config.ttl);
    this.relationshipCache = new LRUCache(this.config.relationshipCacheSize, this.config.ttl);
    this.taskCache = new LRUCache(this.config.taskCacheSize, this.config.ttl);
    this.roomsByWorldCache = new LRUCache(50, this.config.ttl);
    this.entitiesForRoomCache = new LRUCache(100, this.config.ttl);
  }

  // ==================== Helper Methods ====================

  private cacheKey(type: string, id: string): string {
    return `${this.cacheKeyPrefix}${type}:${id}`;
  }

  private async getFromCache<T>(
    cache: LRUCache<string, T>,
    type: string,
    id: string
  ): Promise<T | undefined> {
    // Check L1 (in-memory)
    const l1Value = cache.get(id);
    if (l1Value !== undefined) return l1Value;

    // Check L2 (external) if available
    if (this.externalCache) {
      const l2Value = await this.externalCache.get<T>(this.cacheKey(type, id));
      if (l2Value !== undefined) {
        cache.set(id, l2Value); // Promote to L1
        return l2Value;
      }
    }

    return undefined;
  }

  private async setInCache<T>(
    cache: LRUCache<string, T>,
    type: string,
    id: string,
    value: T
  ): Promise<void> {
    cache.set(id, value);
    if (this.externalCache) {
      await this.externalCache.set(this.cacheKey(type, id), value, this.config.ttl);
    }
  }

  private async deleteFromCache<T>(
    cache: LRUCache<string, T>,
    type: string,
    id: string
  ): Promise<void> {
    cache.delete(id);
    if (this.externalCache) {
      await this.externalCache.delete(this.cacheKey(type, id));
    }
  }

  // ==================== Passthrough Properties ====================

  get db(): unknown {
    return this.baseAdapter.db;
  }

  // ==================== Initialization Methods ====================

  async initialize(config?: Record<string, string | number | boolean | null>): Promise<void> {
    return this.baseAdapter.initialize(config);
  }

  async init(): Promise<void> {
    return this.baseAdapter.init();
  }

  async isReady(): Promise<boolean> {
    return this.baseAdapter.isReady();
  }

  async close(): Promise<void> {
    this.clearAllCaches();
    return this.baseAdapter.close();
  }

  async getConnection(): Promise<unknown> {
    return this.baseAdapter.getConnection();
  }

  async ensureEmbeddingDimension(dimension: number): Promise<void> {
    return this.baseAdapter.ensureEmbeddingDimension(dimension);
  }

  // ==================== Agent Methods (Cached) ====================

  async getAgent(agentId: UUID): Promise<Agent | null> {
    const cached = await this.getFromCache<Agent>(this.agentCache, 'agent', agentId);
    if (cached) return cached;

    const agent = await this.baseAdapter.getAgent(agentId);
    if (agent) {
      await this.setInCache(this.agentCache, 'agent', agentId, agent);
    }
    return agent;
  }

  async getAgents(): Promise<Partial<Agent>[]> {
    // Not cached - returns partial agents and is typically admin operation
    return this.baseAdapter.getAgents();
  }

  async createAgent(agent: Partial<Agent>): Promise<boolean> {
    const result = await this.baseAdapter.createAgent(agent);
    if (result && agent.id) {
      await this.setInCache(this.agentCache, 'agent', agent.id, agent as Agent);
    }
    return result;
  }

  async updateAgent(agentId: UUID, agent: Partial<Agent>): Promise<boolean> {
    const result = await this.baseAdapter.updateAgent(agentId, agent);
    if (result) {
      await this.deleteFromCache(this.agentCache, 'agent', agentId);
    }
    return result;
  }

  async deleteAgent(agentId: UUID): Promise<boolean> {
    const result = await this.baseAdapter.deleteAgent(agentId);
    if (result) {
      await this.deleteFromCache(this.agentCache, 'agent', agentId);
    }
    return result;
  }

  // ==================== Entity Methods (Cached) ====================

  async getEntitiesByIds(entityIds: UUID[]): Promise<Entity[] | null> {
    if (!entityIds.length) return [];

    const results: Entity[] = [];
    const missingIds: UUID[] = [];

    // Check cache for each ID
    for (const id of entityIds) {
      const cached = await this.getFromCache<Entity>(this.entityCache, 'entity', id);
      if (cached) {
        results.push(cached);
      } else {
        missingIds.push(id);
      }
    }

    // Fetch missing from database
    if (missingIds.length > 0) {
      const fetched = await this.baseAdapter.getEntitiesByIds(missingIds);
      if (fetched) {
        for (const entity of fetched) {
          if (entity.id) {
            await this.setInCache(this.entityCache, 'entity', entity.id, entity);
            results.push(entity);
          }
        }
      }
    }

    return results.length > 0 ? results : null;
  }

  async getEntitiesForRoom(roomId: UUID, includeComponents?: boolean): Promise<Entity[]> {
    const cacheKey = `${roomId}:${includeComponents ?? false}`;
    const cached = await this.getFromCache<Entity[]>(
      this.entitiesForRoomCache,
      'entitiesForRoom',
      cacheKey
    );
    if (cached) return cached;

    const entities = await this.baseAdapter.getEntitiesForRoom(roomId, includeComponents);

    // Cache the result and individual entities
    await this.setInCache(this.entitiesForRoomCache, 'entitiesForRoom', cacheKey, entities);
    for (const entity of entities) {
      if (entity.id) {
        await this.setInCache(this.entityCache, 'entity', entity.id, entity);
      }
    }

    return entities;
  }

  async createEntities(entities: Entity[]): Promise<boolean> {
    const result = await this.baseAdapter.createEntities(entities);
    if (result) {
      for (const entity of entities) {
        if (entity.id) {
          await this.setInCache(this.entityCache, 'entity', entity.id, entity);
        }
      }
      // Invalidate entitiesForRoom cache (we don't know which rooms are affected)
      this.entitiesForRoomCache.clear();
    }
    return result;
  }

  async updateEntity(entity: Entity): Promise<void> {
    await this.baseAdapter.updateEntity(entity);
    if (entity.id) {
      await this.setInCache(this.entityCache, 'entity', entity.id, entity);
    }
    this.entitiesForRoomCache.clear();
  }

  // ==================== Room Methods (Cached) ====================

  async getRoomsByIds(roomIds: UUID[]): Promise<Room[] | null> {
    if (!roomIds.length) return [];

    const results: Room[] = [];
    const missingIds: UUID[] = [];

    for (const id of roomIds) {
      const cached = await this.getFromCache<Room>(this.roomCache, 'room', id);
      if (cached) {
        results.push(cached);
      } else {
        missingIds.push(id);
      }
    }

    if (missingIds.length > 0) {
      const fetched = await this.baseAdapter.getRoomsByIds(missingIds);
      if (fetched) {
        for (const room of fetched) {
          if (room.id) {
            await this.setInCache(this.roomCache, 'room', room.id, room);
            results.push(room);
          }
        }
      }
    }

    return results.length > 0 ? results : null;
  }

  async createRooms(rooms: Room[]): Promise<UUID[]> {
    const result = await this.baseAdapter.createRooms(rooms);
    for (const room of rooms) {
      if (room.id) {
        await this.setInCache(this.roomCache, 'room', room.id, room);
      }
      if (room.worldId) {
        await this.deleteFromCache(this.roomsByWorldCache, 'roomsByWorld', room.worldId);
      }
    }
    return result;
  }

  async deleteRoom(roomId: UUID): Promise<void> {
    // Get room first to invalidate world cache
    const room = await this.getFromCache<Room>(this.roomCache, 'room', roomId);
    await this.baseAdapter.deleteRoom(roomId);
    await this.deleteFromCache(this.roomCache, 'room', roomId);
    await this.deleteFromCache(this.participantCache, 'participants', roomId);
    if (room?.worldId) {
      await this.deleteFromCache(this.roomsByWorldCache, 'roomsByWorld', room.worldId);
    }
  }

  async deleteRoomsByWorldId(worldId: UUID): Promise<void> {
    // Get rooms first to invalidate caches
    const rooms = await this.getRoomsByWorld(worldId);
    await this.baseAdapter.deleteRoomsByWorldId(worldId);
    for (const room of rooms) {
      if (room.id) {
        await this.deleteFromCache(this.roomCache, 'room', room.id);
        await this.deleteFromCache(this.participantCache, 'participants', room.id);
      }
    }
    await this.deleteFromCache(this.roomsByWorldCache, 'roomsByWorld', worldId);
  }

  async updateRoom(room: Room): Promise<void> {
    await this.baseAdapter.updateRoom(room);
    if (room.id) {
      await this.setInCache(this.roomCache, 'room', room.id, room);
    }
    if (room.worldId) {
      await this.deleteFromCache(this.roomsByWorldCache, 'roomsByWorld', room.worldId);
    }
  }

  async getRoomsForParticipant(entityId: UUID): Promise<UUID[]> {
    // Not cached - changes frequently
    return this.baseAdapter.getRoomsForParticipant(entityId);
  }

  async getRoomsForParticipants(userIds: UUID[]): Promise<UUID[]> {
    return this.baseAdapter.getRoomsForParticipants(userIds);
  }

  async getRoomsByWorld(worldId: UUID): Promise<Room[]> {
    const cached = await this.getFromCache<Room[]>(this.roomsByWorldCache, 'roomsByWorld', worldId);
    if (cached) return cached;

    const rooms = await this.baseAdapter.getRoomsByWorld(worldId);
    await this.setInCache(this.roomsByWorldCache, 'roomsByWorld', worldId, rooms);

    // Also cache individual rooms
    for (const room of rooms) {
      if (room.id) {
        await this.setInCache(this.roomCache, 'room', room.id, room);
      }
    }

    return rooms;
  }

  // ==================== World Methods (Cached) ====================

  async createWorld(world: World): Promise<UUID> {
    const result = await this.baseAdapter.createWorld(world);
    if (world.id) {
      await this.setInCache(this.worldCache, 'world', world.id, world);
    }
    return result;
  }

  async getWorld(id: UUID): Promise<World | null> {
    const cached = await this.getFromCache<World>(this.worldCache, 'world', id);
    if (cached) return cached;

    const world = await this.baseAdapter.getWorld(id);
    if (world) {
      await this.setInCache(this.worldCache, 'world', id, world);
    }
    return world;
  }

  async removeWorld(id: UUID): Promise<void> {
    await this.baseAdapter.removeWorld(id);
    await this.deleteFromCache(this.worldCache, 'world', id);
    await this.deleteFromCache(this.roomsByWorldCache, 'roomsByWorld', id);
  }

  async getAllWorlds(): Promise<World[]> {
    const worlds = await this.baseAdapter.getAllWorlds();
    for (const world of worlds) {
      if (world.id) {
        await this.setInCache(this.worldCache, 'world', world.id, world);
      }
    }
    return worlds;
  }

  async updateWorld(world: World): Promise<void> {
    await this.baseAdapter.updateWorld(world);
    if (world.id) {
      await this.setInCache(this.worldCache, 'world', world.id, world);
    }
  }

  // ==================== Participant Methods (Cached) ====================

  async removeParticipant(entityId: UUID, roomId: UUID): Promise<boolean> {
    const result = await this.baseAdapter.removeParticipant(entityId, roomId);
    if (result) {
      await this.deleteFromCache(this.participantCache, 'participants', roomId);
    }
    return result;
  }

  async getParticipantsForEntity(entityId: UUID): Promise<Participant[]> {
    // Not cached - complex query
    return this.baseAdapter.getParticipantsForEntity(entityId);
  }

  async getParticipantsForRoom(roomId: UUID): Promise<UUID[]> {
    const cached = await this.getFromCache<UUID[]>(this.participantCache, 'participants', roomId);
    if (cached) return cached;

    const participants = await this.baseAdapter.getParticipantsForRoom(roomId);
    await this.setInCache(this.participantCache, 'participants', roomId, participants);
    return participants;
  }

  async isRoomParticipant(roomId: UUID, entityId: UUID): Promise<boolean> {
    const cached = await this.getFromCache<UUID[]>(this.participantCache, 'participants', roomId);
    if (cached) {
      return cached.includes(entityId);
    }
    return this.baseAdapter.isRoomParticipant(roomId, entityId);
  }

  async addParticipantsRoom(entityIds: UUID[], roomId: UUID): Promise<boolean> {
    const result = await this.baseAdapter.addParticipantsRoom(entityIds, roomId);
    if (result) {
      await this.deleteFromCache(this.participantCache, 'participants', roomId);
    }
    return result;
  }

  async getParticipantUserState(
    roomId: UUID,
    entityId: UUID
  ): Promise<'FOLLOWED' | 'MUTED' | null> {
    return this.baseAdapter.getParticipantUserState(roomId, entityId);
  }

  async setParticipantUserState(
    roomId: UUID,
    entityId: UUID,
    state: 'FOLLOWED' | 'MUTED' | null
  ): Promise<void> {
    return this.baseAdapter.setParticipantUserState(roomId, entityId, state);
  }

  // ==================== Component Methods (Cached) ====================

  async getComponent(
    entityId: UUID,
    type: string,
    worldId?: UUID,
    sourceEntityId?: UUID
  ): Promise<Component | null> {
    const cacheKey = `${entityId}:${type}:${worldId ?? 'null'}:${sourceEntityId ?? 'null'}`;
    const cached = await this.getFromCache<Component>(this.componentCache, 'component', cacheKey);
    if (cached) return cached;

    const component = await this.baseAdapter.getComponent(entityId, type, worldId, sourceEntityId);
    if (component) {
      await this.setInCache(this.componentCache, 'component', cacheKey, component);
    }
    return component;
  }

  async getComponents(entityId: UUID, worldId?: UUID, sourceEntityId?: UUID): Promise<Component[]> {
    // Not cached - returns array, complex invalidation
    return this.baseAdapter.getComponents(entityId, worldId, sourceEntityId);
  }

  async createComponent(component: Component): Promise<boolean> {
    const result = await this.baseAdapter.createComponent(component);
    // Invalidate related caches
    this.componentCache.clear();
    this.entitiesForRoomCache.clear();
    return result;
  }

  async updateComponent(component: Component): Promise<void> {
    await this.baseAdapter.updateComponent(component);
    this.componentCache.clear();
    this.entitiesForRoomCache.clear();
  }

  async deleteComponent(componentId: UUID): Promise<void> {
    await this.baseAdapter.deleteComponent(componentId);
    this.componentCache.clear();
    this.entitiesForRoomCache.clear();
  }

  // ==================== Relationship Methods (Cached) ====================

  async createRelationship(params: {
    sourceEntityId: UUID;
    targetEntityId: UUID;
    tags?: string[];
    metadata?: Record<string, unknown>;
  }): Promise<boolean> {
    const result = await this.baseAdapter.createRelationship(params);
    // Invalidate relationship cache for both entities
    await this.deleteFromCache(
      this.relationshipCache,
      'relationship',
      `${params.sourceEntityId}:${params.targetEntityId}`
    );
    return result;
  }

  async updateRelationship(relationship: Relationship): Promise<void> {
    await this.baseAdapter.updateRelationship(relationship);
    if (relationship.sourceEntityId && relationship.targetEntityId) {
      await this.deleteFromCache(
        this.relationshipCache,
        'relationship',
        `${relationship.sourceEntityId}:${relationship.targetEntityId}`
      );
    }
  }

  async getRelationship(params: {
    sourceEntityId: UUID;
    targetEntityId: UUID;
  }): Promise<Relationship | null> {
    const cacheKey = `${params.sourceEntityId}:${params.targetEntityId}`;
    const cached = await this.getFromCache<Relationship>(
      this.relationshipCache,
      'relationship',
      cacheKey
    );
    if (cached) return cached;

    const relationship = await this.baseAdapter.getRelationship(params);
    if (relationship) {
      await this.setInCache(this.relationshipCache, 'relationship', cacheKey, relationship);
    }
    return relationship;
  }

  async getRelationships(params: { entityId: UUID; tags?: string[] }): Promise<Relationship[]> {
    // Not cached - complex query with tags filter
    return this.baseAdapter.getRelationships(params);
  }

  // ==================== Task Methods (Cached) ====================

  async createTask(task: Task): Promise<UUID> {
    const result = await this.baseAdapter.createTask(task);
    if (task.id) {
      await this.setInCache(this.taskCache, 'task', task.id, task);
    }
    return result;
  }

  async getTasks(params: { roomId?: UUID; tags?: string[]; entityId?: UUID }): Promise<Task[]> {
    // Not cached - complex query
    return this.baseAdapter.getTasks(params);
  }

  async getTask(id: UUID): Promise<Task | null> {
    const cached = await this.getFromCache<Task>(this.taskCache, 'task', id);
    if (cached) return cached;

    const task = await this.baseAdapter.getTask(id);
    if (task) {
      await this.setInCache(this.taskCache, 'task', id, task);
    }
    return task;
  }

  async getTasksByName(name: string): Promise<Task[]> {
    // Not cached - name lookup
    return this.baseAdapter.getTasksByName(name);
  }

  async updateTask(id: UUID, task: Partial<Task>): Promise<void> {
    await this.baseAdapter.updateTask(id, task);
    await this.deleteFromCache(this.taskCache, 'task', id);
  }

  async deleteTask(id: UUID): Promise<void> {
    await this.baseAdapter.deleteTask(id);
    await this.deleteFromCache(this.taskCache, 'task', id);
  }

  // ==================== Memory Methods (Not Cached - High Volume) ====================

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
    return this.baseAdapter.getMemories(params);
  }

  async getMemoryById(id: UUID): Promise<Memory | null> {
    return this.baseAdapter.getMemoryById(id);
  }

  async getMemoriesByIds(ids: UUID[], tableName?: string): Promise<Memory[]> {
    return this.baseAdapter.getMemoriesByIds(ids, tableName);
  }

  async getMemoriesByRoomIds(params: {
    tableName: string;
    roomIds: UUID[];
    limit?: number;
  }): Promise<Memory[]> {
    return this.baseAdapter.getMemoriesByRoomIds(params);
  }

  async getCachedEmbeddings(params: {
    query_table_name: string;
    query_threshold: number;
    query_input: string;
    query_field_name: string;
    query_field_sub_name: string;
    query_match_count: number;
  }): Promise<{ embedding: number[]; levenshtein_score: number }[]> {
    return this.baseAdapter.getCachedEmbeddings(params);
  }

  async searchMemories(params: {
    embedding: number[];
    match_threshold?: number;
    count?: number;
    unique?: boolean;
    tableName: string;
    query?: string;
    roomId?: UUID;
    worldId?: UUID;
    entityId?: UUID;
  }): Promise<Memory[]> {
    return this.baseAdapter.searchMemories(params);
  }

  async createMemory(memory: Memory, tableName: string, unique?: boolean): Promise<UUID> {
    return this.baseAdapter.createMemory(memory, tableName, unique);
  }

  async updateMemory(
    memory: Partial<Memory> & { id: UUID; metadata?: MemoryMetadata }
  ): Promise<boolean> {
    return this.baseAdapter.updateMemory(memory);
  }

  async deleteMemory(memoryId: UUID): Promise<void> {
    return this.baseAdapter.deleteMemory(memoryId);
  }

  async deleteManyMemories(memoryIds: UUID[]): Promise<void> {
    return this.baseAdapter.deleteManyMemories(memoryIds);
  }

  async deleteAllMemories(roomId: UUID, tableName: string): Promise<void> {
    return this.baseAdapter.deleteAllMemories(roomId, tableName);
  }

  async countMemories(roomId: UUID, unique?: boolean, tableName?: string): Promise<number> {
    return this.baseAdapter.countMemories(roomId, unique, tableName);
  }

  async getMemoriesByWorldId(params: {
    worldId: UUID;
    count?: number;
    tableName?: string;
  }): Promise<Memory[]> {
    return this.baseAdapter.getMemoriesByWorldId(params);
  }

  // ==================== Log Methods (Not Cached) ====================

  async log(params: {
    body: { [key: string]: unknown };
    entityId: UUID;
    roomId: UUID;
    type: string;
  }): Promise<void> {
    return this.baseAdapter.log(params);
  }

  async getLogs(params: {
    entityId?: UUID;
    roomId?: UUID;
    type?: string;
    count?: number;
    offset?: number;
  }): Promise<Log[]> {
    return this.baseAdapter.getLogs(params);
  }

  async deleteLog(logId: UUID): Promise<void> {
    return this.baseAdapter.deleteLog(logId);
  }

  // ==================== Cache Methods (Passthrough to DB cache) ====================

  async getCache<T>(key: string): Promise<T | undefined> {
    return this.baseAdapter.getCache<T>(key);
  }

  async setCache<T>(key: string, value: T): Promise<boolean> {
    return this.baseAdapter.setCache<T>(key, value);
  }

  async deleteCache(key: string): Promise<boolean> {
    return this.baseAdapter.deleteCache(key);
  }

  // ==================== Optional Methods ====================

  async runPluginMigrations?(
    plugins: Array<{
      name: string;
      schema?: Record<string, string | number | boolean | null | Record<string, unknown>>;
    }>,
    options?: { verbose?: boolean; force?: boolean; dryRun?: boolean }
  ): Promise<void> {
    if (this.baseAdapter.runPluginMigrations) {
      return this.baseAdapter.runPluginMigrations(plugins, options);
    }
  }

  async runMigrations?(migrationsPaths?: string[]): Promise<void> {
    if (this.baseAdapter.runMigrations) {
      return this.baseAdapter.runMigrations(migrationsPaths);
    }
  }

  async withEntityContext?<T>(entityId: UUID | null, callback: () => Promise<T>): Promise<T> {
    if (this.baseAdapter.withEntityContext) {
      return this.baseAdapter.withEntityContext(entityId, callback);
    }
    return callback();
  }

  async getAgentRunSummaries?(params: {
    limit?: number;
    roomId?: UUID;
    status?: RunStatus | 'all';
    from?: number;
    to?: number;
    entityId?: UUID;
  }): Promise<AgentRunSummaryResult> {
    if (this.baseAdapter.getAgentRunSummaries) {
      return this.baseAdapter.getAgentRunSummaries(params);
    }
    return { runs: [], total: 0, hasMore: false };
  }

  // ==================== Cache Management Methods ====================

  /**
   * Clear all in-memory caches
   */
  clearAllCaches(): void {
    this.entityCache.clear();
    this.roomCache.clear();
    this.worldCache.clear();
    this.agentCache.clear();
    this.participantCache.clear();
    this.componentCache.clear();
    this.relationshipCache.clear();
    this.taskCache.clear();
    this.roomsByWorldCache.clear();
    this.entitiesForRoomCache.clear();
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): Record<string, { size: number; maxSize: number; ttl: number | null }> {
    return {
      entity: this.entityCache.stats(),
      room: this.roomCache.stats(),
      world: this.worldCache.stats(),
      agent: this.agentCache.stats(),
      participant: this.participantCache.stats(),
      component: this.componentCache.stats(),
      relationship: this.relationshipCache.stats(),
      task: this.taskCache.stats(),
      roomsByWorld: this.roomsByWorldCache.stats(),
      entitiesForRoom: this.entitiesForRoomCache.stats(),
    };
  }

  /**
   * Check if external cache is configured
   */
  hasExternalCache(): boolean {
    return this.externalCache !== undefined;
  }

  /**
   * Get the underlying base adapter
   */
  getBaseAdapter(): IDatabaseAdapter {
    return this.baseAdapter;
  }
}

/**
 * Factory function to create a cached adapter
 */
export function createCachedAdapter(
  baseAdapter: IDatabaseAdapter,
  config?: CachedAdapterConfig
): CachedDatabaseAdapter {
  return new CachedDatabaseAdapter(baseAdapter, config);
}
