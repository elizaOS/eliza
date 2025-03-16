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
  private isShuttingDown = false;
  private readonly connectionTimeout: number = 5000;

  /**
   * Constructor for creating a connection pool.
   * @param {string} connectionString - The connection string used to connect to the database.
   */
  constructor(connectionString: string) {
    const defaultConfig = {
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: this.connectionTimeout,
    };

    this.pool = new Pool({
      ...defaultConfig,
      connectionString,
    });

    this.pool.on('error', (err) => {
      logger.error('Unexpected pool error', err);
      this.handlePoolError(err);
    });

    this.setupPoolErrorHandling();
    this.testConnection();
  }

  /**
   * Handles a pool error by attempting to reconnect the pool.
   *
   * @param {Error} error The error that occurred in the pool.
   * @throws {Error} If failed to reconnect the pool.
   */
  private async handlePoolError(error: Error) {
    logger.error('Pool error occurred, attempting to reconnect', {
      error: error.message,
    });

    try {
      await this.pool.end();

      this.pool = new Pool({
        ...this.pool.options,
        connectionTimeoutMillis: this.connectionTimeout,
      });

      await this.testConnection();
      logger.success('Pool reconnection successful');
    } catch (reconnectError) {
      logger.error('Failed to reconnect pool', {
        error: reconnectError instanceof Error ? reconnectError.message : String(reconnectError),
      });
      throw reconnectError;
    }
  }

  /**
   * Asynchronously tests the database connection by executing a query to get the current timestamp.
   *
   * @returns {Promise<boolean>} - A Promise that resolves to true if the database connection test is successful.
   */
  async testConnection(): Promise<boolean> {
    let client: pkg.PoolClient | null = null;
    try {
      client = await this.pool.connect();
      const result = await client.query('SELECT NOW()');
      logger.success('Database connection test successful:', result.rows[0]);
      return true;
    } catch (error) {
      logger.error('Database connection test failed:', error);
      throw new Error(`Failed to connect to database: ${(error as Error).message}`);
    } finally {
      if (client) client.release();
    }
  }

  /**
   * Sets up event listeners to handle pool cleanup on SIGINT, SIGTERM, and beforeExit events.
   */
  private setupPoolErrorHandling() {
    process.on('SIGINT', async () => {
      await this.cleanup();
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      await this.cleanup();
      process.exit(0);
    });

    process.on('beforeExit', async () => {
      await this.cleanup();
    });
  }

  /**
   * Get the connection pool.
   * @returns {PgPool} The connection pool
   * @throws {Error} If the connection manager is shutting down or an error occurs when trying to get the connection from the pool
   */
  public getConnection(): PgPool {
    if (this.isShuttingDown) {
      throw new Error('Connection manager is shutting down');
    }

    try {
      return this.pool;
    } catch (error) {
      logger.error('Failed to get connection from pool:', error);
      throw error;
    }
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
   * Initializes the PostgreSQL connection manager by testing the connection and logging the result.
   *
   * @returns {Promise<void>} A Promise that resolves once the manager is successfully initialized
   * @throws {Error} If there is an error initializing the connection manager
   */
  public async initialize(): Promise<void> {
    try {
      await this.testConnection();
      logger.info('PostgreSQL connection manager initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize connection manager:', error);
      throw error;
    }
  }

  /**
   * Asynchronously close the current process by executing a cleanup function.
   * @returns A promise that resolves once the cleanup is complete.
   */
  public async close(): Promise<void> {
    await this.cleanup();
  }

  /**
   * Cleans up and closes the database pool.
   * @returns {Promise<void>} A Promise that resolves when the database pool is closed.
   */
  async cleanup(): Promise<void> {
    try {
      await this.pool.end();
      logger.info('Database pool closed');
    } catch (error) {
      logger.error('Error closing database pool:', error);
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

      const __filename = fileURLToPath(import.meta.url);
      const __dirname = path.dirname(__filename);

      await migrate(db, {
        migrationsFolder: path.resolve(__dirname, '../drizzle/migrations'),
      });
    } catch (error) {
      logger.error('Failed to run database migrations (pg):', error);
      console.trace(error);
    }
  }
}
