import { type UUID, logger } from '@elizaos/core';
import { type PgliteDatabase, drizzle } from 'drizzle-orm/pglite';
import type { PGlite } from '@electric-sql/pglite';
import { BaseDrizzleAdapter } from '../base';
import { DIMENSION_MAP, type EmbeddingDimensionColumn } from '../schema/embedding';
import type { PGliteClientManager } from './manager';

/**
 * PgliteDatabaseAdapter class represents an adapter for interacting with a PgliteDatabase.
 * Extends BaseDrizzleAdapter<PgliteDatabase>.
 *
 * @constructor
 * @param {UUID} agentId - The ID of the agent.
 * @param {PGliteClientManager} manager - The manager for the PgliteDatabase.
 *
 * @method withDatabase
 * @param {() => Promise<T>} operation - The operation to perform on the database.
 * @return {Promise<T>} - The result of the operation.
 *
 * @method init
 * @return {Promise<void>} - A Promise that resolves when the initialization is complete.
 *
 * @method close
 * @return {void} - A Promise that resolves when the database is closed.
 */
export class PgliteDatabaseAdapter extends BaseDrizzleAdapter<PgliteDatabase> {
  private manager: PGliteClientManager;
  protected embeddingDimension: EmbeddingDimensionColumn = DIMENSION_MAP[384];
  private initialized = false;

  /**
   * Constructor for creating an instance of a class.
   * @param {UUID} agentId - The unique identifier for the agent.
   * @param {PGliteClientManager} manager - The manager for the PGlite client.
   */
  constructor(agentId: UUID, manager: PGliteClientManager) {
    super(agentId);
    this.manager = manager;
  }

  /**
   * Ensures the manager is initialized and sets up the db instance.
   */
  private async ensureInitialized(): Promise<void> {
    if (!this.initialized || !this.db) {
      await this.manager.initialize();
      // Cast to PGlite for drizzle compatibility (PgliteWorker has same interface)
      const connection = this.manager.getConnection() as PGlite;
      this.db = drizzle(connection);
      this.initialized = true;
    }
  }

  /**
   * Asynchronously runs the provided database operation while checking if the database manager is currently shutting down.
   * If the database manager is shutting down, a warning is logged and null is returned.
   *
   * @param {Function} operation - The database operation to be performed.
   * @returns {Promise<T>} A promise that resolves with the result of the database operation.
   */
  protected async withDatabase<T>(operation: () => Promise<T>): Promise<T> {
    if (this.manager.isShuttingDown()) {
      logger.warn('Database is shutting down');
      return null as unknown as T;
    }

    await this.ensureInitialized();
    return operation();
  }

  /**
   * Asynchronously initializes the database by running migrations using the manager.
   *
   * @returns {Promise<void>} A Promise that resolves when the database initialization is complete.
   */
  async init(): Promise<void> {
    try {
      await this.ensureInitialized();
      await this.manager.runMigrations();
      logger.info('PgliteDatabaseAdapter initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize database:', error);
      throw error;
    }
  }

  /**
   * Asynchronously closes the manager.
   */
  async close() {
    await this.manager.close();
    this.initialized = false;
    this.db = null as any;
  }

  /**
   * Asynchronously retrieves the connection from the manager.
   *
   * @returns {Promise<PGlite>} A Promise that resolves with the connection.
   */
  async getConnection() {
    await this.ensureInitialized();
    return this.manager.getConnection() as PGlite;
  }
}
