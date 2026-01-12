import { mkdirSync } from "node:fs";
import type { IDatabaseAdapter, UUID } from "@elizaos/core";
import { type IAgentRuntime, logger, type Plugin, stringToUuid } from "@elizaos/core";
import { PgDatabaseAdapter } from "./pg/adapter";
import { PostgresConnectionManager } from "./pg/manager";
import { PgliteDatabaseAdapter } from "./pglite/adapter";
import { PGliteClientManager } from "./pglite/manager";
import * as schema from "./schema";
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

export const plugin: Plugin = {
  name: "@elizaos/plugin-sql",
  description: "A plugin for SQL database access with dynamic schema migrations",
  priority: 0,
  schema: schema,
  init: async (_config, runtime: IAgentRuntime) => {
    runtime.logger.info(
      { src: "plugin:sql", agentId: runtime.agentId },
      "plugin-sql (node) init starting"
    );

    const adapterRegistered = await runtime
      .isReady()
      .then(() => true)
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("Database adapter not registered")) {
          runtime.logger.info(
            { src: "plugin:sql", agentId: runtime.agentId },
            "No pre-registered database adapter detected; registering adapter"
          );
        } else {
          runtime.logger.warn(
            { src: "plugin:sql", agentId: runtime.agentId, error: message },
            "Database adapter readiness check error; proceeding to register adapter"
          );
        }
        return false;
      });
    if (adapterRegistered) {
      runtime.logger.info(
        { src: "plugin:sql", agentId: runtime.agentId },
        "Database adapter already registered, skipping creation"
      );
      return;
    }

    const postgresUrl = runtime.getSetting("POSTGRES_URL");
    const dataDir = runtime.getSetting("PGLITE_DATA_DIR");

    const dbAdapter = createDatabaseAdapter(
      {
        dataDir: typeof dataDir === "string" ? dataDir : undefined,
        postgresUrl: typeof postgresUrl === "string" ? postgresUrl : undefined,
      },
      runtime.agentId
    );

    runtime.registerDatabaseAdapter(dbAdapter);
    runtime.logger.info(
      { src: "plugin:sql", agentId: runtime.agentId },
      "Database adapter created and registered"
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
