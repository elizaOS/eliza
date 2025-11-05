import type { IDatabaseAdapter, UUID } from '@elizaos/core';
import { type IAgentRuntime, type Plugin, logger, stringToUuid } from '@elizaos/core';
import { PgliteDatabaseAdapter } from './pglite/adapter';
import { PGliteClientManager } from './pglite/manager';
import { PgDatabaseAdapter } from './pg/adapter';
import { PostgresConnectionManager } from './pg/manager';
import { resolvePgliteDir } from './utils.node';
import * as schema from './schema';

const GLOBAL_SINGLETONS = Symbol.for('@elizaos/plugin-sql/global-singletons');

interface GlobalSingletons {
  pgLiteClientManager?: PGliteClientManager;
  // Map of PostgreSQL connection managers by owner_id (for RLS multi-tenancy)
  // Key: owner_id (or 'default' for non-RLS mode)
  postgresConnectionManagers?: Map<string, PostgresConnectionManager>;
}

const globalSymbols = globalThis as unknown as Record<symbol, GlobalSingletons>;
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
    // Determine RLS owner_id if RLS isolation is enabled
    const rlsEnabled = process.env.ENABLE_RLS_ISOLATION === 'true';
    let rlsOwnerId: string | undefined;
    let managerKey = 'default'; // Key for connection manager map

    if (rlsEnabled) {
      const rlsOwnerIdString = process.env.RLS_OWNER_ID;
      if (!rlsOwnerIdString) {
        throw new Error(
          '[RLS] ENABLE_RLS_ISOLATION=true requires RLS_OWNER_ID environment variable'
        );
      }
      rlsOwnerId = stringToUuid(rlsOwnerIdString);
      managerKey = rlsOwnerId; // Use owner_id as key for multi-tenancy
      logger.debug(
        `[RLS] Using connection pool for owner_id: ${rlsOwnerId.slice(0, 8)}… (from RLS_OWNER_ID="${rlsOwnerIdString}")`
      );
    }

    // Initialize connection managers map if needed
    if (!globalSingletons.postgresConnectionManagers) {
      globalSingletons.postgresConnectionManagers = new Map();
    }

    // Get or create connection manager for this owner_id
    let manager = globalSingletons.postgresConnectionManagers.get(managerKey);
    if (!manager) {
      logger.debug(`[RLS] Creating new connection pool for key: ${managerKey.slice(0, 8)}…`);
      manager = new PostgresConnectionManager(config.postgresUrl, rlsOwnerId);
      globalSingletons.postgresConnectionManagers.set(managerKey, manager);
    }

    return new PgDatabaseAdapter(agentId, manager);
  }

  const dataDir = resolvePgliteDir(config.dataDir);
  if (!globalSingletons.pgLiteClientManager) {
    globalSingletons.pgLiteClientManager = new PGliteClientManager({ dataDir });
  }
  return new PgliteDatabaseAdapter(agentId, globalSingletons.pgLiteClientManager);
}

export const plugin: Plugin = {
  name: '@elizaos/plugin-sql',
  description: 'A plugin for SQL database access with dynamic schema migrations',
  priority: 0,
  schema: schema,
  init: async (_config, runtime: IAgentRuntime) => {
    logger.info('plugin-sql (node) init starting...');

    const adapterRegistered = await runtime
      .isReady()
      .then(() => true)
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes('Database adapter not registered')) {
          // Expected on first load before the adapter is created; not a warning condition
          logger.info('No pre-registered database adapter detected; registering adapter');
        } else {
          // Unexpected readiness error - keep as a warning with details
          logger.warn(
            { error },
            'Database adapter readiness check error; proceeding to register adapter'
          );
        }
        return false;
      });
    if (adapterRegistered) {
      logger.info('Database adapter already registered, skipping creation');
      return;
    }

    const postgresUrl = runtime.getSetting('POSTGRES_URL');
    // Only support PGLITE_DATA_DIR going forward
    const dataDir = runtime.getSetting('PGLITE_DATA_DIR') || undefined;

    const dbAdapter = createDatabaseAdapter(
      {
        dataDir,
        postgresUrl,
      },
      runtime.agentId
    );

    runtime.registerDatabaseAdapter(dbAdapter);
    logger.info('Database adapter created and registered');
  },
};

export default plugin;

export { DatabaseMigrationService } from './migration-service';
export {
  installRLSFunctions,
  getOrCreateRlsOwner,
  setOwnerContext,
  assignAgentToOwner,
  applyRLSToNewTables,
  uninstallRLS,
} from './rls';
