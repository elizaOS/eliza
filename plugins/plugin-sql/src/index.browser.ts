/**
 * Browser entry point for `@elizaos/plugin-sql`: registers a PGlite
 * (WASM-only) `IDatabaseAdapter`, backed by a process-global, per-agent
 * `PGliteClientManager` singleton cache so repeated imports never spin up
 * duplicate PGlite instances. No PostgreSQL support — see `index.node.ts`
 * for the Node/Bun entry that adds it.
 */
import {
  type IAgentRuntime,
  type IDatabaseAdapter,
  logger,
  type Plugin,
  type UUID,
} from "@elizaos/core";
import { PgliteDatabaseAdapter } from "./pglite/adapter";
import { PGliteClientManager } from "./pglite/manager";
import {
  type ClosePgliteSingletonResult,
  dropActivePgliteManager,
  getOrCreatePgliteManagerForAgent,
  type PgliteManagerCache,
  type PgliteSingletonCache,
} from "./pglite/manager-cache";
import * as schema from "./schema";
import { AdvancedMemoryStorageService } from "./services/advanced-memory-storage";

const GLOBAL_SINGLETONS = Symbol.for("elizaos.plugin-sql.global-singletons");

type GlobalSingletons = PgliteManagerCache<PGliteClientManager>;

interface RuntimeWithAdapterRegistrar {
  registerDatabaseAdapter: (adapter: IDatabaseAdapter) => void;
}

const globalSymbols = globalThis as typeof globalThis & Record<symbol, GlobalSingletons>;
if (!globalSymbols[GLOBAL_SINGLETONS]) {
  globalSymbols[GLOBAL_SINGLETONS] = {};
}
const globalSingletons = globalSymbols[GLOBAL_SINGLETONS];

function getOrCreatePgliteManager(agentId: UUID): PGliteClientManager {
  return getOrCreatePgliteManagerForAgent(globalSingletons, undefined, agentId, () => {
    return new PGliteClientManager({ agentId });
  });
}

export function createDatabaseAdapter(
  _config: { dataDir?: string },
  agentId: UUID
): IDatabaseAdapter {
  return new PgliteDatabaseAdapter(agentId, getOrCreatePgliteManager(agentId));
}

/**
 * Close and drop the process-global PGlite singleton manager.
 *
 * Awaits the manager's `close()` bounded by `timeoutMs` (default 1000ms), then
 * removes it from the singleton cache so the next `createDatabaseAdapter()`
 * builds a fresh manager. Returns whether a manager was closed and whether
 * close() timed out.
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

export const plugin: Plugin = {
  name: "@elizaos/plugin-sql",
  description: "A plugin for SQL database access (PGlite WASM in browser).",
  priority: 0,
  schema: schema,
  services: [AdvancedMemoryStorageService],
  init: async (_config, runtime: IAgentRuntime) => {
    const runtimeWithAdapter = runtime as IAgentRuntime & RuntimeWithAdapterRegistrar;
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
    runtimeWithAdapter.registerDatabaseAdapter(dbAdapter);
    await dbAdapter.initialize();
    logger.info({ src: "plugin:sql" }, "Browser database adapter (PGlite) created and registered");
  },
  async dispose(runtime) {
    await runtime
      .getService<AdvancedMemoryStorageService>(AdvancedMemoryStorageService.serviceType)
      ?.stop();
  },
};

export default plugin;

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
export { DatabaseMigrationService } from "./migration-service";
export * from "./pglite/errors";
export type {
  ClosePgliteSingletonResult,
  PgliteSingletonCache,
  PgliteSingletonManager,
} from "./pglite/manager-cache";
export * from "./schema";
export { AdvancedMemoryStorageService } from "./services/advanced-memory-storage";
export type { DrizzleDatabase } from "./types";
