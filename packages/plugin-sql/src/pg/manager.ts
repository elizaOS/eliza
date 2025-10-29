import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool, type PoolClient, type PoolConfig } from 'pg';
import { logger } from '@elizaos/core';

export class PostgresConnectionManager {
  private pool: Pool;
  private db: NodePgDatabase;

  constructor(connectionString: string, rlsOwnerId?: string) {
    // If RLS is enabled, set application_name to the owner_id
    // This allows the RLS function current_owner_id() to read it
    const poolConfig: PoolConfig = { connectionString };

    if (rlsOwnerId) {
      poolConfig.application_name = rlsOwnerId;
      logger.debug(`[RLS] Pool configured with application_name: ${rlsOwnerId}`);
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
   * Closes the connection pool.
   * @returns {Promise<void>}
   * @memberof PostgresConnectionManager
   */
  public async close(): Promise<void> {
    await this.pool.end();
  }
}
