import type { IDatabaseAdapter, UUID } from '@elizaos/core';
import { type IAgentRuntime, type Plugin, logger } from '@elizaos/core';
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

const globalSymbols = global as unknown as Record<symbol, GlobalSingletons>;

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
      globalSingletons.postgresConnectionManager = new PostgresConnectionManager(
        config.postgresUrl
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
  schema,
  init: async (_, runtime: IAgentRuntime) => {
    logger.info('plugin-sql init starting...');

    // Check if a database adapter is already registered
    try {
      // Try to access the database adapter to see if one exists
      const existingAdapter = (runtime as any).databaseAdapter;
      if (existingAdapter) {
        logger.info('Database adapter already registered, skipping creation');
        return;
      }
    } catch (error) {
      // No adapter exists, continue with creation
    }

    // Get database configuration from runtime settings
    const postgresUrl = runtime.getSetting('POSTGRES_URL');
    const dataDir =
      runtime.getSetting('PGLITE_PATH') ||
      runtime.getSetting('DATABASE_PATH') ||
      './.eliza/.elizadb';

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
export { schema };
