import {
  type Agent,
  type Component,
  type Content,
  DatabaseAdapter,
  type Entity,
  type Log,
  type LogBody,
  logger,
  type Memory,
  type MemoryMetadata,
  type MemoryTypeAlias,
  type Metadata,
  type Participant,
  type Relationship,
  type Room,
  type Task,
  type UUID,
  type World,
} from "@elizaos/core";
import { SimpleHNSW } from "./hnsw";
import { COLLECTIONS, type IStorage } from "./types";

interface StoredParticipant {
  id: string;
  entityId: string;
  roomId: string;
  userState?: "FOLLOWED" | "MUTED" | null;
}

interface StoredMemory {
  id?: string;
  entityId: string;
  agentId?: string;
  createdAt?: number;
  content: Content;
  embedding?: number[];
  roomId: string;
  worldId?: string;
  unique?: boolean;
  similarity?: number;
  metadata?: {
    type?: string;
    source?: string;
    sourceId?: string;
    scope?: string;
    timestamp?: number;
    tags?: string[];
    [key: string]: string | number | boolean | null | undefined | string[] | UUID;
  };
}

interface StoredRelationship {
  id: string;
  sourceEntityId: string;
  targetEntityId: string;
  agentId?: string;
  tags?: string[];
  metadata?: Metadata;
  createdAt?: string;
}

function toMemory(stored: StoredMemory): Memory {
  return {
    id: stored.id as UUID | undefined,
    entityId: stored.entityId as UUID,
    agentId: stored.agentId as UUID | undefined,
    createdAt: stored.createdAt,
    content: stored.content,
    embedding: stored.embedding,
    roomId: stored.roomId as UUID,
    worldId: stored.worldId as UUID | undefined,
    unique: stored.unique,
    similarity: stored.similarity,
    metadata: stored.metadata as MemoryMetadata | undefined,
  };
}

function toMemories(stored: StoredMemory[]): Memory[] {
  return stored.map(toMemory);
}

export class LocalDatabaseAdapter extends DatabaseAdapter<IStorage> {
  private storage: IStorage;
  private vectorIndex: SimpleHNSW;
  private embeddingDimension = 384;
  private ready = false;
  private agentId: UUID;

  constructor(storage: IStorage, agentId: UUID) {
    super();
    this.storage = storage;
    this.agentId = agentId;
    this.vectorIndex = new SimpleHNSW(
      async () => {
        const index = this.vectorIndex.getIndex();
        await this.storage.saveRaw("vectors/hnsw_index.json", JSON.stringify(index));
      },
      async () => {
        const data = await this.storage.loadRaw("vectors/hnsw_index.json");
        if (data) {
          try {
            return JSON.parse(data);
          } catch {
            return null;
          }
        }
        return null;
      }
    );
  }

  async initialize(): Promise<void> {
    await this.init();
  }

  async init(): Promise<void> {
    await this.storage.init();
    await this.vectorIndex.init(this.embeddingDimension);
    this.ready = true;
    logger.info({ src: "plugin:localdb" }, "Local database initialized");
  }

  async runPluginMigrations(
    _plugins: Array<{ name: string; schema?: Record<string, unknown> }>,
    _options?: { verbose?: boolean; force?: boolean; dryRun?: boolean }
  ): Promise<void> {
    logger.debug({ src: "plugin:localdb" }, "Plugin migrations not needed for JSON storage");
  }

  async isReady(): Promise<boolean> {
    return this.ready && (await this.storage.isReady());
  }

  async close(): Promise<void> {
    await this.vectorIndex.save();
    await this.storage.close();
    this.ready = false;
    logger.info({ src: "plugin:localdb" }, "Local database closed");
  }

  async getConnection(): Promise<IStorage> {
    return this.storage;
  }

  async getAgent(agentId: UUID): Promise<Agent | null> {
    return this.storage.get<Agent>(COLLECTIONS.AGENTS, agentId);
  }

  async getAgents(): Promise<Partial<Agent>[]> {
    return this.storage.getAll<Agent>(COLLECTIONS.AGENTS);
  }

