import { logger, type UUID, validateUuid } from "@elizaos/core";
import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool, type PoolClient, type PoolConfig } from "pg";

export class PostgresConnectionManager {
  private pool: Pool;
  private db: NodePgDatabase;
  private readonly rlsServerId?: string;

  constructor(connectionString: string, rlsServerId?: string) {
    this.rlsServerId = rlsServerId;

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
      logger.debug(
        { src: "plugin:sql", rlsServerId: rlsServerId.substring(0, 8) },
        "Pool configured with RLS server",
      );
    }

    this.pool = new Pool(poolConfig);

    this.pool.on("error", (err) => {
      logger.warn(
        { src: "plugin:sql", error: err?.message || String(err) },
        "Pool client error (connection will be replaced)",
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
        "Failed to connect to the database",
      );
      return false;
    } finally {
      if (client) {
        client.release();
      }
    }
  }

  /**
   * Execute a query with full isolation context (Server RLS + Entity RLS).
   * Uses set_config() with parameterized queries for SQL injection protection.
   */
  public async withIsolationContext<T>(
    entityId: UUID | null,
    callback: (tx: NodePgDatabase) => Promise<T>,
  ): Promise<T> {
    const dataIsolationEnabled = process.env.ENABLE_DATA_ISOLATION === "true";

    return await this.db.transaction(async (tx) => {
      if (dataIsolationEnabled) {
        if (this.rlsServerId) {
          await tx.execute(
            sql`SELECT set_config('app.server_id', ${this.rlsServerId}, true)`,
          );
        }

        if (entityId) {
          if (!validateUuid(entityId)) {
            throw new Error(
              `Invalid UUID format for entity context: ${entityId}`,
            );
          }
          await tx.execute(
            sql`SELECT set_config('app.entity_id', ${entityId}, true)`,
          );
        }
      }

      return await callback(tx);
    });
  }

  public async close(): Promise<void> {
    await this.pool.end();
  }
}
