import { type Agent, type Entity, type Memory, type UUID } from "@elizaos/core";
import { type PgliteDatabase } from "drizzle-orm/pglite";
import { BaseDrizzleAdapter } from "../base";
import { type EmbeddingDimensionColumn } from "../schema/embedding";
import type { PGliteClientManager } from "./manager";
/**
 * PgliteDatabaseAdapter class represents an adapter for interacting with a PgliteDatabase.
 * Extends BaseDrizzleAdapter.
 *
 * @constructor
 * @param {UUID} agentId - The ID of the agent.
 * @param {PGliteClientManager} manager - The manager for the Pglite client.
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
export declare class PgliteDatabaseAdapter extends BaseDrizzleAdapter {
  private manager;
  protected embeddingDimension: EmbeddingDimensionColumn;
  /**
   * Constructor for creating an instance of a class.
   * @param {UUID} agentId - The unique identifier for the agent.
   * @param {PGliteClientManager} manager - The manager for the Pglite client.
   */
  constructor(agentId: UUID, manager: PGliteClientManager);
  /**
   * Execute a callback with entity context for Entity RLS
   * PGLite: No RLS support, just execute the callback in a simple transaction
   *
   * This is a public method because it's part of the adapter's public API
   * for operations that need entity-scoped database access.
   */
  withEntityContext<T>(
    _entityId: UUID | null,
    callback: (tx: PgliteDatabase) => Promise<T>,
  ): Promise<T>;
  getEntityByIds(entityIds: UUID[]): Promise<Entity[] | null>;
  getMemoriesByServerId(_params: {
    serverId: UUID;
    count?: number;
  }): Promise<Memory[]>;
  ensureAgentExists(agent: Partial<Agent>): Promise<Agent>;
  /**
   * Asynchronously runs the provided database operation while checking if the database is currently shutting down.
   * If the database is shutting down, an error is thrown to prevent operations on a closing database.
   *
   * @param {Function} operation - The database operation to be performed.
   * @returns {Promise<T>} A promise that resolves with the result of the database operation.
   * @throws {Error} If the database is shutting down.
   */
  protected withDatabase<T>(operation: () => Promise<T>): Promise<T>;
  /**
   * Asynchronously initializes the database by running migrations.
   *
   * @returns {Promise<void>} A Promise that resolves when the database initialization is complete.
   */
  init(): Promise<void>;
  /**
   * Checks if the database connection is ready and active.
   * For PGLite, this checks if the client is not in a shutting down state.
   * @returns {Promise<boolean>} A Promise that resolves to true if the connection is healthy.
   */
  isReady(): Promise<boolean>;
  /**
   * Asynchronously closes the database.
   */
  close(): Promise<void>;
  /**
   * Asynchronously retrieves the connection from the client.
   *
   * @returns {Promise<PGlite>} A Promise that resolves with the connection.
   */
  getConnection(): Promise<import("@electric-sql/pglite").PGlite>;
}
//# sourceMappingURL=adapter.d.ts.map
