import { dirname as pathDirname, resolve as pathResolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite, type PGliteOptions } from '@electric-sql/pglite';
import { fuzzystrmatch } from '@electric-sql/pglite/contrib/fuzzystrmatch';
import { vector } from '@electric-sql/pglite/vector';
import { logger } from '@elizaos/core';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import type { IDatabaseClientManager } from '../types';

/**
 * Class representing a database client manager for PGlite.
 * @implements { IDatabaseClientManager }
 */
export class PGliteClientManager implements IDatabaseClientManager<PGlite> {
  private client: PGlite;
  private shuttingDown = false;
  private readonly shutdownTimeout = 500;

  /**
   * Constructor for creating a new instance of PGlite with the provided options.
   * Initializes the PGlite client with additional extensions.
   * @param {PGliteOptions} options - The options to configure the PGlite client.
   */
  constructor(options: PGliteOptions) {
    this.client = new PGlite({
      ...options,
      extensions: {
        vector,
        fuzzystrmatch,
      },
    });
    this.setupShutdownHandlers();
  }

  /**
   * Retrieves the PostgreSQL lite connection.
   *
   * @returns {PGlite} The PostgreSQL lite connection.
   * @throws {Error} If the client manager is currently shutting down.
   */
  public getConnection(): PGlite {
    if (this.shuttingDown) {
      throw new Error('Client manager is shutting down');
    }
    return this.client;
  }

  /**
   * Initiates a graceful shutdown of the PGlite client.
   * Checks if the client is already in the process of shutting down.
   * Logs the start of shutdown process and sets shuttingDown flag to true.
   * Sets a timeout for the shutdown process and forces closure of database connection if timeout is reached.
   * Handles the shutdown process, closes the client connection, clears the timeout, and logs the completion of shutdown.
   * Logs any errors that occur during the shutdown process.
   */
  private async gracefulShutdown() {
    if (this.shuttingDown) {
      return;
    }

    this.shuttingDown = true;
    logger.info('Starting graceful shutdown of PGlite client...');

    const timeout = setTimeout(() => {
      logger.warn('Shutdown timeout reached, forcing database connection closure...');
      this.client.close().finally(() => {
        process.exit(1);
      });
    }, this.shutdownTimeout);

    try {
      await this.client.close();
      clearTimeout(timeout);
      logger.info('PGlite client shutdown completed successfully');
      process.exit(0);
    } catch (error) {
      logger.error('Error during graceful shutdown:', error);
      process.exit(1);
    }
  }

  /**
   * Sets up shutdown handlers for SIGINT, SIGTERM, and beforeExit events to gracefully shutdown the application.
   * @private
   */
  private setupShutdownHandlers() {
    process.on('SIGINT', async () => {
      await this.gracefulShutdown();
    });

    process.on('SIGTERM', async () => {
      await this.gracefulShutdown();
    });

    process.on('beforeExit', async () => {
      await this.gracefulShutdown();
    });
  }

  /**
   * Initializes the client for PGlite.
   *
   * @returns {Promise<void>} A Promise that resolves when the client is initialized successfully
   */
  public async initialize(): Promise<void> {
    try {
      await this.client.waitReady;
      logger.info('PGlite client initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize PGlite client:', error);
      throw error;
    }
  }

  /**
   * Asynchronously closes the resource. If the resource is not already shutting down,
   * it performs a graceful shutdown before closing.
   *
   * @returns A promise that resolves once the resource has been closed.
   */
  public async close(): Promise<void> {
    if (!this.shuttingDown) {
      await this.gracefulShutdown();
    }
  }

  /**
   * Check if the system is currently shutting down.
   *
   * @returns {boolean} True if the system is shutting down, false otherwise.
   */
  public isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  /**
   * Asynchronously runs database migrations using Drizzle.
   *
   * Drizzle will first check if the migrations are already applied.
   * If there is a diff between database schema and migrations, it will apply the migrations.
   * If they are already applied, it will skip them.
   *
   * @returns {Promise<void>} A Promise that resolves once the migrations are completed successfully.
   */
  async runMigrations(): Promise<void> {
    try {
      const db = drizzle(this.client);

      const packageJsonUrl = await import.meta.resolve('@elizaos/plugin-sql/package.json');
      const packageJsonPath = fileURLToPath(packageJsonUrl);
      const packageRoot = pathDirname(packageJsonPath);
      const migrationsPath = pathResolve(packageRoot, 'drizzle/migrations');
      logger.debug(
        `Resolved migrations path (pglite) using import.meta.resolve: ${migrationsPath}`
      );

      await migrate(db, {
        migrationsFolder: migrationsPath,
        migrationsSchema: 'public',
      });
    } catch (error) {
      logger.error('Failed to run database migrations (pglite):', error);
    }
  }
}
