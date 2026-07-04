/**
 * `PostgresConnectionManager` wraps a single `pg` `Pool` (env-tunable size,
 * SSL mode normalized) behind the shared connection-manager surface used by
 * `PgDatabaseAdapter`: exposes the pool and a Drizzle handle, tracks
 * shutdown state so in-flight and new work is rejected during `close()`,
 * and runs callbacks inside a transaction that sets the Row Level Security
 * `app.entity_id` config when data isolation is enabled.
 */
import { logger, type UUID, validateUuid } from "@elizaos/core";
import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool, type PoolClient, type PoolConfig } from "pg";
import { normalizePgSslMode } from "./sslmode";

export class PostgresConnectionManager {
  private pool: Pool;
  private db: NodePgDatabase;
  private closePromise: Promise<void> | null = null;
  private shuttingDown = false;

  constructor(connectionString: string, rlsServerId?: string) {
    // Pool sizing is env-tunable so multi-tenant deployments (e.g. Eliza Cloud,
    // where many agent containers share one Postgres) can run lean pools and not
    // exhaust the server's max_connections. Defaults preserve the original
    // single-agent behavior (max 20 / min 2). Set POSTGRES_POOL_MIN=0 so idle
    // agents release every connection; a small POSTGRES_POOL_MAX caps bursts.
    const envInt = (key: string, fallback: number): number => {
      const raw = process.env[key];
      if (raw === undefined || raw === "") return fallback;
      const n = Number(raw);
      return Number.isFinite(n) && n >= 0 ? n : fallback;
    };
    const poolConfig: PoolConfig = {
      connectionString: normalizePgSslMode(connectionString),
      max: envInt("POSTGRES_POOL_MAX", 20),
      min: envInt("POSTGRES_POOL_MIN", 2),
      idleTimeoutMillis: envInt("POSTGRES_POOL_IDLE_TIMEOUT_MS", 30000),
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
        { src: "plugin:sql", error: err.message || String(err) },
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

  public isShuttingDown(): boolean {
    return this.shuttingDown || this.pool.ending || this.pool.ended;
  }

  public async getClient(): Promise<PoolClient> {
    if (this.isShuttingDown()) {
      throw new Error("Database pool is shutting down - client acquisition rejected");
    }

    return this.pool.connect();
  }

  public async testConnection(): Promise<boolean> {
    let client: PoolClient | null = null;
    try {
      if (this.isShuttingDown()) {
        return false;
      }

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
    if (this.isShuttingDown()) {
      throw new Error("Database pool is shutting down - operation rejected");
    }

    const dataIsolationEnabled = process.env.ENABLE_DATA_ISOLATION === "true";

    return await this.db.transaction(async (tx) => {
      if (dataIsolationEnabled && entityId) {
        if (!validateUuid(entityId)) {
          throw new Error(`Invalid UUID format for entity context: ${entityId}`);
        }

        try {
          // Use parameterized set_config() (transaction-scoped via is_local=true)
          // instead of string-interpolated SET LOCAL, matching the Neon adapter.
          // SET LOCAL cannot take a bind parameter; set_config() can, removing
          // the only interpolated SQL in the RLS path.
          await tx.execute(sql`SELECT set_config('app.entity_id', ${entityId}, true)`);
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
    if (this.closePromise) {
      return this.closePromise;
    }

    this.shuttingDown = true;
    if (this.pool.ended) {
      return;
    }

    this.closePromise = this.pool.end().finally(() => {
      this.shuttingDown = true;
    });

    return this.closePromise;
  }
}
