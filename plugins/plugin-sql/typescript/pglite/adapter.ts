import { type Agent, type Entity, logger, type Memory, type UUID } from "@elizaos/core";
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
    this.db = drizzle(this.manager.getConnection());
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

  async getMemoriesByServerId(_params: { serverId: UUID; count?: number }): Promise<Memory[]> {
    logger.warn({ src: "plugin:sql" }, "getMemoriesByServerId called but not implemented");
    return [];
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
      logger.warn(
        { src: "plugin:sql", error: error.message },
        "Database operation rejected during shutdown"
      );
      throw error;
    }
    return operation();
  }

  async init(): Promise<void> {
    logger.debug({ src: "plugin:sql" }, "PGliteDatabaseAdapter initialized");
  }

  async isReady(): Promise<boolean> {
    return !this.manager.isShuttingDown();
  }

  async close() {
    await this.manager.close();
  }

  async getConnection(): Promise<PgliteDatabase> {
    return this.db as PgliteDatabase;
  }

  getRawConnection() {
    return this.manager.getConnection();
  }
}
