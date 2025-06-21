import type { IDatabaseAdapter, UUID } from '@elizaos/core';
import { type IAgentRuntime, type Plugin, logger } from '@elizaos/core';
import { PgliteDatabaseAdapter } from './pglite/adapter';
import { PGliteClientManager } from './pglite/manager';
import { PgDatabaseAdapter } from './pg/adapter';
import { PostgresConnectionManager } from './pg/manager';
import { resolvePgliteDir } from './utils';
import { setDatabaseType } from './schema/factory';
import { ensureCoreTablesExist, ensurePluginTablesExist } from './simple-migrator';

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
  const dataDir = resolvePgliteDir(config.dataDir);

  if (config.postgresUrl) {
    // Set database type for PostgreSQL
    setDatabaseType('postgres');

    if (!globalSingletons.postgresConnectionManager) {
      globalSingletons.postgresConnectionManager = new PostgresConnectionManager(
        config.postgresUrl
      );
    }
    return new PgDatabaseAdapter(agentId, globalSingletons.postgresConnectionManager);
  }

  // Set database type for PGLite
  setDatabaseType('pglite');

  if (!globalSingletons.pgLiteClientManager) {
    globalSingletons.pgLiteClientManager = new PGliteClientManager({ dataDir });
  }

  return new PgliteDatabaseAdapter(agentId, globalSingletons.pgLiteClientManager);
}

/**
 * SQL plugin for database adapter using Drizzle ORM
 */
export const plugin: Plugin & { runPluginMigrations?: Function; initializePluginSchema?: Function } = {
  name: '@elizaos/plugin-sql',
  description: 'A plugin for SQL database access with Drizzle ORM',
  priority: 0,
  init: async (_, runtime: IAgentRuntime) => {
    logger.info('plugin-sql init starting...');

    // Check if a database adapter is already registered
    try {
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

    // Ensure core tables exist right after adapter creation
    try {
      logger.info('🔧 SQL PLUGIN INIT: Running core table setup...');
      const db = (dbAdapter as any).db;
      logger.info('🔧 SQL PLUGIN INIT: Database handle info:', {
        hasDb: !!db,
        dbType: typeof db,
        dbConstructor: db?.constructor?.name,
        adapterType: dbAdapter.constructor.name,
      });
      if (db) {
        await ensureCoreTablesExist(db);
        logger.info('🔧 SQL PLUGIN INIT: Core table setup completed');
      } else {
        logger.warn('🔧 SQL PLUGIN INIT: No database handle available for table setup');
      }
    } catch (error) {
      logger.error('🔧 SQL PLUGIN INIT: Failed to ensure core tables exist:', error);
      // Don't fail initialization - this is a fallback
    }

    runtime.registerDatabaseAdapter(dbAdapter);
    logger.info('Database adapter created and registered');
  },

  // Plugin-level schema initialization function that runtime expects
  initializePluginSchema: async (drizzle: any, pluginName: string, schema: any) => {
    logger.info(`🔧 SQL PLUGIN: Initializing schema for plugin: ${pluginName}`);
    // Dynamic table loading - ensure tables exist based on schema
    try {
      await ensurePluginTablesExist(drizzle, pluginName, schema);
      logger.info(`🔧 SQL PLUGIN: Schema initialized successfully for plugin: ${pluginName}`);
    } catch (error) {
      logger.error(`🔧 SQL PLUGIN: Failed to initialize schema for plugin ${pluginName}:`, error);
      throw error;
    }
  },
};

export default plugin;

// Export utilities for direct use if needed
export { setDatabaseType } from './schema/factory';
export { resolvePgliteDir } from './utils';
