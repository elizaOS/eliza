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
import {
  type LiveNamespace,
  PGliteClientManager,
  type PgliteSyncStatus,
  type PgliteSyncTableStatus,
} from "./pglite/manager";
import {
  type ClosePgliteSingletonResult,
  dropActivePgliteManager,
  getActivePgliteManager,
  getOrCreatePgliteManagerForAgent,
  type PgliteManagerCache,
  type PgliteSingletonCache,
} from "./pglite/manager-cache";
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
export type { LiveNamespace, PgliteSyncStatus, PgliteSyncTableStatus } from "./pglite/manager";
export type {
  ClosePgliteSingletonResult,
  PgliteSingletonCache,
  PgliteSingletonManager,
} from "./pglite/manager-cache";
export * from "./schema";
export type { DrizzleDatabase } from "./types";

const GLOBAL_SINGLETONS = Symbol.for("elizaos.plugin-sql.global-singletons");

interface GlobalSingletons extends PgliteManagerCache<PGliteClientManager> {
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
    dataDir?: string;
    postgresUrl?: string;
  },
  agentId: UUID
): IDatabaseAdapter {
  if (config.postgresUrl) {
    let manager = globalSingletons.postgresConnectionManager;
    if (!shouldReusePostgresManager(manager)) {
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

      manager = new PostgresConnectionManager(config.postgresUrl, rlsServerId);
      globalSingletons.postgresConnectionManager = manager;
    }
    return new PgDatabaseAdapter(agentId, manager);
  }

  const dataDir = resolvePgliteDir(config.dataDir);

  // `:memory:` is PGlite's in-memory sentinel, not a real path. On Windows the
  // reserved `:` makes mkdirSync throw (on POSIX it silently creates a junk
  // `:memory:` directory), so skip directory creation for it and for URLs.
  if (dataDir && !dataDir.includes("://") && dataDir !== ":memory:") {
    mkdirSync(dataDir, { recursive: true });
  }

  const manager = getOrCreatePgliteManagerForAgent(globalSingletons, dataDir, agentId, () => {
    return new PGliteClientManager({ dataDir, agentId });
  });

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
  async dispose(runtime) {
    await runtime
      .getService<AdvancedMemoryStorageService>(AdvancedMemoryStorageService.serviceType)
      ?.stop();
  },
};

export default plugin;

export * from "./drizzle";
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

/**
 * Query the live Electric Sync status from the global PGliteClientManager
 * singleton. Returns "disabled" when no manager exists or sync is not
 * configured, and "syncing" / "synced" / "error" at runtime as the sync
 * client transitions.
 */
export function getPgliteSyncStatus(): {
  status: PgliteSyncStatus;
  error: string | null;
  tables: PgliteSyncTableStatus;
  synced: string[];
} {
  const manager = getActivePgliteManager(globalSingletons);
  if (!manager) {
    return { status: "disabled", error: null, tables: {}, synced: [] };
  }
  return manager.getSyncStatus();
}

/**
 * Access the PGlite live query namespace from the global singleton.
 * Returns null when the PGlite adapter is not in use or extensions are disabled.
 * Use for reactive dashboard queries via pg.live.query() / incrementalQuery() / changes().
 */
export function getPgliteLiveNamespace(): LiveNamespace | null {
  const manager = globalSingletons.pgLiteClientManager;
  if (!manager) return null;
  return manager.liveQuery();
}

/**
 * Force-reset the Electric Sync stream for the current agent.
 * Drops the electric schema, unsubscribes the current stream,
 * and starts a fresh sync from the source Postgres.
 * Returns the sync status after the reset, or null when sync is not configured.
 */
export async function forcePgliteResync(): Promise<{
  status: PgliteSyncStatus;
  error: string | null;
  tables: PgliteSyncTableStatus;
  synced: string[];
} | null> {
  const manager = globalSingletons.pgLiteClientManager;
  if (!manager) return null;
  return manager.forceResync();
}

/**
 * Close and drop the process-global PGlite singleton manager.
 *
 * Awaits the manager's `close()` bounded by `timeoutMs` (default 1000ms), then
 * removes it from the singleton cache so the next `createDatabaseAdapter()`
 * builds a fresh manager. Used by hosts recovering from a corrupt PGlite data
 * directory. Returns whether a manager was closed and whether close() timed out.
 */
export async function closePgliteSingleton(options?: {
  timeoutMs?: number;
}): Promise<ClosePgliteSingletonResult> {
  const manager = globalSingletons.pgLiteClientManager;
  if (!manager) {
    return { closed: false, timedOut: false, error: null };
  }

  let timedOut = false;
  let error: Error | null = null;
  const timeoutMs = options?.timeoutMs ?? 1_000;
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

  try {
    await Promise.race([
      Promise.resolve(manager.close()),
      new Promise<void>((resolve) => {
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          resolve();
        }, timeoutMs);
      }),
    ]);
  } catch (err) {
    error = err instanceof Error ? err : new Error(String(err));
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }

  dropActivePgliteManager(globalSingletons, manager);
  return { closed: true, timedOut, error };
}

/**
 * Public handle onto the process-global PGlite singleton cache. Lets a host
 * pre-seed or inspect the active manager (e.g. a browser bundle that
 * pre-initializes PGlite with custom asset loading) without hand-copying the
 * private `Symbol.for("elizaos.plugin-sql.global-singletons")`.
 */
export function getPgliteSingletonCache(): PgliteSingletonCache {
  return globalSingletons;
}
