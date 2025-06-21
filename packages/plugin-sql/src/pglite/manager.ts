import { PGlite, type PGliteOptions } from '@electric-sql/pglite';
import { fuzzystrmatch } from '@electric-sql/pglite/contrib/fuzzystrmatch';
import { vector } from '@electric-sql/pglite/vector';
import { logger } from '@elizaos/core';
import type { IDatabaseClientManager } from '../types';

/**
 * Class representing a database client manager for PGlite.
 * @implements { IDatabaseClientManager }
 */
export class PGliteClientManager implements IDatabaseClientManager<PGlite> {
  private client: PGlite;
  private shuttingDown = false;
  private readonly shutdownTimeout = 500;
  private queryCount = 0;
  private totalQueryTime = 0;
  private startTime = Date.now();

  /**
   * Constructor for creating a new instance of PGlite with the provided options.
   * Initializes the PGlite client with additional extensions.
   * @param {PGliteOptions} options - The options to configure the PGlite client.
   */
  constructor(options: PGliteOptions) {
    // Enhanced PGlite options for better performance
    this.client = new PGlite({
      ...options,
      extensions: {
        vector,
        fuzzystrmatch,
      },
      // Add performance optimizations
      relaxedDurability: true, // Better performance at cost of some durability guarantees
    });
    this.setupShutdownHandlers();
    this.setupPerformanceMonitoring();
  }

  public getConnection(): PGlite {
    return this.client;
  }

  public isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  public async initialize(): Promise<void> {
    // Kept for backward compatibility
  }

  public async close(): Promise<void> {
    if (this.shuttingDown) {
      // Already shutting down or closed, just return
      return;
    }
    this.shuttingDown = true;
    this.logPerformanceStats();
    try {
      await this.client.close();
    } catch (error) {
      // Ignore errors if already closed
      logger.debug('PGLite close error (may be already closed):', error);
    }
  }

  /**
   * Get performance statistics for monitoring
   */
  public getPerformanceStats() {
    const uptime = Date.now() - this.startTime;
    return {
      queryCount: this.queryCount,
      totalQueryTime: this.totalQueryTime,
      averageQueryTime: this.queryCount > 0 ? this.totalQueryTime / this.queryCount : 0,
      uptimeMs: uptime,
      queriesPerSecond: this.queryCount > 0 ? (this.queryCount / uptime) * 1000 : 0,
    };
  }

  /**
   * Log current performance statistics
   */
  public logPerformanceStats(): void {
    const stats = this.getPerformanceStats();
    logger.info('PGlite Performance Stats:', {
      queries: stats.queryCount,
      avgQueryTime: `${Math.round(stats.averageQueryTime)}ms`,
      qps: Math.round(stats.queriesPerSecond * 100) / 100,
      uptime: `${Math.round(stats.uptimeMs / 1000)}s`,
    });
  }

  /**
   * Track query performance
   */
  public trackQuery(startTime: number): void {
    this.queryCount++;
    this.totalQueryTime += Date.now() - startTime;
  }

  private setupShutdownHandlers() {
    // Graceful shutdown handlers
    const shutdown = async () => {
      if (!this.shuttingDown) {
        logger.info('PGlite: Graceful shutdown initiated');
        await this.close();
      }
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
    process.on('SIGUSR2', shutdown); // nodemon restart
  }

  private setupPerformanceMonitoring() {
    // Log performance stats every 60 seconds
    setInterval(() => {
      if (!this.shuttingDown && this.queryCount > 0) {
        this.logPerformanceStats();
      }
    }, 60000);
  }
}