  async createAgent(agent: Partial<Agent>): Promise<boolean> {
    if (!agent.id) return false;
    await this.storage.set(COLLECTIONS.AGENTS, agent.id, agent);
    return true;
  }

  async updateAgent(agentId: UUID, agent: Partial<Agent>): Promise<boolean> {
    const existing = await this.getAgent(agentId);
    if (!existing) return false;
    await this.storage.set(COLLECTIONS.AGENTS, agentId, {
      ...existing,
      ...agent,
    });
    return true;
  }

  async deleteAgent(agentId: UUID): Promise<boolean> {
    return this.storage.delete(COLLECTIONS.AGENTS, agentId);
  }

  async ensureEmbeddingDimension(dimension: number): Promise<void> {
    if (this.embeddingDimension !== dimension) {
      this.embeddingDimension = dimension;
      await this.vectorIndex.init(dimension);
    }
  }

  async getEntitiesByIds(entityIds: UUID[]): Promise<Entity[] | null> {
    const entities: Entity[] = [];
    for (const id of entityIds) {
      const entity = await this.storage.get<Entity>(COLLECTIONS.ENTITIES, id);
      if (entity) entities.push(entity);
    }
    return entities.length > 0 ? entities : null;
  }

  async getEntitiesForRoom(roomId: UUID, includeComponents = false): Promise<Entity[]> {
    const participants = await this.storage.getWhere<StoredParticipant>(
      COLLECTIONS.PARTICIPANTS,
      (p) => p.roomId === roomId
    );

    const entityIds = participants.map((p) => p.entityId);
    const entities: Entity[] = [];

    for (const entityId of entityIds) {
      const entity = await this.storage.get<Entity>(COLLECTIONS.ENTITIES, entityId);
      if (entity) {
        if (includeComponents) {
          const components = await this.getComponents(entityId as UUID);
          (entity as Entity & { components?: Component[] }).components = components;
        }
        entities.push(entity);
      }
    }

    return entities;
  }

  async createEntities(entities: Entity[]): Promise<boolean> {
    for (const entity of entities) {
      if (!entity.id) continue;
      await this.storage.set(COLLECTIONS.ENTITIES, entity.id, entity);
    }
    return true;
  }

  async updateEntity(entity: Entity): Promise<void> {
    if (!entity.id) return;
    await this.storage.set(COLLECTIONS.ENTITIES, entity.id, entity);
  }

  async getComponent(
    entityId: UUID,
    type: string,
    worldId?: UUID,
    sourceEntityId?: UUID
  ): Promise<Component | null> {
    const components = await this.storage.getWhere<Component>(
      COLLECTIONS.COMPONENTS,
      (c) =>
        c.entityId === entityId &&
        c.type === type &&
        (worldId === undefined || c.worldId === worldId) &&
        (sourceEntityId === undefined || c.sourceEntityId === sourceEntityId)
    );
    return components[0] ?? null;
  }

  async getComponents(entityId: UUID, worldId?: UUID, sourceEntityId?: UUID): Promise<Component[]> {
    return this.storage.getWhere<Component>(
      COLLECTIONS.COMPONENTS,
      (c) =>
        c.entityId === entityId &&
        (worldId === undefined || c.worldId === worldId) &&
        (sourceEntityId === undefined || c.sourceEntityId === sourceEntityId)
    );
  }

  async createComponent(component: Component): Promise<boolean> {
    if (!component.id) return false;
    await this.storage.set(COLLECTIONS.COMPONENTS, component.id, component);
    return true;
  }

  async updateComponent(component: Component): Promise<void> {
    if (!component.id) return;
    await this.storage.set(COLLECTIONS.COMPONENTS, component.id, component);
  }

