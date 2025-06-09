import { type UUID, logger } from '@elizaos/core';
import { type NodePgDatabase, drizzle } from 'drizzle-orm/node-postgres';
import { BaseDrizzleAdapter } from '../base';
import { DIMENSION_MAP, type EmbeddingDimensionColumn } from '../schema/embedding';
import type { PostgresConnectionManager } from './manager';
import { type Pool as PgPool } from 'pg';

/**
 * Adapter class for interacting with a PostgreSQL database.
 * Extends BaseDrizzleAdapter<NodePgDatabase>.
 */
export class PgDatabaseAdapter extends BaseDrizzleAdapter<NodePgDatabase> {
  protected embeddingDimension: EmbeddingDimensionColumn = DIMENSION_MAP[384];

  constructor(
    agentId: UUID,
    private manager: PostgresConnectionManager
  ) {
    super(agentId);
    this.manager = manager;
    this.db = this.manager.getDatabase();
  }

  /**
   * Executes the provided operation with a database connection.
   *
   * @template T
   * @param {() => Promise<T>} operation - The operation to be executed with the database connection.
   * @returns {Promise<T>} A promise that resolves with the result of the operation.
   */
  protected async withDatabase<T>(operation: () => Promise<T>): Promise<T> {
    return await this.withRetry(async () => {
      const client = await this.manager.getClient();
      try {
        const db = drizzle(client);
        this.db = db;

        return await operation();
      } finally {
        client.release();
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
    logger.debug('PgDatabaseAdapter initialized, skipping automatic migrations.');
  }

  async runMigrations(schemaOrPaths?: any, pluginName?: string): Promise<void> {
    if (Array.isArray(schemaOrPaths)) {
      await this.manager.runMigrations(schemaOrPaths[0]);
    } else if (schemaOrPaths && pluginName) {
      const client = await this.manager.getClient();
      try {
        const _drizzle = this.db || drizzle(client);
        const { runPluginMigrations } = await import('../custom-migrator');
        await runPluginMigrations(_drizzle, pluginName, schemaOrPaths);
      } finally {
        client.release();
      }
    } else {
      await this.manager.runMigrations();
    }
  }

  /**
   * Checks if the database connection is ready and active.
   * @returns {Promise<boolean>} A Promise that resolves to true if the connection is healthy.
   */
  async isReady(): Promise<boolean> {
    return this.manager.testConnection();
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
   * Asynchronously retrieves the connection from the manager.
   *
   * @returns {Promise<Pool>} A Promise that resolves with the connection.
   */
  async getConnection() {
    return this.manager.getConnection();
  }
}
