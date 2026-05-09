import { type Agent, type Entity, logger, type Memory, type UUID } from "@elizaos/core";
import type { NeonDatabase } from "drizzle-orm/neon-serverless";
import { BaseDrizzleAdapter } from "../base";
import { DIMENSION_MAP, type EmbeddingDimensionColumn } from "../schema/embedding";
import type { DrizzleDatabase } from "../types";
import type { NeonConnectionManager } from "./manager";

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
    // Neon and node-postgres adapters expose compatible drizzle APIs, but
    // BaseDrizzleAdapter expects the shared DrizzleDatabase union type.
    this.db = manager.getDatabase() as DrizzleDatabase;
  }

  getManager(): NeonConnectionManager {
    return this.manager;
  }

  public async withEntityContext<T>(
    entityId: UUID | null,
    callback: (tx: DrizzleDatabase) => Promise<T>
  ): Promise<T> {
    return this.manager.withIsolationContext(
      entityId,
      callback as (tx: NeonDatabase) => Promise<T>
    );
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
    logger.warn({ src: "plugin:sql:neon" }, "getMemoriesByServerId called but not implemented");
    return [];
  }

  async ensureAgentExists(agent: Partial<Agent>): Promise<Agent> {
    const existingAgent = await this.getAgent(this.agentId);
    if (existingAgent) {
      return existingAgent;
    }

    const newAgent: Agent = {
      id: this.agentId,
      name: agent.name || "Unknown Agent",
      username: agent.username,
      bio: (Array.isArray(agent.bio)
        ? agent.bio
        : agent.bio
          ? [agent.bio]
          : ["An AI agent"]) as string[],
      createdAt: agent.createdAt || Date.now(),
      updatedAt: agent.updatedAt || Date.now(),
    };

    await this.createAgent(newAgent);
    const createdAgent = await this.getAgent(this.agentId);
    if (!createdAgent) {
      throw new Error("Failed to create agent");
    }
    return createdAgent;
  }

  protected async withDatabase<T>(operation: () => Promise<T>): Promise<T> {
    return await this.withRetry(async () => {
      return await operation();
    });
  }

  async init(): Promise<void> {
    logger.debug({ src: "plugin:sql:neon" }, "NeonDatabaseAdapter initialized");
  }

  async isReady(): Promise<boolean> {
    return this.manager.testConnection();
  }

  async close(): Promise<void> {
    await this.manager.close();
  }

  async getConnection(): Promise<DrizzleDatabase> {
    return this.db as DrizzleDatabase;
  }

  getRawConnection() {
    return this.manager.getConnection();
  }
}
