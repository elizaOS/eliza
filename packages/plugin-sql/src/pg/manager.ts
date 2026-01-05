import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool, type PoolClient, type PoolConfig } from 'pg';
import { sql } from 'drizzle-orm';
import { logger, type UUID } from '@elizaos/core';

export class PostgresConnectionManager {
  private pool: Pool;
  private db: NodePgDatabase;

  constructor(connectionString: string, rlsServerId?: string) {
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

    // If RLS is enabled, set application_name to the server_id
    // This allows the RLS function current_server_id() to read it
    if (rlsServerId) {
      poolConfig.application_name = rlsServerId;
      logger.debug(
        { src: 'plugin:sql', rlsServerId: rlsServerId.substring(0, 8) },
        'Pool configured with RLS server'
      );
    }

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
   * Execute a query with entity context for Entity RLS.
   * Sets app.entity_id before executing the callback.
   *
   * Server RLS context (if enabled) is already set via Pool's application_name.
   *
   * If ENABLE_DATA_ISOLATION is not true, this method skips setting entity context
   * entirely to avoid PostgreSQL errors that would abort the transaction.
   *
   * @param entityId - The entity UUID to set as context (or null for server operations)
   * @param callback - The database operations to execute with the entity context
   * @returns The result of the callback
   * @throws {Error} If the callback fails or if there's a critical Entity RLS configuration issue
   */
  public async withEntityContext<T>(
    entityId: UUID | null,
    callback: (tx: NodePgDatabase) => Promise<T>
  ): Promise<T> {
    // Check if data isolation is enabled - if not, skip SET LOCAL entirely
    // This avoids PostgreSQL transaction abort errors when app.entity_id is not configured
    const dataIsolationEnabled = process.env.ENABLE_DATA_ISOLATION === 'true';

    return await this.db.transaction(async (tx) => {
      // Only set entity context if ENABLE_DATA_ISOLATION is true AND entityId is provided
      if (dataIsolationEnabled && entityId) {
        try {
          // SET LOCAL does not support parameterized queries, so we must use sql.raw()
          await tx.execute(sql.raw(`SET LOCAL app.entity_id = '${entityId}'`));
          logger.debug(`[Entity Context] Set app.entity_id = ${entityId}`);
        } catch (error) {
          // This is an unexpected error since we already checked ENABLE_DATA_ISOLATION
          const errorMessage = error instanceof Error ? error.message : String(error);
          logger.error(
            { error, entityId },
            `[Entity Context] Failed to set entity context: ${errorMessage}`
          );
          // Re-throw because if ENABLE_DATA_ISOLATION is true, this should work
          throw error;
        }
      } else if (!dataIsolationEnabled) {
        // Data isolation not enabled - just execute without entity context
        // This is the expected path for most deployments
      } else {
        logger.debug('[Entity Context] No entity context set (server operation)');
      }

      // Execute the callback with the transaction
      return await callback(tx);
    });
  }

  /**
   * Closes the connection pool.
   * @returns {Promise<void>}
   * @memberof PostgresConnectionManager
   */
  public async close(): Promise<void> {
    await this.pool.end();
  }
}
