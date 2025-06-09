import { Pool, type PoolClient } from 'pg';
import { logger } from '@elizaos/core';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';

export class PostgresConnectionManager {
  private pool: Pool;
  private db: NodePgDatabase;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
    this.db = drizzle(this.pool);
  }

  public getConnection(): Pool {
    return this.pool;
  }

  public async getClient(): Promise<PoolClient> {
    return this.pool.connect();
  }

  public async runMigrations(migrationsFolder = './drizzle'): Promise<void> {
    try {
      await migrate(this.db, { migrationsFolder });
      logger.info('Migrations ran successfully.');
    } catch (error) {
      logger.error('Failed to run migrations:', error);
      throw error;
    }
  }

  public async testConnection(): Promise<boolean> {
    try {
      const client = await this.pool.connect();
      await client.query('SELECT 1');
      client.release();
      return true;
    } catch (error) {
      logger.error('Failed to connect to the database:', error);
      return false;
    }
  }

  public async close(): Promise<void> {
    await this.pool.end();
  }
}
