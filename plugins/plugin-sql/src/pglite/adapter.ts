import type { PGlite } from "@electric-sql/pglite";
import {
  type Agent,
  type Entity,
  logger,
  type Memory,
  type MemoryMetadata,
  type Relationship,
  type Room,
  type Task,
  type UUID,
  type World,
} from "@elizaos/core";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { BaseDrizzleAdapter } from "../base";
import { DIMENSION_MAP, type EmbeddingDimensionColumn } from "../schema/embedding";
import type { PGliteClientManager } from "./manager";

export class PgliteDatabaseAdapter extends BaseDrizzleAdapter {
  private manager: PGliteClientManager;
  protected embeddingDimension: EmbeddingDimensionColumn = DIMENSION_MAP[384];

  constructor(agentId: UUID, manager: PGliteClientManager) {
    super(agentId);
    this.manager = manager;
    // The PGlite class identity differs across @electric-sql/pglite minor
    // versions when this workspace is nested under a parent that pins an
    // older copy. Type the call site explicitly; the runtime
    // shape is identical and drizzle just calls .query() on the client.
    const drizzlePglite = drizzle as (client: unknown) => PgliteDatabase;
    this.db = drizzlePglite(this.manager.getConnection());
  }

  public async withEntityContext<T>(
    _entityId: UUID | null,
    callback: (tx: PgliteDatabase) => Promise<T>
  ): Promise<T> {
    return this.db.transaction(callback);
  }

  async getEntityByIds(entityIds: UUID[]): Promise<Entity[] | null> {
    return this.getEntitiesByIds(entityIds);
  }

  async getMemoriesByServerId(params: { serverId: UUID; count?: number }): Promise<Memory[]> {
    return super.getMemoriesByServerId(params);
  }

  async ensureAgentExists(agent: Partial<Agent>): Promise<Agent> {
    const existingAgent = await this.getAgent(this.agentId);
    if (existingAgent) {
      return existingAgent;
    }

    const newAgent: Agent = {
      id: this.agentId,
      name: agent.name || "Unknown Agent",
      username: agent.username,
      bio: (Array.isArray(agent.bio)
        ? agent.bio
        : agent.bio
          ? [agent.bio]
          : ["An AI agent"]) as string[],
      createdAt: agent.createdAt || Date.now(),
      updatedAt: agent.updatedAt || Date.now(),
    };

    await this.createAgent(newAgent);
    const createdAgent = await this.getAgent(this.agentId);
    if (!createdAgent) {
      throw new Error("Failed to create agent");
    }
    return createdAgent;
  }

  protected async withDatabase<T>(operation: () => Promise<T>): Promise<T> {
    if (this.manager.isShuttingDown()) {
      const error = new Error("Database is shutting down - operation rejected");
      logger.info(
        { src: "plugin:sql", error: error.message },
        "Database operation rejected during shutdown"
      );
      throw error;
    }
    const managerWithInit = this.manager as PGliteClientManager & {
      initialize?: () => Promise<void>;
      ensureSync?: () => Promise<void>;
    };
    await managerWithInit.initialize();
    // Deferred Electric Sync startup: tables must exist before sync inserts
    // data. Migrations run after plugin init, so we defer sync to the first
    // real database operation — by which point tables are guaranteed to exist.
    await managerWithInit.ensureSync?.();
    if (this.manager.isShuttingDown()) {
      const error = new Error("Database is shutting down - operation rejected");
      logger.info(
        { src: "plugin:sql", error: error.message },
        "Database operation rejected during shutdown"
      );
      throw error;
    }
    return operation();
  }

  async init(): Promise<void> {
    const managerWithInit = this.manager as PGliteClientManager & {
      initialize?: () => Promise<void>;
    };
    await managerWithInit.initialize();
    logger.debug({ src: "plugin:sql" }, "PGliteDatabaseAdapter initialized");
  }

  async isReady(): Promise<boolean> {
    const managerWithState = this.manager as PGliteClientManager & {
      isInitialized?: () => boolean;
    };
    return !this.manager.isShuttingDown() && managerWithState.isInitialized() === true;
  }

  async close() {
    await this.manager.close();
  }

  async getConnection(): Promise<PgliteDatabase> {
    const managerWithInit = this.manager as PGliteClientManager & {
      initialize?: () => Promise<void>;
    };
    await managerWithInit.initialize();
    return this.db as PgliteDatabase;
  }

  getRawConnection(): PGlite {
    return this.manager.getConnection();
  }

  // ── Electric write-back notification overrides ─────────────────────────
  // Each override calls super[method] then fires manager.notifyWrite() so the
  // WriteBackService (Pattern 1 — Online Writes) can forward the change to the
  // cloud API. The row payload contains at minimum the primary key(s); for
  // inserts and upserts it includes the full data the caller provided.

