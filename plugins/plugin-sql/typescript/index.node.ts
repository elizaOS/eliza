import { mkdirSync } from "node:fs";
import type { IDatabaseAdapter, UUID } from "@elizaos/core";
import { logger, type Plugin, stringToUuid } from "@elizaos/core";
import { PgDatabaseAdapter } from "./pg/adapter";
import { PostgresConnectionManager } from "./pg/manager";
import { PgliteDatabaseAdapter } from "./pglite/adapter";
import { PGliteClientManager } from "./pglite/manager";
import * as schema from './tables';
import { resolvePgliteDir } from "./utils.node";

const GLOBAL_SINGLETONS = Symbol.for("@elizaos/plugin-sql/global-singletons");

interface GlobalSingletons {
  pgLiteClientManager?: PGliteClientManager;
  postgresConnectionManagers?: Map<string, PostgresConnectionManager>;
}

const globalSymbols = globalThis as typeof globalThis & Record<symbol, GlobalSingletons>;
if (!globalSymbols[GLOBAL_SINGLETONS]) {
  globalSymbols[GLOBAL_SINGLETONS] = {};
}
const globalSingletons = globalSymbols[GLOBAL_SINGLETONS];

export function createDatabaseAdapter(
  config: {
    dataDir?: string;
    postgresUrl?: string;
  },
  agentId: UUID
): IDatabaseAdapter {
  if (config.postgresUrl) {
    const dataIsolationEnabled = process.env.ENABLE_DATA_ISOLATION === "true";
    let rlsServerId: string | undefined;
    let managerKey = "default";

    if (dataIsolationEnabled) {
      const rlsServerIdString = process.env.ELIZA_SERVER_ID;
      if (!rlsServerIdString) {
        throw new Error(
          "[Data Isolation] ENABLE_DATA_ISOLATION=true requires ELIZA_SERVER_ID environment variable"
        );
      }
      rlsServerId = stringToUuid(rlsServerIdString);
      managerKey = rlsServerId;
      logger.debug(
        {
          src: "plugin:sql",
          rlsServerId: rlsServerId.slice(0, 8),
          serverIdString: rlsServerIdString,
        },
        "Using connection pool for RLS server"
      );
    }

    // Initialize connection managers map if needed
    if (!globalSingletons.postgresConnectionManagers) {
      globalSingletons.postgresConnectionManagers = new Map();
    }

    // Get or create connection manager for this server_id
    let manager = globalSingletons.postgresConnectionManagers.get(managerKey);
    if (!manager) {
      logger.debug(
        { src: "plugin:sql", managerKey: managerKey.slice(0, 8) },
        "Creating new connection pool"
      );
      manager = new PostgresConnectionManager(config.postgresUrl, rlsServerId);
      globalSingletons.postgresConnectionManagers.set(managerKey, manager);
    }

    return new PgDatabaseAdapter(agentId, manager);
  }

  const dataDir = resolvePgliteDir(config.dataDir);

  if (dataDir && !dataDir.includes("://")) {
    mkdirSync(dataDir, { recursive: true });
  }

  if (!globalSingletons.pgLiteClientManager) {
    globalSingletons.pgLiteClientManager = new PGliteClientManager({ dataDir });
  }
  return new PgliteDatabaseAdapter(agentId, globalSingletons.pgLiteClientManager);
}

/** Schema-only plugin: contributes migration schemas. Adapter must be created via createDatabaseAdapter() and passed to AgentRuntime constructor. */
export const plugin: Plugin = {
  name: "@elizaos/plugin-sql",
  description: "A plugin for SQL database access with dynamic schema migrations",
  priority: 0,
  schema: schema,
  adapter(agentId, settings) {
    const postgresUrl = settings.POSTGRES_URL || settings.DATABASE_URL;
    return createDatabaseAdapter(
      postgresUrl ? { postgresUrl } : { dataDir: settings.PGLITE_DATA_DIR },
      agentId,
    );
  },
};

export default plugin;

export { DatabaseMigrationService } from "./migration-service";
export {
  applyRLSToNewTables,
  assignAgentToServer,
  getOrCreateRlsServer,
  installRLSFunctions,
  setServerContext,
  uninstallRLS,
} from "./rls";
