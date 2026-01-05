import { type UUID, logger, Agent, Entity, Memory, Component } from '@elizaos/core';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
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

  constructor(
    agentId: UUID,
    manager: PostgresConnectionManager,
    _schema?: Record<string, unknown>
  ) {
    super(agentId);
    this.manager = manager;
    this.db = manager.getDatabase();
  }

  getManager(): PostgresConnectionManager {
    return this.manager;
  }

  /**
   * Execute a callback with entity context for Entity RLS
   * Delegates to the manager's withEntityContext method
   *
   * This is a public method because it's part of the adapter's public API
   * for operations that need entity-scoped database access.
   */
  public async withEntityContext<T>(
    entityId: UUID | null,
    callback: (tx: NodePgDatabase) => Promise<T>
  ): Promise<T> {
    return await this.manager.withEntityContext(entityId, callback);
  }

  // Methods required by TypeScript but not in base class
  async getEntityByIds(entityIds: UUID[]): Promise<Entity[] | null> {
    // Delegate to the correct method name
    return this.getEntitiesByIds(entityIds);
  }

  async getMemoriesByServerId(_params: { serverId: UUID; count?: number }): Promise<Memory[]> {
    // This method doesn't seem to exist in the base implementation
    // Provide a basic implementation that returns empty array
    logger.warn({ src: 'plugin:sql' }, 'getMemoriesByServerId called but not implemented');
    return [];
  }

  async ensureAgentExists(agent: Partial<Agent>): Promise<Agent> {
    // Check if agent exists, create if not
    const existingAgent = await this.getAgent(this.agentId);
    if (existingAgent) {
      return existingAgent;
    }

    // Create the agent with required fields
    const newAgent: Agent = {
      id: this.agentId,
      name: agent.name || 'Unknown Agent',
      username: agent.username,
      bio: agent.bio || 'An AI agent',
      createdAt: agent.createdAt || Date.now(),
      updatedAt: agent.updatedAt || Date.now(),
    };

    await this.createAgent(newAgent);
    const createdAgent = await this.getAgent(this.agentId);
    if (!createdAgent) {
      throw new Error('Failed to create agent');
    }
    return createdAgent;
  }

  /**
   * Executes the provided operation with a database connection.
   *
   * This method acquires a dedicated connection from the pool, executes the operation,
   * and properly releases the connection back to the pool. On error, the connection
   * is released with the error flag set to true, signaling the pool to destroy the
   * connection rather than returning it to the pool in a potentially corrupted state.
   *
   * IMPORTANT: This method creates a per-operation database instance to avoid race
   * conditions when multiple operations run concurrently. The operation callback
   * receives the database instance directly rather than relying on shared state.
   *
   * @template T
   * @param {(db: NodePgDatabase) => Promise<T>} operation - The operation to be executed with the database connection.
   * @returns {Promise<T>} A promise that resolves with the result of the operation.
   */
  protected async withDatabase<T>(operation: (db?: NodePgDatabase) => Promise<T>): Promise<T> {
    return await this.withRetry(async () => {
      const client = await this.manager.getClient();
      let hasError = false;
      try {
        // Create a per-operation database instance to avoid race conditions
        // when multiple operations run concurrently. This ensures each operation
        // has its own isolated database context.
        const db = drizzle(client);

        // Also update instance db for backward compatibility with code that
        // accesses this.db directly (though new code should use the callback parameter)
        this.db = db;

        return await operation(db);
      } catch (error) {
        hasError = true;
        throw error;
      } finally {
        // Release with error flag to signal pool to destroy connection if there was an error
        // This prevents returning a potentially corrupted connection (e.g., aborted transaction)
        // back to the pool where it could be reused by another operation
        client.release(hasError);
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
    logger.debug({ src: 'plugin:sql' }, 'PgDatabaseAdapter initialized');
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
