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

    const dataDir = runtime.getSetting("LOCALDB_DATA_DIR") as string | undefined;
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
