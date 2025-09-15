import {
  type IAgentRuntime,
  type IDatabaseAdapter,
  type UUID,
  type Plugin,
  logger,
} from '@elizaos/core/browser';
import { PgliteDatabaseAdapter } from './pglite/adapter';
import { PGliteClientManager } from './pglite/manager';
import * as schema from './schema';

/**
 * Browser-safe entrypoint for @elizaos/plugin-sql
 *
 * This entrypoint only uses the PGlite (WASM) path and avoids any Node/Postgres-only
 * code or Node builtins, so it can be safely bundled into browser/client environments.
 */

// Global singletons (browser-safe)
const GLOBAL_SINGLETONS = Symbol.for('@elizaos/plugin-sql/global-singletons');

interface GlobalSingletons {
  pgLiteClientManager?: PGliteClientManager;
}

const globalSymbols = globalThis as unknown as Record<symbol, GlobalSingletons>;
if (!globalSymbols[GLOBAL_SINGLETONS]) {
  globalSymbols[GLOBAL_SINGLETONS] = {};
}
const globalSingletons = globalSymbols[GLOBAL_SINGLETONS];

/**
 * Create a PGlite adapter for the browser (in-memory by default).
 * No Postgres fallback in browser builds.
 */
export function createDatabaseAdapter(
  _config: { dataDir?: string },
  agentId: UUID
): IDatabaseAdapter {
  if (!globalSingletons.pgLiteClientManager) {
    // Use in-memory PGlite by default in the browser.
    globalSingletons.pgLiteClientManager = new PGliteClientManager({});
  }
  return new PgliteDatabaseAdapter(agentId, globalSingletons.pgLiteClientManager);
}

export const plugin: Plugin = {
  name: '@elizaos/plugin-sql',
  description: 'A plugin for SQL database access (PGlite WASM in browser).',
  priority: 0,
  schema: schema,
  init: async (_config, runtime: IAgentRuntime) => {
    logger.info('plugin-sql (browser) init starting...');

    // Skip if adapter already exists
    // Always register the browser adapter in client builds

    // In browser builds, always use PGlite (in-memory unless configured elsewhere in runtime)
    const dbAdapter = createDatabaseAdapter({}, runtime.agentId);
    runtime.registerDatabaseAdapter(dbAdapter);
    logger.info('Browser database adapter (PGlite) created and registered');
  },
};

export default plugin;

export { DatabaseMigrationService } from './migration-service';
