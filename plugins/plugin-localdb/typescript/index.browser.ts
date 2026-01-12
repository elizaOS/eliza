import {
  type IAgentRuntime,
  type IDatabaseAdapter,
  logger,
  type Plugin,
  type UUID,
} from "@elizaos/core";
import { LocalDatabaseAdapter } from "./adapter";
import { BrowserStorage } from "./storage-browser";

const GLOBAL_SINGLETONS = Symbol.for("@elizaos/plugin-localdb/global-singletons");
type GlobalSymbols = typeof globalThis & {
  [GLOBAL_SINGLETONS]?: {
    storageManager?: BrowserStorage;
  };
};
const globalSymbols: GlobalSymbols = globalThis as GlobalSymbols;

if (!globalSymbols[GLOBAL_SINGLETONS]) {
  globalSymbols[GLOBAL_SINGLETONS] = {};
}
const globalSingletons = globalSymbols[GLOBAL_SINGLETONS];

export function createDatabaseAdapter(
  config: { prefix?: string },
  agentId: UUID
): IDatabaseAdapter {
  const prefix = config.prefix ?? "elizaos";

  if (!globalSingletons.storageManager) {
    globalSingletons.storageManager = new BrowserStorage(prefix);
  }

  return new LocalDatabaseAdapter(globalSingletons.storageManager, agentId);
}

export const plugin: Plugin = {
  name: "@elizaos/plugin-localdb",
  description: "Simple JSON-based local database storage for elizaOS (browser)",

  async init(_config: Record<string, string>, runtime: IAgentRuntime): Promise<void> {
    logger.info({ src: "plugin:localdb" }, "Initializing local database plugin (browser)");

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

    const prefix = runtime.getSetting("LOCALDB_PREFIX") as string | undefined;
    const adapter = createDatabaseAdapter({ prefix }, runtime.agentId);

    await adapter.init();
    runtime.registerDatabaseAdapter(adapter);

    logger.success({ src: "plugin:localdb" }, "Local database adapter registered successfully");
  },
};

export { LocalDatabaseAdapter } from "./adapter";
export { SimpleHNSW } from "./hnsw";
export { BrowserStorage } from "./storage-browser";
export * from "./types";

export default plugin;
