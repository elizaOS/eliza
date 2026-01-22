import { DatabaseAdapter } from "../database";
import type {
  Agent,
  Component,
  Entity,
  Log,
  LogBody,
  Memory,
  MemoryMetadata,
  Participant,
  Relationship,
  Room,
  Task,
  UUID,
  World,
} from "../types";
import { DEFAULT_UUID } from "../types/primitives";

function asUuid(id: string): UUID {
  return id as UUID;
}

function roomTableKey(tableName: string, roomId: UUID): string {
  return `${tableName}:${String(roomId)}`;
}

/**
 * In-memory database adapter intended for:
 * - Benchmarks
 * - Tests
 * - Serverless / ephemeral runs
 *
 * It implements the full `IDatabaseAdapter` surface with safe no-op defaults.
 * Persistence is process-local.
 */
export class InMemoryDatabaseAdapter extends DatabaseAdapter<
  Record<string, never>
> {
  db: Record<string, never> = {};

  private ready = false;

  private agents = new Map<string, Partial<Agent>>();
  private entities = new Map<string, Entity>();
  private rooms = new Map<string, Room>();
  private worlds = new Map<string, World>();
  private tasks = new Map<string, Task>();
  private logs: Log[] = [];

  private memoriesById = new Map<string, Memory>();
  private memoriesByRoom = new Map<string, Memory[]>();
  private cache = new Map<string, string>();

  private participantsByRoom = new Map<string, Set<string>>();
  private roomsByParticipant = new Map<string, Set<string>>();
  private participantUserState = new Map<string, "FOLLOWED" | "MUTED" | null>();

  async initialize(_config?: Record<string, string | number | boolean | null>) {
    this.ready = true;
  }

  async init() {
    this.ready = true;
  }

  async runPluginMigrations() {
    // no-op
  }

  async runMigrations() {
    // no-op
  }

  async isReady(): Promise<boolean> {
    return this.ready;
  }

  async close(): Promise<void> {
    this.ready = false;
  }

  async getConnection(): Promise<Record<string, never>> {
    return this.db;
  }

  async getAgent(agentId: UUID): Promise<Agent | null> {
    const a = this.agents.get(String(agentId));
    return (a ?? null) as Agent | null;
  }

  async getAgents(): Promise<Partial<Agent>[]> {
    return Array.from(this.agents.values());
  }

  async createAgent(agent: Partial<Agent>): Promise<boolean> {
    if (agent.id) {
      this.agents.set(String(agent.id), agent);
    }
    return true;
  }

  async updateAgent(agentId: UUID, agent: Partial<Agent>): Promise<boolean> {
    const existing = this.agents.get(String(agentId)) ?? {};
    this.agents.set(String(agentId), { ...existing, ...agent, id: agentId });
    return true;
  }

  async deleteAgent(agentId: UUID): Promise<boolean> {
    this.agents.delete(String(agentId));
    return true;
  }

  async ensureEmbeddingDimension(_dimension: number): Promise<void> {
    // no-op
  }

  async getEntitiesByIds(entityIds: UUID[]): Promise<Entity[] | null> {
    const out: Entity[] = [];
    for (const id of entityIds) {
      const e = this.entities.get(String(id));
      if (e) out.push(e);
    }
    return out;
  }

  async getEntitiesForRoom(_roomId: UUID): Promise<Entity[]> {
    return [];
  }

  async createEntities(entities: Entity[]): Promise<boolean> {
    for (const e of entities) {
      this.entities.set(String(e.id), e);
    }
    return true;
  }

  async updateEntity(entity: Entity): Promise<void> {
    this.entities.set(String(entity.id), entity);
  }

  async getComponent(
    _entityId: UUID,
    _type: string,
    _worldId?: UUID,
    _sourceEntityId?: UUID,
  ): Promise<Component | null> {
    return null;
  }

  async getComponents(
    _entityId: UUID,
    _worldId?: UUID,
    _sourceEntityId?: UUID,
  ): Promise<Component[]> {
    return [];
  }

  async createComponent(_component: Component): Promise<boolean> {
    return true;
  }

  async updateComponent(_component: Component): Promise<void> {
    // no-op
  }

  async deleteComponent(_componentId: UUID): Promise<void> {
    // no-op
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
    const roomId = params.roomId ?? DEFAULT_UUID;
    const all =
      this.memoriesByRoom.get(roomTableKey(params.tableName, roomId)) ?? [];
    const offset = params.offset ?? 0;
    const count = params.count ?? all.length;
    return all.slice(offset, offset + count);
  }

  async getMemoryById(id: UUID): Promise<Memory | null> {
    return this.memoriesById.get(String(id)) ?? null;
  }

  async getMemoriesByIds(ids: UUID[]): Promise<Memory[]> {
    const out: Memory[] = [];
    for (const id of ids) {
      const m = this.memoriesById.get(String(id));
      if (m) out.push(m);
    }
    return out;
  }

  async getMemoriesByRoomIds(params: {
    tableName: string;
    roomIds: UUID[];
    limit?: number;
  }): Promise<Memory[]> {
    const limit = params.limit ?? 20;
    const out: Memory[] = [];
    for (const rid of params.roomIds) {
      const list =
        this.memoriesByRoom.get(roomTableKey(params.tableName, rid)) ?? [];
      for (const m of list) {
        out.push(m);
        if (out.length >= limit) return out;
      }
    }
    return out;
  }

  async getCachedEmbeddings(): Promise<
    { embedding: number[]; levenshtein_score: number }[]
  > {
    return [];
  }

  async log(params: {
    body: LogBody;
    entityId: UUID;
    roomId: UUID;
    type: string;
  }) {
    const id =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    this.logs.push({
      id: asUuid(id),
      createdAt: new Date(),
      entityId: params.entityId,
      roomId: params.roomId,
      type: params.type,
      body: params.body,
    });
  }

  async getLogs(): Promise<Log[]> {
    return this.logs;
  }

  async deleteLog(logId: UUID): Promise<void> {
    this.logs = this.logs.filter((l) => l.id !== logId);
  }

  async searchMemories(): Promise<Memory[]> {
    return [];
  }

  async createMemory(memory: Memory, tableName: string): Promise<UUID> {
    const gen =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const id = memory.id ? String(memory.id) : gen;
    const stored: Memory = {
      ...memory,
      id: asUuid(id),
    };
    this.memoriesById.set(id, stored);
    const roomId = memory.roomId ?? DEFAULT_UUID;
    const key = roomTableKey(tableName, roomId);
    const list = this.memoriesByRoom.get(key) ?? [];
    list.push(stored);
    this.memoriesByRoom.set(key, list);
    return asUuid(id);
  }

  async updateMemory(
    memory: Partial<Memory> & { id: UUID; metadata?: MemoryMetadata },
  ): Promise<boolean> {
    const existing = this.memoriesById.get(String(memory.id));
    if (!existing) return false;
    const merged: Memory = { ...existing, ...memory };
    this.memoriesById.set(String(memory.id), merged);
    return true;
  }

  async deleteMemory(memoryId: UUID): Promise<void> {
    this.memoriesById.delete(String(memoryId));
  }

  async deleteManyMemories(memoryIds: UUID[]): Promise<void> {
    for (const id of memoryIds) {
      this.memoriesById.delete(String(id));
    }
  }

  async deleteAllMemories(roomId: UUID): Promise<void> {
    this.memoriesByRoom.delete(String(roomId));
  }

  async countMemories(roomId: UUID): Promise<number> {
    return (this.memoriesByRoom.get(String(roomId)) ?? []).length;
  }

  async createWorld(world: World): Promise<UUID> {
    this.worlds.set(String(world.id), world);
    return world.id;
  }

  async getWorld(id: UUID): Promise<World | null> {
    return this.worlds.get(String(id)) ?? null;
  }

  async removeWorld(id: UUID): Promise<void> {
    this.worlds.delete(String(id));
  }

  async getAllWorlds(): Promise<World[]> {
    return Array.from(this.worlds.values());
  }

  async updateWorld(world: World): Promise<void> {
    this.worlds.set(String(world.id), world);
  }

  async createRoom(room: Room): Promise<UUID> {
    this.rooms.set(String(room.id), room);
    return room.id;
  }

  async getRoom(id: UUID): Promise<Room | null> {
    return this.rooms.get(String(id)) ?? null;
  }

  async deleteRoom(id: UUID): Promise<void> {
    this.rooms.delete(String(id));
  }

  async updateRoom(room: Room): Promise<void> {
    this.rooms.set(String(room.id), room);
  }

  async getRoomsByIds(roomIds: UUID[]): Promise<Room[] | null> {
    const out: Room[] = [];
    for (const id of roomIds) {
      const r = this.rooms.get(String(id));
      if (r) out.push(r);
    }
    return out.length > 0 ? out : null;
  }

  async createRooms(rooms: Room[]): Promise<UUID[]> {
    const ids: UUID[] = [];
    for (const r of rooms) {
      this.rooms.set(String(r.id), r);
      ids.push(r.id);
    }
    return ids;
  }

  async getRoomsForParticipant(entityId: UUID): Promise<UUID[]> {
    const set = this.roomsByParticipant.get(String(entityId));
    if (!set) return [];
    return Array.from(set.values()).map(asUuid);
  }

  async getRoomsForParticipants(userIds: UUID[]): Promise<UUID[]> {
    const out = new Set<string>();
    for (const id of userIds) {
      const set = this.roomsByParticipant.get(String(id));
      if (!set) continue;
      for (const roomId of set.values()) out.add(roomId);
    }
    return Array.from(out.values()).map(asUuid);
  }

  async getRoomsByWorld(worldId: UUID): Promise<Room[]> {
    const out: Room[] = [];
    for (const room of this.rooms.values()) {
      if (room.worldId && room.worldId === worldId) {
        out.push(room);
      }
    }
    return out;
  }

  async getParticipantsForEntity(entityId: UUID): Promise<Participant[]> {
    const entity = this.entities.get(String(entityId));
    if (!entity) return [];
    return [{ id: entityId, entity }];
  }

  async getParticipantsForRoom(roomId: UUID): Promise<UUID[]> {
    const set = this.participantsByRoom.get(String(roomId));
    if (!set) return [];
    return Array.from(set.values()).map(asUuid);
  }

  async addParticipantsRoom(entityIds: UUID[], roomId: UUID): Promise<boolean> {
    const roomKey = String(roomId);
    const participants =
      this.participantsByRoom.get(roomKey) ?? new Set<string>();
    for (const eid of entityIds) {
      const entityKey = String(eid);
      participants.add(entityKey);
      const rooms = this.roomsByParticipant.get(entityKey) ?? new Set<string>();
      rooms.add(roomKey);
      this.roomsByParticipant.set(entityKey, rooms);
    }
    this.participantsByRoom.set(roomKey, participants);
    return true;
  }

  async removeParticipant(entityId: UUID, roomId: UUID): Promise<boolean> {
    const roomKey = String(roomId);
    const entityKey = String(entityId);
    const participants = this.participantsByRoom.get(roomKey);
    if (participants) {
      participants.delete(entityKey);
      if (participants.size === 0) this.participantsByRoom.delete(roomKey);
    }
    const rooms = this.roomsByParticipant.get(entityKey);
    if (rooms) {
      rooms.delete(roomKey);
      if (rooms.size === 0) this.roomsByParticipant.delete(entityKey);
    }
    this.participantUserState.delete(`${roomKey}:${entityKey}`);
    return true;
  }

  async isRoomParticipant(roomId: UUID, entityId: UUID): Promise<boolean> {
    const set = this.participantsByRoom.get(String(roomId));
    if (!set) return false;
    return set.has(String(entityId));
  }

  async getParticipantUserState(
    roomId: UUID,
    entityId: UUID,
  ): Promise<"FOLLOWED" | "MUTED" | null> {
    const key = `${String(roomId)}:${String(entityId)}`;
    return this.participantUserState.get(key) ?? null;
  }

  async setParticipantUserState(
    roomId: UUID,
    entityId: UUID,
    state: "FOLLOWED" | "MUTED" | null,
  ): Promise<void> {
    const key = `${String(roomId)}:${String(entityId)}`;
    this.participantUserState.set(key, state);
  }

  async createRelationship(): Promise<boolean> {
    return true;
  }

  async updateRelationship(): Promise<void> {
    // no-op
  }

  async getRelationship(): Promise<Relationship | null> {
    return null;
  }

  async getRelationships(): Promise<Relationship[]> {
    return [];
  }

  async getCache<T>(key: string): Promise<T | undefined> {
    const raw = this.cache.get(key);
    if (raw === undefined) return undefined;
    return JSON.parse(raw) as T;
  }

  async setCache<T>(key: string, value: T): Promise<boolean> {
    this.cache.set(key, JSON.stringify(value));
    return true;
  }

  async deleteCache(key: string): Promise<boolean> {
    return this.cache.delete(key);
  }

  async createTask(task: Task): Promise<UUID> {
    const gen =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const id = task.id ? String(task.id) : gen;
    const stored: Task = { ...task, id: asUuid(id) };
    this.tasks.set(id, stored);
    return asUuid(id);
  }

  async getTasks(params: {
    roomId?: UUID;
    tags?: string[];
    entityId?: UUID;
  }): Promise<Task[]> {
    const all = Array.from(this.tasks.values());
    return all.filter((t) => {
      if (params.roomId && t.roomId !== params.roomId) return false;
      if (params.entityId && t.entityId !== params.entityId) return false;
      if (params.tags && params.tags.length > 0) {
        for (const tag of params.tags) {
          if (!t.tags.includes(tag)) return false;
        }
      }
      return true;
    });
  }

  async getTask(taskId: UUID): Promise<Task | null> {
    return this.tasks.get(String(taskId)) ?? null;
  }

  async getTasksByName(name: string): Promise<Task[]> {
    return Array.from(this.tasks.values()).filter((t) => t.name === name);
  }

  async updateTask(taskId: UUID, task: Partial<Task>): Promise<void> {
    const existing = this.tasks.get(String(taskId));
    if (!existing) return;
    this.tasks.set(String(taskId), {
      ...existing,
      ...task,
      id: taskId,
    } as Task);
  }

  async deleteTask(taskId: UUID): Promise<void> {
    this.tasks.delete(String(taskId));
  }

  async getMemoriesByWorldId(params: {
    worldId: UUID;
    count?: number;
    tableName?: string;
  }): Promise<Memory[]> {
    const rooms = await this.getRoomsByWorld(params.worldId);
    const roomIds = rooms.map((r) => r.id);
    const limit = params.count ?? 50;

    const out: Memory[] = [];
    for (const rid of roomIds) {
      if (params.tableName) {
        const list =
          this.memoriesByRoom.get(roomTableKey(params.tableName, rid)) ?? [];
        for (const m of list) {
          out.push(m);
          if (out.length >= limit) return out;
        }
        continue;
      }

      for (const [key, list] of this.memoriesByRoom.entries()) {
        if (!key.endsWith(`:${String(rid)}`)) continue;
        for (const m of list) {
          out.push(m);
          if (out.length >= limit) return out;
        }
      }
    }
    return out;
  }

  async deleteRoomsByWorldId(worldId: UUID): Promise<void> {
    const rooms = await this.getRoomsByWorld(worldId);
    for (const room of rooms) {
      const roomKey = String(room.id);
      this.rooms.delete(roomKey);
      for (const key of this.memoriesByRoom.keys()) {
        if (key.endsWith(`:${roomKey}`)) {
          this.memoriesByRoom.delete(key);
        }
      }
      this.participantsByRoom.delete(roomKey);
      // remove room membership from roomsByParticipant
      for (const [entityKey, roomSet] of this.roomsByParticipant.entries()) {
        if (roomSet.delete(roomKey) && roomSet.size === 0) {
          this.roomsByParticipant.delete(entityKey);
        }
      }
      // remove participant user states for this room
      for (const key of this.participantUserState.keys()) {
        if (key.startsWith(`${roomKey}:`)) {
          this.participantUserState.delete(key);
        }
      }
    }
  }
}
