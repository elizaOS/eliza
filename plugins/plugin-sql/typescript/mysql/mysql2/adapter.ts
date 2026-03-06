import {
  type Agent,
  type Entity,
  logger,
  type Memory,
  type UUID,
} from "@elizaos/core";
import type { MySql2Database } from "drizzle-orm/mysql2";
import { BaseDrizzleAdapter } from "../base";
import type { MySql2ConnectionManager } from "./manager";

export class MySql2DatabaseAdapter extends BaseDrizzleAdapter {
  // WHY: No redeclaration of embeddingDimension here — the base class already
  // declares it with the correct default. Redeclaring would shadow the base
  // property, causing ensureEmbeddingDimension() to update a different field.
  private manager: MySql2ConnectionManager;

  constructor(
    agentId: UUID,
    manager: MySql2ConnectionManager,
    _schema?: Record<string, unknown>
  ) {
    super(agentId);
    this.manager = manager;
    this.db = manager.getDatabase();
  }

  getManager(): MySql2ConnectionManager {
    return this.manager;
  }

  /**
   * MySQL doesn't have Row Level Security.
   * withEntityContext is a passthrough that just executes the callback.
   */
  public async withEntityContext<T>(
    _entityId: UUID | null,
    callback: (tx: MySql2Database) => Promise<T>
  ): Promise<T> {
    // WHY: No transaction wrapper needed — MySQL doesn't use RLS, so the
    // callback runs directly against the connection. Wrapping in a transaction
    // would add unnecessary overhead for every entity-scoped operation.
    return callback(this.db as MySql2Database);
  }

  async getEntityByIds(entityIds: UUID[]): Promise<Entity[] | null> {
    return this.getEntitiesByIds(entityIds);
  }

  async getMemoriesByServerId(_params: { serverId: UUID; count?: number }): Promise<Memory[]> {
    logger.warn({ src: "plugin:sql" }, "getMemoriesByServerId called but not implemented");
    return [];
  }

  /**
   * WHY: Race-safe agent creation using try/catch pattern. Under concurrent
   * startup, two instances may both see "no agent exists" and try to create.
   * The try/catch handles the duplicate key error by re-reading instead of
   * crashing, matching the PostgreSQL adapter's behavior.
   */
  async ensureAgentExists(agent: Partial<Agent>): Promise<Agent> {
    const existing = await this.getAgentsByIds([this.agentId]);
    if (existing.length > 0) {
      return existing[0];
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

    try {
      await this.createAgents([newAgent]);
    } catch (error) {
      // Concurrent creation race — another instance created it first.
      // Re-read and return the existing agent.
      const raceResult = await this.getAgentsByIds([this.agentId]);
      if (raceResult.length > 0) {
        return raceResult[0];
      }
      throw error; // Genuine failure, not a race condition
    }

    const created = await this.getAgentsByIds([this.agentId]);
    if (created.length === 0) {
      throw new Error("Failed to create agent");
    }
    return created[0];
  }

  protected async withDatabase<T>(operation: () => Promise<T>): Promise<T> {
    return this.withRetry(() => operation());
  }

  async init(): Promise<void> {
    logger.debug({ src: "plugin:sql" }, "MySql2DatabaseAdapter initialized");
  }

  async isReady(): Promise<boolean> {
    return this.manager.testConnection();
  }

  async close(): Promise<void> {
    await this.manager.close();
  }

  async getConnection(): Promise<MySql2Database> {
    return this.db as MySql2Database;
  }

  getRawConnection() {
    return this.manager.getConnection();
  }

  // WHY: No redundant super overrides here. The base class (BaseDrizzleAdapter)
  // already exposes createEntities, getEntitiesByIds, updateEntity, createMemory,
  // getMemoryById, updateMemory, deleteMemory, createComponent, getComponent,
  // updateComponent, deleteComponent via inheritance. Overriding with just
  // `return super.method()` adds maintenance burden without changing behavior.
}
