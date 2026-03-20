import {
  type IAgentRuntime,
  type IDatabaseAdapter,
  logger,
  type Plugin,
  type UUID,
} from "@elizaos/core";
import { InMemoryDatabaseAdapter } from "./adapter";
import { MemoryStorage } from "./storage-memory";

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

export function createDatabaseAdapter(agentId: UUID): IDatabaseAdapter {
  if (!globalSingletons.storageManager) {
    globalSingletons.storageManager = new MemoryStorage();
  }

  return new InMemoryDatabaseAdapter(globalSingletons.storageManager, agentId);
}

export const plugin: Plugin = {
  name: "@elizaos/plugin-inmemorydb",
  description: "Pure in-memory, ephemeral database storage for elizaOS - no persistence",

  /** Adapter factory for runtime composition (createRuntimes). No settings required. */
  adapter(agentId) {
    return createDatabaseAdapter(agentId);
  },

  async init(_config: Record<string, string>, runtime: IAgentRuntime): Promise<void> {
    logger.info({ src: "plugin:inmemorydb" }, "Initializing in-memory database plugin");

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

    logger.warn(
      { src: "plugin:inmemorydb" },
      "No database adapter on runtime. Pass adapter in AgentRuntime constructor or use createRuntimes with this plugin's adapter factory."
    );
  },
};

export { InMemoryDatabaseAdapter } from "./adapter";
export { EphemeralHNSW } from "./hnsw";
export { MemoryStorage } from "./storage-memory";
export * from "./types";

export default plugin;
