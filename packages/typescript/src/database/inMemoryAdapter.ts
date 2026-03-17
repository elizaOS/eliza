import { DatabaseAdapter } from "../database";
import type {
  Agent,
  Component,
  Entity,
  IDatabaseAdapter,
  Log,
  LogBody,
  Memory,
  MemoryMetadata,
  Metadata,
  PatchOp,
  PairingAllowlistEntry,
  PairingChannel,
  PairingRequest,
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
 * In-memory database adapter.
 *
 * Intended for:
 * - Unit / integration tests (fast, no external dependencies)
 * - Benchmarks (measure agent logic without DB latency)
 * - Serverless / ephemeral runs (no persistence needed)
 *
 * Implements the full batch-first `IDatabaseAdapter` surface using plain
 * Maps and arrays. No single-item CRUD methods exist here -- those are
 * convenience wrappers on AgentRuntime that delegate to these batch methods.
 *
 * WHY Maps and not a single big array:
 * - `memoriesById` gives O(1) ID lookups (batch getMemoriesByIds)
 * - `memoriesByRoom` gives O(1) room-scoped queries (getMemories, countMemories)
 * - This mirrors how SQL adapters use indexed columns, keeping the
 *   in-memory adapter's performance characteristics honest.
 *
 * Persistence is process-local. Data is lost on restart.
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

  // Pairing storage
  private pairingRequests = new Map<string, PairingRequest>();
  private pairingAllowlist = new Map<string, PairingAllowlistEntry>();

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

  // Batch agent methods
  async getAgentsByIds(agentIds: UUID[]): Promise<Agent[]> {
    const agents: Agent[] = [];
    for (const id of agentIds) {
      const agent = this.agents.get(String(id));
      if (agent && agent.id) {
        agents.push(agent as Agent);
      }
    }
    return agents;
  }

  async createAgents(agents: Partial<Agent>[]): Promise<UUID[]> {
    const ids: UUID[] = [];
    for (const agent of agents) {
      if (agent.id) {
        this.agents.set(String(agent.id), agent);
        ids.push(agent.id);
      }
    }
    return ids;
  }
  
  async upsertAgents(agents: Partial<Agent>[]): Promise<void> {
    // WHY simple set: Map.set() overwrites if key exists, inserts if not.
    // This is the InMemory equivalent of ON CONFLICT DO UPDATE.
    for (const agent of agents) {
      if (agent.id) {
        this.agents.set(String(agent.id), agent);
      }
    }
  }

  async updateAgents(updates: Array<{ agentId: UUID; agent: Partial<Agent> }>): Promise<void> {
    for (const { agentId, agent } of updates) {
      const existing = this.agents.get(String(agentId)) ?? {};
      this.agents.set(String(agentId), { ...existing, ...agent, id: agentId });
    }
  }

  async deleteAgents(agentIds: UUID[]): Promise<void> {
    for (const id of agentIds) {
      this.agents.delete(String(id));
    }
  }
  
  async countAgents(): Promise<number> {
    return this.agents.size;
  }
  
  async cleanupAgents(): Promise<void> {
    // WHY no-op: InMemory adapter has no persistent storage, so no cleanup needed.
    // Agents are automatically cleared when process restarts.
  }

  async getAgents(): Promise<Partial<Agent>[]> {
    return Array.from(this.agents.values());
  }

  async ensureEmbeddingDimension(_dimension: number): Promise<void> {
    // no-op
  }

  async transaction<T>(
    callback: (tx: IDatabaseAdapter<Record<string, never>>) => Promise<T>,
    _options?: { entityContext?: UUID },
  ): Promise<T> {
    return callback(this);
  }

  async queryEntities(_params: {
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
    if (_params.entityIds?.length) {
      return this.getEntitiesByIds(_params.entityIds);
    }
    return [];
  }

  async getEntitiesForRoom(roomId: UUID, includeComponents?: boolean): Promise<Entity[]> {
    // Get participant entity IDs for the given roomId from participantsByRoom
    const participantSet = this.participantsByRoom.get(String(roomId));
    if (!participantSet || participantSet.size === 0) {
      return [];
    }

    // Return all entities that are participants in that room
    const entities: Entity[] = [];
    for (const entityIdStr of participantSet) {
      const entity = this.entities.get(entityIdStr);
      if (entity) {
        entities.push(entity);
      }
    }

    // If includeComponents is requested, include component data
    // Note: For in-memory adapter, components are not tracked per entity,
    // so this is effectively a no-op, but we maintain the interface contract
    if (includeComponents) {
      // Components would be attached here if we tracked them
      // For now, entities are returned as-is
    }

    return entities;
  }

  async createEntities(entities: Entity[]): Promise<UUID[]> {
    const ids: UUID[] = [];
    for (const e of entities) {
      if (!e.id) throw new Error("Entity id is required");
      this.entities.set(String(e.id), e);
      ids.push(e.id);
    }
    return ids;
  }
  
  async upsertEntities(entities: Entity[]): Promise<void> {
    // WHY simple set: For InMemory, upsert is just Map.set() which naturally
    // handles both insert (new key) and update (existing key) cases.
    for (const entity of entities) {
      this.entities.set(String(entity.id), entity);
    }
  }
  
  async searchEntitiesByName(params: {
    query: string;
    agentId: UUID;
    limit?: number;
  }): Promise<Entity[]> {
    // WHY O(N) scan: InMemory has no indexing, so we iterate all entities.
    // Case-insensitive substring match on any name in the names array.
    const lowerQuery = params.query.toLowerCase();
    const limit = params.limit ?? 10;
    const matches: Entity[] = [];
    
    for (const entity of this.entities.values()) {
      if (entity.agentId !== params.agentId) continue;
      
      const hasMatch = entity.names?.some(name => 
        name.toLowerCase().includes(lowerQuery)
      );
      
      if (hasMatch) {
        matches.push(entity);
        if (matches.length >= limit) break;
      }
    }
    
    return matches;
  }
  
  async getEntitiesByNames(params: { names: string[]; agentId: UUID }): Promise<Entity[]> {
    // WHY O(N) scan: InMemory has no indexing. Match ANY name in entity.names.
    // Case-sensitive exact match (consistent with SQL implementations).
    const nameSet = new Set(params.names);
    const matches: Entity[] = [];
    
    for (const entity of this.entities.values()) {
      if (entity.agentId !== params.agentId) continue;
      
      const hasMatch = entity.names?.some(name => nameSet.has(name));
      if (hasMatch) {
        matches.push(entity);
      }
    }
    
    return matches;
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

  // Batch entity methods
  async getEntitiesByIds(entityIds: UUID[]): Promise<Entity[]> {
    const entities: Entity[] = [];
    for (const entityId of entityIds) {
      const entity = this.entities.get(String(entityId));
      if (entity) entities.push(entity);
    }
    return entities;
  }

  async updateEntities(entities: Entity[]): Promise<void> {
    for (const entity of entities) {
      this.entities.set(String(entity.id), entity);
    }
  }

  async deleteEntities(entityIds: UUID[]): Promise<void> {
    for (const entityId of entityIds) {
      this.entities.delete(String(entityId));
    }
  }

  // Batch component methods
  async createComponents(components: Component[]): Promise<UUID[]> {
    return components.map(c => c.id);
  }

  async getComponentsByIds(_componentIds: UUID[]): Promise<Component[]> {
    return [];
  }

  async updateComponents(_components: Component[]): Promise<void> {
    // no-op
  }

  async deleteComponents(_componentIds: UUID[]): Promise<void> {
    // no-op
  }

  async upsertComponents(
    _components: Component[],
    _options?: { entityContext?: UUID },
  ): Promise<void> {
    // InMemory does not persist components; no-op for compatibility.
  }

  async patchComponent(
    _componentId: UUID,
    _ops: PatchOp[],
    _options?: { entityContext?: UUID },
  ): Promise<void> {
    // InMemory does not persist components; no-op for compatibility.
  }

  async getMemories(params: {
    entityId?: UUID;
    agentId?: UUID;
    /** @deprecated use limit */
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
  }): Promise<Memory[]> {
    const effectiveLimit = params.limit ?? params.count ?? Infinity;
    const roomId = params.roomId ?? DEFAULT_UUID;
    let all =
      this.memoriesByRoom.get(roomTableKey(params.tableName, roomId)) ?? [];

    // Filter by timestamp range (start/end are timestamps in milliseconds)
    // This supports history compaction - only return messages after the compaction point
    if (params.start !== undefined || params.end !== undefined) {
      all = all.filter((memory) => {
        const createdAt = memory.createdAt ?? 0;
        if (params.start !== undefined && createdAt < params.start) {
          return false;
        }
        if (params.end !== undefined && createdAt > params.end) {
          return false;
        }
        return true;
      });
    }

    // WHY: In-memory metadata filtering uses deep equality check for each
    // filter key. This is less efficient than SQL containment operators but
    // correct for nested objects/arrays. Matches PG @> and MySQL JSON_CONTAINS semantics.
    if (params.metadata) {
      const filterMeta = params.metadata as Record<string, unknown>;
      all = all.filter((memory) => {
        if (!memory.metadata) return false;
        const memMeta = memory.metadata as Record<string, unknown>;
        // Check if memory.metadata contains all key-value pairs from params.metadata
        for (const [key, value] of Object.entries(filterMeta)) {
          if (!(key in memMeta)) return false;
          // Deep equality check for nested objects/arrays
          if (JSON.stringify(memMeta[key]) !== JSON.stringify(value)) {
            return false;
          }
        }
        return true;
      });
    }

    const offset = params.offset ?? 0;
    return all.slice(offset, offset + (effectiveLimit === Infinity ? all.length : effectiveLimit));
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

  async getLogs(params: {
    entityId?: UUID;
    roomId?: UUID;
    type?: string;
    /** @deprecated use limit */
    count?: number;
    limit?: number;
    offset?: number;
  }): Promise<Log[]> {
    const effectiveLimit = params.limit ?? params.count ?? 10;
    let filtered = this.logs;

    // Filter by entityId if provided
    if (params.entityId !== undefined) {
      filtered = filtered.filter((log) => log.entityId === params.entityId);
    }

    // Filter by roomId if provided
    if (params.roomId !== undefined) {
      filtered = filtered.filter((log) => log.roomId === params.roomId);
    }

    // Filter by type if provided
    if (params.type !== undefined) {
      filtered = filtered.filter((log) => log.type === params.type);
    }

    // Apply offset (skip first N results)
    const offset = params.offset ?? 0;
    filtered = filtered.slice(offset);

    // Apply limit (limit results)
    filtered = filtered.slice(0, effectiveLimit);

    return filtered;
  }

  // Batch log methods
  async getLogsByIds(logIds: UUID[]): Promise<Log[]> {
    const idSet = new Set(logIds.map(String));
    return this.logs.filter((l) => idSet.has(String(l.id)));
  }

  async createLogs(params: Array<{ body: LogBody; entityId: UUID; roomId: UUID; type: string }>): Promise<void> {
    for (const param of params) {
      const id =
        typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      this.logs.push({
        id: asUuid(id),
        createdAt: new Date(),
        entityId: param.entityId,
        roomId: param.roomId,
        type: param.type,
        body: param.body,
      });
    }
  }

  async updateLogs(logs: Array<{ id: UUID; updates: Partial<Log> }>): Promise<void> {
    for (const { id, updates } of logs) {
      const log = this.logs.find((l) => String(l.id) === String(id));
      if (log) {
        Object.assign(log, updates);
      }
    }
  }

  async deleteLogs(logIds: UUID[]): Promise<void> {
    const idSet = new Set(logIds.map(String));
    this.logs = this.logs.filter((l) => !idSet.has(String(l.id)));
  }

  async searchMemories(): Promise<Memory[]> {
    return [];
  }

  // Batch memory methods
  async createMemories(memories: Array<{ memory: Memory; tableName: string; unique?: boolean }>): Promise<UUID[]> {
    const ids: UUID[] = [];
    for (const { memory, tableName } of memories) {
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
      ids.push(asUuid(id));
    }
    return ids;
  }

  async updateMemories(
    memories: Array<Partial<Memory> & { id: UUID; metadata?: MemoryMetadata }>,
  ): Promise<void> {
    for (const memory of memories) {
      const existing = this.memoriesById.get(String(memory.id));
      if (!existing) {
        // WHY: Changed from returning false to skipping. Update failures should
        // ideally throw, but silently skipping non-existent memories maintains
        // backward compatibility with callers that may not check return values.
        continue;
      }
      const merged: Memory = { ...existing, ...memory };
      this.memoriesById.set(String(memory.id), merged);
      // Update reference in memoriesByRoom to keep consistency
      for (const [, list] of this.memoriesByRoom) {
        const idx = list.findIndex((m) => String(m.id) === String(memory.id));
        if (idx !== -1) {
          list[idx] = merged;
          break;
        }
      }
    }
  }

  async upsertMemories(
    memories: Array<{ memory: Memory; tableName: string }>,
    _options?: { entityContext?: UUID },
  ): Promise<void> {
    for (const { memory, tableName } of memories) {
      const id = memory.id;
      if (id == null) {
        await this.createMemories([{ memory, tableName }]);
        continue;
      }
      if (this.memoriesById.has(String(id))) {
        await this.updateMemories([{ ...memory, id }]);
      } else {
        await this.createMemories([{ memory, tableName }]);
      }
    }
  }

  async deleteMemories(memoryIds: UUID[]): Promise<void> {
    const idSet = new Set(memoryIds.map(String));
    for (const id of memoryIds) {
      this.memoriesById.delete(String(id));
    }
    // Clean up memoriesByRoom references
    for (const [key, list] of this.memoriesByRoom) {
      const filtered = list.filter((m) => !idSet.has(String(m.id)));
      if (filtered.length === 0) {
        this.memoriesByRoom.delete(key);
      } else if (filtered.length !== list.length) {
        this.memoriesByRoom.set(key, filtered);
      }
    }
  }

  async deleteAllMemories(roomId: UUID, tableName: string): Promise<void> {
    const key = roomTableKey(tableName, roomId);
    const memories = this.memoriesByRoom.get(key) ?? [];
    for (const mem of memories) {
      this.memoriesById.delete(String(mem.id));
    }
    this.memoriesByRoom.delete(key);
  }

  async countMemories(
    roomIdOrParams:
      | UUID
      | {
          roomId?: UUID;
          unique?: boolean;
          tableName?: string;
          entityId?: UUID;
          agentId?: UUID;
          metadata?: Record<string, unknown>;
        },
    unique?: boolean,
    tableName?: string,
  ): Promise<number> {
    const roomId: UUID | undefined =
      typeof roomIdOrParams === "object" && roomIdOrParams !== null && "roomId" in roomIdOrParams
        ? roomIdOrParams.roomId
        : (roomIdOrParams as UUID);
    const u = typeof roomIdOrParams === "object" && roomIdOrParams !== null && "unique" in roomIdOrParams ? roomIdOrParams.unique : unique;
    const tbl = typeof roomIdOrParams === "object" && roomIdOrParams !== null && "tableName" in roomIdOrParams ? roomIdOrParams.tableName : tableName;
    if (roomId == null) return 0;
    const key = roomTableKey(tbl ?? "messages", roomId);
    const memories = this.memoriesByRoom.get(key) ?? [];
    if (u) {
      return memories.filter((m) => m.unique).length;
    }
    return memories.length;
  }

  // Batch world methods
  async getWorldsByIds(worldIds: UUID[]): Promise<World[]> {
    const worlds: World[] = [];
    for (const id of worldIds) {
      const world = this.worlds.get(String(id));
      if (world) {
        worlds.push(world);
      }
    }
    return worlds;
  }

  async createWorlds(worlds: World[]): Promise<UUID[]> {
    const ids: UUID[] = [];
    for (const world of worlds) {
      this.worlds.set(String(world.id), world);
      ids.push(world.id);
    }
    return ids;
  }
  
  async upsertWorlds(worlds: World[]): Promise<void> {
    // WHY simple set: Map.set() handles both insert and update atomically.
    for (const world of worlds) {
      this.worlds.set(String(world.id), world);
    }
  }

  async deleteWorlds(worldIds: UUID[]): Promise<void> {
    for (const id of worldIds) {
      this.worlds.delete(String(id));
    }
  }

  async updateWorlds(worlds: World[]): Promise<void> {
    for (const world of worlds) {
      this.worlds.set(String(world.id), world);
    }
  }

  async getAllWorlds(): Promise<World[]> {
    return Array.from(this.worlds.values());
  }

  // Batch room methods
  async updateRooms(rooms: Room[]): Promise<void> {
    for (const room of rooms) {
      this.rooms.set(String(room.id), room);
    }
  }

  async deleteRooms(roomIds: UUID[]): Promise<void> {
    for (const id of roomIds) {
      this.rooms.delete(String(id));
    }
  }

  async getRoomsByIds(roomIds: UUID[]): Promise<Room[]> {
    const out: Room[] = [];
    for (const id of roomIds) {
      const r = this.rooms.get(String(id));
      if (r) out.push(r);
    }
    return out;
  }

  async createRooms(rooms: Room[]): Promise<UUID[]> {
    const ids: UUID[] = [];
    for (const r of rooms) {
      this.rooms.set(String(r.id), r);
      ids.push(r.id);
    }
    return ids;
  }
  
  async upsertRooms(rooms: Room[]): Promise<void> {
    // WHY simple set: InMemory upsert is just Map.set() - idempotent by nature.
    for (const room of rooms) {
      this.rooms.set(String(room.id), room);
    }
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

  async getRoomsByWorld(worldId: UUID, limit?: number, offset?: number): Promise<Room[]> {
    let out: Room[] = [];
    for (const room of this.rooms.values()) {
      if (room.worldId && room.worldId === worldId) {
        out.push(room);
      }
    }

    // WHY: Apply pagination to limit result size. Previously returned ALL rooms in world.
    const off = offset ?? 0;
    out = out.slice(off);
    if (limit) {
      out = out.slice(0, limit);
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

  async createRoomParticipants(entityIds: UUID[], roomId: UUID): Promise<UUID[]> {
    // WHY: InMemory doesn't have real participant record IDs (it's just a set).
    // We generate UUIDs to match the interface contract, even though they're not stored.
    const roomKey = String(roomId);
    const participants =
      this.participantsByRoom.get(roomKey) ?? new Set<string>();
    const ids: UUID[] = [];
    
    for (const eid of entityIds) {
      const entityKey = String(eid);
      participants.add(entityKey);
      const rooms = this.roomsByParticipant.get(entityKey) ?? new Set<string>();
      rooms.add(roomKey);
      this.roomsByParticipant.set(entityKey, rooms);
      // Generate a synthetic ID for this participant record
      ids.push(`${roomId}:${eid}` as UUID);
    }
    this.participantsByRoom.set(roomKey, participants);
    return ids;
  }

  // Batch participant methods
  async deleteParticipants(participants: Array<{ entityId: UUID; roomId: UUID }>): Promise<void> {
    for (const { entityId, roomId } of participants) {
      const roomKey = String(roomId);
      const entityKey = String(entityId);
      const roomParticipants = this.participantsByRoom.get(roomKey);
      if (roomParticipants) {
        roomParticipants.delete(entityKey);
        if (roomParticipants.size === 0) this.participantsByRoom.delete(roomKey);
      }
      const rooms = this.roomsByParticipant.get(entityKey);
      if (rooms) {
        rooms.delete(roomKey);
        if (rooms.size === 0) this.roomsByParticipant.delete(entityKey);
      }
      this.participantUserState.delete(`${roomKey}:${entityKey}`);
    }
  }

  async updateParticipants(participants: Array<{
    entityId: UUID;
    roomId: UUID;
    updates: Partial<Participant>;
  }>): Promise<void> {
    // InMemory adapter stores participants as just sets of IDs, so we can only
    // update roomState (which is stored separately in participantUserState).
    // Metadata updates are not supported in this simple adapter.
    for (const { entityId, roomId, updates } of participants) {
      const roomState = (updates as any).roomState;
      if (roomState !== undefined) {
        const key = `${String(roomId)}:${String(entityId)}`;
        this.participantUserState.set(key, roomState);
      }
    }
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

  async updateParticipantUserState(
    roomId: UUID,
    entityId: UUID,
    state: "FOLLOWED" | "MUTED" | null,
  ): Promise<void> {
    const key = `${String(roomId)}:${String(entityId)}`;
    this.participantUserState.set(key, state);
  }

  async getRelationship(): Promise<Relationship | null> {
    return null;
  }

  async getRelationships(_params: {
    entityId: UUID;
    tags?: string[];
    limit?: number;
    offset?: number;
  }): Promise<Relationship[]> {
    return [];
  }

  // Batch relationship methods
  async createRelationships(relationships: Array<{
    sourceEntityId: UUID;
    targetEntityId: UUID;
    tags?: string[];
    metadata?: Metadata;
  }>): Promise<UUID[]> {
    // WHY: InMemory adapter doesn't actually store relationships, but we return
    // placeholder IDs to match the interface contract.
    return relationships.map(() => {
      const gen =
        typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      return gen as UUID;
    });
  }

  async getRelationshipsByIds(_relationshipIds: UUID[]): Promise<Relationship[]> {
    return [];
  }

  async updateRelationships(_relationships: Relationship[]): Promise<void> {
    // no-op
  }

  async deleteRelationships(_relationshipIds: UUID[]): Promise<void> {
    // no-op
  }

  // Batch cache methods
  async getCaches<T>(keys: string[]): Promise<Map<string, T>> {
    const result = new Map<string, T>();
    for (const key of keys) {
      const raw = this.cache.get(key);
      if (raw === undefined) continue;
      result.set(key, JSON.parse(raw) as T);
    }
    return result;
  }

  async setCaches<T>(entries: Array<{ key: string; value: T }>): Promise<boolean> {
    for (const entry of entries) {
      this.cache.set(entry.key, JSON.stringify(entry.value));
    }
    return true;
  }

  async deleteCaches(keys: string[]): Promise<boolean> {
    for (const key of keys) {
      this.cache.delete(key);
    }
    return true;
  }

  async getTasks(params: {
    roomId?: UUID;
    tags?: string[];
    entityId?: UUID;
    limit?: number;
    offset?: number;
  }): Promise<Task[]> {
    const all = Array.from(this.tasks.values());
    let filtered = all.filter((t) => {
      if (params.roomId && t.roomId !== params.roomId) return false;
      if (params.entityId && t.entityId !== params.entityId) return false;
      if (params.tags && params.tags.length > 0) {
        for (const tag of params.tags) {
          if (!t.tags.includes(tag)) return false;
        }
      }
      return true;
    });

    // WHY: Apply pagination to limit result size. Previously returned ALL matching tasks.
    const offset = params.offset ?? 0;
    filtered = filtered.slice(offset);
    if (params.limit) {
      filtered = filtered.slice(0, params.limit);
    }

    return filtered;
  }

  async getTasksByName(name: string): Promise<Task[]> {
    return Array.from(this.tasks.values()).filter((t) => t.name === name);
  }

  // Batch task methods
  async createTasks(tasks: Task[]): Promise<UUID[]> {
    const ids: UUID[] = [];
    for (const task of tasks) {
      const gen =
        typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const id = task.id ? String(task.id) : gen;
      const taskId = asUuid(id);
      const stored: Task = { ...task, id: taskId };
      this.tasks.set(id, stored);
      ids.push(taskId);
    }
    return ids;
  }

  async getTasksByIds(taskIds: UUID[]): Promise<Task[]> {
    const tasks: Task[] = [];
    for (const taskId of taskIds) {
      const task = this.tasks.get(String(taskId));
      if (task) tasks.push(task);
    }
    return tasks;
  }

  async updateTasks(updates: Array<{ id: UUID; task: Partial<Task> }>): Promise<void> {
    for (const update of updates) {
      const existing = this.tasks.get(String(update.id));
      if (!existing) continue;
      this.tasks.set(String(update.id), {
        ...existing,
        ...update.task,
        id: update.id,
      } as Task);
    }
  }

  async deleteTasks(taskIds: UUID[]): Promise<void> {
    for (const taskId of taskIds) {
      this.tasks.delete(String(taskId));
    }
  }

  async getMemoriesByWorldId(params: {
    worldId: UUID;
    /** @deprecated use limit */
    count?: number;
    limit?: number;
    tableName?: string;
  }): Promise<Memory[]> {
    const rooms = await this.getRoomsByWorld(params.worldId);
    const roomIds = rooms.map((r) => r.id);
    const effectiveLimit = params.limit ?? params.count ?? 50;

    const out: Memory[] = [];
    for (const rid of roomIds) {
      if (params.tableName) {
        const list =
          this.memoriesByRoom.get(roomTableKey(params.tableName, rid)) ?? [];
        for (const m of list) {
          out.push(m);
          if (out.length >= effectiveLimit) return out;
        }
        continue;
      }

      for (const [key, list] of this.memoriesByRoom.entries()) {
        if (!key.endsWith(`:${String(rid)}`)) continue;
        for (const m of list) {
          out.push(m);
          if (out.length >= effectiveLimit) return out;
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

  // ===============================
  // Pairing Methods
  // ===============================

  async getPairingRequests(
    channel: PairingChannel,
    agentId: UUID,
  ): Promise<PairingRequest[]> {
    const results: PairingRequest[] = [];
    for (const request of this.pairingRequests.values()) {
      if (request.channel === channel && request.agentId === agentId) {
        results.push(request);
      }
    }
    return results.sort(
      (a, b) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );
  }

  // Batch pairing request methods
  async createPairingRequests(requests: PairingRequest[]): Promise<UUID[]> {
    const ids: UUID[] = [];
    for (const request of requests) {
      const gen =
        typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const id = request.id ? String(request.id) : gen;
      const stored: PairingRequest = { ...request, id: asUuid(id) };
      this.pairingRequests.set(id, stored);
      ids.push(asUuid(id));
    }
    return ids;
  }

  async updatePairingRequests(requests: PairingRequest[]): Promise<void> {
    for (const request of requests) {
      const existing = this.pairingRequests.get(String(request.id));
      if (existing) {
        this.pairingRequests.set(String(request.id), {
          ...existing,
          ...request,
        });
      }
    }
  }

  async deletePairingRequests(ids: UUID[]): Promise<void> {
    for (const id of ids) {
      this.pairingRequests.delete(String(id));
    }
  }

  async getPairingAllowlist(
    channel: PairingChannel,
    agentId: UUID,
  ): Promise<PairingAllowlistEntry[]> {
    const results: PairingAllowlistEntry[] = [];
    for (const entry of this.pairingAllowlist.values()) {
      if (entry.channel === channel && entry.agentId === agentId) {
        results.push(entry);
      }
    }
    return results.sort(
      (a, b) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );
  }

  // Batch pairing allowlist methods
  async createPairingAllowlistEntries(
    entries: PairingAllowlistEntry[],
  ): Promise<UUID[]> {
    const ids: UUID[] = [];
    for (const entry of entries) {
      const gen =
        typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const id = entry.id ? String(entry.id) : gen;
      const stored: PairingAllowlistEntry = { ...entry, id: asUuid(id) };
      this.pairingAllowlist.set(id, stored);
      ids.push(asUuid(id));
    }
    return ids;
  }

  async updatePairingAllowlistEntries(entries: PairingAllowlistEntry[]): Promise<void> {
    for (const entry of entries) {
      if (!entry.id) continue;
      const id = String(entry.id);
      const existing = this.pairingAllowlist.get(id);
      if (existing) {
        this.pairingAllowlist.set(id, { ...existing, ...entry });
      }
    }
  }

  async deletePairingAllowlistEntries(ids: UUID[]): Promise<void> {
    for (const id of ids) {
      this.pairingAllowlist.delete(String(id));
    }
  }
}
