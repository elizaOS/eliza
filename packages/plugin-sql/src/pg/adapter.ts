import { type UUID, logger } from '@elizaos/core';
import { type PostgresJsDatabase, drizzle } from 'drizzle-orm/postgres-js';
import { type Sql } from 'postgres';
import { BaseDrizzleAdapter } from '../base';
import { DIMENSION_MAP, type EmbeddingDimensionColumn } from '../schema/embedding';
import type { PostgresConnectionManager } from './manager';

/**
 * Adapter class for interacting with a PostgreSQL database using postgres.js.
 * Extends BaseDrizzleAdapter<PostgresJsDatabase>.
 */
export class PgDatabaseAdapter extends BaseDrizzleAdapter<PostgresJsDatabase> {
  protected embeddingDimension: EmbeddingDimensionColumn = DIMENSION_MAP[384];

  /**
   * Constructor for creating a new instance of a class.
   * @param {UUID} agentId - The unique identifier for the agent.
   * @param {PostgresConnectionManager} manager - The Postgres connection manager for the instance.
   */
  constructor(
    agentId: UUID,
    private manager: PostgresConnectionManager
  ) {
    super(agentId);
  }

  /**
   * Executes the provided operation with a database connection from postgres.js.
   *
   * @template T
   * @param {() => Promise<T>} operation - The operation to be executed with the database connection.
   * @returns {Promise<T>} A promise that resolves with the result of the operation.
   */
  protected async withDatabase<T>(operation: () => Promise<T>): Promise<T> {
    return await this.withRetry(async () => {
      const pgJsClient = this.manager.getConnection();
      try {
        const db = drizzle(pgJsClient);
        this.db = db;

        return await operation();
      } finally {
      }
    });
  }

  /**
   * Asynchronously initializes the PgDatabaseAdapter by running migrations using the manager.
   * Logs a success message if initialization is successful, otherwise logs an error message.
   *
   * @returns {Promise<void>} A promise that resolves when initialization is complete.
   */
  async init(): Promise<void> {
    try {
      await this.manager.runMigrations();
      logger.debug('PgDatabaseAdapter (postgres.js) initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize PgDatabaseAdapter (postgres.js):', error);
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

  /**
   * Asynchronously retrieves the postgres.js client instance from the manager.
   *
   * @returns {Promise<Sql<{}>>} A Promise that resolves with the postgres.js client instance.
   */
  async getConnection(): Promise<Sql<{}>> {
    return this.manager.getConnection();
  }
}
