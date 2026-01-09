import {
  type Agent,
  type Component,
  type Entity,
  type Memory,
  type UUID,
} from "@elizaos/core";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { BaseDrizzleAdapter } from "../base";
import { type EmbeddingDimensionColumn } from "../schema/embedding";
import type { PostgresConnectionManager } from "./manager";
/**
 * Adapter class for interacting with a PostgreSQL database.
 * Extends BaseDrizzleAdapter.
 */
export declare class PgDatabaseAdapter extends BaseDrizzleAdapter {
  protected embeddingDimension: EmbeddingDimensionColumn;
  private manager;
  constructor(
    agentId: UUID,
    manager: PostgresConnectionManager,
    _schema?: Record<string, unknown>,
  );
  getManager(): PostgresConnectionManager;
  /**
   * Execute a callback with entity context for Entity RLS
   * Delegates to the manager's withEntityContext method
   *
   * This is a public method because it's part of the adapter's public API
   * for operations that need entity-scoped database access.
   */
  withEntityContext<T>(
    entityId: UUID | null,
    callback: (tx: NodePgDatabase) => Promise<T>,
  ): Promise<T>;
  getEntityByIds(entityIds: UUID[]): Promise<Entity[] | null>;
  getMemoriesByServerId(_params: {
    serverId: UUID;
    count?: number;
  }): Promise<Memory[]>;
  ensureAgentExists(agent: Partial<Agent>): Promise<Agent>;
  /**
   * Executes the provided operation with a database connection.
   *
   * This method uses the shared pool-based database instance from the manager.
   * The pg Pool handles connection management internally, automatically acquiring
   * and releasing connections for each query. This avoids race conditions that
   * could occur with manual client management and shared state.
   *
   * Note: The this.db instance is set once in the constructor from manager.getDatabase()
   * and is backed by a connection pool, so concurrent operations are safe.
   *
   * @template T
   * @param {() => Promise<T>} operation - The operation to be executed with the database connection.
   * @returns {Promise<T>} A promise that resolves with the result of the operation.
   */
  protected withDatabase<T>(operation: () => Promise<T>): Promise<T>;
  /**
   * Asynchronously initializes the PgDatabaseAdapter by running migrations using the manager.
   * Logs a success message if initialization is successful, otherwise logs an error message.
   *
   * @returns {Promise<void>} A promise that resolves when initialization is complete.
   */
  init(): Promise<void>;
  /**
   * Checks if the database connection is ready and active.
   * @returns {Promise<boolean>} A Promise that resolves to true if the connection is healthy.
   */
  isReady(): Promise<boolean>;
  /**
   * Asynchronously closes the manager associated with this instance.
   *
   * @returns A Promise that resolves once the manager is closed.
   */
  close(): Promise<void>;
  /**
   * Asynchronously retrieves the connection from the manager.
   *
   * @returns {Promise<Pool>} A Promise that resolves with the connection.
   */
  getConnection(): Promise<import("pg").Pool>;
  createAgent(agent: Agent): Promise<boolean>;
  getAgent(agentId: UUID): Promise<Agent | null>;
  updateAgent(agentId: UUID, agent: Partial<Agent>): Promise<boolean>;
  deleteAgent(agentId: UUID): Promise<boolean>;
  createEntities(entities: Entity[]): Promise<boolean>;
  getEntitiesByIds(entityIds: UUID[]): Promise<Entity[]>;
  updateEntity(entity: Entity): Promise<void>;
  createMemory(memory: Memory, tableName: string): Promise<UUID>;
  getMemoryById(memoryId: UUID): Promise<Memory | null>;
  updateMemory(
    memory: Partial<Memory> & {
      id: UUID;
    },
  ): Promise<boolean>;
  deleteMemory(memoryId: UUID): Promise<void>;
  createComponent(component: Component): Promise<boolean>;
  getComponent(
    entityId: UUID,
    type: string,
    worldId?: UUID,
    sourceEntityId?: UUID,
  ): Promise<Component | null>;
  updateComponent(component: Component): Promise<void>;
  deleteComponent(componentId: UUID): Promise<void>;
}
//# sourceMappingURL=adapter.d.ts.map
