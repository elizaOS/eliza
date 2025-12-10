import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool, type PoolClient, type PoolConfig } from 'pg';
import { sql } from 'drizzle-orm';
import { logger, type UUID } from '@elizaos/core';

export class PostgresConnectionManager {
  private pool: Pool;
  private db: NodePgDatabase;

  constructor(connectionString: string, rlsServerId?: string) {
    // If RLS is enabled, set application_name to the server_id
    // This allows the RLS function current_server_id() to read it
    const poolConfig: PoolConfig = { connectionString };

    if (rlsServerId) {
      poolConfig.application_name = rlsServerId;
      logger.debug(
        { src: 'plugin:sql', rlsServerId: rlsServerId.substring(0, 8) },
        'Pool configured with RLS server'
      );
    }

    this.pool = new Pool(poolConfig);
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
   * If Entity RLS is not installed (ENABLE_DATA_ISOLATION=false), this method
   * gracefully degrades to executing the callback without setting entity context.
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
    return await this.db.transaction(async (tx) => {
      // Set entity context for this transaction (if Entity RLS is enabled)
      if (entityId) {
        try {
          // Try to set entity context - will fail gracefully if Entity RLS not installed
          await tx.execute(sql`SET LOCAL app.entity_id = ${entityId}`);
          logger.debug(`[Entity Context] Set app.entity_id = ${entityId}`);
        } catch (error) {
          // Distinguish between "Entity RLS not installed" vs "critical error"
          const errorMessage = error instanceof Error ? error.message : String(error);

          // Check if this is just Entity RLS not being installed (expected when ENABLE_DATA_ISOLATION=false)
          if (
            errorMessage.includes('unrecognized configuration parameter') ||
            errorMessage.includes('app.entity_id')
          ) {
            // This is expected when Entity RLS is not enabled - continue without entity context
            logger.debug(
              '[Entity Context] Entity RLS not enabled, executing without entity context'
            );
          } else {
            // This is an unexpected error - log it with higher severity
            logger.error(
              { error, entityId },
              '[Entity Context] Critical error setting entity context - this may indicate a configuration issue'
            );
            // Don't throw - allow degraded operation, but the error is now visible
            logger.warn(
              '[Entity Context] Continuing without entity context due to error - data isolation may be compromised'
            );
          }
        }
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
