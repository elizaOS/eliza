import { type IDatabaseAdapter, type Plugin, type UUID } from "@elizaos/core";
import { PgliteDatabaseAdapter } from "./pglite/adapter";
import { PGliteClientManager } from "./pglite/manager";
import * as schema from './tables';

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

/** Schema-only plugin: contributes migration schemas. Adapter must be created via createDatabaseAdapter() and passed to AgentRuntime constructor. */
export const plugin: Plugin = {
  name: "@elizaos/plugin-sql",
  description: "A plugin for SQL database access (PGlite WASM in browser).",
  priority: 0,
  schema: schema,
  adapter(agentId, settings) {
    return createDatabaseAdapter(
      { dataDir: settings.PGLITE_DATA_DIR },
      agentId,
    );
  },
};

export default plugin;

export { DatabaseMigrationService } from "./migration-service";
