import {
  type IAgentRuntime,
  type IDatabaseAdapter,
  logger,
  type Plugin,
  type UUID,
} from "@elizaos/core";
import { InMemoryDatabaseAdapter } from "./adapter";
import { MemoryStorage } from "./storage-memory";

// The InMemoryDatabaseAdapter implements an older revision of the
// DatabaseAdapter abstract base in @elizaos/core (see adapter.ts), so we cast
// to IDatabaseAdapter at the boundary. Calls into methods that were added in
// newer core revisions will fail at runtime — the plugin needs to be brought
// back to parity.
type CompatAdapter = IDatabaseAdapter & {
  init?: () => Promise<void>;
  initialize?: () => Promise<void>;
};
type RuntimeWithRegister = IAgentRuntime & {
  registerDatabaseAdapter?: (adapter: IDatabaseAdapter) => void;
};

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

  return new InMemoryDatabaseAdapter(
    globalSingletons.storageManager,
    agentId,
  ) as unknown as IDatabaseAdapter;
}

export const plugin: Plugin = {
  name: "@elizaos/plugin-inmemorydb",
  description: "Pure in-memory, ephemeral database storage for elizaOS - no persistence",

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

    const adapter = createDatabaseAdapter(runtime.agentId) as CompatAdapter;

    if (typeof adapter.init === "function") {
      await adapter.init();
    } else if (typeof adapter.initialize === "function") {
      await adapter.initialize();
    }
    const runtimeReg = runtime as RuntimeWithRegister;
    runtimeReg.registerDatabaseAdapter?.(adapter);

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
