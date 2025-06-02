import { dirname as pathDirname, resolve as pathResolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite, type PGliteOptions } from '@electric-sql/pglite';
import { PGliteWorker } from '@electric-sql/pglite/worker';
import { logger } from '@elizaos/core';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import type { IDatabaseClientManager } from '../types';

/**
 * Class representing a database client manager for PGlite.
 * Uses PGliteWorker for multi-tab support and improved robustness.
 * @implements { IDatabaseClientManager }
 */
export class PGliteClientManager implements IDatabaseClientManager<PGlite | PGliteWorker> {
  private client: PGlite | PGliteWorker | null = null;
  private shuttingDown = false;
  private readonly shutdownTimeout = 5000; // Increased timeout for worker shutdown
  private isWorkerEnvironment: boolean;
  private readonly options: PGliteOptions;

  /**
   * Constructor for creating a new PGlite manager instance.
   * Detects environment and uses appropriate PGlite implementation.
   * @param {PGliteOptions} options - The options to configure the PGlite client.
   */
  constructor(options: PGliteOptions) {
    this.options = options;
    // Detect if we're in a browser environment that supports workers
    this.isWorkerEnvironment = typeof window !== 'undefined' && typeof Worker !== 'undefined';
    this.setupShutdownHandlers();
  }

  /**
   * Initializes the appropriate PGlite client based on environment.
   * Uses PgliteWorker in browser environments for multi-tab support.
   */
  private async initializeClient(): Promise<void> {
    if (this.client && !this.shuttingDown) {
      return; // Client already initialized
    }

    try {
      if (this.isWorkerEnvironment) {
        // Browser environment: Use PgliteWorker for multi-tab support
        logger.info('Initializing PgliteWorker for browser environment');

        // Create worker URL dynamically
        const workerUrl = new URL('./pglite.worker.js', import.meta.url);

        this.client = new PGliteWorker(new Worker(workerUrl, { type: 'module' }), {
          dataDir: this.options.dataDir,
          // Generate a unique ID based on dataDir to group workers
          id: `pglite-${this.options.dataDir?.replace(/[^a-zA-Z0-9]/g, '-')}`,
          // Pass additional options via meta
          meta: {
            relaxedDurability: this.options.relaxedDurability,
          },
        });

        // Wait for the worker to be ready
        await (this.client as PGliteWorker).waitReady;

        logger.info('PgliteWorker initialized successfully', {
          isLeader: (this.client as PGliteWorker).isLeader,
        });
      } else {
        // Node.js/Bun environment: Use regular PGlite
        logger.info('Initializing PGlite for Node.js environment');

        // Check if extensions should be disabled (useful for testing environments)
        const disableExtensions = process.env.DISABLE_PGLITE_EXTENSIONS === 'true';

        if (disableExtensions) {
          logger.info(
            'PGlite extensions disabled via DISABLE_PGLITE_EXTENSIONS environment variable, forcing in-memory database for this PGlite instance.'
          );

          this.client = new PGlite({
            // Force memory mode when extensions are disabled to avoid filesystem issues in tests
            dataDir: 'memory://',
            relaxedDurability: this.options.relaxedDurability, // Still respect relaxedDurability if set
          });
        } else {
          // Standard Node.js/Bun environment: Use regular PGlite with provided dataDir or default
          logger.info('Initializing PGlite for Node.js environment with extensions enabled.');
          try {
            const { fuzzystrmatch } = await import('@electric-sql/pglite/contrib/fuzzystrmatch');
            const { vector } = await import('@electric-sql/pglite/vector');

            this.client = new PGlite({
              ...this.options, // This will include dataDir if provided by the caller
              extensions: {
                vector,
                fuzzystrmatch,
              },
            });
          } catch (extensionError) {
            // Fallback: Initialize without extensions if they fail to load
            logger.warn(
              'Failed to load PGlite extensions, initializing without them:',
              extensionError
            );
            logger.warn('This may happen when running tests from different package contexts');

            this.client = new PGlite({
              ...this.options,
            });
          }
        }

        await this.client.waitReady;
        logger.info('PGlite initialized successfully');
      }
    } catch (error) {
      logger.error('Failed to initialize PGlite client:', error);
      this.client = null;
      throw error;
    }
  }

