import type { IDatabaseAdapter, UUID } from '@elizaos/core';
import { type IAgentRuntime, type Plugin, logger, stringToUuid } from '@elizaos/core';
import { PgliteDatabaseAdapter } from './pglite/adapter';
import { PGliteClientManager } from './pglite/manager';
import { PgDatabaseAdapter } from './pg/adapter';
import { PostgresConnectionManager } from './pg/manager';
import { resolvePgliteDir } from './utils';
import * as schema from './schema';

/**
 * Global Singleton Instances (Package-scoped)
 *
 * These instances are stored globally within the package scope to ensure a single shared instance across multiple adapters within this package.
 * This approach prevents multiple instantiations due to module caching or multiple imports within the same process.
 *
 * IMPORTANT:
 * - Do NOT directly modify these instances outside their intended initialization logic.
 * - These instances are NOT exported and should NOT be accessed outside this package.
 */
const GLOBAL_SINGLETONS = Symbol.for('@elizaos/plugin-sql/global-singletons');

interface GlobalSingletons {
  pgLiteClientManager?: PGliteClientManager;
  postgresConnectionManager?: PostgresConnectionManager;
}

const globalSymbols = globalThis as unknown as Record<symbol, GlobalSingletons>;

if (!globalSymbols[GLOBAL_SINGLETONS]) {
  globalSymbols[GLOBAL_SINGLETONS] = {};
}

const globalSingletons = globalSymbols[GLOBAL_SINGLETONS];

/**
 * Creates a database adapter based on the provided configuration.
 * If a postgresUrl is provided in the config, a PgDatabaseAdapter is initialized using the PostgresConnectionManager.
 * If no postgresUrl is provided, a PgliteDatabaseAdapter is initialized using PGliteClientManager with the dataDir from the config.
 *
 * @param {object} config - The configuration object.
 * @param {string} [config.dataDir] - The directory where data is stored. Defaults to "./.eliza/.elizadb".
 * @param {string} [config.postgresUrl] - The URL for the PostgreSQL database.
 * @param {UUID} agentId - The unique identifier for the agent.
 * @returns {IDatabaseAdapter} The created database adapter.
 */
export function createDatabaseAdapter(
  config: {
    dataDir?: string;
    postgresUrl?: string;
  },
  agentId: UUID
): IDatabaseAdapter {
  if (config.postgresUrl) {
    if (!globalSingletons.postgresConnectionManager) {
      // Determine RLS owner_id if RLS isolation is enabled
      const rlsEnabled = process.env.ENABLE_RLS_ISOLATION === 'true';
      let rlsOwnerId: string | undefined;
      if (rlsEnabled) {
        const rlsOwnerIdString = process.env.RLS_OWNER_ID;
        if (!rlsOwnerIdString) {
          throw new Error(
            '[RLS] ENABLE_RLS_ISOLATION=true requires RLS_OWNER_ID environment variable'
          );
        }
        rlsOwnerId = stringToUuid(rlsOwnerIdString);
        logger.debug(
          `[RLS] Creating connection pool with owner_id: ${rlsOwnerId.slice(0, 8)}… (from RLS_OWNER_ID="${rlsOwnerIdString}")`
        );
      }

      globalSingletons.postgresConnectionManager = new PostgresConnectionManager(
        config.postgresUrl,
        rlsOwnerId
      );
    }
    return new PgDatabaseAdapter(agentId, globalSingletons.postgresConnectionManager);
  }

  // Only resolve PGLite directory when we're actually using PGLite
  const dataDir = resolvePgliteDir(config.dataDir);

  if (!globalSingletons.pgLiteClientManager) {
    globalSingletons.pgLiteClientManager = new PGliteClientManager({ dataDir });
  }

  return new PgliteDatabaseAdapter(agentId, globalSingletons.pgLiteClientManager);
}

/**
 * SQL plugin for database adapter using Drizzle ORM with dynamic plugin schema migrations
 *
 * @typedef {Object} Plugin
 * @property {string} name - The name of the plugin
 * @property {string} description - The description of the plugin
 * @property {Function} init - The initialization function for the plugin
 * @param {any} _ - Input parameter
 * @param {IAgentRuntime} runtime - The runtime environment for the agent
 */
export const plugin: Plugin = {
  name: '@elizaos/plugin-sql',
  description: 'A plugin for SQL database access with dynamic schema migrations',
  priority: 0,
  schema: schema,
  init: async (_, runtime: IAgentRuntime) => {
    logger.info('plugin-sql init starting...');

    // Prefer direct check for existing adapter (avoid readiness heuristics)
    const adapterRegistered =
      typeof (runtime as any).hasDatabaseAdapter === 'function'
        ? (runtime as any).hasDatabaseAdapter()
        : (() => {
            try {
              const existing =
                (runtime as any).getDatabaseAdapter?.() ??
                (runtime as any).databaseAdapter ??
                (runtime as any).adapter;
              return Boolean(existing);
            } catch {
              return false;
            }
          })();

    if (adapterRegistered) {
      logger.info('Database adapter already registered, skipping creation');
      return;
    }

    logger.debug('No database adapter found, proceeding to register new adapter');

    // Get database configuration from runtime settings
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

    // Note: DatabaseMigrationService is not registered as a runtime service
    // because migrations are handled at the server level before agents are loaded
  },
};

export default plugin;

// Export additional utilities that may be needed by consumers
export { DatabaseMigrationService } from './migration-service';
export {
  installRLSFunctions,
  getOrCreateRlsOwner,
  setOwnerContext,
  assignAgentToOwner,
  applyRLSToNewTables,
  uninstallRLS,
} from './rls';
export { schema };
