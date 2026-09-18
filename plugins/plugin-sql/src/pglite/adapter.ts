/** Local PGlite adapter. Mutations use the same transactional stores as PostgreSQL. */
import type { PGlite } from "@electric-sql/pglite";
import { type Agent, type Entity, logger, type Memory, type UUID } from "@elizaos/core";
import { sql } from "drizzle-orm";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { BaseDrizzleAdapter } from "../base";
import { DIMENSION_MAP, type EmbeddingDimensionColumn } from "../schema/embedding";
import type { PGliteClientManager, PgliteBoundedDataDirExport } from "./manager";

export class PgliteDatabaseAdapter extends BaseDrizzleAdapter {
  private manager: PGliteClientManager;
  protected embeddingDimension: EmbeddingDimensionColumn = DIMENSION_MAP[384];
  protected readonly databaseBackend = "pglite";

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
    };
    await managerWithInit.initialize();
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
    if (this.manager.isShuttingDown() || managerWithState.isInitialized() !== true) {
      return false;
    }
    try {
      await this.db.execute(sql`SELECT 1`);
      return true;
    } catch {
      // error-policy:J4 readiness probe returns explicit unavailable state
      return false;
    }
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

  getPgliteDataDir(): string | null {
    return this.manager.getDataDir();
  }

  async dumpPgliteDataDir(compression: "gzip" = "gzip"): Promise<File | Blob> {
    return await this.manager.dumpDataDir(compression);
  }

  async dumpPgliteDataDirAfterPreflight<T>(
    preflight: () => Promise<T>,
    compression: "gzip" = "gzip"
  ): Promise<PgliteBoundedDataDirExport<T>> {
    return await this.manager.dumpDataDirAfterPreflight(preflight, compression);
  }
}
