import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '@elizaos/core';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres, { type Sql } from 'postgres';
import type { IDatabaseClientManager } from '../types';

/**
 * Manages connections to a PostgreSQL database using postgres.js.
 * Implements IDatabaseClientManager interface for a postgres.js client.
 */
export class PostgresConnectionManager implements IDatabaseClientManager<Sql<{}>> {
  private pgClient: Sql<{}>;
  private isShuttingDown = false;
  private readonly connectionTimeout: number = 5000; // in ms
  private readonly pgConnectionString: string;

  /**
   * Constructor for creating a postgres.js client.
   * @param {string} connectionString - The connection string used to connect to the database.
   */
  constructor(connectionString: string) {
    this.pgConnectionString = connectionString;

    // Standard options for postgres.js
    // max: number of connections in the pool
    // idle_timeout: seconds before an idle connection is closed
    // connect_timeout: seconds before a connection attempt times out
    this.pgClient = postgres(this.pgConnectionString, {
      max: 20,
      idle_timeout: 30, // seconds
      connect_timeout: this.connectionTimeout / 1000, // seconds
      onnotice: (notice) => logger.debug('Postgres Notice:', notice),
    });

    this.setupSignalHandlers();
    // No immediate testConnection here, as postgres.js connects lazily.
    // We can add an explicit initialization step if needed, or test on first use.
    logger.info('PostgresConnectionManager initialized with postgres.js');
  }

  // The complex handlePoolError might not be directly applicable
  // as postgres.js manages its pool differently.
  // We rely on its internal resilience and the onerror callback for now.

  /**
   * Asynchronously tests the database connection by executing a simple query.
   * @returns {Promise<boolean>} - A Promise that resolves to true if the database connection test is successful.
   */
  async testConnection(): Promise<boolean> {
    try {
      const result = await this.pgClient`SELECT NOW()`;
      logger.success('Database connection test successful with postgres.js:', result[0]);
      return true;
    } catch (error) {
      logger.error('Database connection test failed with postgres.js:', error);
      throw new Error(
        `Failed to connect to database with postgres.js: ${(error as Error).message}`
      );
    }
  }

  /**
   * Sets up event listeners to handle pool cleanup on SIGINT, SIGTERM, and beforeExit events.
   */
  private setupSignalHandlers() {
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
   * Get the postgres.js client instance.
   * @returns {Sql<{}>} The postgres.js client instance.
   * @throws {Error} If the connection manager is shutting down.
   */
  public getConnection(): Sql<{}> {
    if (this.isShuttingDown) {
      throw new Error('Connection manager is shutting down');
    }
    return this.pgClient;
  }

  /**
   * getClient is not typically needed with postgres.js as the main client instance is used.
   * This method can be removed or adapted if specific single-connection operations are required
   * outside of Drizzle's transaction/query management.
   * For now, it will also return the main client.
   */
  public async getClient(): Promise<Sql<{}>> {
    if (this.isShuttingDown) {
      throw new Error('Connection manager is shutting down');
    }
    // postgres.js manages connections from its internal pool transparently.
    return this.pgClient;
  }

  /**
   * Initializes the PostgreSQL connection manager by testing the connection.
   * @returns {Promise<void>} A Promise that resolves once the manager is successfully initialized.
   * @throws {Error} If there is an error initializing the connection manager.
   */
  public async initialize(): Promise<void> {
    try {
      await this.testConnection();
      logger.debug('PostgreSQL connection manager (postgres.js) initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize connection manager (postgres.js):', error);
      throw error;
    }
  }

  /**
   * Closes the postgres.js client connection.
   * @returns A promise that resolves once the cleanup is complete.
   */
  public async close(): Promise<void> {
    await this.cleanup();
  }

  /**
   * Cleans up and closes the postgres.js client.
   * @returns {Promise<void>} A Promise that resolves when the client has ended.
   */
  async cleanup(): Promise<void> {
    if (this.isShuttingDown) {
      return;
    }
    this.isShuttingDown = true;
    try {
      await this.pgClient.end({ timeout: 5 }); // 5 seconds timeout for graceful shutdown
      logger.info('postgres.js client connections closed');
    } catch (error) {
      logger.error('Error closing postgres.js client:', error);
    }
  }

  /**
   * Asynchronously runs database migrations using Drizzle ORM with the postgres.js client.
   * @returns {Promise<void>} A Promise that resolves once the migrations are completed successfully.
   */
  async runMigrations(): Promise<void> {
    try {
      // Drizzle needs the postgres.js client instance directly
      const db = drizzle(this.pgClient);

      const packageJsonUrl = await import.meta.resolve('@elizaos/plugin-sql/package.json');
      const packageJsonPath = fileURLToPath(packageJsonUrl);
      const packageRoot = path.dirname(packageJsonPath);
      const migrationsPath = path.resolve(packageRoot, 'drizzle/migrations');
      logger.debug(
        `Resolved migrations path (pg with postgres.js) using import.meta.resolve: ${migrationsPath}`
      );

      await migrate(db, {
        migrationsFolder: migrationsPath,
        migrationsSchema: 'public', // Or your specific migrations schema
      });
      logger.success('Database migrations completed successfully with postgres.js');
    } catch (error) {
      logger.error('Failed to run database migrations (pg with postgres.js):', error);
      // Consider re-throwing or handling more specifically if migrations are critical for startup
    }
  }
}
