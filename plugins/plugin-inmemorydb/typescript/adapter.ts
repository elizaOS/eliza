/**
 * In-Memory Database Adapter
 *
 * WHY this adapter exists: Provides a zero-dependency database backend for
 * testing, ephemeral agents, and environments where no persistent database
 * is available. All data lives in a Map-based storage and is lost on restart.
 *
 * DESIGN: Implements the full IDatabaseAdapter interface with batch-first
 * CRUD methods. Create methods return UUID[], update/delete methods return
 * void and throw on failure. This matches the SQL adapter contract exactly.
 *
 * TRADE-OFFS:
 * - No persistence (data lost on restart)
 * - No vector search optimization (brute-force similarity scan)
 * - Plugin store is in-memory only (registerPluginSchema/getPluginStore supported)
 * - No messaging adapter support (IMessagingAdapter not implemented)
 */
import {
  type Agent,
  type Component,
  type Content,
  createMapBackend,
  DatabaseAdapter,
  type Entity,
  InMemoryPluginStore,
  type Log,
  type LogBody,
  logger,
  type Memory,
  type MemoryMetadata,
  type MemoryTypeAlias,
  type Metadata,
  type PairingAllowlistEntry,
  type PairingChannel,
  type PluginSchema,
  type PairingRequest,
  type Participant,
  type Relationship,
  type Room,
  type Task,
  type UUID,
  type World,
} from "@elizaos/core";
import { EphemeralHNSW } from "./hnsw";
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
  metadata?: MemoryMetadata;
}

