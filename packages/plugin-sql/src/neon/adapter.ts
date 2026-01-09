import { type UUID, logger, Agent, Entity, Memory, Component } from '@elizaos/core';
import type { NeonDatabase } from 'drizzle-orm/neon-serverless';
import { BaseDrizzleAdapter } from '../base';
import { DIMENSION_MAP, type EmbeddingDimensionColumn } from '../schema/embedding';
import type { NeonConnectionManager } from './manager';

/**
 * Adapter class for interacting with a Neon Serverless database.
 * Extends BaseDrizzleAdapter and uses @neondatabase/serverless driver.
 *
 * Benefits:
 * - Optimized for serverless environments (Vercel, Cloudflare, etc.)
 * - Connection pooling handled at Neon's edge proxy
 * - Better cold start performance
 * - WebSocket-based connections
 */
export class NeonDatabaseAdapter extends BaseDrizzleAdapter {
  protected embeddingDimension: EmbeddingDimensionColumn = DIMENSION_MAP[384];
  private manager: NeonConnectionManager;

  constructor(agentId: UUID, manager: NeonConnectionManager, _schema?: Record<string, unknown>) {
    super(agentId);
    this.manager = manager;
    // Cast to any because NeonDatabase and NodePgDatabase have compatible APIs
    // but TypeScript doesn't know that
    this.db = manager.getDatabase() as any;
  }

  getManager(): NeonConnectionManager {
    return this.manager;
  }

  /**
   * Execute a callback with full isolation context (Server RLS + Entity RLS).
   */
  public async withIsolationContext<T>(
    entityId: UUID | null,
    callback: (tx: NeonDatabase) => Promise<T>
  ): Promise<T> {
    return await this.manager.withIsolationContext(entityId, callback);
  }

  async getEntityByIds(entityIds: UUID[]): Promise<Entity[] | null> {
    return this.getEntitiesByIds(entityIds);
  }

  async getMemoriesByServerId(_params: { serverId: UUID; count?: number }): Promise<Memory[]> {
    logger.warn({ src: 'plugin:sql:neon' }, 'getMemoriesByServerId called but not implemented');
    return [];
  }

  async ensureAgentExists(agent: Partial<Agent>): Promise<Agent> {
    const existingAgent = await this.getAgent(this.agentId);
    if (existingAgent) {
      return existingAgent;
    }

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

  protected async withDatabase<T>(operation: () => Promise<T>): Promise<T> {
    return await this.withRetry(async () => {
      return await operation();
    });
  }

  async init(): Promise<void> {
    logger.debug({ src: 'plugin:sql:neon' }, 'NeonDatabaseAdapter initialized');
  }

  async isReady(): Promise<boolean> {
    return this.manager.testConnection();
  }

  async close(): Promise<void> {
    await this.manager.close();
  }

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
