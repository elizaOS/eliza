import { mkdirSync } from "node:fs";
import type { IDatabaseAdapter, UUID } from "@elizaos/core";
import { type IAgentRuntime, logger, type Plugin } from "@elizaos/core";

export {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  lt,
  lte,
  ne,
  or,
  type SQL,
  sql,
} from "drizzle-orm";

import { PgDatabaseAdapter } from "./pg/adapter";
import { PostgresConnectionManager } from "./pg/manager";
import { PgliteDatabaseAdapter } from "./pglite/adapter";
import { PGliteClientManager } from "./pglite/manager";
import * as schema from "./schema";
import { AdvancedMemoryStorageService } from "./services/advanced-memory-storage";
import { resolvePgliteDir } from "./utils";
import { stringToUuid } from "./utils/string-to-uuid";

export type {
  AppendConnectorAccountAuditEventParams,
  ConnectorAccountAuditEventRecord,
  ConnectorAccountAuditOutcome,
  ConnectorAccountCredentialRefRecord,
  ConnectorAccountJsonObject,
  ConnectorAccountRecord,
  ConsumeOAuthFlowStateParams,
  CreateOAuthFlowStateParams,
  DeleteConnectorAccountParams,
  GetConnectorAccountCredentialRefParams,
  GetConnectorAccountParams,
  ListConnectorAccountCredentialRefsParams,
  ListConnectorAccountsParams,
  OAuthFlowRecord,
  SetConnectorAccountCredentialRefParams,
  UpsertConnectorAccountParams,
} from "@elizaos/core";
export * from "./connector-credential-store";
export * from "./pglite/errors";
export * from "./schema";
export type { DrizzleDatabase } from "./types";

const GLOBAL_SINGLETONS = Symbol.for("@elizaos/plugin-sql/global-singletons");

interface GlobalSingletons {
  pgLiteClientManager?: PGliteClientManager;
  postgresConnectionManager?: PostgresConnectionManager;
}

interface RuntimeWithAdapterRegistrar {
  adapter?: IDatabaseAdapter;
  databaseAdapter?: IDatabaseAdapter;
  getDatabaseAdapter?: () => IDatabaseAdapter | undefined;
  hasDatabaseAdapter?: () => boolean;
  registerDatabaseAdapter: (adapter: IDatabaseAdapter) => void;
}

const globalSymbols = globalThis as typeof globalThis & Record<symbol, GlobalSingletons>;

if (!globalSymbols[GLOBAL_SINGLETONS]) {
  globalSymbols[GLOBAL_SINGLETONS] = {};
}

const globalSingletons = globalSymbols[GLOBAL_SINGLETONS];

function shouldReusePgliteManager(manager: PGliteClientManager | undefined): boolean {
  if (!manager) {
    return false;
  }

  return !manager.isShuttingDown();
}

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

  if (!shouldReusePgliteManager(globalSingletons.pgLiteClientManager)) {
    globalSingletons.pgLiteClientManager = new PGliteClientManager({ dataDir });
  }

  const manager = globalSingletons.pgLiteClientManager;
  if (!manager) {
    throw new Error("[plugin-sql] pgLiteClientManager not initialized before adapter creation");
  }

  return new PgliteDatabaseAdapter(agentId, manager);
}

export const plugin: Plugin = {
  name: "@elizaos/plugin-sql",
  description: "A plugin for SQL database access with dynamic schema migrations",
  priority: 0,
  schema: schema,
  services: [AdvancedMemoryStorageService],
  init: async (_, runtime: IAgentRuntime) => {
    const runtimeWithAdapter = runtime as IAgentRuntime & RuntimeWithAdapterRegistrar;
    runtime.logger.info(
      { src: "plugin:sql", agentId: runtime.agentId },
      "plugin-sql init starting"
    );

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

    runtimeWithAdapter.registerDatabaseAdapter(dbAdapter);
    await dbAdapter.initialize();
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
export * from "./schema";
export { AdvancedMemoryStorageService } from "./services/advanced-memory-storage";
export * from "./types";
export { schema };
export * from "./drizzle";
