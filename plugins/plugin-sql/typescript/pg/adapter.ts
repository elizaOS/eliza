import {
  type Agent,
  type Entity,
  logger,
  type Memory,
  type UUID,
} from "@elizaos/core";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { BaseDrizzleAdapter } from "../base";
import type { PostgresConnectionManager } from "./manager";

export class PgDatabaseAdapter extends BaseDrizzleAdapter {
  private manager: PostgresConnectionManager;

  constructor(
    agentId: UUID,
    manager: PostgresConnectionManager,
    _schema?: Record<string, unknown>,
  ) {
    super(agentId);
    this.manager = manager;
    this.db = manager.getDatabase();
  }

  getManager(): PostgresConnectionManager {
    return this.manager;
  }

  public async withIsolationContext<T>(
    entityId: UUID | null,
    callback: (tx: NodePgDatabase) => Promise<T>,
  ): Promise<T> {
    return await this.manager.withIsolationContext(entityId, callback);
  }

  async getEntityByIds(entityIds: UUID[]): Promise<Entity[] | null> {
    return this.getEntitiesByIds(entityIds);
  }

  async getMemoriesByServerId(_params: {
    serverId: UUID;
    count?: number;
  }): Promise<Memory[]> {
    logger.warn(
      { src: "plugin:sql" },
      "getMemoriesByServerId called but not implemented",
    );
    return [];
  }

  protected async withDatabase<T>(operation: () => Promise<T>): Promise<T> {
    return await this.withRetry(async () => {
      return await operation();
    });
  }

  async init(): Promise<void> {
    logger.debug({ src: "plugin:sql" }, "PgDatabaseAdapter initialized");
  }

  async isReady(): Promise<boolean> {
    return this.manager.testConnection();
  }

  async close(): Promise<void> {
    await this.manager.close();
  }

  async getConnection(): Promise<NodePgDatabase> {
    return this.db as NodePgDatabase;
  }

  getRawConnection() {
    return this.manager.getConnection();
  }

  // WHY no overrides: the old code had 12+ methods that just called super.
  // Inheritance already exposes them. The getEntitiesByIds override added
  // a redundant `|| []` that the base class already handles.
}
