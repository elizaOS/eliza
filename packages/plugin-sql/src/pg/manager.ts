import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool, type PoolClient } from 'pg';
import { logger } from '@elizaos/core';
import { DatabaseErrorHandler } from '../db-error-handler';

export class PostgresConnectionManager {
  private pool: Pool;
  private db: NodePgDatabase;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
    this.db = drizzle(this.pool as any);
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
      logger.error('Failed to connect to the database:', error);
      return false;
    } finally {
      if (client) {
        client.release();
      }
    }
  }

  /**
   * Validates the database connection and provides clear error messages for common issues
   * @throws {Error} With specific error message for connection/authentication issues
   */
  public async validateConnection(): Promise<void> {
    await DatabaseErrorHandler.validateConnection(async () => {
      const client = await this.pool.connect();
      try {
        await client.query('SELECT 1');
      } finally {
        client.release();
      }
    }, 'during connection validation');
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