  /**
   * Retrieves the PGlite connection, initializing if necessary.
   *
   * @returns {PGlite | PGliteWorker} The PGlite connection.
   * @throws {Error} If the client manager is currently shutting down.
   */
  public getConnection(): PGlite | PGliteWorker {
    if (this.shuttingDown) {
      throw new Error('Client manager is shutting down');
    }

    if (!this.client) {
      throw new Error('PGlite client not initialized. Call initialize() first.');
    }

    return this.client;
  }

  /**
   * Initiates a graceful shutdown of the PGlite client.
   * Handles both regular PGlite and PgliteWorker instances.
   */
  private async gracefulShutdown() {
    if (this.shuttingDown || !this.client) {
      return;
    }

    this.shuttingDown = true;
    logger.info('Starting graceful shutdown of PGlite client...');

    const timeout = setTimeout(() => {
      logger.warn('Shutdown timeout reached, forcing closure...');
      this.client = null;
      if (process.env.NODE_ENV !== 'test') {
        process.exit(1);
      }
    }, this.shutdownTimeout);

    try {
      if (this.client) {
        await this.client.close();
        this.client = null;
      }

      clearTimeout(timeout);
      logger.info('PGlite client shutdown completed successfully');

      if (process.env.NODE_ENV !== 'test') {
        process.exit(0);
      }
    } catch (error) {
      logger.error('Error during graceful shutdown:', error);
      clearTimeout(timeout);

      if (process.env.NODE_ENV !== 'test') {
        process.exit(1);
      } else {
        throw error;
      }
    }
  }

  /**
   * Sets up shutdown handlers for SIGINT, SIGTERM, and beforeExit events.
   * @private
   */
  private setupShutdownHandlers() {
    // Only set up process handlers in Node.js environment
    if (typeof process !== 'undefined' && typeof process.on === 'function') {
      const shutdownHandler = async () => {
        await this.gracefulShutdown();
      };

      process.once('SIGINT', shutdownHandler);
      process.once('SIGTERM', shutdownHandler);
      process.once('beforeExit', shutdownHandler);
    }

    // Browser environment: clean up on page unload
    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', () => {
        if (this.client && !this.shuttingDown) {
          this.shuttingDown = true;
          // Note: We can't await in beforeunload
          this.client.close().catch((error) => {
            console.error('Error closing PGlite on page unload:', error);
          });
        }
      });
    }
  }

  /**
   * Initializes the client for PGlite.
   *
   * @returns {Promise<void>} A Promise that resolves when the client is initialized successfully
   */
  public async initialize(): Promise<void> {
    await this.initializeClient();
  }

  /**
   * Asynchronously closes the resource.
   *
   * @returns A promise that resolves once the resource has been closed.
   */
  public async close(): Promise<void> {
    await this.gracefulShutdown();
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
   * @returns {Promise<void>} A Promise that resolves once the migrations are completed successfully.
   */
  async runMigrations(): Promise<void> {
    try {
      if (!this.client) {
        await this.initializeClient();
      }

      // Cast to PGlite for drizzle compatibility (PgliteWorker has same interface)
      const db = drizzle(this.client as PGlite);

      const packageJsonUrl = await import.meta.resolve('@elizaos/plugin-sql/package.json');
      const packageJsonPath = fileURLToPath(packageJsonUrl);
      const packageRoot = pathDirname(packageJsonPath);
      const migrationsPath = pathResolve(packageRoot, 'drizzle/migrations');

      logger.debug(`Resolved migrations path: ${migrationsPath}`);

      await migrate(db, {
        migrationsFolder: migrationsPath,
        migrationsSchema: 'public',
      });

      logger.success('Database migrations completed successfully');
    } catch (error) {
      logger.error('Failed to run database migrations:', error);
      throw error;
    }
  }
}
