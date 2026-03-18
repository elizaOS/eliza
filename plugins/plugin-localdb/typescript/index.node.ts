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

export function createDatabaseAdapter(
  config: { dataDir?: string },
  agentId: UUID
): IDatabaseAdapter {
  const dataDir = config.dataDir ?? join(process.cwd(), "data");

  if (!globalSingletons.storageManager) {
    globalSingletons.storageManager = new NodeStorage(dataDir);
  }

  return new LocalDatabaseAdapter(globalSingletons.storageManager, agentId);
}

export const plugin: Plugin = {
  name: "@elizaos/plugin-localdb",
  description: "Simple JSON-based local database storage for elizaOS",

  /** Adapter factory for runtime composition. Uses LOCALDB_DATA_DIR from bootstrap settings if set. */
  adapter(agentId, settings) {
    const dataDir = settings.LOCALDB_DATA_DIR;
    return createDatabaseAdapter(dataDir ? { dataDir } : {}, agentId);
  },

  async init(_config: Record<string, string>, runtime: IAgentRuntime): Promise<void> {
    logger.info({ src: "plugin:localdb" }, "Initializing local database plugin");

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

    logger.warn(
      { src: "plugin:localdb" },
      "No database adapter on runtime. Pass adapter in AgentRuntime constructor or use createRuntimes with this plugin's adapter factory."
    );
  },
};

export { LocalDatabaseAdapter } from "./adapter";
export { SimpleHNSW } from "./hnsw";
export { NodeStorage } from "./storage-node";
export * from "./types";

export default plugin;
