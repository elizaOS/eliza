import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '@elizaos/core';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pkg, { type Pool as PgPool } from 'pg';
import type { IDatabaseClientManager } from '../types';

const { Pool } = pkg;

/**
 * Manages connections to a PostgreSQL database using a connection pool.
 * Implements IDatabaseClientManager interface.
 */
export class PostgresConnectionManager implements IDatabaseClientManager<PgPool> {
  private pool: PgPool;

  /**
   * Constructor for creating a connection pool.
   * @param {string} connectionString - The connection string used to connect to the database.
   */
  constructor(connectionString: string) {
    // Use minimal configuration to avoid conflicts with Supabase pooling
    this.pool = new Pool({
      connectionString,
      // Let pg use its defaults for most settings
      // Supabase will handle pooling through pgBouncer
    });

    // Simple error logging without automatic reconnection
    this.pool.on('error', (err) => {
      logger.error('PostgreSQL pool error:', err);
    });
  }

  /**
   * Get the connection pool.
   * @returns {PgPool} The connection pool
   */
  public getConnection(): PgPool {
    return this.pool;
  }

  /**
   * Asynchronously acquires a database client from the connection pool.
   *
   * @returns {Promise<pkg.PoolClient>} A Promise that resolves with the acquired database client.
   * @throws {Error} If an error occurs while acquiring the database client.
   */
  public async getClient(): Promise<pkg.PoolClient> {
    try {
      return await this.pool.connect();
    } catch (error) {
      logger.error('Failed to acquire a database client:', error);
      throw error;
    }
  }

  /**
   * Initializes the PostgreSQL connection manager.
   *
   * @returns {Promise<void>} A Promise that resolves once the manager is successfully initialized
   * @throws {Error} If there is an error initializing the connection manager
   */
  public async initialize(): Promise<void> {
    try {
      // Simple connection test without storing the client
      const client = await this.pool.connect();
      await client.query('SELECT 1');
      client.release();
      logger.debug('PostgreSQL connection manager initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize PostgreSQL connection:', error);
      throw error;
    }
  }

  /**
   * Asynchronously close the connection pool.
   * @returns A promise that resolves once the pool is closed.
   */
  public async close(): Promise<void> {
    try {
      await this.pool.end();
      logger.info('PostgreSQL connection pool closed');
    } catch (error) {
      logger.error('Error closing PostgreSQL pool:', error);
    }
  }

  /**
   * Asynchronously runs database migrations using the Drizzle library.
   *
   * Drizzle will first check if the migrations are already applied.
   * If there is a diff between database schema and migrations, it will apply the migrations.
   * If they are already applied, it will skip them.
   *
   * @returns {Promise<void>} A Promise that resolves once the migrations are completed successfully.
   */
  async runMigrations(): Promise<void> {
    try {
      const db = drizzle(this.pool);

      const packageJsonUrl = await import.meta.resolve('@elizaos/plugin-sql/package.json');
      const packageJsonPath = fileURLToPath(packageJsonUrl);
      const packageRoot = path.dirname(packageJsonPath);
      const migrationsPath = path.resolve(packageRoot, 'drizzle/migrations');
      logger.debug(`Resolved migrations path (pg) using import.meta.resolve: ${migrationsPath}`);

      await migrate(db, {
        migrationsFolder: migrationsPath,
        migrationsSchema: 'public',
      });
    } catch (error) {
      logger.error('Failed to run database migrations (pg):', error);
    }
  }
}
