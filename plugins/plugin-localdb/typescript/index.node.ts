/**
 * Node.js entry point for plugin-localdb
 *
 * Uses file-based JSON storage for persistence.
 */

import { join } from "node:path";
import {
  type IAgentRuntime,
  type IDatabaseAdapter,
  logger,
  type Plugin,
  type UUID,
} from "@elizaos/core";
import { LocalDatabaseAdapter } from "./adapter";
import { NodeStorage } from "./storage-node";

// Global singleton for connection manager
const GLOBAL_SINGLETONS = Symbol.for("@elizaos/plugin-localdb/global-singletons");
type GlobalSymbols = typeof globalThis & {
  [GLOBAL_SINGLETONS]?: {
    storageManager?: NodeStorage;
  };
};
const globalSymbols: GlobalSymbols = globalThis as GlobalSymbols;

if (!globalSymbols[GLOBAL_SINGLETONS]) {
  globalSymbols[GLOBAL_SINGLETONS] = {};
}
const globalSingletons = globalSymbols[GLOBAL_SINGLETONS];

/**
 * Creates a local database adapter for Node.js
 *
 * @param config Configuration options
 * @param config.dataDir Directory for storing data files (default: ./data)
 * @param agentId The agent ID
 * @returns The database adapter
 */
export function createDatabaseAdapter(
  config: { dataDir?: string },
  agentId: UUID
): IDatabaseAdapter {
  const dataDir = config.dataDir ?? join(process.cwd(), "data");

  // Create or reuse storage manager
  if (!globalSingletons.storageManager) {
    globalSingletons.storageManager = new NodeStorage(dataDir);
  }

  return new LocalDatabaseAdapter(globalSingletons.storageManager, agentId);
}

/**
 * Plugin definition for elizaOS
 */
export const plugin: Plugin = {
  name: "@elizaos/plugin-localdb",
  description: "Simple JSON-based local database storage for elizaOS",

  async init(_config: Record<string, string>, runtime: IAgentRuntime): Promise<void> {
    logger.info({ src: "plugin:localdb" }, "Initializing local database plugin");

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
        { src: "plugin:localdb" },
        "Database adapter already exists, skipping initialization"
      );
      return;
    }

    // Get data directory from settings
    const dataDir = runtime.getSetting("LOCALDB_DATA_DIR") as string | undefined;

    // Create and register adapter
    const adapter = createDatabaseAdapter({ dataDir }, runtime.agentId);

    await adapter.init();
    runtime.registerDatabaseAdapter(adapter);

    logger.success({ src: "plugin:localdb" }, "Local database adapter registered successfully");
  },
};

export { LocalDatabaseAdapter } from "./adapter";
export { SimpleHNSW } from "./hnsw";
export { NodeStorage } from "./storage-node";
export * from "./types";

export default plugin;
