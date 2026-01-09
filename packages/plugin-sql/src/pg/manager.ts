import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool, type PoolClient, type PoolConfig } from 'pg';
import { sql } from 'drizzle-orm';
import { logger, type UUID, validateUuid } from '@elizaos/core';

export class PostgresConnectionManager {
  private pool: Pool;
  private db: NodePgDatabase;
  private _closed = false;
  private readonly connectionString: string;
  private readonly rlsServerId?: string;

  constructor(connectionString: string, rlsServerId?: string) {
    this.connectionString = connectionString;
    this.rlsServerId = rlsServerId;
    // Production-optimized pool configuration
    // See: https://node-postgres.com/apis/pool
    const poolConfig: PoolConfig = {
      connectionString,

      // Pool sizing - conservative defaults suitable for most deployments
      // For multi-instance deployments, ensure: max * instances < database connection limit
      max: 20,
      min: 2,

      // Timeouts
      // CRITICAL: connectionTimeoutMillis defaults to 0 (infinite) which can hang forever
      idleTimeoutMillis: 30000, // 30s - balance between cleanup and reconnection overhead
      connectionTimeoutMillis: 5000, // 5s - prevents indefinite hangs if DB is unreachable

      // Connection health - essential for cloud environments (Railway, AWS, Heroku, etc.)
      // Cloud load balancers/firewalls often terminate idle connections silently
      keepAlive: true,
      keepAliveInitialDelayMillis: 10000,
    };

    this.pool = new Pool(poolConfig);

    // CRITICAL: Handle pool errors to prevent Node.js process crashes
    // When an idle client encounters an error (DB restart, network partition, etc.),
    // the pool emits 'error'. Without a handler, this crashes the process.
    // The pool automatically removes and replaces the failed connection.
    this.pool.on('error', (err) => {
      logger.warn(
        { src: 'plugin:sql', error: err?.message || String(err) },
        'Pool client error (connection will be replaced)'
      );
    });

    this.db = drizzle(this.pool, { casing: 'snake_case' });
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
      await client.query('SELECT 1');
      return true;
    } catch (error) {
      logger.error(
        { src: 'plugin:sql', error: error instanceof Error ? error.message : String(error) },
        'Failed to connect to the database'
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
   * Uses set_config() with parameterized queries for proper SQL injection protection.
   */
  public async withIsolationContext<T>(
    entityId: UUID | null,
    callback: (tx: NodePgDatabase) => Promise<T>
  ): Promise<T> {
    const dataIsolationEnabled = process.env.ENABLE_DATA_ISOLATION === 'true';

    return await this.db.transaction(async (tx) => {
      if (dataIsolationEnabled) {
        // Set server context (Server RLS) using parameterized set_config()
        if (this.rlsServerId) {
          await tx.execute(sql`SELECT set_config('app.server_id', ${this.rlsServerId}, true)`);
        }

        // Set entity context (Entity RLS) using parameterized set_config()
        if (entityId) {
          if (!validateUuid(entityId)) {
            throw new Error(`Invalid UUID format for entity context: ${entityId}`);
          }
          await tx.execute(sql`SELECT set_config('app.entity_id', ${entityId}, true)`);
        }
      }

      return await callback(tx);
    });
  }

  /**
   * Closes the connection pool.
   * After calling close(), the manager is unusable and isClosed() returns true.
   * The singleton pattern in index.node.ts will detect this and recreate the manager.
   * @returns {Promise<void>}
   * @memberof PostgresConnectionManager
   */
  public async close(): Promise<void> {
    if (this._closed) return;
    this._closed = true;
    await this.pool.end();
  }

  /**
   * Check if the connection pool has been closed.
   * Used by the singleton pattern to detect stale managers after close().
   */
  public isClosed(): boolean {
    return this._closed;
  }

  /**
   * Get the connection string for this manager.
   * Used when recreating a manager after it was closed.
   */
  public getConnectionString(): string {
    return this.connectionString;
  }

  /**
   * Get the RLS server ID for this manager.
   * Used when recreating a manager after it was closed.
   */
  public getRlsServerId(): string | undefined {
    return this.rlsServerId;
  }
}