  async deleteComponent(componentId: UUID): Promise<void> {
    await this.storage.delete(COLLECTIONS.COMPONENTS, componentId);
  }

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
    let memories = await this.storage.getWhere<StoredMemory>(COLLECTIONS.MEMORIES, (m) => {
      if (params.entityId && m.entityId !== params.entityId) return false;
      if (params.agentId && m.agentId !== params.agentId) return false;
      if (params.roomId && m.roomId !== params.roomId) return false;
      if (params.worldId && m.worldId !== params.worldId) return false;
      if (params.tableName && m.metadata?.type !== params.tableName) return false;
      if (params.start && m.createdAt && m.createdAt < params.start) return false;
      if (params.end && m.createdAt && m.createdAt > params.end) return false;
      if (params.unique && !m.unique) return false;
      return true;
    });

    memories.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));

    if (params.offset) {
      memories = memories.slice(params.offset);
    }
    if (params.count) {
      memories = memories.slice(0, params.count);
    }

    return toMemories(memories);
  }

  async getMemoriesByRoomIds(params: {
    roomIds: UUID[];
    tableName: string;
    limit?: number;
  }): Promise<Memory[]> {
    const memories = await this.storage.getWhere<StoredMemory>(
      COLLECTIONS.MEMORIES,
      (m) =>
        params.roomIds.includes(m.roomId as UUID) &&
        (params.tableName ? m.metadata?.type === params.tableName : true)
    );

    memories.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));

    if (params.limit) {
      return toMemories(memories.slice(0, params.limit));
    }
    return toMemories(memories);
  }

  async getMemoryById(id: UUID): Promise<Memory | null> {
    return this.storage.get<Memory>(COLLECTIONS.MEMORIES, id);
  }

  async getMemoriesByIds(memoryIds: UUID[], tableName?: string): Promise<Memory[]> {
    const memories: Memory[] = [];
    for (const id of memoryIds) {
      const memory = await this.storage.get<StoredMemory>(COLLECTIONS.MEMORIES, id);
      if (memory) {
        if (tableName && memory.metadata?.type !== tableName) continue;
        memories.push(toMemory(memory));
      }
    }
    return memories;
  }

  async getCachedEmbeddings(params: {
    query_table_name: string;
    query_threshold: number;
    query_input: string;
    query_field_name: string;
    query_field_sub_name: string;
    query_match_count: number;
  }): Promise<{ embedding: number[]; levenshtein_score: number }[]> {
    const memories = await this.storage.getWhere<StoredMemory>(
      COLLECTIONS.MEMORIES,
      (m) => m.metadata?.type === params.query_table_name
    );

    const results: { embedding: number[]; levenshtein_score: number }[] = [];

    for (const memory of memories) {
      if (!memory.embedding) continue;

      const memoryRecord = memory as StoredMemory &
        Record<string, string | number | boolean | null | undefined | string[] | UUID>;
      const fieldValue = memoryRecord[params.query_field_name];
      const content = String(fieldValue ?? "");
      const score = this.simpleStringScore(params.query_input, content);

      if (score <= params.query_threshold) {
        results.push({
          embedding: memory.embedding,
          levenshtein_score: score,
        });
      }
    }

    return results.slice(0, params.query_match_count);
  }

  private simpleStringScore(a: string, b: string): number {
    if (a === b) return 0;
    const aLower = a.toLowerCase();
    const bLower = b.toLowerCase();
    if (aLower === bLower) return 0.1;
    if (aLower.includes(bLower) || bLower.includes(aLower)) return 0.3;
    return 1;
  }

  async log(params: { body: LogBody; entityId: UUID; roomId: UUID; type: string }): Promise<void> {
    const id = crypto.randomUUID() as UUID;
    const log: Log = {
      id,
      entityId: params.entityId,
      roomId: params.roomId,
      body: params.body,
      type: params.type,
      createdAt: new Date(),
    };
    await this.storage.set(COLLECTIONS.LOGS, id, log);
  }

  async getLogs(params: {
    entityId?: UUID;
    roomId?: UUID;
    type?: string;
    count?: number;
    offset?: number;
  }): Promise<Log[]> {
    let logs = await this.storage.getWhere<Log>(COLLECTIONS.LOGS, (l) => {
      if (params.entityId && l.entityId !== params.entityId) return false;
      if (params.roomId && l.roomId !== params.roomId) return false;
      if (params.type && l.type !== params.type) return false;
      return true;
    });

    logs.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    if (params.offset) {
      logs = logs.slice(params.offset);
    }
    if (params.count) {
      logs = logs.slice(0, params.count);
    }

    return logs;
  }

  async deleteLog(logId: UUID): Promise<void> {
    await this.storage.delete(COLLECTIONS.LOGS, logId);
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
    const threshold = params.match_threshold ?? 0.5;
    const count = params.count ?? 10;

    const results = await this.vectorIndex.search(params.embedding, count * 2, threshold);
    const memories: Memory[] = [];
    for (const result of results) {
      const memory = await this.storage.get<StoredMemory>(COLLECTIONS.MEMORIES, result.id);
      if (!memory) continue;

      if (params.tableName && memory.metadata?.type !== params.tableName) continue;
      if (params.roomId && memory.roomId !== params.roomId) continue;
      if (params.worldId && memory.worldId !== params.worldId) continue;
      if (params.entityId && memory.entityId !== params.entityId) continue;
      if (params.unique && !memory.unique) continue;

      memories.push({
        ...toMemory(memory),
        similarity: result.similarity,
      });
    }

    return memories.slice(0, count);
  }

  async createMemory(memory: Memory, tableName: string, unique = false): Promise<UUID> {
    const id = memory.id ?? (crypto.randomUUID() as UUID);
    const now = Date.now();

    const storedMemory: StoredMemory = {
      ...memory,
      id,
      agentId: memory.agentId ?? this.agentId,
      unique: unique || memory.unique,
      createdAt: memory.createdAt ?? now,
      metadata: {
        ...(memory.metadata as Record<string, unknown>),
        type: tableName as MemoryTypeAlias,
      },
    };

    await this.storage.set(COLLECTIONS.MEMORIES, id, storedMemory);

    if (memory.embedding && memory.embedding.length > 0) {
      await this.vectorIndex.add(id, memory.embedding);
      await this.vectorIndex.save();
    }

    return id;
  }

  async updateMemory(
    memory: Partial<Memory> & { id: UUID; metadata?: MemoryMetadata }
  ): Promise<boolean> {
    const existing = await this.getMemoryById(memory.id);
    if (!existing) return false;

    const updated = {
      ...existing,
      ...memory,
      metadata: {
        ...(existing.metadata as Record<string, unknown>),
        ...(memory.metadata as Record<string, unknown>),
      },
    };

    await this.storage.set(COLLECTIONS.MEMORIES, memory.id, updated);

    if (memory.embedding && memory.embedding.length > 0) {
      await this.vectorIndex.add(memory.id, memory.embedding);
      await this.vectorIndex.save();
    }

    return true;
  }

  async deleteMemory(memoryId: UUID): Promise<void> {
    await this.storage.delete(COLLECTIONS.MEMORIES, memoryId);
    await this.vectorIndex.remove(memoryId);
    await this.vectorIndex.save();
  }

  async deleteManyMemories(memoryIds: UUID[]): Promise<void> {
    for (const id of memoryIds) {
      await this.deleteMemory(id);
    }
  }

  async deleteAllMemories(roomId: UUID, tableName: string): Promise<void> {
    const memories = await this.getMemories({ roomId, tableName });
    await this.deleteManyMemories(
      memories.map((m) => m.id).filter((id): id is UUID => id !== undefined)
    );
  }

  async countMemories(roomId: UUID, unique = false, tableName?: string): Promise<number> {
    return this.storage.count<StoredMemory>(COLLECTIONS.MEMORIES, (memory) => {
      if (memory.roomId !== roomId) return false;
      if (unique && !memory.unique) return false;
      if (tableName && memory.metadata?.type !== tableName) return false;
      return true;
    });
  }

  async getMemoriesByWorldId(params: {
    worldId: UUID;
    count?: number;
    tableName?: string;
  }): Promise<Memory[]> {
    const memories = await this.storage.getWhere<StoredMemory>(
      COLLECTIONS.MEMORIES,
      (m) =>
        m.worldId === params.worldId &&
        (params.tableName ? m.metadata?.type === params.tableName : true)
    );

    memories.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));

    if (params.count) {
      return toMemories(memories.slice(0, params.count));
    }
    return toMemories(memories);
  }

  async createWorld(world: World): Promise<UUID> {
    const id = world.id ?? (crypto.randomUUID() as UUID);
    await this.storage.set(COLLECTIONS.WORLDS, id, { ...world, id });
    return id;
  }

  async getWorld(id: UUID): Promise<World | null> {
    return this.storage.get<World>(COLLECTIONS.WORLDS, id);
  }

  async removeWorld(id: UUID): Promise<void> {
    await this.storage.delete(COLLECTIONS.WORLDS, id);
  }

  async getAllWorlds(): Promise<World[]> {
    return this.storage.getAll<World>(COLLECTIONS.WORLDS);
  }

  async updateWorld(world: World): Promise<void> {
    if (!world.id) return;
    await this.storage.set(COLLECTIONS.WORLDS, world.id, world);
  }

  async getRoomsByIds(roomIds: UUID[]): Promise<Room[] | null> {
    const rooms: Room[] = [];
    for (const id of roomIds) {
      const room = await this.storage.get<Room>(COLLECTIONS.ROOMS, id);
      if (room) rooms.push(room);
    }
    return rooms.length > 0 ? rooms : null;
  }

  async createRooms(rooms: Room[]): Promise<UUID[]> {
    const ids: UUID[] = [];
    for (const room of rooms) {
      const id = room.id ?? (crypto.randomUUID() as UUID);
      await this.storage.set(COLLECTIONS.ROOMS, id, { ...room, id });
      ids.push(id);
    }
    return ids;
  }

  async deleteRoom(roomId: UUID): Promise<void> {
    await this.storage.delete(COLLECTIONS.ROOMS, roomId);
    await this.storage.deleteWhere<StoredParticipant>(
      COLLECTIONS.PARTICIPANTS,
      (p) => p.roomId === roomId
    );
    await this.storage.deleteWhere<StoredMemory>(COLLECTIONS.MEMORIES, (m) => m.roomId === roomId);
  }

  async deleteRoomsByWorldId(worldId: UUID): Promise<void> {
    const rooms = await this.getRoomsByWorld(worldId);
    for (const room of rooms) {
      if (room.id) {
        await this.deleteRoom(room.id);
      }
    }
  }

  async updateRoom(room: Room): Promise<void> {
    if (!room.id) return;
    await this.storage.set(COLLECTIONS.ROOMS, room.id, room);
  }

  async getRoomsForParticipant(entityId: UUID): Promise<UUID[]> {
    const participants = await this.storage.getWhere<StoredParticipant>(
      COLLECTIONS.PARTICIPANTS,
      (p) => p.entityId === entityId
    );
    return participants.map((p) => p.roomId as UUID);
  }

  async getRoomsForParticipants(userIds: UUID[]): Promise<UUID[]> {
    const participants = await this.storage.getWhere<StoredParticipant>(
      COLLECTIONS.PARTICIPANTS,
      (p) => userIds.includes(p.entityId as UUID)
    );
    return [...new Set(participants.map((p) => p.roomId as UUID))];
  }

  async getRoomsByWorld(worldId: UUID): Promise<Room[]> {
    return this.storage.getWhere<Room>(COLLECTIONS.ROOMS, (r) => r.worldId === worldId);
  }

  async removeParticipant(entityId: UUID, roomId: UUID): Promise<boolean> {
    const participants = await this.storage.getWhere<StoredParticipant>(
      COLLECTIONS.PARTICIPANTS,
      (p) => p.entityId === entityId && p.roomId === roomId
    );

    if (participants.length === 0) return false;

    for (const p of participants) {
      if (p.id) {
        await this.storage.delete(COLLECTIONS.PARTICIPANTS, p.id);
      }
    }
    return true;
  }

  async getParticipantsForEntity(entityId: UUID): Promise<Participant[]> {
    const stored = await this.storage.getWhere<StoredParticipant>(
      COLLECTIONS.PARTICIPANTS,
      (p) => p.entityId === entityId
    );

    const participants: Participant[] = [];
    for (const p of stored) {
      const entity = await this.storage.get<Entity>(COLLECTIONS.ENTITIES, p.entityId);
      if (entity) {
        participants.push({
          id: p.id as UUID,
          entity,
        });
      }
    }
    return participants;
  }

  async getParticipantsForRoom(roomId: UUID): Promise<UUID[]> {
    const participants = await this.storage.getWhere<StoredParticipant>(
      COLLECTIONS.PARTICIPANTS,
      (p) => p.roomId === roomId
    );
    return participants.map((p) => p.entityId as UUID);
  }

  async isRoomParticipant(roomId: UUID, entityId: UUID): Promise<boolean> {
    const participants = await this.storage.getWhere<StoredParticipant>(
      COLLECTIONS.PARTICIPANTS,
      (p) => p.roomId === roomId && p.entityId === entityId
    );
    return participants.length > 0;
  }

  async addParticipantsRoom(entityIds: UUID[], roomId: UUID): Promise<boolean> {
    for (const entityId of entityIds) {
      const exists = await this.isRoomParticipant(roomId, entityId);
      if (!exists) {
        const id = crypto.randomUUID();
        const participant: StoredParticipant = {
          id,
          entityId,
          roomId,
        };
        await this.storage.set(COLLECTIONS.PARTICIPANTS, id, participant);
      }
    }
    return true;
  }

  async getParticipantUserState(
    roomId: UUID,
    entityId: UUID
  ): Promise<"FOLLOWED" | "MUTED" | null> {
    const participants = await this.storage.getWhere<StoredParticipant>(
      COLLECTIONS.PARTICIPANTS,
      (p) => p.roomId === roomId && p.entityId === entityId
    );

    if (participants.length === 0) return null;
    const state = participants[0].userState;
    if (state === "FOLLOWED" || state === "MUTED") return state;
    return null;
  }

  async setParticipantUserState(
    roomId: UUID,
    entityId: UUID,
    state: "FOLLOWED" | "MUTED" | null
  ): Promise<void> {
    const participants = await this.storage.getWhere<StoredParticipant>(
      COLLECTIONS.PARTICIPANTS,
      (p) => p.roomId === roomId && p.entityId === entityId
    );

    for (const p of participants) {
      if (p.id) {
        await this.storage.set(COLLECTIONS.PARTICIPANTS, p.id, {
          ...p,
          userState: state,
        });
      }
    }
  }

  async createRelationship(params: {
    sourceEntityId: UUID;
    targetEntityId: UUID;
    tags?: string[];
    metadata?: Metadata;
  }): Promise<boolean> {
    const id = crypto.randomUUID() as UUID;
    const relationship: StoredRelationship = {
      id,
      sourceEntityId: params.sourceEntityId,
      targetEntityId: params.targetEntityId,
      agentId: this.agentId,
      tags: params.tags ?? [],
      metadata: params.metadata ?? ({} as Metadata),
      createdAt: new Date().toISOString(),
    };
    await this.storage.set(COLLECTIONS.RELATIONSHIPS, id, relationship);
    return true;
  }

  async getRelationship(params: {
    sourceEntityId: UUID;
    targetEntityId: UUID;
  }): Promise<Relationship | null> {
    const relationships = await this.storage.getWhere<StoredRelationship>(
      COLLECTIONS.RELATIONSHIPS,
      (r) =>
        r.sourceEntityId === params.sourceEntityId && r.targetEntityId === params.targetEntityId
    );

    if (relationships.length === 0) return null;

    const r = relationships[0];
    return {
      id: r.id as UUID,
      sourceEntityId: r.sourceEntityId as UUID,
      targetEntityId: r.targetEntityId as UUID,
      agentId: (r.agentId as UUID) ?? this.agentId,
      tags: r.tags ?? [],
      metadata: r.metadata ?? {},
      createdAt: r.createdAt,
    };
  }

  async getRelationships(params: { entityId: UUID; tags?: string[] }): Promise<Relationship[]> {
    const stored = await this.storage.getWhere<StoredRelationship>(
      COLLECTIONS.RELATIONSHIPS,
      (r) => {
        const isInvolved =
          r.sourceEntityId === params.entityId || r.targetEntityId === params.entityId;
        if (!isInvolved) return false;
        if (params.tags && params.tags.length > 0) {
          return params.tags.some((tag) => r.tags?.includes(tag));
        }
        return true;
      }
    );

    return stored.map((r) => ({
      id: r.id as UUID,
      sourceEntityId: r.sourceEntityId as UUID,
      targetEntityId: r.targetEntityId as UUID,
      agentId: (r.agentId as UUID) ?? this.agentId,
      tags: r.tags ?? [],
      metadata: r.metadata ?? {},
      createdAt: r.createdAt,
    }));
  }

  async updateRelationship(relationship: Relationship): Promise<void> {
    const existing = await this.getRelationship({
      sourceEntityId: relationship.sourceEntityId,
      targetEntityId: relationship.targetEntityId,
    });

    if (!existing || !existing.id) return;

    const stored: StoredRelationship = {
      id: existing.id,
      sourceEntityId: relationship.sourceEntityId,
      targetEntityId: relationship.targetEntityId,
      agentId: relationship.agentId,
      tags: relationship.tags ?? existing.tags ?? [],
      metadata: { ...(existing.metadata ?? {}), ...(relationship.metadata ?? {}) },
      createdAt: existing.createdAt ?? new Date().toISOString(),
    };

    await this.storage.set(COLLECTIONS.RELATIONSHIPS, existing.id, stored);
  }

  async getCache<T>(key: string): Promise<T | undefined> {
    const cached = await this.storage.get<{ value: T; expiresAt?: number }>(COLLECTIONS.CACHE, key);
    if (!cached) return undefined;

    if (cached.expiresAt && Date.now() > cached.expiresAt) {
      await this.deleteCache(key);
      return undefined;
    }

    return cached.value;
  }

  async setCache<T>(key: string, value: T): Promise<boolean> {
    await this.storage.set(COLLECTIONS.CACHE, key, { value });
    return true;
  }

  async deleteCache(key: string): Promise<boolean> {
    return this.storage.delete(COLLECTIONS.CACHE, key);
  }

  async createTask(task: Task): Promise<UUID> {
    const id = task.id ?? (crypto.randomUUID() as UUID);
    await this.storage.set(COLLECTIONS.TASKS, id, { ...task, id });
    return id;
  }

  async getTasks(params: { roomId?: UUID; tags?: string[]; entityId?: UUID }): Promise<Task[]> {
    return this.storage.getWhere<Task>(COLLECTIONS.TASKS, (t) => {
      if (params.roomId && t.roomId !== params.roomId) return false;
      if (params.entityId && t.entityId !== params.entityId) return false;
      if (params.tags && params.tags.length > 0) {
        if (!t.tags?.some((tag) => params.tags?.includes(tag))) return false;
      }
      return true;
    });
  }

  async getTask(id: UUID): Promise<Task | null> {
    return this.storage.get<Task>(COLLECTIONS.TASKS, id);
  }

  async getTasksByName(name: string): Promise<Task[]> {
    return this.storage.getWhere<Task>(COLLECTIONS.TASKS, (t) => t.name === name);
  }

  async updateTask(id: UUID, task: Partial<Task>): Promise<void> {
    const existing = await this.getTask(id);
    if (!existing) return;
    await this.storage.set(COLLECTIONS.TASKS, id, { ...existing, ...task });
  }

  async deleteTask(id: UUID): Promise<void> {
    await this.storage.delete(COLLECTIONS.TASKS, id);
  }
}
