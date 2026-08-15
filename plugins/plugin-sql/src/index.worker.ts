/**
 * Cloudflare Workers entry point for `@elizaos/plugin-sql`: registers the
 * PostgreSQL adapter over a Hyperdrive-provided connection string. The pg
 * driver and drizzle-orm/node-postgres run on workerd under the
 * `nodejs_compat` flag, which is Cloudflare's documented combination for
 * Postgres access; the host passes `env.HYPERDRIVE.connectionString` to the
 * runtime as the `POSTGRES_URL` setting.
 *
 * No PGlite and no filesystem fallback: a Worker isolate has no durable disk,
 * so a missing connection string is a configuration error, not a cue to start
 * an embedded database. Postgres connection managers are cached per isolate
 * behind the same global symbol the node entry uses, so warm requests reuse
 * the pool instead of re-dialing Hyperdrive.
 */
import type { IDatabaseAdapter, UUID } from "@elizaos/core";
import { ElizaError, type IAgentRuntime, logger, type Plugin } from "@elizaos/core";
import {
  createAdapterReadinessError,
  describeAdapterReadinessError,
  isMissingDatabaseAdapterError,
} from "./adapter-readiness";
import { PgDatabaseAdapter } from "./pg/adapter";
import { PostgresConnectionManager } from "./pg/manager";
import * as schema from "./schema";
import { AdvancedMemoryStorageService } from "./services/advanced-memory-storage";
import { stringToUuid } from "./utils/string-to-uuid";

export * from "./schema";
export type { DrizzleDatabase } from "./types";

const GLOBAL_SINGLETONS = Symbol.for("elizaos.plugin-sql.global-singletons");

interface GlobalSingletons {
  postgresConnectionManagers?: Map<string, PostgresConnectionManager>;
}

interface RuntimeWithAdapterRegistrar {
  registerDatabaseAdapter: (adapter: IDatabaseAdapter) => void;
}

const globalSymbols = globalThis as typeof globalThis & Record<symbol, GlobalSingletons>;
if (!globalSymbols[GLOBAL_SINGLETONS]) {
  globalSymbols[GLOBAL_SINGLETONS] = {};
}
const globalSingletons = globalSymbols[GLOBAL_SINGLETONS];

function shouldReusePostgresManager(
  manager: PostgresConnectionManager | undefined
): manager is PostgresConnectionManager {
  if (!manager) {
    return false;
  }

  return !manager.isShuttingDown();
}

export function createDatabaseAdapter(
  config: {
    postgresUrl?: string;
    dataIsolationEnabled?: boolean;
    serverId?: string;
  },
  agentId: UUID
): IDatabaseAdapter {
  if (!config.postgresUrl) {
    throw new ElizaError(
      "plugin-sql (workerd): POSTGRES_URL is required. Pass the Hyperdrive binding's " +
        "connectionString (env.HYPERDRIVE.connectionString) to the runtime as POSTGRES_URL; " +
        "a Worker isolate has no disk for an embedded database fallback.",
      {
        code: "WORKER_POSTGRES_URL_REQUIRED",
        context: { entrypoint: "workerd" },
        severity: "fatal",
      }
    );
  }

  let rlsServerId: string | undefined;
  let managerKey = stringToUuid(config.postgresUrl);

  if (config.dataIsolationEnabled) {
    const rlsServerIdString = config.serverId;
    if (!rlsServerIdString) {
      throw new ElizaError(
        "[Data Isolation] ENABLE_DATA_ISOLATION=true requires the ELIZA_SERVER_ID runtime setting",
        {
          code: "DATA_ISOLATION_SERVER_ID_REQUIRED",
          context: { entrypoint: "workerd" },
          severity: "fatal",
        }
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

  if (!globalSingletons.postgresConnectionManagers) {
    globalSingletons.postgresConnectionManagers = new Map();
  }

  let manager = globalSingletons.postgresConnectionManagers.get(managerKey);
  if (!shouldReusePostgresManager(manager)) {
    logger.debug(
      { src: "plugin:sql", managerKey: managerKey.slice(0, 8) },
      "Creating new connection pool"
    );
    manager = new PostgresConnectionManager(config.postgresUrl, rlsServerId);
    globalSingletons.postgresConnectionManagers.set(managerKey, manager);
  }

  return new PgDatabaseAdapter(agentId, manager);
}

export const plugin: Plugin = {
  name: "@elizaos/plugin-sql",
  description: "A plugin for SQL database access with dynamic schema migrations",
  priority: 0,
  schema: schema,
  services: [AdvancedMemoryStorageService],
  init: async (_config, runtime: IAgentRuntime) => {
    const runtimeWithAdapter = runtime as IAgentRuntime & RuntimeWithAdapterRegistrar;
    runtime.logger.info(
      { src: "plugin:sql", agentId: runtime.agentId },
      "plugin-sql (workerd) init starting"
    );

    const adapterRegistered = await runtime
      .isReady()
      .then(() => true)
      .catch((error: unknown) => {
        const message = describeAdapterReadinessError(error);
        if (isMissingDatabaseAdapterError(error)) {
          runtime.logger.info(
            { src: "plugin:sql", agentId: runtime.agentId },
            "No pre-registered database adapter detected; registering adapter"
          );
          return false;
        }
        runtime.logger.error(
          { src: "plugin:sql", agentId: runtime.agentId, error: message },
          "Database adapter readiness check failed"
        );
        throw createAdapterReadinessError(error, {
          agentId: runtime.agentId,
          entrypoint: "workerd",
        });
      });
    if (adapterRegistered) {
      runtime.logger.info(
        { src: "plugin:sql", agentId: runtime.agentId },
        "Database adapter already registered, skipping creation"
      );
      return;
    }

    const postgresUrl = runtime.getSetting("POSTGRES_URL");
    const dataIsolationSetting = runtime.getSetting("ENABLE_DATA_ISOLATION");
    const serverId = runtime.getSetting("ELIZA_SERVER_ID");

    const dbAdapter = createDatabaseAdapter(
      {
        postgresUrl: typeof postgresUrl === "string" ? postgresUrl : undefined,
        dataIsolationEnabled: dataIsolationSetting === true || dataIsolationSetting === "true",
        serverId: typeof serverId === "string" ? serverId : undefined,
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
  async dispose(runtime) {
    await runtime
      .getService<AdvancedMemoryStorageService>(AdvancedMemoryStorageService.serviceType)
      ?.stop();
  },
};

export default plugin;
