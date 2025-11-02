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
      logger.debug(`[RLS] Pool configured with application_name: ${rlsServerId.substring(0, 8)}...`);
    }

    this.pool = new Pool(poolConfig);
    this.db = drizzle(this.pool);
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
        `Failed to connect to the database: ${error instanceof Error ? error.message : String(error)}`
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
   * If Entity RLS is not installed (ENABLE_RLS_ISOLATION=false), this method
   * gracefully degrades to executing the callback without setting entity context.
   *
   * @param entityId - The entity UUID to set as context (or null for server operations)
   * @param callback - The database operations to execute with the entity context
   * @returns The result of the callback
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
          // Entity RLS not installed - continue without entity context (legacy mode)
          logger.debug(
            '[Entity Context] Entity RLS not enabled, executing without entity context (legacy mode)'
          );
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
