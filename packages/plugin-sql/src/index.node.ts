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
      // Determine RLS owner_id if RLS isolation is enabled
      let rlsOwnerId: string | undefined;
      if (process.env.ENABLE_RLS_ISOLATION === 'true') {
        const authToken = process.env.ELIZA_SERVER_AUTH_TOKEN;
        if (authToken) {
          rlsOwnerId = stringToUuid(authToken);
          logger.debug(`[RLS] Creating connection pool with owner_id: ${rlsOwnerId}`);
        } else {
          logger.warn('[RLS] ENABLE_RLS_ISOLATION is true but ELIZA_SERVER_AUTH_TOKEN is not set');
        }
      }

      globalSingletons.postgresConnectionManager = new PostgresConnectionManager(
        config.postgresUrl,
        rlsOwnerId
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
  getOwnerFromAuthToken,
  setOwnerContext,
  assignAgentToOwner,
  applyRLSToNewTables,
  uninstallRLS,
} from './rls';
