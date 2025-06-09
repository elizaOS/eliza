import { PGlite, type PGliteOptions } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { fuzzystrmatch } from '@electric-sql/pglite/contrib/fuzzystrmatch';
import { logger } from '@elizaos/core';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { dirname as pathDirname, resolve as pathResolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IDatabaseClientManager } from '../types';

const __filename = fileURLToPath(import.meta.url);
const __dirname = pathDirname(__filename);

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

  public getConnection(): PGlite {
    return this.client;
  }

  public isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  public async runMigrations(): Promise<void> {
    const migrationsFolder = pathDirname(__dirname) + '/../drizzle/migrations';
    try {
      logger.info(`Using migrations folder: ${migrationsFolder}`);
      await migrate(drizzle(this.client), { migrationsFolder });
      logger.info('Migrations ran successfully.');
    } catch (error) {
      logger.error('Failed to run migrations:', error);
      throw error;
    }
  }

  public async initialize(): Promise<void> {
    // Kept for backward compatibility
  }

  public async close(): Promise<void> {
    this.shuttingDown = true;
  }

  private setupShutdownHandlers() {
    // Implementation of setupShutdownHandlers method
  }
}
