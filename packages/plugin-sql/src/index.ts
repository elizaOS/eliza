// Import shim first to ensure __filename and __dirname are available for better-sqlite3
import './shim';

import type { IDatabaseAdapter, UUID } from '@elizaos/core';
import { type IAgentRuntime, type Plugin, logger } from '@elizaos/core';
import { SqliteDatabaseAdapter } from './sqlite/adapter';
import { SqliteClientManager } from './sqlite/manager';
import { PgDatabaseAdapter } from './pg/adapter';
import { PostgresConnectionManager } from './pg/manager';
import { resolveSqliteDir } from './utils';

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
  sqliteClientManager?: SqliteClientManager;
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
 * If no postgresUrl is provided, a SqliteDatabaseAdapter is initialized using SqliteClientManager with the dataDir from the config.
 *
 * @param {object} config - The configuration object.
 * @param {string} [config.dataDir] - The directory where data is stored. Defaults to "./.elizadb".
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
  const dataDir = resolveSqliteDir(config.dataDir);

  if (config.postgresUrl) {
    if (!globalSingletons.postgresConnectionManager) {
      globalSingletons.postgresConnectionManager = new PostgresConnectionManager(
        config.postgresUrl
      );
    }
    return new PgDatabaseAdapter(agentId, globalSingletons.postgresConnectionManager);
  }

  if (!globalSingletons.sqliteClientManager) {
    globalSingletons.sqliteClientManager = new SqliteClientManager(dataDir);
  }

  return new SqliteDatabaseAdapter(agentId, globalSingletons.sqliteClientManager);
}

/**
 * SQL plugin for database adapter using Drizzle ORM
 *
 * @typedef {Object} Plugin
 * @property {string} name - The name of the plugin
 * @property {string} description - The description of the plugin
 * @property {Function} init - The initialization function for the plugin
 * @param {any} _ - Input parameter
 * @param {IAgentRuntime} runtime - The runtime environment for the agent
 */
const sqlPlugin: Plugin = {
  name: 'sql',
  description: 'SQL database adapter plugin using Drizzle ORM with PostgreSQL and SQLite support',
  init: async (_, runtime: IAgentRuntime) => {
    const config = {
      dataDir: resolveSqliteDir(runtime.getSetting('SQLITE_DATA_DIR') as string | undefined),
      postgresUrl: runtime.getSetting('POSTGRES_URL'),
    };

    try {
      const db = createDatabaseAdapter(config, runtime.agentId);
      logger.success('Database connection established successfully');
      runtime.registerDatabaseAdapter(db);
    } catch (error) {
      logger.error('Failed to initialize database:', error);
      throw error;
    }
  },
};

export default sqlPlugin;
