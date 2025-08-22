import { type UUID, logger, Agent, Entity, Memory, Component } from '@elizaos/core';
import { drizzle } from 'drizzle-orm/node-postgres';
import { BaseDrizzleAdapter } from '../base';
import { DIMENSION_MAP, type EmbeddingDimensionColumn } from '../schema/embedding';
import type { PostgresConnectionManager } from './manager';

/**
 * Adapter class for interacting with a PostgreSQL database.
 * Extends BaseDrizzleAdapter.
 */
export class PgDatabaseAdapter extends BaseDrizzleAdapter {
  protected embeddingDimension: EmbeddingDimensionColumn = DIMENSION_MAP[384];
  private manager: PostgresConnectionManager;

  constructor(agentId: UUID, manager: PostgresConnectionManager, _schema?: any) {
    super(agentId);
    this.manager = manager;
    this.db = manager.getDatabase();
  }

  /**
   * Runs database migrations. For PostgreSQL, migrations should be handled
   * externally or during deployment, so this is a no-op.
   * @returns {Promise<void>}
   */
  async runMigrations(): Promise<void> {
    logger.debug('PgDatabaseAdapter: Migrations should be handled externally');
    // Migrations are handled by the migration service, not the adapter
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
        // Cast to any to avoid type conflicts between different pg versions
        const db = drizzle(client as any);
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

  async createAgent(agent: Agent): Promise<boolean> {
    return super.createAgent(agent);
  }

  getAgent(agentId: UUID): Promise<Agent | null> {
    return super.getAgent(agentId);
  }

  updateAgent(agentId: UUID, agent: Partial<Agent>): Promise<boolean> {
    return super.updateAgent(agentId, agent);
  }

  deleteAgent(agentId: UUID): Promise<boolean> {
    return super.deleteAgent(agentId);
  }

  createEntities(entities: Entity[]): Promise<boolean> {
    return super.createEntities(entities);
  }

  getEntitiesByIds(entityIds: UUID[]): Promise<Entity[]> {
    return super.getEntitiesByIds(entityIds).then((result) => result || []);
  }

  updateEntity(entity: Entity): Promise<void> {
    return super.updateEntity(entity);
  }

  createMemory(memory: Memory, tableName: string): Promise<UUID> {
    return super.createMemory(memory, tableName);
  }

  getMemoryById(memoryId: UUID): Promise<Memory | null> {
    return super.getMemoryById(memoryId);
  }

  searchMemories(params: any): Promise<any[]> {
    return super.searchMemories(params);
  }

  updateMemory(memory: Partial<Memory> & { id: UUID }): Promise<boolean> {
    return super.updateMemory(memory);
  }

  deleteMemory(memoryId: UUID): Promise<void> {
    return super.deleteMemory(memoryId);
  }

  createComponent(component: Component): Promise<boolean> {
    return super.createComponent(component);
  }

  getComponent(
    entityId: UUID,
    type: string,
    worldId?: UUID,
    sourceEntityId?: UUID
  ): Promise<Component | null> {
    return super.getComponent(entityId, type, worldId, sourceEntityId);
  }

  updateComponent(component: Component): Promise<void> {
    return super.updateComponent(component);
  }

  deleteComponent(componentId: UUID): Promise<void> {
    return super.deleteComponent(componentId);
  }
}