  async createAgent(agent: Agent): Promise<boolean> {
    const ok = await super.createAgent(agent);
    if (ok && agent.id) {
      this.manager.notifyWrite("agents", "insert", { ...agent, id: agent.id } as Record<
        string,
        unknown
      >);
    }
    return ok;
  }

  async updateAgent(agentId: UUID, agent: Partial<Agent>): Promise<boolean> {
    const ok = await super.updateAgent(agentId, agent);
    if (ok) {
      this.manager.notifyWrite("agents", "upsert", { ...agent, id: agentId } as Record<
        string,
        unknown
      >);
    }
    return ok;
  }

  async deleteAgent(agentId: UUID): Promise<boolean> {
    const ok = await super.deleteAgent(agentId);
    if (ok) {
      this.manager.notifyWrite("agents", "delete", { id: agentId });
    }
    return ok;
  }

  async deleteAgents(agentIds: UUID[]): Promise<boolean> {
    const ok = await super.deleteAgents(agentIds);
    if (ok) {
      for (const id of agentIds) {
        this.manager.notifyWrite("agents", "delete", { id });
      }
    }
    return ok;
  }

  async createEntities(entities: Entity[]): Promise<UUID[]> {
    const ids = await super.createEntities(entities);
    for (let i = 0; i < entities.length && i < ids.length; i++) {
      this.manager.notifyWrite("entities", "insert", { ...entities[i], id: ids[i] } as Record<
        string,
        unknown
      >);
    }
    return ids;
  }

  async updateEntity(entity: Entity): Promise<void> {
    await super.updateEntity(entity);
    if (entity.id) {
      this.manager.notifyWrite("entities", "upsert", { ...entity, id: entity.id } as Record<
        string,
        unknown
      >);
    }
  }

  async deleteEntity(entityId: UUID): Promise<void> {
    await super.deleteEntity(entityId);
    this.manager.notifyWrite("entities", "delete", { id: entityId });
  }

  async createWorld(world: World): Promise<UUID> {
    const id = await super.createWorld(world);
    this.manager.notifyWrite("worlds", "insert", { ...world, id } as Record<string, unknown>);
    return id;
  }

  async updateWorld(world: World): Promise<void> {
    await super.updateWorld(world);
    if (world.id) {
      this.manager.notifyWrite("worlds", "upsert", { ...world, id: world.id } as Record<
        string,
        unknown
      >);
    }
  }

  async removeWorld(id: UUID): Promise<void> {
    await super.removeWorld(id);
    this.manager.notifyWrite("worlds", "delete", { id });
  }

  async createRooms(rooms: Room[]): Promise<UUID[]> {
    const ids = await super.createRooms(rooms);
    for (let i = 0; i < rooms.length && i < ids.length; i++) {
      this.manager.notifyWrite("rooms", "insert", { ...rooms[i], id: ids[i] } as Record<
        string,
        unknown
      >);
    }
    return ids;
  }

  async updateRoom(room: Room): Promise<void> {
    await super.updateRoom(room);
    this.manager.notifyWrite("rooms", "upsert", { ...room, id: room.id } as Record<
      string,
      unknown
    >);
  }

  async deleteRoom(roomId: UUID): Promise<void> {
    await super.deleteRoom(roomId);
    this.manager.notifyWrite("rooms", "delete", { id: roomId });
  }

  async addParticipant(entityId: UUID, roomId: UUID): Promise<boolean> {
    const ok = await super.addParticipant(entityId, roomId);
    if (ok) {
      // Query the actual DB-generated id so the write-back ID matches the
      // local row. The base adapter returns boolean, not UUID.
      let participantId: string | null = null;
      try {
        const result = await this.manager
          .getConnection()
          .query(
            `SELECT id FROM participants WHERE user_id = $1 AND room_id = $2 AND agent_id = $3 ORDER BY joined_at DESC LIMIT 1`,
            [entityId, roomId, this.agentId]
          );
        const rows = result.rows as Array<{ id: string }>;
        participantId = rows[0]?.id ?? null;
      } catch (err) {
        logger.debug(
          { src: "plugin:sql", error: err instanceof Error ? err.message : String(err) },
          "Failed to look up participant id for write-back"
        );
      }
      if (participantId) {
        this.manager.notifyWrite("participants", "insert", {
          id: participantId,
          user_id: entityId,
          room_id: roomId,
          agent_id: this.agentId,
        });
      }
    }
    return ok;
  }

  async removeParticipant(entityId: UUID, roomId: UUID): Promise<boolean> {
    const ok = await super.removeParticipant(entityId, roomId);
    if (ok) {
      this.manager.notifyWrite("participants", "delete", { entity_id: entityId, room_id: roomId });
    }
    return ok;
  }

