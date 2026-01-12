import { mkdirSync } from "node:fs";
import type { IDatabaseAdapter, UUID } from "@elizaos/core";
import { type IAgentRuntime, logger, type Plugin, stringToUuid } from "@elizaos/core";
import { PgDatabaseAdapter } from "./pg/adapter";
import { PostgresConnectionManager } from "./pg/manager";
import { PgliteDatabaseAdapter } from "./pglite/adapter";
import { PGliteClientManager } from "./pglite/manager";
import * as schema from "./schema";
import { resolvePgliteDir } from "./utils";

const GLOBAL_SINGLETONS = Symbol.for("@elizaos/plugin-sql/global-singletons");

interface GlobalSingletons {
  pgLiteClientManager?: PGliteClientManager;
  postgresConnectionManager?: PostgresConnectionManager;
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
    if (!globalSingletons.postgresConnectionManager) {
      const dataIsolationEnabled = process.env.ENABLE_DATA_ISOLATION === "true";
      let rlsServerId: string | undefined;
      if (dataIsolationEnabled) {
        const rlsServerIdString = process.env.ELIZA_SERVER_ID;
        if (!rlsServerIdString) {
          throw new Error(
            "[Data Isolation] ENABLE_DATA_ISOLATION=true requires ELIZA_SERVER_ID environment variable"
          );
        }
        rlsServerId = stringToUuid(rlsServerIdString);
        logger.debug(
          {
            src: "plugin:sql",
            rlsServerId: rlsServerId.slice(0, 8),
            serverIdString: rlsServerIdString,
          },
          "Creating connection pool with RLS server"
        );
      }

      globalSingletons.postgresConnectionManager = new PostgresConnectionManager(
        config.postgresUrl,
        rlsServerId
      );
    }
    return new PgDatabaseAdapter(agentId, globalSingletons.postgresConnectionManager);
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
  init: async (_, runtime: IAgentRuntime) => {
    runtime.logger.info(
      { src: "plugin:sql", agentId: runtime.agentId },
      "plugin-sql init starting"
    );

    interface RuntimeWithAdapter {
      adapter?: IDatabaseAdapter;
      hasDatabaseAdapter?: () => boolean;
      getDatabaseAdapter?: () => IDatabaseAdapter | undefined;
      databaseAdapter?: IDatabaseAdapter;
    }
    const runtimeWithAdapter = runtime as RuntimeWithAdapter;
    const adapterRegistered =
      typeof runtimeWithAdapter.hasDatabaseAdapter === "function"
        ? runtimeWithAdapter.hasDatabaseAdapter()
        : (() => {
            try {
              const existing =
                runtimeWithAdapter.getDatabaseAdapter?.() ??
                runtimeWithAdapter.databaseAdapter ??
                runtimeWithAdapter.adapter;
              return Boolean(existing);
            } catch {
              return false;
            }
          })();

    if (adapterRegistered) {
      runtime.logger.info(
        { src: "plugin:sql", agentId: runtime.agentId },
        "Database adapter already registered, skipping creation"
      );
      return;
    }

    runtime.logger.debug(
      { src: "plugin:sql", agentId: runtime.agentId },
      "No database adapter found, proceeding to register"
    );

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
export { schema };
