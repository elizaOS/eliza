import { logger, type UUID, validateUuid } from "@elizaos/core";
import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool, type PoolClient, type PoolConfig } from "pg";

export class PostgresConnectionManager {
  private pool: Pool;
  private db: NodePgDatabase;

  constructor(connectionString: string, rlsServerId?: string) {
    const poolConfig: PoolConfig = {
      connectionString,
      max: 20,
      min: 2,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
      keepAlive: true,
      keepAliveInitialDelayMillis: 10000,
    };

    if (rlsServerId) {
      poolConfig.application_name = rlsServerId;
      logger.debug(
        { src: "plugin:sql", rlsServerId: rlsServerId.substring(0, 8) },
        "Pool configured with RLS server"
      );
    }

    this.pool = new Pool(poolConfig);

    this.pool.on("error", (err) => {
      logger.warn(
        { src: "plugin:sql", error: err?.message || String(err) },
        "Pool client error (connection will be replaced)"
      );
    });

    this.db = drizzle(this.pool, { casing: "snake_case" });
  }

  public getDatabase(): NodePgDatabase {
    return this.db;
  }

  public getConnection(): Pool {
    return this.pool;
  }

  public async getClient(): Promise<PoolClient> {
    return this.pool.connect();
  }

  public async testConnection(): Promise<boolean> {
    let client: PoolClient | null = null;
    try {
      client = await this.pool.connect();
      await client.query("SELECT 1");
      return true;
    } catch (error) {
      logger.error(
        {
          src: "plugin:sql",
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to connect to the database"
      );
      return false;
    } finally {
      if (client) {
        client.release();
      }
    }
  }

  public async withEntityContext<T>(
    entityId: UUID | null,
    callback: (tx: NodePgDatabase) => Promise<T>
  ): Promise<T> {
    const dataIsolationEnabled = process.env.ENABLE_DATA_ISOLATION === "true";

    return await this.db.transaction(async (tx) => {
      if (dataIsolationEnabled && entityId) {
        if (!validateUuid(entityId)) {
          throw new Error(`Invalid UUID format for entity context: ${entityId}`);
        }

        try {
          await tx.execute(sql.raw(`SET LOCAL app.entity_id = '${entityId}'`));
          logger.debug(`[Entity Context] Set app.entity_id = ${entityId}`);
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          logger.error(
            { error, entityId },
            `[Entity Context] Failed to set entity context: ${errorMessage}`
          );
          throw error;
        }
      } else if (!dataIsolationEnabled) {
      } else {
        logger.debug("[Entity Context] No entity context set (server operation)");
      }

      return await callback(tx);
    });
  }

  public async close(): Promise<void> {
    await this.pool.end();
  }
}
