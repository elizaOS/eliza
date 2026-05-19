import {
  type IAgentRuntime,
  type IDatabaseAdapter,
  logger,
  type Plugin,
  type UUID,
} from "@elizaos/core";
import { InMemoryDatabaseAdapter } from "./adapter";
import { MemoryStorage } from "./storage-memory";

const GLOBAL_SINGLETONS = Symbol.for("elizaos.plugin-inmemorydb.global-singletons");
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

export function createDatabaseAdapter(agentId: UUID): InMemoryDatabaseAdapter {
  if (!globalSingletons.storageManager) {
    globalSingletons.storageManager = new MemoryStorage();
  }
  return new InMemoryDatabaseAdapter(globalSingletons.storageManager, agentId);
}

// `IAgentRuntime` historically didn't expose `registerDatabaseAdapter` on the
// public type — at runtime it does. We narrow the runtime to the registration
// surface we need and call it defensively so the plugin still loads against
// runtimes that don't accept adapter registration.
type RuntimeWithRegister = IAgentRuntime & {
  registerDatabaseAdapter?: (adapter: IDatabaseAdapter) => void;
  adapter?: IDatabaseAdapter;
  databaseAdapter?: IDatabaseAdapter;
  hasDatabaseAdapter?: () => boolean;
};

export const plugin: Plugin = {
  name: "@elizaos/plugin-inmemorydb",
  description: "Pure in-memory, ephemeral database storage for elizaOS - no persistence",

  async init(_config: Record<string, string>, runtime: IAgentRuntime): Promise<void> {
    logger.info({ src: "plugin:inmemorydb" }, "Initializing in-memory database plugin");

    const r = runtime as RuntimeWithRegister;
    const hasAdapter =
      r.adapter !== undefined ||
      r.databaseAdapter !== undefined ||
      (r.hasDatabaseAdapter?.() ?? false);

    if (hasAdapter) {
      logger.debug(
        { src: "plugin:inmemorydb" },
        "Database adapter already exists, skipping initialization"
      );
      return;
    }

    const adapter = createDatabaseAdapter(runtime.agentId);
    await adapter.initialize();
    r.registerDatabaseAdapter?.(adapter);

    logger.success(
      { src: "plugin:inmemorydb" },
      "In-memory database adapter registered successfully"
    );
  },
};

export { InMemoryDatabaseAdapter } from "./adapter";
export { EphemeralHNSW } from "./hnsw";
export { MemoryStorage } from "./storage-memory";
export * from "./types";

export default plugin;
