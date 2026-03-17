import { type Entity, logger, type Memory, type UUID } from "@elizaos/core";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { BaseDrizzleAdapter } from "../base";
import type { DrizzleDatabase } from "../types";
import type { PGliteClientManager } from "./manager";

export class PgliteDatabaseAdapter extends BaseDrizzleAdapter {
  private manager: PGliteClientManager;

  constructor(agentId: UUID, manager: PGliteClientManager) {
    super(agentId);
    this.manager = manager;
    this.db = drizzle(this.manager.getConnection());
  }

  // WHY no transaction: PGLite doesn't use RLS (entityId is ignored).
  // The old code opened a transaction on every call for snapshot isolation
  // overhead that provided no benefit. Pass db directly.
  public async withIsolationContext<T>(
    _entityId: UUID | null,
    callback: (tx: DrizzleDatabase) => Promise<T>
  ): Promise<T> {
    return callback(this.db as DrizzleDatabase);
  }

  async getEntityByIds(entityIds: UUID[]): Promise<Entity[] | null> {
    return this.getEntitiesByIds(entityIds);
  }

  async getMemoriesByServerId(_params: { serverId: UUID; count?: number }): Promise<Memory[]> {
    logger.warn({ src: "plugin:sql" }, "getMemoriesByServerId called but not implemented");
    return [];
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
