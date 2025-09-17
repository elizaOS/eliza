import type { IDatabaseAdapter, UUID } from '@elizaos/core';
import { type IAgentRuntime, type Plugin, logger } from '@elizaos/core';
import { PgliteDatabaseAdapter } from './pglite/adapter';
import { PGliteClientManager } from './pglite/manager';
import { PgDatabaseAdapter } from './pg/adapter';
import { PostgresConnectionManager } from './pg/manager';
import { resolvePgliteDir } from './utils.node';
import * as schema from './schema';

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
  },
};

export default plugin;

export { DatabaseMigrationService } from './migration-service';
