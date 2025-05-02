import { type UUID, logger } from '@elizaos/core';
import { type MySql2Database, drizzle } from 'drizzle-orm/mysql2';
import { BaseDrizzleAdapter } from '../base';
import { DIMENSION_MAP, type EmbeddingDimensionColumn } from '../schema/embedding';
import type { MySql2ConnectionManager } from './manager';

/**
 * Adapter class for interacting with a MySQL database.
 * Extends BaseDrizzleAdapter<MySql2Database>.
 */
export class MySql2DatabaseAdapter extends BaseDrizzleAdapter<MySql2Database> {
  protected embeddingDimension: EmbeddingDimensionColumn = DIMENSION_MAP[384];

  /**
   * Constructor for creating a new instance of a class.
   * @param {UUID} agentId - The unique identifier for the agent.
   * @param {MySql2ConnectionManager} manager - The MySQL connection manager for the instance.
   */
  constructor(
    agentId: UUID,
    private manager: MySql2ConnectionManager
  ) {
    super(agentId);
    this.manager = manager;
  }

  /**
   * Executes the provided operation with a database connection.
   *
   * @template T
   * @param {() => Promise<T>} operation - The operation to be executed with the database connection.
   * @param {string} operationName - Name of the operation being executed for logging purposes.
   * @returns {Promise<T>} A promise that resolves with the result of the operation.
   */
  protected async withDatabase<T>(operation: () => Promise<T>, operationName: string): Promise<T> {
    const connection = await this.manager.getClient();
    try {
      return this.withRetry(async () => {
        const db = drizzle(connection);
        this.db = db;

        return operation();
      }, operationName);
    } finally {
      // Release the connection back to the pool
      connection.release();
    }
  }

  /**
   * Asynchronously initializes the MySql2DatabaseAdapter by running migrations using the manager.
   * Logs a success message if initialization is successful, otherwise logs an error message.
   *
   * @returns {Promise<void>} A promise that resolves when initialization is complete.
   */
  async init(): Promise<void> {
    try {
      await this.manager.runMigrations();
      logger.debug('MySql2DatabaseAdapter initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize MySql2DatabaseAdapter:', error);
      throw error;
    }
  }

  /**
   * Asynchronously closes the manager associated with this instance.
   *
   * @returns A Promise that resolves once the manager is closed.
   */
  async close(): Promise<void> {
    await this.manager.close();
  }
}
