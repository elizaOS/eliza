import * as os from 'node:os';
import type { IDatabaseAdapter, UUID } from '@elizaos/core';
import { type IAgentRuntime, type Plugin, logger } from '@elizaos/core';
import { MySql2DatabaseAdapter } from './mysql2/adapter';
import { MySql2ConnectionManager } from './mysql2/manager';

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
const GLOBAL_SINGLETONS = Symbol.for('@elizaos/plugin-mysql/global-singletons');

interface GlobalSingletons {
  mysqlConnectionManager?: MySql2ConnectionManager;
}

const globalSymbols = global as unknown as Record<symbol, GlobalSingletons>;

if (!globalSymbols[GLOBAL_SINGLETONS]) {
  globalSymbols[GLOBAL_SINGLETONS] = {};
}

const globalSingletons = globalSymbols[GLOBAL_SINGLETONS];

/**
 * Helper function to expand tilde in paths
 */
function expandTildePath(filepath: string): string {
  if (filepath && typeof filepath === 'string' && filepath.startsWith('~')) {
    return filepath.replace(/^~/, os.homedir());
  }
  return filepath;
}

/**
 * Creates a database adapter based on the provided configuration.
 * If a postgresUrl is provided in the config, a PgDatabaseAdapter is initialized using the PostgresConnectionManager.
 * If no postgresUrl is provided, a PgliteDatabaseAdapter is initialized using PGliteClientManager with the dataDir from the config.
 *
 * @param {object} config - The configuration object.
 * @param {string} [config.dataDir] - The directory where data is stored. Defaults to "./elizadb".
 * @param {string} [config.postgresUrl] - The URL for the PostgreSQL database.
 * @param {UUID} agentId - The unique identifier for the agent.
 * @returns {IDatabaseAdapter} The created database adapter.
 */
export function createDatabaseAdapter(
  config: {
    mysqlUrl?: string;
  },
  agentId: UUID
): IDatabaseAdapter {
  logger.debug('Creating MySQL database adapter with config:', config);
  if (config.mysqlUrl) {
    if (!globalSingletons.mysqlConnectionManager) {
      globalSingletons.mysqlConnectionManager = new MySql2ConnectionManager(config.mysqlUrl);
    }
  }

  if (!globalSingletons.mysqlConnectionManager) {
    throw new Error('MySQL connection manager not initialized');
  }

  return new MySql2DatabaseAdapter(agentId, globalSingletons.mysqlConnectionManager);
}

/**
 * MySQL plugin for database adapter using Drizzle ORM
 *
 * @typedef {Object} Plugin
 * @property {string} name - The name of the plugin
 * @property {string} description - The description of the plugin
 * @property {Function} init - The initialization function for the plugin
 * @param {any} _ - Input parameter
 * @param {IAgentRuntime} runtime - The runtime environment for the agent
 */
const mysqlPlugin: Plugin = {
  name: 'mysql',
  description: 'MySQL database adapter plugin using Drizzle ORM',
  init: async (_, runtime: IAgentRuntime) => {
    const config = {
      mysqlUrl: runtime.getSetting('MYSQL_URL'),
    };

    logger.debug('MySQL config:', config);

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

export default mysqlPlugin;
