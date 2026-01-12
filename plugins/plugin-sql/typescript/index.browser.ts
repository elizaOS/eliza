import {
  type IAgentRuntime,
  type IDatabaseAdapter,
  logger,
  type Plugin,
  type UUID,
} from "@elizaos/core";
import { PgliteDatabaseAdapter } from "./pglite/adapter";
import { PGliteClientManager } from "./pglite/manager";
import * as schema from "./schema";

const GLOBAL_SINGLETONS = Symbol.for("@elizaos/plugin-sql/global-singletons");

interface GlobalSingletons {
  pgLiteClientManager?: PGliteClientManager;
}

const globalSymbols = globalThis as typeof globalThis & Record<symbol, GlobalSingletons>;
if (!globalSymbols[GLOBAL_SINGLETONS]) {
  globalSymbols[GLOBAL_SINGLETONS] = {};
}
const globalSingletons = globalSymbols[GLOBAL_SINGLETONS];

export function createDatabaseAdapter(
  _config: { dataDir?: string },
  agentId: UUID
): IDatabaseAdapter {
  if (!globalSingletons.pgLiteClientManager) {
    globalSingletons.pgLiteClientManager = new PGliteClientManager({});
  }
  return new PgliteDatabaseAdapter(agentId, globalSingletons.pgLiteClientManager);
}

export const plugin: Plugin = {
  name: "@elizaos/plugin-sql",
  description: "A plugin for SQL database access (PGlite WASM in browser).",
  priority: 0,
  schema: schema,
  init: async (_config, runtime: IAgentRuntime) => {
    logger.info({ src: "plugin:sql" }, "plugin-sql (browser) init starting");

    try {
      const isReady = await runtime.isReady();
      if (isReady) {
        logger.info(
          { src: "plugin:sql" },
          "Database adapter already registered, skipping creation"
        );
        return;
      }
    } catch (_error) {}

    const dbAdapter = createDatabaseAdapter({}, runtime.agentId);
    runtime.registerDatabaseAdapter(dbAdapter);
    logger.info({ src: "plugin:sql" }, "Browser database adapter (PGlite) created and registered");
  },
};

export default plugin;

export { DatabaseMigrationService } from "./migration-service";
