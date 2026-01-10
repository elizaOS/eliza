/**
 * Main entry point for plugin-inmemorydb
 * 
 * Pure in-memory, ephemeral storage - all data is lost on restart.
 * Works identically in both Node.js and browser environments.
 */

import {
  type IAgentRuntime,
  type IDatabaseAdapter,
  logger,
  type Plugin,
  type UUID,
} from "@elizaos/core";
import { InMemoryDatabaseAdapter } from "./adapter";
import { MemoryStorage } from "./storage-memory";

// Global singleton for storage (shared across all agents in the same process)
const GLOBAL_SINGLETONS = Symbol.for("@elizaos/plugin-inmemorydb/global-singletons");
type GlobalSymbols = typeof globalThis & {
  [GLOBAL_SINGLETONS]?: {
    storageManager?: MemoryStorage;
  };
};
const globalSymbols: GlobalSymbols = globalThis as GlobalSymbols;

if (!globalSymbols[GLOBAL_SINGLETONS]) {
  globalSymbols[GLOBAL_SINGLETONS] = {};
}
const globalSingletons = globalSymbols[GLOBAL_SINGLETONS];

/**
 * Creates an in-memory database adapter
 * 
 * @param agentId The agent ID
 * @returns The database adapter
 */
export function createDatabaseAdapter(agentId: UUID): IDatabaseAdapter {
  // Create or reuse storage manager
  if (!globalSingletons.storageManager) {
    globalSingletons.storageManager = new MemoryStorage();
  }

  return new InMemoryDatabaseAdapter(globalSingletons.storageManager, agentId);
}

/**
 * Plugin definition for elizaOS
 * 
 * This plugin provides a pure in-memory database that is completely ephemeral.
 * All data is lost when the process restarts or when close() is called.
 * 
 * Perfect for:
 * - Testing and CI/CD
 * - Stateless deployments
 * - Development without persistence
 * - Scenarios where data should not persist
 */
export const plugin: Plugin = {
  name: "@elizaos/plugin-inmemorydb",
  description: "Pure in-memory, ephemeral database storage for elizaOS - no persistence",
  
  async init(_config: Record<string, string>, runtime: IAgentRuntime): Promise<void> {
    logger.info({ src: "plugin:inmemorydb" }, "Initializing in-memory database plugin (ephemeral)");

    // Check if adapter already exists
    interface RuntimeWithAdapter {
      adapter?: IDatabaseAdapter;
      hasDatabaseAdapter?: () => boolean;
      getDatabaseAdapter?: () => IDatabaseAdapter | undefined;
      databaseAdapter?: IDatabaseAdapter;
    }
    const runtimeWithAdapter = runtime as RuntimeWithAdapter;
    
    const hasAdapter = 
      runtimeWithAdapter.adapter !== undefined ||
      runtimeWithAdapter.databaseAdapter !== undefined ||
      (runtimeWithAdapter.hasDatabaseAdapter?.() ?? false);

    if (hasAdapter) {
      logger.debug(
        { src: "plugin:inmemorydb" },
        "Database adapter already exists, skipping initialization"
      );
      return;
    }

    // Create and register adapter
    const adapter = createDatabaseAdapter(runtime.agentId);

    await adapter.init();
    runtime.registerDatabaseAdapter(adapter);

    logger.success(
      { src: "plugin:inmemorydb" },
      "In-memory database adapter registered successfully (ephemeral - data will be lost on restart)"
    );
  },
};

export { InMemoryDatabaseAdapter } from "./adapter";
export { MemoryStorage } from "./storage-memory";
export { EphemeralHNSW } from "./hnsw";
export * from "./types";

export default plugin;