function toMemory(stored: StoredMemory): Memory {
  return {
    id: stored.id as UUID | undefined,
    entityId: stored.entityId as UUID,
    agentId: stored.agentId as UUID | undefined,
    createdAt: stored.createdAt,
    content: stored.content as Content,
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

interface StoredRelationship {
  id: string;
  sourceEntityId: string;
  targetEntityId: string;
  agentId?: string;
  tags?: string[];
  metadata?: Metadata;
  createdAt?: string;
}

export class InMemoryDatabaseAdapter extends DatabaseAdapter<IStorage> {
  private storage: IStorage;
  private vectorIndex: EphemeralHNSW;
  private embeddingDimension = 384;
  private ready = false;
  private agentId: UUID;
  private pluginSchemas = new Map<string, PluginSchema>();
  private pluginStoreBackend = createMapBackend();

  constructor(storage: IStorage, agentId: UUID) {
    super();
    this.storage = storage;
    this.agentId = agentId;
    this.vectorIndex = new EphemeralHNSW();
  }

  async initialize(): Promise<void> {
    await this.init();
  }

  async init(): Promise<void> {
    await this.storage.init();
    await this.vectorIndex.init(this.embeddingDimension);
    this.ready = true;
    logger.info({ src: "plugin:inmemorydb" }, "In-memory database initialized");
  }

  async runPluginMigrations(
    _plugins: Array<{ name: string; schema?: Record<string, unknown> }>,
    _options?: { verbose?: boolean; force?: boolean; dryRun?: boolean }
  ): Promise<void> {
    logger.debug(
      { src: "plugin:inmemorydb" },
      "Plugin migrations not needed for in-memory storage"
    );
  }

  async registerPluginSchema(schema: PluginSchema): Promise<void> {
    this.pluginSchemas.set(schema.pluginName, schema);
  }

  getPluginStore(pluginName: string): import("@elizaos/core").IPluginStore | null {
    return new InMemoryPluginStore(pluginName, this.pluginStoreBackend.backend);
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

  // ===============================
  // Agent Methods
  // ===============================

  async getAgent(agentId: UUID): Promise<Agent | null> {
    return this.storage.get<Agent>(COLLECTIONS.AGENTS, agentId);
  }

  async getAgents(): Promise<Partial<Agent>[]> {
    return this.storage.getAll<Agent>(COLLECTIONS.AGENTS);
  }

  async getAgentsByIds(agentIds: UUID[]): Promise<Agent[]> {
    const agents: Agent[] = [];
    for (const id of agentIds) {
      const agent = await this.getAgent(id);
      if (agent) agents.push(agent);
    }
    return agents;
  }

  async createAgent(agent: Partial<Agent>): Promise<boolean> {
    if (!agent.id) return false;
    await this.storage.set(COLLECTIONS.AGENTS, agent.id, agent);
    return true;
  }

  async createAgents(agents: Partial<Agent>[]): Promise<UUID[]> {
    const ids: UUID[] = [];
    for (const agent of agents) {
      if (agent.id) {
        await this.createAgent(agent);
        ids.push(agent.id);
      }
    }
    return ids;
  }
  
  async upsertAgents(agents: Partial<Agent>[]): Promise<void> {
    // WHY: InMemoryDB uses storage.set() which naturally handles both insert and update
    for (const agent of agents) {
      if (agent.id) {
        await this.storage.set(COLLECTIONS.AGENTS, agent.id, agent);
      }
    }
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

  async updateAgents(updates: Array<{ agentId: UUID; agent: Partial<Agent> }>): Promise<boolean> {
    for (const { agentId, agent } of updates) {
      await this.updateAgent(agentId, agent);
    }
    return true;
  }

  async deleteAgent(agentId: UUID): Promise<boolean> {
    return this.storage.delete(COLLECTIONS.AGENTS, agentId);
  }

  async deleteAgents(agentIds: UUID[]): Promise<boolean> {
    for (const id of agentIds) {
      await this.deleteAgent(id);
    }
    return true;
  }
  
  async countAgents(): Promise<number> {
    const agents = await this.storage.getAll<Partial<Agent>>(COLLECTIONS.AGENTS);
    return agents.length;
  }
  
  async cleanupAgents(): Promise<void> {
    // WHY no-op: InMemoryDB persists to disk but has no time-based cleanup logic.
    // Cleanup would require adding updatedAt tracking to all agent records.
  }

  async ensureEmbeddingDimension(dimension: number): Promise<void> {
    if (this.embeddingDimension !== dimension) {
      this.embeddingDimension = dimension;
      await this.vectorIndex.init(dimension);
    }
  }

  // ===============================
  // Entity Methods
  // ===============================

  async getEntitiesByIds(entityIds: UUID[]): Promise<Entity[]> {
    const entities: Entity[] = [];
    for (const id of entityIds) {
      const entity = await this.storage.get<Entity>(COLLECTIONS.ENTITIES, id);
      if (entity) entities.push(entity);
    }
    return entities;
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

  async createEntities(entities: Entity[]): Promise<UUID[]> {
    const ids: UUID[] = [];
    for (const entity of entities) {
      if (!entity.id) continue;
      await this.storage.set(COLLECTIONS.ENTITIES, entity.id, entity);
      ids.push(entity.id);
    }
    return ids;
  }
  
  async upsertEntities(entities: Entity[]): Promise<void> {
    // WHY: storage.set() is idempotent - overwrites if exists, inserts if not
    for (const entity of entities) {
      if (entity.id) {
        await this.storage.set(COLLECTIONS.ENTITIES, entity.id, entity);
      }
    }
  }
  
  async searchEntitiesByName(params: {
    query: string;
    agentId: UUID;
    limit?: number;
  }): Promise<Entity[]> {
    const lowerQuery = params.query.toLowerCase();
    const limit = params.limit ?? 10;
    const allEntities = await this.storage.getAll<Entity>(COLLECTIONS.ENTITIES);
    const matches: Entity[] = [];
    
    for (const entity of allEntities) {
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
    const nameSet = new Set(params.names);
    const allEntities = await this.storage.getAll<Entity>(COLLECTIONS.ENTITIES);
    const matches: Entity[] = [];
    
    for (const entity of allEntities) {
      if (entity.agentId !== params.agentId) continue;
      
      const hasMatch = entity.names?.some(name => nameSet.has(name));
      if (hasMatch) {
        matches.push(entity);
      }
    }
    
    return matches;
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
    const { componentType, componentDataFilter, agentId, entityIds, worldId, limit, offset, includeAllComponents = false } = params;

    // TRAP: Prevent full table scans - require at least one meaningful filter OR explicit limit
    const hasFilter = componentType || componentDataFilter || entityIds || agentId || worldId;
    if (!hasFilter && !limit) {
      throw new Error('queryEntities requires at least one filter (componentType, componentDataFilter, entityIds, agentId, worldId) or an explicit limit');
    }

    const allComponents = await this.storage.getAll<Component>(COLLECTIONS.COMPONENTS);
    const matchingEntityIds = new Set<UUID>();

    // Filter components to find matching entities
    for (const component of allComponents) {
      // Apply filters
      if (agentId && component.agentId !== agentId) continue;
      if (worldId && component.worldId !== worldId) continue;
      if (entityIds && !entityIds.includes(component.entityId)) continue;
      if (componentType && component.type !== componentType) continue;
      
      if (componentDataFilter) {
        // TRAP: InMemory must implement deep-contains, not shallow equality
        if (!this.deepContains(component.data || {}, componentDataFilter)) continue;
      }
      
      matchingEntityIds.add(component.entityId);
    }

    // Fetch entities and their components
    // TRAP: Only count entities that actually exist (storage.get returns non-null).
    // If we counted null entities, they'd burn pagination slots and callers would
    // get fewer results than requested.
    const entities: Entity[] = [];
    let skipped = 0;
    let collected = 0;
    const startIdx = offset ?? 0;
    const maxCount = limit ?? Infinity;

    for (const entityId of matchingEntityIds) {
      if (collected >= maxCount) break;

      const entity = await this.storage.get<Entity>(COLLECTIONS.ENTITIES, entityId);
      if (!entity) continue;

      // Apply offset (skip first N real entities)
      if (skipped < startIdx) {
        skipped++;
        continue;
      }

      // Attach components
      const entityComponents: Component[] = [];
      for (const comp of allComponents) {
        if (comp.entityId !== entityId) continue;

        if (!includeAllComponents && componentType && comp.type !== componentType) {
          continue;
        }

        entityComponents.push(comp);
      }

      entities.push({
        ...entity,
        components: entityComponents,
      });

      collected++;
    }

    return entities;
  }

  /**
   * Deep containment check: does target contain all keys/values from filter?
   * For primitives: exact equality
   * For objects: recursive containment
   * For arrays: filter array must be subset of target array
   */
  private deepContains(target: unknown, filter: unknown): boolean {
    if (filter === null || filter === undefined) return true;
    if (target === null || target === undefined) return false;
    
    // Primitive equality
    if (typeof filter !== 'object') {
      return target === filter;
    }
    
    // Array containment: filter array must be subset of target array
    if (Array.isArray(filter)) {
      if (!Array.isArray(target)) return false;
      return filter.every(filterItem =>
        target.some(targetItem => this.deepContains(targetItem, filterItem))
      );
    }
    
    // Object containment: all filter keys must exist in target with matching values
    if (typeof target !== 'object' || Array.isArray(target)) return false;
    
    const filterObj = filter as Record<string, unknown>;
    const targetObj = target as Record<string, unknown>;
    
    for (const key of Object.keys(filterObj)) {
      if (!(key in targetObj)) return false;
      if (!this.deepContains(targetObj[key], filterObj[key])) return false;
    }
    
    return true;
  }

  async updateEntity(entity: Entity): Promise<void> {
    if (!entity.id) return;
    await this.storage.set(COLLECTIONS.ENTITIES, entity.id, entity);
  }

  async updateEntities(entities: Entity[]): Promise<void> {
    for (const entity of entities) {
      await this.updateEntity(entity);
    }
  }

  async deleteEntities(entityIds: UUID[]): Promise<void> {
    for (const id of entityIds) {
      await this.storage.delete(COLLECTIONS.ENTITIES, id);
    }
  }

  // ===============================
  // Component Methods
  // ===============================

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

  async createComponents(components: Component[]): Promise<UUID[]> {
    const ids: UUID[] = [];
    for (const component of components) {
      if (component.id) {
        await this.createComponent(component);
        ids.push(component.id);
      }
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

  async updateComponent(component: Component): Promise<void> {
    if (!component.id) return;
    await this.storage.set(COLLECTIONS.COMPONENTS, component.id, component);
  }

  async updateComponents(components: Component[]): Promise<void> {
    for (const component of components) {
      await this.updateComponent(component);
    }
  }

  async deleteComponent(componentId: UUID): Promise<void> {
    await this.storage.delete(COLLECTIONS.COMPONENTS, componentId);
  }

  async deleteComponents(componentIds: UUID[]): Promise<void> {
    for (const id of componentIds) {
      await this.deleteComponent(id);
    }
  }

  async upsertComponents(
    components: Component[],
    _options?: { entityContext?: UUID },
  ): Promise<void> {
    // WHY: InMemory upsert finds existing components by natural key, NOT by id.
    // The natural key is (entityId, type, worldId, sourceEntityId).
    for (const component of components) {
      // Find existing component by natural key
      const allComponents = await this.storage.list(COLLECTIONS.COMPONENTS);
      let existingId: UUID | null = null;
      
      for (const [id, existing] of allComponents) {
        const comp = existing as Component;
        if (
          comp.entityId === component.entityId &&
          comp.type === component.type &&
          (comp.worldId ?? null) === (component.worldId ?? null) &&
          (comp.sourceEntityId ?? null) === (component.sourceEntityId ?? null)
        ) {
          existingId = id as UUID;
          break;
        }
      }

      if (existingId) {
        // Update existing: merge mutable fields only
        const existing = await this.storage.get<Component>(COLLECTIONS.COMPONENTS, existingId);
        if (!existing) continue;
        const updated: Component = {
          ...existing,
          data: component.data,
          agentId: component.agentId,
          roomId: component.roomId,
          // Preserve: id, entityId, type, worldId, sourceEntityId, createdAt
        };
        await this.storage.set(COLLECTIONS.COMPONENTS, existingId, updated);
      } else {
        // Insert new with provided id
        await this.storage.set(COLLECTIONS.COMPONENTS, component.id, {
          ...component,
          createdAt: component.createdAt ?? Date.now(),
        });
      }
    }
  }

  async patchComponent(
    componentId: UUID,
    ops: import("@elizaos/core").PatchOp[],
    _options?: { entityContext?: UUID },
  ): Promise<void> {
    if (ops.length === 0) return;

    const component = await this.storage.get<Component>(COLLECTIONS.COMPONENTS, componentId);
    if (!component) {
      throw new Error(`Component not found: ${componentId}`);
    }

    // Clone data to avoid mutating original
    const data = JSON.parse(JSON.stringify(component.data || {}));

    // Apply each operation
    for (const op of ops) {
      const segments = this.validatePatchPath(op.path);

      switch (op.op) {
        case 'set': {
          if (op.value === undefined) {
            throw new Error(`'set' operation requires a value`);
          }
          this.setNestedValue(data, segments, op.value);
          break;
        }
        
        case 'push': {
          if (op.value === undefined) {
            throw new Error(`'push' operation requires a value`);
          }
          const arr = this.getNestedValue(data, segments);
          if (!Array.isArray(arr)) {
            throw new Error(`Cannot push to non-array at path "${op.path}"`);
          }
          arr.push(op.value);
          break;
        }
        
        case 'remove': {
          // Idempotent: no error if path doesn't exist
          this.removeNestedValue(data, segments);
          break;
        }
        
        case 'increment': {
          if (op.value === undefined) {
            throw new Error(`'increment' operation requires a value`);
          }
          const current = this.getNestedValue(data, segments);
          if (typeof current !== 'number') {
            throw new Error(`Cannot increment non-numeric value at path "${op.path}"`);
          }
          this.setNestedValue(data, segments, current + Number(op.value));
          break;
        }
        
        default:
          throw new Error(`Unknown patch operation: ${(op as import("@elizaos/core").PatchOp).op}`);
      }
    }

    // Save updated component
    await this.storage.set(COLLECTIONS.COMPONENTS, componentId, {
      ...component,
      data,
    });
  }

  /**
   * Validate patch path segments (same logic as SQL adapters)
   */
  private validatePatchPath(path: string): string[] {
    const PATH_SEGMENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
    const segments = path.split('.');
    for (const seg of segments) {
      if (!PATH_SEGMENT_RE.test(seg) && !/^\d+$/.test(seg)) {
        throw new Error(
          `Invalid patch path segment: "${seg}". Only alphanumeric, underscore, and numeric indices allowed.`
        );
      }
    }
    return segments;
  }

  /**
   * Get value at nested path in object
   */
  private getNestedValue(obj: any, segments: string[]): any {
    let current = obj;
    for (const seg of segments) {
      if (current == null) return undefined;
      current = current[seg];
    }
    return current;
  }

  /**
   * Set value at nested path in object (creates path if missing)
   */
  private setNestedValue(obj: any, segments: string[], value: unknown): void {
    let current = obj;
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i];
      if (current[seg] == null) {
        // Create intermediate object or array based on next segment
        const nextSeg = segments[i + 1];
        current[seg] = /^\d+$/.test(nextSeg) ? [] : {};
      }
      current = current[seg];
    }
    current[segments[segments.length - 1]] = value;
  }

  /**
   * Remove value at nested path in object (idempotent if missing)
   */
  private removeNestedValue(obj: any, segments: string[]): void {
    if (segments.length === 0) return;
    
    let current = obj;
    for (let i = 0; i < segments.length - 1; i++) {
      if (current == null) return; // Path doesn't exist - idempotent
      current = current[segments[i]];
    }
    
    if (current != null) {
      delete current[segments[segments.length - 1]];
    }
  }

  // ===============================
  // Memory Methods
  // ===============================

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
    orderBy?: 'createdAt';
    orderDirection?: 'asc' | 'desc';
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
      if (params.metadata) {
        if (!m.metadata) return false;
        for (const [key, value] of Object.entries(params.metadata)) {
          if (!(key in m.metadata)) return false;
          if (JSON.stringify(m.metadata[key]) !== JSON.stringify(value)) return false;
        }
      }
      return true;
    });

    // Sort by createdAt; default DESC (newest first) to match SQL adapter behavior
    if (params.orderDirection === 'asc') {
      memories.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
    } else {
      memories.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
    }

    if (params.offset) {
      memories = memories.slice(params.offset);
    }
    const effectiveLimit = params.limit ?? params.count;
    if (effectiveLimit) {
      memories = memories.slice(0, effectiveLimit);
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

      const memoryRecord = memory as StoredMemory & Record<string, unknown>;
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
        ...(memory.metadata ?? {}),
        type: tableName as MemoryTypeAlias,
      } as StoredMemory["metadata"],
    };

    await this.storage.set(COLLECTIONS.MEMORIES, id, storedMemory);

    if (memory.embedding && memory.embedding.length > 0) {
      await this.vectorIndex.add(id, memory.embedding);
    }

    return id;
  }

  async createMemories(
    memories: Array<{ memory: Memory; tableName: string; unique?: boolean }>
  ): Promise<UUID[]> {
    const ids: UUID[] = [];
    for (const { memory, tableName, unique } of memories) {
      ids.push(await this.createMemory(memory, tableName, unique));
    }
    return ids;
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
        ...(existing.metadata ?? {}),
        ...(memory.metadata ?? {}),
      } as MemoryMetadata,
    };

    await this.storage.set(COLLECTIONS.MEMORIES, memory.id, updated);

    if (memory.embedding && memory.embedding.length > 0) {
      await this.vectorIndex.add(memory.id, memory.embedding);
    }

    return true;
  }

  async updateMemories(
    memories: Array<Partial<Memory> & { id: UUID; metadata?: MemoryMetadata }>
  ): Promise<void> {
    const errors: Array<{ index: number; id: UUID }> = [];
    for (let i = 0; i < memories.length; i++) {
      const success = await this.updateMemory(memories[i]);
      if (!success) {
        errors.push({ index: i, id: memories[i].id });
      }
    }
    if (errors.length > 0) {
      throw new Error(`Failed to update ${errors.length} of ${memories.length} memories`);
    }
  }

  async deleteMemory(memoryId: UUID): Promise<void> {
    await this.storage.delete(COLLECTIONS.MEMORIES, memoryId);
    await this.vectorIndex.remove(memoryId);
  }

  async deleteMemories(memoryIds: UUID[]): Promise<void> {
    for (const id of memoryIds) {
      await this.deleteMemory(id);
    }
  }

  async upsertMemories(
    memories: Array<{ memory: Memory; tableName: string }>,
    _options?: { entityContext?: UUID },
  ): Promise<void> {
    for (const { memory, tableName } of memories) {
      const memoryId = memory.id ?? (crypto.randomUUID() as UUID);
      await this.storage.set(COLLECTIONS.MEMORIES, memoryId, {
        ...memory,
        id: memoryId,
        type: tableName,
        createdAt: memory.createdAt ?? Date.now(),
        metadata: {
          ...(memory.metadata ?? {}),
          type: tableName,
        } as StoredMemory["metadata"],
      });

      // Update vector index so upserted memories are visible to searchMemories
      if (memory.embedding && memory.embedding.length > 0) {
        await this.vectorIndex.add(memoryId, memory.embedding);
      }
    }
  }

  async deleteManyMemories(memoryIds: UUID[]): Promise<void> {
    await this.deleteMemories(memoryIds);
  }

  async deleteAllMemories(roomId: UUID, tableName: string): Promise<void> {
    const memories = await this.getMemories({ roomId, tableName });
    await this.deleteMemories(
      memories.map((m) => m.id).filter((id): id is UUID => id !== undefined)
    );
  }

  async countMemories(
    roomIdOrParams: UUID | {
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
    // Runtime type detection: object arg = new API, string arg = legacy positional
    const isObjectParams = typeof roomIdOrParams === 'object' && roomIdOrParams !== null && !unique && !tableName;

    if (isObjectParams) {
      const params = roomIdOrParams as {
        roomId?: UUID;
        unique?: boolean;
        tableName?: string;
        entityId?: UUID;
        agentId?: UUID;
        metadata?: Record<string, unknown>;
      };
      return this.storage.count<StoredMemory>(COLLECTIONS.MEMORIES, (memory) => {
        if (params.roomId && memory.roomId !== params.roomId) return false;
        if (params.unique && !memory.unique) return false;
        if (params.tableName && memory.metadata?.type !== params.tableName) return false;
        if (params.entityId && memory.entityId !== params.entityId) return false;
        if (params.agentId && memory.agentId !== params.agentId) return false;
        if (params.metadata) {
          const data = memory.metadata ?? {};
          for (const [key, value] of Object.entries(params.metadata)) {
            if (data[key] !== value) return false;
          }
        }
        return true;
      });
    }

    // Legacy positional params
    const roomId = roomIdOrParams as UUID;
    return this.storage.count<StoredMemory>(COLLECTIONS.MEMORIES, (memory) => {
      if (memory.roomId !== roomId) return false;
      if (unique && !memory.unique) return false;
      if (tableName && memory.metadata?.type !== tableName) return false;
      return true;
    });
  }

  async getMemoriesByWorldIds(params: {
    worldIds: UUID[];
    tableName?: string;
    limit?: number;
  }): Promise<Memory[]> {
    if (params.worldIds.length === 0) return [];
    const worldIdSet = new Set(params.worldIds);
    const memories = await this.storage.getWhere<StoredMemory>(
      COLLECTIONS.MEMORIES,
      (m) =>
        worldIdSet.has(m.worldId as UUID) &&
        (params.tableName ? m.metadata?.type === params.tableName : true)
    );
    memories.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
    const effectiveLimit = params.limit ?? 50;
    return toMemories(memories.slice(0, effectiveLimit));
  }

  // ===============================
  // Log Methods
  // ===============================

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

  async getLogsByIds(logIds: UUID[]): Promise<Log[]> {
    const logs: Log[] = [];
    for (const id of logIds) {
      const log = await this.storage.get<Log>(COLLECTIONS.LOGS, id);
      if (log) logs.push(log);
    }
    return logs;
  }

  async createLogs(
    params: Array<{ body: LogBody; entityId: UUID; roomId: UUID; type: string }>
  ): Promise<void> {
    for (const param of params) {
      await this.log(param);
    }
  }

  async updateLogs(logs: Array<{ id: UUID; updates: Partial<Log> }>): Promise<void> {
    for (const { id, updates } of logs) {
      const log = await this.storage.get<Log>(COLLECTIONS.LOGS, id);
      if (log) {
        await this.storage.set(COLLECTIONS.LOGS, id, { ...log, ...updates });
      }
    }
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

  async deleteLogs(logIds: UUID[]): Promise<void> {
    for (const id of logIds) {
      await this.deleteLog(id);
    }
  }

  // ===============================
  // World Methods
  // ===============================

  async createWorld(world: World): Promise<UUID> {
    const id = world.id ?? (crypto.randomUUID() as UUID);
    await this.storage.set(COLLECTIONS.WORLDS, id, { ...world, id });
    return id;
  }

  async createWorlds(worlds: World[]): Promise<UUID[]> {
    const ids: UUID[] = [];
    for (const world of worlds) {
      ids.push(await this.createWorld(world));
    }
    return ids;
  }
  
  async upsertWorlds(worlds: World[]): Promise<void> {
    // WHY: storage.set() handles both insert (new id) and update (existing id)
    for (const world of worlds) {
      if (world.id) {
        await this.storage.set(COLLECTIONS.WORLDS, world.id, world);
      }
    }
  }

  async getWorld(id: UUID): Promise<World | null> {
    return this.storage.get<World>(COLLECTIONS.WORLDS, id);
  }

  async getWorldsByIds(worldIds: UUID[]): Promise<World[]> {
    const worlds: World[] = [];
    for (const id of worldIds) {
      const world = await this.getWorld(id);
      if (world) worlds.push(world);
    }
    return worlds;
  }

  async removeWorld(id: UUID): Promise<void> {
    await this.storage.delete(COLLECTIONS.WORLDS, id);
  }

  async deleteWorlds(worldIds: UUID[]): Promise<void> {
    for (const id of worldIds) {
      await this.removeWorld(id);
    }
  }

  async getAllWorlds(): Promise<World[]> {
    return this.storage.getAll<World>(COLLECTIONS.WORLDS);
  }

  async updateWorld(world: World): Promise<void> {
    if (!world.id) return;
    await this.storage.set(COLLECTIONS.WORLDS, world.id, world);
  }

  async updateWorlds(worlds: World[]): Promise<void> {
    for (const world of worlds) {
      await this.updateWorld(world);
    }
  }

  // ===============================
  // Room Methods
  // ===============================

  async getRoomsByIds(roomIds: UUID[]): Promise<Room[]> {
    const rooms: Room[] = [];
    for (const id of roomIds) {
      const room = await this.storage.get<Room>(COLLECTIONS.ROOMS, id);
      if (room) rooms.push(room);
    }
    return rooms;
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
  
  async upsertRooms(rooms: Room[]): Promise<void> {
    // WHY: storage.set() is atomic upsert for key-value stores
    for (const room of rooms) {
      if (room.id) {
        await this.storage.set(COLLECTIONS.ROOMS, room.id, room);
      }
    }
  }

  async deleteRoom(roomId: UUID): Promise<void> {
    await this.storage.delete(COLLECTIONS.ROOMS, roomId);
    await this.storage.deleteWhere<StoredParticipant>(
      COLLECTIONS.PARTICIPANTS,
      (p) => p.roomId === roomId
    );
    await this.storage.deleteWhere<StoredMemory>(COLLECTIONS.MEMORIES, (m) => m.roomId === roomId);
  }

  async deleteRooms(roomIds: UUID[]): Promise<void> {
    for (const id of roomIds) {
      await this.deleteRoom(id);
    }
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

  async updateRooms(rooms: Room[]): Promise<void> {
    for (const room of rooms) {
      await this.updateRoom(room);
    }
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

  // ===============================
  // Participant Methods
  // ===============================

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

  async deleteParticipants(
    participants: Array<{ entityId: UUID; roomId: UUID }>
  ): Promise<boolean> {
    for (const { entityId, roomId } of participants) {
      await this.removeParticipant(entityId, roomId);
    }
    return true;
  }

  async updateParticipants(participants: Array<{
    entityId: UUID;
    roomId: UUID;
    updates: Partial<Participant>;
  }>): Promise<void> {
    for (const { entityId, roomId, updates } of participants) {
      const stored = await this.storage.getWhere<StoredParticipant>(
        COLLECTIONS.PARTICIPANTS,
        (p) => p.entityId === entityId && p.roomId === roomId
      );
      if (stored.length > 0) {
        const participant = stored[0];
        if (participant.id) {
          await this.storage.set(COLLECTIONS.PARTICIPANTS, participant.id, {
            ...participant,
            ...updates,
          });
        }
      }
    }
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

  async createRoomParticipants(entityIds: UUID[], roomId: UUID): Promise<UUID[]> {
    const ids: UUID[] = [];
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
        ids.push(id as UUID);
      } else {
        // Already exists - return the entityId as the participant ID
        ids.push(entityId);
      }
    }
    return ids;
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

  async updateParticipantUserState(
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

  // ===============================
  // Relationship Methods
  // ===============================

  async createRelationship(params: {
    sourceEntityId: UUID;
    targetEntityId: UUID;
    tags?: string[];
    metadata?: Metadata;
  }): Promise<UUID> {
    const id = crypto.randomUUID() as UUID;
    const relationship: StoredRelationship = {
      id,
      sourceEntityId: params.sourceEntityId,
      targetEntityId: params.targetEntityId,
      agentId: this.agentId,
      tags: params.tags ?? [],
      metadata: params.metadata ?? {},
      createdAt: new Date().toISOString(),
    };
    await this.storage.set(COLLECTIONS.RELATIONSHIPS, id, relationship);
    return id;
  }

  async createRelationships(
    relationships: Array<{
      sourceEntityId: UUID;
      targetEntityId: UUID;
      tags?: string[];
      metadata?: Metadata;
    }>
  ): Promise<UUID[]> {
    const ids: UUID[] = [];
    for (const rel of relationships) {
      const id = await this.createRelationship(rel);
      ids.push(id);
    }
    return ids;
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

  async getRelationshipsByIds(relationshipIds: UUID[]): Promise<Relationship[]> {
    const relationships: Relationship[] = [];
    for (const id of relationshipIds) {
      const r = await this.storage.get<StoredRelationship>(COLLECTIONS.RELATIONSHIPS, id);
      if (r) {
        relationships.push({
          id: r.id as UUID,
          sourceEntityId: r.sourceEntityId as UUID,
          targetEntityId: r.targetEntityId as UUID,
          agentId: (r.agentId as UUID) ?? this.agentId,
          tags: r.tags ?? [],
          metadata: r.metadata ?? {},
          createdAt: r.createdAt,
        });
      }
    }
    return relationships;
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

  async updateRelationships(relationships: Relationship[]): Promise<void> {
    for (const rel of relationships) {
      await this.updateRelationship(rel);
    }
  }

  async deleteRelationships(relationshipIds: UUID[]): Promise<void> {
    for (const id of relationshipIds) {
      await this.storage.delete(COLLECTIONS.RELATIONSHIPS, id);
    }
  }

  // ===============================
  // Cache Methods
  // ===============================

  async getCache<T>(key: string): Promise<T | undefined> {
    const cached = await this.storage.get<{ value: T; expiresAt?: number }>(COLLECTIONS.CACHE, key);
    if (!cached) return undefined;

    if (cached.expiresAt && Date.now() > cached.expiresAt) {
      await this.deleteCache(key);
      return undefined;
    }

    return cached.value;
  }

  async getCaches<T>(keys: string[]): Promise<Map<string, T>> {
    const map = new Map<string, T>();
    for (const key of keys) {
      const value = await this.getCache<T>(key);
      if (value !== undefined) map.set(key, value);
    }
    return map;
  }

  async setCache<T>(key: string, value: T): Promise<boolean> {
    await this.storage.set(COLLECTIONS.CACHE, key, { value });
    return true;
  }

  async setCaches<T>(entries: Array<{ key: string; value: T }>): Promise<boolean> {
    for (const { key, value } of entries) {
      await this.setCache(key, value);
    }
    return true;
  }

  async deleteCache(key: string): Promise<boolean> {
    return this.storage.delete(COLLECTIONS.CACHE, key);
  }

  async deleteCaches(keys: string[]): Promise<boolean> {
    for (const key of keys) {
      await this.deleteCache(key);
    }
    return true;
  }

  // ===============================
  // Task Methods
  // ===============================

  async createTask(task: Task): Promise<UUID> {
    const id = task.id ?? (crypto.randomUUID() as UUID);
    await this.storage.set(COLLECTIONS.TASKS, id, { ...task, id });
    return id;
  }

  async createTasks(tasks: Task[]): Promise<UUID[]> {
    const ids: UUID[] = [];
    for (const task of tasks) {
      ids.push(await this.createTask(task));
    }
    return ids;
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

  async getTasksByIds(taskIds: UUID[]): Promise<Task[]> {
    const tasks: Task[] = [];
    for (const id of taskIds) {
      const task = await this.getTask(id);
      if (task) tasks.push(task);
    }
    return tasks;
  }

  async getTasksByName(name: string): Promise<Task[]> {
    return this.storage.getWhere<Task>(COLLECTIONS.TASKS, (t) => t.name === name);
  }

  async updateTask(id: UUID, task: Partial<Task>): Promise<void> {
    const existing = await this.getTask(id);
    if (!existing) return;
    await this.storage.set(COLLECTIONS.TASKS, id, { ...existing, ...task });
  }

  async updateTasks(updates: Array<{ id: UUID; task: Partial<Task> }>): Promise<void> {
    for (const { id, task } of updates) {
      await this.updateTask(id, task);
    }
  }

  async deleteTask(id: UUID): Promise<void> {
    await this.storage.delete(COLLECTIONS.TASKS, id);
  }

  async deleteTasks(taskIds: UUID[]): Promise<void> {
    for (const id of taskIds) {
      await this.deleteTask(id);
    }
  }

  // ===============================
  // Pairing Methods
  // ===============================

  async getPairingRequests(channel: PairingChannel, agentId: UUID): Promise<PairingRequest[]> {
    return this.storage.getWhere<PairingRequest>(
      COLLECTIONS.PAIRING_REQUESTS,
      (r) => r.channel === channel && r.agentId === agentId
    );
  }

  async createPairingRequest(request: PairingRequest): Promise<UUID> {
    const id = request.id ?? (crypto.randomUUID() as UUID);
    await this.storage.set(COLLECTIONS.PAIRING_REQUESTS, id, { ...request, id });
    return id;
  }

  async createPairingRequests(requests: PairingRequest[]): Promise<UUID[]> {
    const ids: UUID[] = [];
    for (const request of requests) {
      ids.push(await this.createPairingRequest(request));
    }
    return ids;
  }

  async updatePairingRequest(request: PairingRequest): Promise<void> {
    const existing = await this.storage.get<PairingRequest>(
      COLLECTIONS.PAIRING_REQUESTS,
      request.id
    );
    if (existing) {
      await this.storage.set(COLLECTIONS.PAIRING_REQUESTS, request.id, {
        ...existing,
        ...request,
      });
    }
  }

  async updatePairingRequests(requests: PairingRequest[]): Promise<void> {
    for (const request of requests) {
      await this.updatePairingRequest(request);
    }
  }

  async deletePairingRequest(id: UUID): Promise<void> {
    await this.storage.delete(COLLECTIONS.PAIRING_REQUESTS, id);
  }

  async deletePairingRequests(ids: UUID[]): Promise<void> {
    for (const id of ids) {
      await this.deletePairingRequest(id);
    }
  }

  async getPairingAllowlist(
    channel: PairingChannel,
    agentId: UUID
  ): Promise<PairingAllowlistEntry[]> {
    return this.storage.getWhere<PairingAllowlistEntry>(
      COLLECTIONS.PAIRING_ALLOWLIST,
      (e) => e.channel === channel && e.agentId === agentId
    );
  }

  async createPairingAllowlistEntry(entry: PairingAllowlistEntry): Promise<UUID> {
    const id = entry.id ?? (crypto.randomUUID() as UUID);
    await this.storage.set(COLLECTIONS.PAIRING_ALLOWLIST, id, { ...entry, id });
    return id;
  }

  async createPairingAllowlistEntries(entries: PairingAllowlistEntry[]): Promise<UUID[]> {
    const ids: UUID[] = [];
    for (const entry of entries) {
      ids.push(await this.createPairingAllowlistEntry(entry));
    }
    return ids;
  }

  async updatePairingAllowlistEntries(entries: PairingAllowlistEntry[]): Promise<void> {
    for (const entry of entries) {
      if (!entry.id) continue;
      const existing = await this.storage.get<PairingAllowlistEntry>(
        COLLECTIONS.PAIRING_ALLOWLIST,
        entry.id
      );
      if (existing) {
        await this.storage.set(COLLECTIONS.PAIRING_ALLOWLIST, entry.id, { ...existing, ...entry });
      }
    }
  }

  async deletePairingAllowlistEntry(id: UUID): Promise<void> {
    await this.storage.delete(COLLECTIONS.PAIRING_ALLOWLIST, id);
  }

  async deletePairingAllowlistEntries(ids: UUID[]): Promise<void> {
    for (const id of ids) {
      await this.deletePairingAllowlistEntry(id);
    }
  }

  /**
   * Execute a callback (NOT atomic - InMemory does not support true transactions).
   * 
   * WARNING: InMemory transactions are NOT atomic. Changes are not rolled back on error.
   * If step 2 of a callback fails, step 1's changes are ALREADY APPLIED and NOT reversed.
   * 
   * This is acceptable for dev/test environments but NOT for production critical paths
   * where atomicity is required. Use SQL adapters (PostgreSQL/MySQL) for true transactions.
   * 
   * @param callback Function that receives this adapter (not a proxy)
   * @returns Promise resolving to callback's return value
   */
  async transaction<T>(
    callback: (tx: import("@elizaos/core").IDatabaseAdapter<IStorage>) => Promise<T>,
    _options?: { entityContext?: UUID },
  ): Promise<T> {
    // No transaction semantics - just execute the callback with this adapter
    return callback(this);
  }
}
