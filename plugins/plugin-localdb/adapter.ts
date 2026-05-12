/**
 * InMemoryDatabaseAdapter
 *
 * Pure in-memory, ephemeral implementation of the elizaOS `DatabaseAdapter`
 * abstract base. Backed by `MemoryStorage` (a Map-of-Maps) for record CRUD and
 * `EphemeralHNSW` for vector search. No persistence, no migrations, no
 * transaction atomicity — intended for tests, scenarios, and short-lived
 * one-shot runs where speed and zero setup matter more than durability.
 *
 * Implements the full batch-first interface from `@elizaos/core`'s
 * `DatabaseAdapter`. Single-item helpers from earlier revisions of this plugin
 * have been removed — call sites should use the batch APIs (`createEntities`,
 * `getMemoriesByIds`, etc.).
 */

import { randomUUID } from "node:crypto";
import {
  type Agent,
  type Component,
  type Content,
  DatabaseAdapter,
  type EntitiesForRoomsResult,
  type Entity,
  type IDatabaseAdapter,
  type JsonValue,
  type Log,
  type LogBody,
  logger,
  type Memory,
  type MemoryMetadata,
  type MemoryTypeAlias,
  type Metadata,
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
  type Task,
  type UUID,
  type World,
} from "@elizaos/core";
import { EphemeralHNSW } from "./hnsw";
import { COLLECTIONS, type IStorage } from "./types";

// ────────────────────────────────────────────────────────────────────────────
// Internal stored shapes
// ────────────────────────────────────────────────────────────────────────────

interface StoredParticipant {
  id: string;
  entityId: string;
  roomId: string;
  userState?: ParticipantUserState;
  metadata?: Record<string, unknown>;
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
  metadata?: MemoryMetadata;
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

interface StoredCacheEntry<T = unknown> {
  value: T;
  expiresAt?: number;
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

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
    metadata: stored.metadata,
  };
}

function relationshipFromStored(
  r: StoredRelationship,
  fallbackAgentId: UUID,
): Relationship {
  return {
    id: r.id as UUID,
    sourceEntityId: r.sourceEntityId as UUID,
    targetEntityId: r.targetEntityId as UUID,
    agentId: (r.agentId as UUID) ?? fallbackAgentId,
    tags: r.tags ?? [],
    metadata: r.metadata ?? {},
    createdAt: r.createdAt,
  };
}

/**
 * Apply a single JSON patch operation to a deeply-nested target object,
 * resolving the dot-separated `path` to a leaf and mutating in place.
 *
 * This is a best-effort implementation that mirrors what Postgres's JSONB
 * patch operators do for the SQL adapter. It supports `set`, `push`,
 * `remove`, and `increment`.
 */
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

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const prev = new Array(b.length + 1);
  const curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return curr[b.length];
}

// ────────────────────────────────────────────────────────────────────────────
// Adapter
// ────────────────────────────────────────────────────────────────────────────

export class InMemoryDatabaseAdapter extends DatabaseAdapter<IStorage> {
  private storage: IStorage;
  private vectorIndex: EphemeralHNSW;
  private embeddingDimension = 384;
  private ready = false;
  private readonly agentId: UUID;

