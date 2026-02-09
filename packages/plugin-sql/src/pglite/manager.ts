import { PGlite, type PGliteOptions } from '@electric-sql/pglite';
import { fuzzystrmatch } from '@electric-sql/pglite/contrib/fuzzystrmatch';
import { vector } from '@electric-sql/pglite/vector';
import type { IDatabaseClientManager } from '../types';

/**
 * Class representing a database client manager for PGlite.
 * @implements { IDatabaseClientManager }
 */
export class PGliteClientManager implements IDatabaseClientManager<PGlite> {
  private client: PGlite;
  private shuttingDown = false;

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

  /**
   * Wait for the PGLite WASM module to be fully initialized.
   * PGLite initializes its WASM backend asynchronously after construction.
   * Under CI load, the module may not be ready when the first query arrives,
   * causing "access to a null reference (_pgl_initdb)" RuntimeErrors.
   * This method issues a trivial query with retries to ensure readiness.
   */
  public async initialize(): Promise<void> {
    const maxRetries = 3;
    const retryDelayMs = 500;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await this.client.query('SELECT 1');
        return;
      } catch (error) {
        if (attempt === maxRetries) {
          throw new Error(
            `PGLite failed to initialize after ${maxRetries} attempts: ${(error as Error).message}`
          );
        }
        // Wait before retrying -- gives the WASM module time to finish loading
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt));
      }
    }
  }

  public async close(): Promise<void> {
    this.shuttingDown = true;
    // Actually close the PGLite client to release file locks and cleanup resources
    // Without this, the WAL files remain locked and deleting the data directory
    // causes ENOENT errors when subsequent tests try to access it
    if (this.client) {
      try {
        await this.client.close();
      } catch {}
    }
  }

  private setupShutdownHandlers() {
    // Implementation of setupShutdownHandlers method
  }
}