  async createMemory(
    memory: Memory & { metadata?: MemoryMetadata },
    tableName: string
  ): Promise<UUID> {
    const id = await super.createMemory(memory, tableName);
    // `tableName` is the logical memory type (e.g. "messages"/"facts"), stored
    // in the `type` column of the single physical `memories` table — the
    // write-back target is always the physical table.
    this.manager.notifyWrite("memories", "insert", { ...memory, id } as Record<string, unknown>);
    return id;
  }

  async updateMemory(
    memory: Partial<Memory> & { id: UUID; metadata?: MemoryMetadata }
  ): Promise<boolean> {
    const ok = await super.updateMemory(memory);
    if (ok) {
      this.manager.notifyWrite("memories", "upsert", { ...memory, id: memory.id } as Record<
        string,
        unknown
      >);
    }
    return ok;
  }

  async deleteMemory(memoryId: UUID): Promise<void> {
    await super.deleteMemory(memoryId);
    this.manager.notifyWrite("memories", "delete", { id: memoryId });
  }

  async deleteManyMemories(memoryIds: UUID[]): Promise<void> {
    await super.deleteManyMemories(memoryIds);
    for (const id of memoryIds) {
      this.manager.notifyWrite("memories", "delete", { id });
    }
  }

  async deleteAllMemories(roomIds: UUID[], tableName: string): Promise<void>;
  async deleteAllMemories(roomId: UUID, tableName: string): Promise<void>;
  async deleteAllMemories(roomIdsOrRoomId: UUID[] | UUID, tableName: string): Promise<void> {
    // Capture the IDs that will be deleted so the write-back notification
    // can include them. The base method does not return the deleted IDs.
    const roomIds = Array.isArray(roomIdsOrRoomId) ? roomIdsOrRoomId : [roomIdsOrRoomId];
    let deletedIds: string[] = [];
    if (roomIds.length > 0) {
      try {
        const result = await this.manager
          .getConnection()
          .query(
            `SELECT id FROM memories WHERE room_id = ANY($1::uuid[]) AND type = $2 AND agent_id = $3`,
            [roomIds, tableName, this.agentId]
          );
        deletedIds = (result.rows as Array<{ id: string }>).map((r) => r.id);
      } catch {}
    }
    await super.deleteAllMemories(roomIdsOrRoomId as never, tableName);
    for (const id of deletedIds) {
      this.manager.notifyWrite("memories", "delete", { id });
    }
  }

  async createRelationship(params: {
    sourceEntityId: UUID;
    targetEntityId: UUID;
    tags?: string[];
    metadata?: { [key: string]: unknown };
  }): Promise<boolean> {
    const ok = await super.createRelationship(params);
    if (ok) {
      // Query the actual DB-generated id so the write-back ID matches the
      // local row. The base adapter returns boolean, not UUID.
      let relationshipId: string | null = null;
      try {
        const result = await this.manager
          .getConnection()
          .query(
            `SELECT id FROM relationships WHERE source_entity_id = $1 AND target_entity_id = $2 AND agent_id = $3 ORDER BY created_at DESC LIMIT 1`,
            [params.sourceEntityId, params.targetEntityId, this.agentId]
          );
        const rows = result.rows as Array<{ id: string }>;
        relationshipId = rows[0]?.id ?? null;
      } catch (err) {
        logger.debug(
          { src: "plugin:sql", error: err instanceof Error ? err.message : String(err) },
          "Failed to look up relationship id for write-back"
        );
      }
      if (relationshipId) {
        this.manager.notifyWrite("relationships", "insert", {
          id: relationshipId,
          source_entity_id: params.sourceEntityId,
          target_entity_id: params.targetEntityId,
          agent_id: this.agentId,
          tags: params.tags ?? [],
          metadata: params.metadata ?? {},
        });
      }
    }
    return ok;
  }

  async updateRelationship(relationship: Relationship): Promise<void> {
    await super.updateRelationship(relationship);
    this.manager.notifyWrite("relationships", "upsert", {
      ...relationship,
      id: relationship.id,
    } as Record<string, unknown>);
  }

  async deleteRelationships(relationshipIds: UUID[]): Promise<void> {
    await super.deleteRelationships(relationshipIds);
    for (const id of relationshipIds) {
      this.manager.notifyWrite("relationships", "delete", { id });
    }
  }

  async createTask(task: Task): Promise<UUID> {
    const id = await super.createTask(task);
    this.manager.notifyWrite("tasks", "insert", { ...task, id } as Record<string, unknown>);
    return id;
  }

  async updateTask(id: UUID, task: Partial<Task>): Promise<void> {
    await super.updateTask(id, task);
    this.manager.notifyWrite("tasks", "upsert", { ...task, id } as Record<string, unknown>);
  }

  async deleteTask(id: UUID): Promise<void> {
    await super.deleteTask(id);
    this.manager.notifyWrite("tasks", "delete", { id });
  }
}