  constructor(storage: IStorage, agentId: UUID) {
    super();
    this.storage = storage;
    this.agentId = agentId;
    this.db = storage;
    this.vectorIndex = new EphemeralHNSW();
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  async initialize(
    _config?: Record<string, string | number | boolean | null>,
  ): Promise<void> {
    await this.storage.init();
    await this.vectorIndex.init(this.embeddingDimension);
    this.ready = true;
    logger.info({ src: "plugin:inmemorydb" }, "In-memory database initialized");
  }

  /** Backward-compat alias used by `plugin-inmemorydb`'s plugin init hook. */
  async init(): Promise<void> {
    await this.initialize();
  }

  async runPluginMigrations(
    _plugins: Array<{ name: string; schema?: Record<string, JsonValue> }>,
    _options?: { verbose?: boolean; force?: boolean; dryRun?: boolean },
  ): Promise<void> {
    logger.debug(
      { src: "plugin:inmemorydb" },
      "Plugin migrations not needed for in-memory storage",
    );
  }

  async isReady(): Promise<boolean> {
    return this.ready && (await this.storage.isReady());
  }

  async close(): Promise<void> {
    await this.vectorIndex.clear();
    await this.storage.close();
    this.ready = false;
    logger.info({ src: "plugin:inmemorydb" }, "In-memory database closed");
  }

  async getConnection(): Promise<IStorage> {
    return this.storage;
  }

  // ── Transactions ──────────────────────────────────────────────────────
  // No atomicity guarantees: just invoke the callback with `this`. This
  // matches what other in-memory adapters do — callers that need real
  // transactions should use a real database backend.

  async transaction<T>(
    callback: (tx: IDatabaseAdapter<IStorage>) => Promise<T>,
    _options?: { entityContext?: UUID },
  ): Promise<T> {
    return callback(this as IDatabaseAdapter<IStorage>);
  }

  // ── Embedding ─────────────────────────────────────────────────────────

  async ensureEmbeddingDimension(dimension: number): Promise<void> {
    if (this.embeddingDimension !== dimension) {
      this.embeddingDimension = dimension;
      await this.vectorIndex.init(dimension);
    }
  }

  // ── Entity CRUD ───────────────────────────────────────────────────────

  async createEntities(entities: Entity[]): Promise<UUID[]> {
    const ids: UUID[] = [];
    for (const entity of entities) {
      const id = (entity.id ?? randomUUID()) as UUID;
      await this.storage.set(COLLECTIONS.ENTITIES, id, { ...entity, id });
      ids.push(id);
    }
    return ids;
  }

  async upsertEntities(entities: Entity[]): Promise<void> {
    for (const entity of entities) {
      if (!entity.id) continue;
      const existing = await this.storage.get<Entity>(
        COLLECTIONS.ENTITIES,
        entity.id,
      );
      await this.storage.set(COLLECTIONS.ENTITIES, entity.id, {
        ...(existing ?? {}),
        ...entity,
      });
    }
  }

  async getEntitiesByIds(entityIds: UUID[]): Promise<Entity[]> {
    const entities: Entity[] = [];
    for (const id of entityIds) {
      const entity = await this.storage.get<Entity>(COLLECTIONS.ENTITIES, id);
      if (entity) entities.push(entity);
    }
    return entities;
  }

  async updateEntities(entities: Entity[]): Promise<void> {
    for (const entity of entities) {
      if (!entity.id) continue;
      const existing = await this.storage.get<Entity>(
        COLLECTIONS.ENTITIES,
        entity.id,
      );
      if (!existing) continue;
      await this.storage.set(COLLECTIONS.ENTITIES, entity.id, {
        ...existing,
        ...entity,
      });
    }
  }

  async deleteEntities(entityIds: UUID[]): Promise<void> {
    for (const id of entityIds) {
      await this.storage.delete(COLLECTIONS.ENTITIES, id);
    }
  }

  async getEntitiesForRooms(
    roomIds: UUID[],
    includeComponents = false,
  ): Promise<EntitiesForRoomsResult> {
    const result: EntitiesForRoomsResult = [];
    for (const roomId of roomIds) {
      const participants = await this.storage.getWhere<StoredParticipant>(
        COLLECTIONS.PARTICIPANTS,
        (p) => p.roomId === roomId,
      );
      const entityIds = [
        ...new Set(participants.map((p) => p.entityId)),
      ] as UUID[];
      const entities = await this.getEntitiesByIds(entityIds);

      if (includeComponents) {
        for (const entity of entities) {
          if (!entity.id) continue;
          const components = await this.getComponentsForEntities([entity.id]);
          (entity as Entity & { components?: Component[] }).components =
            components;
        }
      }

      result.push({ roomId, entities });
    }
    return result;
  }

  async getEntitiesByNames(params: {
    names: string[];
    agentId: UUID;
  }): Promise<Entity[]> {
    if (params.names.length === 0) return [];
    const set = new Set(params.names);
    return this.storage.getWhere<Entity>(COLLECTIONS.ENTITIES, (e) => {
      const names = (e as Entity & { names?: string[] }).names ?? [];
      return names.some((name) => set.has(name));
    });
  }

  async searchEntitiesByName(params: {
    query: string;
    agentId: UUID;
    limit?: number;
  }): Promise<Entity[]> {
    const q = params.query.toLowerCase();
    const matches = await this.storage.getWhere<Entity>(
      COLLECTIONS.ENTITIES,
      (e) => {
        const names = (e as Entity & { names?: string[] }).names ?? [];
        return names.some((name) => name.toLowerCase().includes(q));
      },
    );
    return params.limit ? matches.slice(0, params.limit) : matches;
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
    let entityIds: UUID[];
    if (params.entityIds && params.entityIds.length > 0) {
      entityIds = params.entityIds;
    } else {
      const allComponents = await this.storage.getWhere<Component>(
        COLLECTIONS.COMPONENTS,
        (c) => {
          if (params.componentType && c.type !== params.componentType)
            return false;
          if (params.worldId && c.worldId !== params.worldId) return false;
          if (params.componentDataFilter) {
            const data = (c as Component & { data?: Record<string, unknown> })
              .data;
            if (!data || typeof data !== "object") return false;
            for (const [k, v] of Object.entries(params.componentDataFilter)) {
              if (data[k] !== v) return false;
            }
          }
          return true;
        },
      );
      entityIds = [...new Set(allComponents.map((c) => c.entityId as UUID))];
    }

    const offset = params.offset ?? 0;
    const limit = params.limit;
    const sliced =
      limit !== undefined
        ? entityIds.slice(offset, offset + limit)
        : entityIds.slice(offset);

    const entities = await this.getEntitiesByIds(sliced);
    if (params.includeAllComponents) {
      for (const entity of entities) {
        if (!entity.id) continue;
        const components = await this.getComponentsForEntities([entity.id]);
        (entity as Entity & { components?: Component[] }).components =
          components;
      }
    }
    return entities;
  }

  // ── Component CRUD ────────────────────────────────────────────────────

  async createComponents(components: Component[]): Promise<UUID[]> {
    const ids: UUID[] = [];
    for (const component of components) {
      const id = (component.id ?? randomUUID()) as UUID;
      await this.storage.set(COLLECTIONS.COMPONENTS, id, { ...component, id });
      ids.push(id);
    }
    return ids;
  }

  async getComponentsByIds(componentIds: UUID[]): Promise<Component[]> {
    const components: Component[] = [];
    for (const id of componentIds) {
      const c = await this.storage.get<Component>(COLLECTIONS.COMPONENTS, id);
      if (c) components.push(c);
    }
    return components;
  }

  async updateComponents(components: Component[]): Promise<void> {
    for (const component of components) {
      if (!component.id) continue;
      const existing = await this.storage.get<Component>(
        COLLECTIONS.COMPONENTS,
        component.id,
      );
      if (!existing) continue;
      await this.storage.set(COLLECTIONS.COMPONENTS, component.id, {
        ...existing,
        ...component,
      });
    }
  }

  async deleteComponents(componentIds: UUID[]): Promise<void> {
    for (const id of componentIds) {
      await this.storage.delete(COLLECTIONS.COMPONENTS, id);
    }
  }

  async upsertComponents(
    components: Component[],
    _options?: { entityContext?: UUID },
  ): Promise<void> {
    for (const component of components) {
      const naturalKey = await this.storage.getWhere<Component>(
        COLLECTIONS.COMPONENTS,
        (c) =>
          c.entityId === component.entityId &&
          c.type === component.type &&
          (c.worldId ?? null) === (component.worldId ?? null) &&
          (c.sourceEntityId ?? null) === (component.sourceEntityId ?? null),
      );

      const existing = naturalKey[0];
      if (existing) {
        await this.storage.set(COLLECTIONS.COMPONENTS, existing.id, {
          ...existing,
          ...component,
          id: existing.id,
        });
      } else {
        const id = (component.id ?? randomUUID()) as UUID;
        await this.storage.set(COLLECTIONS.COMPONENTS, id, {
          ...component,
          id,
        });
      }
    }
  }

  async patchComponents(
    updates: Array<{ componentId: UUID; ops: PatchOp[] }>,
    _options?: { entityContext?: UUID },
  ): Promise<void> {
    for (const update of updates) {
      const component = await this.storage.get<Component>(
        COLLECTIONS.COMPONENTS,
        update.componentId,
      );
      if (!component) continue;
      const data = { ...(component.data ?? {}) } as Record<string, unknown>;
      for (const op of update.ops) {
        applyPatchOp(data, op);
      }
      component.data = data as Component["data"];
      await this.storage.set(
        COLLECTIONS.COMPONENTS,
        update.componentId,
        component,
      );
    }
  }

  async getComponentsByNaturalKeys(
    keys: Array<{
      entityId: UUID;
      type: string;
      worldId?: UUID;
      sourceEntityId?: UUID;
    }>,
  ): Promise<(Component | null)[]> {
    const result: (Component | null)[] = [];
    for (const key of keys) {
      const matches = await this.storage.getWhere<Component>(
        COLLECTIONS.COMPONENTS,
        (c) =>
          c.entityId === key.entityId &&
          c.type === key.type &&
          (c.worldId ?? null) === (key.worldId ?? null) &&
          (c.sourceEntityId ?? null) === (key.sourceEntityId ?? null),
      );
      result.push(matches[0] ?? null);
    }
    return result;
  }

  async getComponentsForEntities(
    entityIds: UUID[],
    worldId?: UUID,
    sourceEntityId?: UUID,
  ): Promise<Component[]> {
    if (entityIds.length === 0) return [];
    const idSet = new Set(entityIds);
    return this.storage.getWhere<Component>(COLLECTIONS.COMPONENTS, (c) => {
      if (!idSet.has(c.entityId as UUID)) return false;
      if (worldId !== undefined && c.worldId !== worldId) return false;
      if (sourceEntityId !== undefined && c.sourceEntityId !== sourceEntityId)
        return false;
      return true;
    });
  }

  // ── Memory CRUD ───────────────────────────────────────────────────────

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
    metadata?: Record<string, unknown>;
  }): Promise<Memory[]> {
    let memories = await this.storage.getWhere<StoredMemory>(
      COLLECTIONS.MEMORIES,
      (m) => {
        if (params.entityId && m.entityId !== params.entityId) return false;
        if (params.agentId && m.agentId !== params.agentId) return false;
        if (params.roomId && m.roomId !== params.roomId) return false;
        if (params.worldId && m.worldId !== params.worldId) return false;
        if (params.tableName && m.metadata?.type !== params.tableName)
          return false;
        if (params.start && m.createdAt && m.createdAt < params.start)
          return false;
        if (params.end && m.createdAt && m.createdAt > params.end) return false;
        if (params.unique && !m.unique) return false;
        if (params.metadata) {
          const md = (m.metadata ?? {}) as Record<string, unknown>;
          for (const [k, v] of Object.entries(params.metadata)) {
            if (md[k] !== v) return false;
          }
        }
        return true;
      },
    );

    memories.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));

    const offset = params.offset ?? 0;
    const limit = params.limit ?? params.count;
    if (offset > 0) memories = memories.slice(offset);
    if (limit !== undefined) memories = memories.slice(0, limit);

    return memories.map(toMemory);
  }

  async getMemoriesByRoomIds(params: {
    roomIds: UUID[];
    tableName: string;
    limit?: number;
  }): Promise<Memory[]> {
    if (params.roomIds.length === 0) return [];
    const roomSet = new Set(params.roomIds);
    const memories = await this.storage.getWhere<StoredMemory>(
      COLLECTIONS.MEMORIES,
      (m) =>
        roomSet.has(m.roomId as UUID) &&
        (params.tableName ? m.metadata?.type === params.tableName : true),
    );
    memories.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
    const sliced = params.limit ? memories.slice(0, params.limit) : memories;
    return sliced.map(toMemory);
  }

  async getMemoriesByIds(
    memoryIds: UUID[],
    tableName?: string,
  ): Promise<Memory[]> {
    const memories: Memory[] = [];
    for (const id of memoryIds) {
      const m = await this.storage.get<StoredMemory>(COLLECTIONS.MEMORIES, id);
      if (!m) continue;
      if (tableName && m.metadata?.type !== tableName) continue;
      memories.push(toMemory(m));
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
      (m) => m.metadata?.type === params.query_table_name && !!m.embedding,
    );

    const results: { embedding: number[]; levenshtein_score: number }[] = [];
    for (const memory of memories) {
      if (!memory.embedding) continue;
      const record = memory as StoredMemory & Record<string, unknown>;
      const fieldValue = record[params.query_field_name];
      const text = String(fieldValue ?? "");
      const score = levenshtein(params.query_input, text);
      if (score <= params.query_threshold) {
        results.push({ embedding: memory.embedding, levenshtein_score: score });
      }
    }
    results.sort((a, b) => a.levenshtein_score - b.levenshtein_score);
    return results.slice(0, params.query_match_count);
  }

  async searchMemories(params: {
    tableName: string;
    embedding: number[];
    match_threshold?: number;
    limit?: number;
    unique?: boolean;
    query?: string;
    roomId?: UUID;
    worldId?: UUID;
    entityId?: UUID;
  }): Promise<Memory[]> {
    const threshold = params.match_threshold ?? 0.5;
    const limit = params.limit ?? 10;

    const results = await this.vectorIndex.search(
      params.embedding,
      limit * 2,
      threshold,
    );

    const memories: Memory[] = [];
    for (const result of results) {
      const memory = await this.storage.get<StoredMemory>(
        COLLECTIONS.MEMORIES,
        result.id,
      );
      if (!memory) continue;
      if (params.tableName && memory.metadata?.type !== params.tableName)
        continue;
      if (params.roomId && memory.roomId !== params.roomId) continue;
      if (params.worldId && memory.worldId !== params.worldId) continue;
      if (params.entityId && memory.entityId !== params.entityId) continue;
      if (params.unique && !memory.unique) continue;
      memories.push({ ...toMemory(memory), similarity: result.similarity });
    }

    return memories.slice(0, limit);
  }

  async createMemories(
    memories: Array<{ memory: Memory; tableName: string; unique?: boolean }>,
  ): Promise<UUID[]> {
    const ids: UUID[] = [];
    for (const { memory, tableName, unique = false } of memories) {
      const id = (memory.id ?? randomUUID()) as UUID;
      const stored: StoredMemory = {
        ...memory,
        id,
        agentId: memory.agentId ?? this.agentId,
        unique: unique || memory.unique,
        createdAt: memory.createdAt ?? Date.now(),
        metadata: {
          ...(memory.metadata ?? {}),
          type: tableName as MemoryTypeAlias,
        } as MemoryMetadata,
      };
      await this.storage.set(COLLECTIONS.MEMORIES, id, stored);
      if (memory.embedding && memory.embedding.length > 0) {
        await this.vectorIndex.add(id, memory.embedding);
      }
      ids.push(id);
    }
    return ids;
  }

  async updateMemories(
    memories: Array<Partial<Memory> & { id: UUID; metadata?: MemoryMetadata }>,
  ): Promise<void> {
    for (const memory of memories) {
      const existing = await this.storage.get<StoredMemory>(
        COLLECTIONS.MEMORIES,
        memory.id,
      );
      if (!existing) continue;
      const updated: StoredMemory = {
        ...existing,
        ...memory,
        metadata: {
          ...(existing.metadata ?? {}),
          ...(memory.metadata ?? {}),
        } as MemoryMetadata,
      };
      await this.storage.set(COLLECTIONS.MEMORIES, memory.id, updated);
      if (memory.embedding && memory.embedding.length > 0) {
        await this.vectorIndex.add(memory.id, memory.embedding);
      }
    }
  }

  async upsertMemories(
    memories: Array<{ memory: Memory; tableName: string }>,
    _options?: { entityContext?: UUID },
  ): Promise<void> {
    for (const { memory, tableName } of memories) {
      if (!memory.id) {
        await this.createMemories([{ memory, tableName }]);
        continue;
      }
      const existing = await this.storage.get<StoredMemory>(
        COLLECTIONS.MEMORIES,
        memory.id,
      );
      const stored: StoredMemory = {
        ...(existing ?? {}),
        ...memory,
        agentId: memory.agentId ?? existing?.agentId ?? this.agentId,
        createdAt: memory.createdAt ?? existing?.createdAt ?? Date.now(),
        metadata: {
          ...(existing?.metadata ?? {}),
          ...(memory.metadata ?? {}),
          type: tableName as MemoryTypeAlias,
        } as MemoryMetadata,
      };
      await this.storage.set(COLLECTIONS.MEMORIES, memory.id, stored);
      if (memory.embedding && memory.embedding.length > 0) {
        await this.vectorIndex.add(memory.id, memory.embedding);
      }
    }
  }

  async deleteMemories(memoryIds: UUID[]): Promise<void> {
    for (const id of memoryIds) {
      await this.storage.delete(COLLECTIONS.MEMORIES, id);
      await this.vectorIndex.remove(id);
    }
  }

  async deleteAllMemories(roomIds: UUID[], tableName: string): Promise<void> {
    if (roomIds.length === 0) return;
    const roomSet = new Set(roomIds);
    const memories = await this.storage.getWhere<StoredMemory>(
      COLLECTIONS.MEMORIES,
      (m) =>
        roomSet.has(m.roomId as UUID) &&
        (tableName ? m.metadata?.type === tableName : true),
    );
    const ids = memories
      .map((m) => m.id)
      .filter((id): id is string => id !== undefined) as UUID[];
    await this.deleteMemories(ids);
  }

  async countMemories(params: {
    roomIds?: UUID[];
    unique?: boolean;
    tableName?: string;
    entityId?: UUID;
    agentId?: UUID;
    metadata?: Record<string, unknown>;
  }): Promise<number> {
    const roomSet = params.roomIds ? new Set(params.roomIds) : null;
    return this.storage.count<StoredMemory>(COLLECTIONS.MEMORIES, (m) => {
      if (roomSet && !roomSet.has(m.roomId as UUID)) return false;
      if (params.unique && !m.unique) return false;
      if (params.tableName && m.metadata?.type !== params.tableName)
        return false;
      if (params.entityId && m.entityId !== params.entityId) return false;
      if (params.agentId && m.agentId !== params.agentId) return false;
      if (params.metadata) {
        const md = (m.metadata ?? {}) as Record<string, unknown>;
        for (const [k, v] of Object.entries(params.metadata)) {
          if (md[k] !== v) return false;
        }
      }
      return true;
    });
  }

  async getMemoriesByWorldId(params: {
    worldIds?: UUID[];
    limit?: number;
    tableName?: string;
  }): Promise<Memory[]> {
    const worldSet = params.worldIds ? new Set(params.worldIds) : null;
    const memories = await this.storage.getWhere<StoredMemory>(
      COLLECTIONS.MEMORIES,
      (m) =>
        (!worldSet || (m.worldId ? worldSet.has(m.worldId as UUID) : false)) &&
        (params.tableName ? m.metadata?.type === params.tableName : true),
    );
    memories.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
    const sliced = params.limit ? memories.slice(0, params.limit) : memories;
    return sliced.map(toMemory);
  }

  // ── Log CRUD ──────────────────────────────────────────────────────────

  async getLogs(params: {
    entityId?: UUID;
    roomId?: UUID;
    type?: string;
    limit?: number;
    offset?: number;
  }): Promise<Log[]> {
    let logs = await this.storage.getWhere<Log>(COLLECTIONS.LOGS, (l) => {
      if (params.entityId && l.entityId !== params.entityId) return false;
      if (params.roomId && l.roomId !== params.roomId) return false;
      if (params.type && l.type !== params.type) return false;
      return true;
    });
    logs.sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
    const offset = params.offset ?? 0;
    if (offset > 0) logs = logs.slice(offset);
    if (params.limit !== undefined) logs = logs.slice(0, params.limit);
    return logs;
  }

  async createLogs(
    params: Array<{
      body: LogBody;
      entityId: UUID;
      roomId: UUID;
      type: string;
    }>,
  ): Promise<void> {
    for (const entry of params) {
      const id = randomUUID() as UUID;
      const log: Log = {
        id,
        entityId: entry.entityId,
        roomId: entry.roomId,
        body: entry.body,
        type: entry.type,
        createdAt: new Date(),
      };
      await this.storage.set(COLLECTIONS.LOGS, id, log);
    }
  }

  async getLogsByIds(logIds: UUID[]): Promise<Log[]> {
    const logs: Log[] = [];
    for (const id of logIds) {
      const log = await this.storage.get<Log>(COLLECTIONS.LOGS, id);
      if (log) logs.push(log);
    }
    return logs;
  }

  async updateLogs(
    logs: Array<{ id: UUID; updates: Partial<Log> }>,
  ): Promise<void> {
    for (const { id, updates } of logs) {
      const existing = await this.storage.get<Log>(COLLECTIONS.LOGS, id);
      if (!existing) continue;
      await this.storage.set(COLLECTIONS.LOGS, id, { ...existing, ...updates });
    }
  }

  async deleteLogs(logIds: UUID[]): Promise<void> {
    for (const id of logIds) {
      await this.storage.delete(COLLECTIONS.LOGS, id);
    }
  }

  // ── World CRUD ────────────────────────────────────────────────────────

  async getAllWorlds(): Promise<World[]> {
    return this.storage.getAll<World>(COLLECTIONS.WORLDS);
  }

  async getWorldsByIds(worldIds: UUID[]): Promise<World[]> {
    const worlds: World[] = [];
    for (const id of worldIds) {
      const w = await this.storage.get<World>(COLLECTIONS.WORLDS, id);
      if (w) worlds.push(w);
    }
    return worlds;
  }

  async createWorlds(worlds: World[]): Promise<UUID[]> {
    const ids: UUID[] = [];
    for (const world of worlds) {
      const id = (world.id ?? randomUUID()) as UUID;
      await this.storage.set(COLLECTIONS.WORLDS, id, { ...world, id });
      ids.push(id);
    }
    return ids;
  }

  async deleteWorlds(worldIds: UUID[]): Promise<void> {
    for (const id of worldIds) {
      await this.storage.delete(COLLECTIONS.WORLDS, id);
    }
  }

  async updateWorlds(worlds: World[]): Promise<void> {
    for (const world of worlds) {
      if (!world.id) continue;
      const existing = await this.storage.get<World>(
        COLLECTIONS.WORLDS,
        world.id,
      );
      if (!existing) continue;
      await this.storage.set(COLLECTIONS.WORLDS, world.id, {
        ...existing,
        ...world,
      });
    }
  }

  async upsertWorlds(worlds: World[]): Promise<void> {
    for (const world of worlds) {
      const id = (world.id ?? randomUUID()) as UUID;
      const existing = await this.storage.get<World>(COLLECTIONS.WORLDS, id);
      await this.storage.set(COLLECTIONS.WORLDS, id, {
        ...(existing ?? {}),
        ...world,
        id,
      });
    }
  }

  // ── Room CRUD ─────────────────────────────────────────────────────────

  async getRoomsByIds(roomIds: UUID[]): Promise<Room[]> {
    const rooms: Room[] = [];
    for (const id of roomIds) {
      const room = await this.storage.get<Room>(COLLECTIONS.ROOMS, id);
      if (room) rooms.push(room);
    }
    return rooms;
  }

  async deleteRoomsByWorldIds(worldIds: UUID[]): Promise<void> {
    if (worldIds.length === 0) return;
    const worldSet = new Set(worldIds);
    const rooms = await this.storage.getWhere<Room>(COLLECTIONS.ROOMS, (r) =>
      r.worldId ? worldSet.has(r.worldId as UUID) : false,
    );
    const roomIds = rooms
      .map((r) => r.id)
      .filter((id): id is UUID => id !== undefined);
    await this.deleteRooms(roomIds);
  }

  async getRoomsForParticipants(entityIds: UUID[]): Promise<UUID[]> {
    if (entityIds.length === 0) return [];
    const entitySet = new Set(entityIds);
    const participants = await this.storage.getWhere<StoredParticipant>(
      COLLECTIONS.PARTICIPANTS,
      (p) => entitySet.has(p.entityId as UUID),
    );
    return [...new Set(participants.map((p) => p.roomId as UUID))];
  }

  async getRoomsByWorlds(
    worldIds: UUID[],
    limit?: number,
    offset?: number,
  ): Promise<Room[]> {
    if (worldIds.length === 0) return [];
    const worldSet = new Set(worldIds);
    let rooms = await this.storage.getWhere<Room>(COLLECTIONS.ROOMS, (r) =>
      r.worldId ? worldSet.has(r.worldId as UUID) : false,
    );
    const off = offset ?? 0;
    if (off > 0) rooms = rooms.slice(off);
    if (limit !== undefined) rooms = rooms.slice(0, limit);
    return rooms;
  }

  async createRooms(rooms: Room[]): Promise<UUID[]> {
    const ids: UUID[] = [];
    for (const room of rooms) {
      const id = (room.id ?? randomUUID()) as UUID;
      await this.storage.set(COLLECTIONS.ROOMS, id, { ...room, id });
      ids.push(id);
    }
    return ids;
  }

  async upsertRooms(rooms: Room[]): Promise<void> {
    for (const room of rooms) {
      const id = (room.id ?? randomUUID()) as UUID;
      const existing = await this.storage.get<Room>(COLLECTIONS.ROOMS, id);
      await this.storage.set(COLLECTIONS.ROOMS, id, {
        ...(existing ?? {}),
        ...room,
        id,
      });
    }
  }

  async updateRooms(rooms: Room[]): Promise<void> {
    for (const room of rooms) {
      if (!room.id) continue;
      const existing = await this.storage.get<Room>(COLLECTIONS.ROOMS, room.id);
      if (!existing) continue;
      await this.storage.set(COLLECTIONS.ROOMS, room.id, {
        ...existing,
        ...room,
      });
    }
  }

  async deleteRooms(roomIds: UUID[]): Promise<void> {
    if (roomIds.length === 0) return;
    const set = new Set(roomIds);
    for (const id of roomIds) {
      await this.storage.delete(COLLECTIONS.ROOMS, id);
    }
    // Cascade: drop participants and memories belonging to these rooms.
    await this.storage.deleteWhere<StoredParticipant>(
      COLLECTIONS.PARTICIPANTS,
      (p) => set.has(p.roomId as UUID),
    );
    await this.storage.deleteWhere<StoredMemory>(COLLECTIONS.MEMORIES, (m) =>
      set.has(m.roomId as UUID),
    );
  }

  // ── Participant CRUD ──────────────────────────────────────────────────

  async createRoomParticipants(
    entityIds: UUID[],
    roomId: UUID,
  ): Promise<UUID[]> {
    const ids: UUID[] = [];
    for (const entityId of entityIds) {
      const existing = await this.storage.getWhere<StoredParticipant>(
        COLLECTIONS.PARTICIPANTS,
        (p) => p.entityId === entityId && p.roomId === roomId,
      );
      const existingParticipant = existing[0];
      if (existingParticipant) {
        ids.push(existingParticipant.id as UUID);
        continue;
      }
      const id = randomUUID() as UUID;
      const participant: StoredParticipant = { id, entityId, roomId };
      await this.storage.set(COLLECTIONS.PARTICIPANTS, id, participant);
      ids.push(id);
    }
    return ids;
  }

  async deleteParticipants(
    participants: Array<{ entityId: UUID; roomId: UUID }>,
  ): Promise<boolean> {
    let removed = false;
    for (const { entityId, roomId } of participants) {
      const matches = await this.storage.getWhere<StoredParticipant>(
        COLLECTIONS.PARTICIPANTS,
        (p) => p.entityId === entityId && p.roomId === roomId,
      );
      for (const p of matches) {
        if (p.id) {
          await this.storage.delete(COLLECTIONS.PARTICIPANTS, p.id);
          removed = true;
        }
      }
    }
    return removed;
  }

  async updateParticipants(
    participants: Array<{
      entityId: UUID;
      roomId: UUID;
      updates: ParticipantUpdateFields;
    }>,
  ): Promise<void> {
    for (const { entityId, roomId, updates } of participants) {
      const matches = await this.storage.getWhere<StoredParticipant>(
        COLLECTIONS.PARTICIPANTS,
        (p) => p.entityId === entityId && p.roomId === roomId,
      );
      for (const p of matches) {
        if (!p.id) continue;
        const next: StoredParticipant = {
          ...p,
          userState: updates.roomState ?? p.userState,
          metadata: { ...(p.metadata ?? {}), ...(updates.metadata ?? {}) },
        };
        await this.storage.set(COLLECTIONS.PARTICIPANTS, p.id, next);
      }
    }
  }

  async getParticipantsForEntities(entityIds: UUID[]): Promise<Participant[]> {
    if (entityIds.length === 0) return [];
    const set = new Set(entityIds);
    const stored = await this.storage.getWhere<StoredParticipant>(
      COLLECTIONS.PARTICIPANTS,
      (p) => set.has(p.entityId as UUID),
    );
    const participants: Participant[] = [];
    for (const p of stored) {
      const entity = await this.storage.get<Entity>(
        COLLECTIONS.ENTITIES,
        p.entityId,
      );
      if (entity) participants.push({ id: p.id as UUID, entity });
    }
    return participants;
  }

  async getParticipantsForRooms(
    roomIds: UUID[],
  ): Promise<ParticipantsForRoomsResult> {
    const result: ParticipantsForRoomsResult = [];
    for (const roomId of roomIds) {
      const stored = await this.storage.getWhere<StoredParticipant>(
        COLLECTIONS.PARTICIPANTS,
        (p) => p.roomId === roomId,
      );
      result.push({
        roomId,
        entityIds: [...new Set(stored.map((p) => p.entityId as UUID))],
      });
    }
    return result;
  }

  async areRoomParticipants(
    pairs: Array<{ roomId: UUID; entityId: UUID }>,
  ): Promise<boolean[]> {
    const result: boolean[] = [];
    for (const { roomId, entityId } of pairs) {
      const matches = await this.storage.getWhere<StoredParticipant>(
        COLLECTIONS.PARTICIPANTS,
        (p) => p.roomId === roomId && p.entityId === entityId,
      );
      result.push(matches.length > 0);
    }
    return result;
  }

  async getParticipantUserStates(
    pairs: Array<{ roomId: UUID; entityId: UUID }>,
  ): Promise<ParticipantUserState[]> {
    const result: ParticipantUserState[] = [];
    for (const { roomId, entityId } of pairs) {
      const matches = await this.storage.getWhere<StoredParticipant>(
        COLLECTIONS.PARTICIPANTS,
        (p) => p.roomId === roomId && p.entityId === entityId,
      );
      const state = matches[0]?.userState ?? null;
      result.push(state);
    }
    return result;
  }

  async updateParticipantUserStates(
    updates: Array<{
      roomId: UUID;
      entityId: UUID;
      state: ParticipantUserState;
    }>,
  ): Promise<void> {
    for (const { roomId, entityId, state } of updates) {
      const matches = await this.storage.getWhere<StoredParticipant>(
        COLLECTIONS.PARTICIPANTS,
        (p) => p.roomId === roomId && p.entityId === entityId,
      );
      for (const p of matches) {
        if (!p.id) continue;
        await this.storage.set(COLLECTIONS.PARTICIPANTS, p.id, {
          ...p,
          userState: state,
        });
      }
    }
  }

  // ── Relationship CRUD ─────────────────────────────────────────────────

  async getRelationshipsByPairs(
    pairs: Array<{ sourceEntityId: UUID; targetEntityId: UUID }>,
  ): Promise<(Relationship | null)[]> {
    const result: (Relationship | null)[] = [];
    for (const pair of pairs) {
      const matches = await this.storage.getWhere<StoredRelationship>(
        COLLECTIONS.RELATIONSHIPS,
        (r) =>
          r.sourceEntityId === pair.sourceEntityId &&
          r.targetEntityId === pair.targetEntityId,
      );
      const first = matches[0];
      result.push(first ? relationshipFromStored(first, this.agentId) : null);
    }
    return result;
  }

  async getRelationships(params: {
    entityIds?: UUID[];
    tags?: string[];
    limit?: number;
    offset?: number;
  }): Promise<Relationship[]> {
    const entitySet = params.entityIds ? new Set(params.entityIds) : null;
    let stored = await this.storage.getWhere<StoredRelationship>(
      COLLECTIONS.RELATIONSHIPS,
      (r) => {
        if (entitySet) {
          if (
            !entitySet.has(r.sourceEntityId as UUID) &&
            !entitySet.has(r.targetEntityId as UUID)
          ) {
            return false;
          }
        }
        if (params.tags && params.tags.length > 0) {
          const tags = r.tags ?? [];
          if (!params.tags.some((t) => tags.includes(t))) return false;
        }
        return true;
      },
    );

    const offset = params.offset ?? 0;
    if (offset > 0) stored = stored.slice(offset);
    if (params.limit !== undefined) stored = stored.slice(0, params.limit);

    return stored.map((r) => relationshipFromStored(r, this.agentId));
  }

  async createRelationships(
    relationships: Array<{
      sourceEntityId: UUID;
      targetEntityId: UUID;
      tags?: string[];
      metadata?: Metadata;
    }>,
  ): Promise<UUID[]> {
    const ids: UUID[] = [];
    for (const rel of relationships) {
      const id = randomUUID() as UUID;
      const stored: StoredRelationship = {
        id,
        sourceEntityId: rel.sourceEntityId,
        targetEntityId: rel.targetEntityId,
        agentId: this.agentId,
        tags: rel.tags ?? [],
        metadata: rel.metadata ?? {},
        createdAt: new Date().toISOString(),
      };
      await this.storage.set(COLLECTIONS.RELATIONSHIPS, id, stored);
      ids.push(id);
    }
    return ids;
  }

  async getRelationshipsByIds(
    relationshipIds: UUID[],
  ): Promise<Relationship[]> {
    const relationships: Relationship[] = [];
    for (const id of relationshipIds) {
      const r = await this.storage.get<StoredRelationship>(
        COLLECTIONS.RELATIONSHIPS,
        id,
      );
      if (r) relationships.push(relationshipFromStored(r, this.agentId));
    }
    return relationships;
  }

  async updateRelationships(relationships: Relationship[]): Promise<void> {
    for (const rel of relationships) {
      if (!rel.id) continue;
      const existing = await this.storage.get<StoredRelationship>(
        COLLECTIONS.RELATIONSHIPS,
        rel.id,
      );
      if (!existing) continue;
      const next: StoredRelationship = {
        ...existing,
        sourceEntityId: rel.sourceEntityId ?? existing.sourceEntityId,
        targetEntityId: rel.targetEntityId ?? existing.targetEntityId,
        agentId: rel.agentId ?? existing.agentId,
        tags: rel.tags ?? existing.tags,
        metadata: { ...(existing.metadata ?? {}), ...(rel.metadata ?? {}) },
      };
      await this.storage.set(COLLECTIONS.RELATIONSHIPS, rel.id, next);
    }
  }

  async deleteRelationships(relationshipIds: UUID[]): Promise<void> {
    for (const id of relationshipIds) {
      await this.storage.delete(COLLECTIONS.RELATIONSHIPS, id);
    }
  }

  // ── Agent CRUD ────────────────────────────────────────────────────────

  async getAgents(): Promise<Partial<Agent>[]> {
    return this.storage.getAll<Agent>(COLLECTIONS.AGENTS);
  }

  async getAgentsByIds(agentIds: UUID[]): Promise<Agent[]> {
    const agents: Agent[] = [];
    for (const id of agentIds) {
      const agent = await this.storage.get<Agent>(COLLECTIONS.AGENTS, id);
      if (agent) agents.push(agent);
    }
    return agents;
  }

  async createAgents(agents: Partial<Agent>[]): Promise<UUID[]> {
    const ids: UUID[] = [];
    for (const agent of agents) {
      const id = (agent.id ?? randomUUID()) as UUID;
      await this.storage.set(COLLECTIONS.AGENTS, id, { ...agent, id });
      ids.push(id);
    }
    return ids;
  }

  async updateAgents(
    updates: Array<{ agentId: UUID; agent: Partial<Agent> }>,
  ): Promise<boolean> {
    let updated = false;
    for (const { agentId, agent } of updates) {
      const existing = await this.storage.get<Agent>(
        COLLECTIONS.AGENTS,
        agentId,
      );
      if (!existing) continue;
      await this.storage.set(COLLECTIONS.AGENTS, agentId, {
        ...existing,
        ...agent,
      });
      updated = true;
    }
    return updated;
  }

  async upsertAgents(agents: Partial<Agent>[]): Promise<void> {
    for (const agent of agents) {
      const id = (agent.id ?? randomUUID()) as UUID;
      const existing = await this.storage.get<Agent>(COLLECTIONS.AGENTS, id);
      await this.storage.set(COLLECTIONS.AGENTS, id, {
        ...(existing ?? {}),
        ...agent,
        id,
      });
    }
  }

  async deleteAgents(agentIds: UUID[]): Promise<boolean> {
    let removed = false;
    for (const id of agentIds) {
      const ok = await this.storage.delete(COLLECTIONS.AGENTS, id);
      if (ok) removed = true;
    }
    return removed;
  }

  async countAgents(): Promise<number> {
    return this.storage.count(COLLECTIONS.AGENTS);
  }

  async cleanupAgents(): Promise<void> {
    // Nothing to clean up for ephemeral storage.
  }

  // ── Cache CRUD ────────────────────────────────────────────────────────

  async getCaches<T>(keys: string[]): Promise<Map<string, T>> {
    const out = new Map<string, T>();
    for (const key of keys) {
      const entry = await this.storage.get<StoredCacheEntry<T>>(
        COLLECTIONS.CACHE,
        key,
      );
      if (!entry) continue;
      if (entry.expiresAt && Date.now() > entry.expiresAt) {
        await this.storage.delete(COLLECTIONS.CACHE, key);
        continue;
      }
      out.set(key, entry.value);
    }
    return out;
  }

  async setCaches<T>(
    entries: Array<{ key: string; value: T }>,
  ): Promise<boolean> {
    for (const { key, value } of entries) {
      await this.storage.set(COLLECTIONS.CACHE, key, { value });
    }
    return true;
  }

  async deleteCaches(keys: string[]): Promise<boolean> {
    let removed = false;
    for (const key of keys) {
      const ok = await this.storage.delete(COLLECTIONS.CACHE, key);
      if (ok) removed = true;
    }
    return removed;
  }

  // ── Task CRUD ─────────────────────────────────────────────────────────

  async getTasks(params: {
    roomId?: UUID;
    tags?: string[];
    entityId?: UUID;
    agentIds: UUID[];
    limit?: number;
    offset?: number;
  }): Promise<Task[]> {
    const agentSet = new Set(params.agentIds);
    let tasks = await this.storage.getWhere<Task>(COLLECTIONS.TASKS, (t) => {
      const taskAgentId = (t as Task & { agentId?: UUID }).agentId;
      if (
        agentSet.size > 0 &&
        taskAgentId !== undefined &&
        !agentSet.has(taskAgentId)
      ) {
        return false;
      }
      if (params.roomId && t.roomId !== params.roomId) return false;
      if (params.entityId && t.entityId !== params.entityId) return false;
      if (params.tags && params.tags.length > 0) {
        const tags = t.tags ?? [];
        if (!params.tags.some((tag) => tags.includes(tag))) return false;
      }
      return true;
    });
    const offset = params.offset ?? 0;
    if (offset > 0) tasks = tasks.slice(offset);
    if (params.limit !== undefined) tasks = tasks.slice(0, params.limit);
    return tasks;
  }

  async getTasksByName(name: string): Promise<Task[]> {
    return this.storage.getWhere<Task>(
      COLLECTIONS.TASKS,
      (t) => t.name === name,
    );
  }

  async createTasks(tasks: Task[]): Promise<UUID[]> {
    const ids: UUID[] = [];
    for (const task of tasks) {
      const id = (task.id ?? randomUUID()) as UUID;
      await this.storage.set(COLLECTIONS.TASKS, id, { ...task, id });
      ids.push(id);
    }
    return ids;
  }

  async getTasksByIds(taskIds: UUID[]): Promise<Task[]> {
    const tasks: Task[] = [];
    for (const id of taskIds) {
      const task = await this.storage.get<Task>(COLLECTIONS.TASKS, id);
      if (task) tasks.push(task);
    }
    return tasks;
  }

  async updateTasks(
    updates: Array<{ id: UUID; task: Partial<Task> }>,
  ): Promise<void> {
    for (const { id, task } of updates) {
      const existing = await this.storage.get<Task>(COLLECTIONS.TASKS, id);
      if (!existing) continue;
      await this.storage.set(COLLECTIONS.TASKS, id, { ...existing, ...task });
    }
  }

  async deleteTasks(taskIds: UUID[]): Promise<void> {
    for (const id of taskIds) {
      await this.storage.delete(COLLECTIONS.TASKS, id);
    }
  }

  // ── Pairing CRUD ──────────────────────────────────────────────────────

  async getPairingRequests(
    queries: Array<{ channel: PairingChannel; agentId: UUID }>,
  ): Promise<PairingRequestsResult> {
    const result: PairingRequestsResult = [];
    for (const { channel, agentId } of queries) {
      const requests = await this.storage.getWhere<PairingRequest>(
        COLLECTIONS.PAIRING_REQUESTS,
        (r) => r.channel === channel && r.agentId === agentId,
      );
      result.push({ channel, agentId, requests });
    }
    return result;
  }

  async getPairingAllowlists(
    queries: Array<{ channel: PairingChannel; agentId: UUID }>,
  ): Promise<PairingAllowlistsResult> {
    const result: PairingAllowlistsResult = [];
    for (const { channel, agentId } of queries) {
      const entries = await this.storage.getWhere<PairingAllowlistEntry>(
        COLLECTIONS.PAIRING_ALLOWLIST,
        (e) => e.channel === channel && e.agentId === agentId,
      );
      result.push({ channel, agentId, entries });
    }
    return result;
  }

  async createPairingRequests(requests: PairingRequest[]): Promise<UUID[]> {
    const ids: UUID[] = [];
    for (const request of requests) {
      const id = (request.id ?? randomUUID()) as UUID;
      await this.storage.set(COLLECTIONS.PAIRING_REQUESTS, id, {
        ...request,
        id,
      });
      ids.push(id);
    }
    return ids;
  }

  async updatePairingRequests(requests: PairingRequest[]): Promise<void> {
    for (const request of requests) {
      if (!request.id) continue;
      const existing = await this.storage.get<PairingRequest>(
        COLLECTIONS.PAIRING_REQUESTS,
        request.id,
      );
      if (!existing) continue;
      await this.storage.set(COLLECTIONS.PAIRING_REQUESTS, request.id, {
        ...existing,
        ...request,
      });
    }
  }

  async deletePairingRequests(ids: UUID[]): Promise<void> {
    for (const id of ids) {
      await this.storage.delete(COLLECTIONS.PAIRING_REQUESTS, id);
    }
  }

  async createPairingAllowlistEntries(
    entries: PairingAllowlistEntry[],
  ): Promise<UUID[]> {
    const ids: UUID[] = [];
    for (const entry of entries) {
      const id = (entry.id ?? randomUUID()) as UUID;
      await this.storage.set(COLLECTIONS.PAIRING_ALLOWLIST, id, {
        ...entry,
        id,
      });
      ids.push(id);
    }
    return ids;
  }

  async updatePairingAllowlistEntries(
    entries: PairingAllowlistEntry[],
  ): Promise<void> {
    for (const entry of entries) {
      if (!entry.id) continue;
      const existing = await this.storage.get<PairingAllowlistEntry>(
        COLLECTIONS.PAIRING_ALLOWLIST,
        entry.id,
      );
      if (!existing) continue;
      await this.storage.set(COLLECTIONS.PAIRING_ALLOWLIST, entry.id, {
        ...existing,
        ...entry,
      });
    }
  }

  async deletePairingAllowlistEntries(ids: UUID[]): Promise<void> {
    for (const id of ids) {
      await this.storage.delete(COLLECTIONS.PAIRING_ALLOWLIST, id);
    }
  }
}
