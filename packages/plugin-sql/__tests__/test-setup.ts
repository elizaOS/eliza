import { PGliteClientManager } from '../src/pglite/manager';
import { PgliteDatabaseAdapter } from '../src/pglite/adapter';
import { DatabaseMigrationService } from '../src/migration-service';
import { plugin as sqlPlugin } from '../src/index';
import type { Plugin, UUID } from '@elizaos/core';
import { AgentRuntime } from '@elizaos/core';
import { mockCharacter } from './fixtures';

/**
 * Sets up a test database using the dynamic migration system.
 * This helper initializes a PGlite in-memory database, creates an adapter,
 * and runs migrations for the core SQL plugin and any additional test plugins.
 */
export async function setupTestDatabase(
  testAgentId: UUID,
  testPlugins: Plugin[] = []
): Promise<{
  connectionManager: PGliteClientManager;
  adapter: PgliteDatabaseAdapter;
  runtime: AgentRuntime;
}> {
  // Use a unique in-memory store for each test run to ensure isolation
  const connectionManager = new PGliteClientManager({ dataDir: `:memory:` });
  await connectionManager.initialize();

  // Initialize adapter
  const adapter = new PgliteDatabaseAdapter(testAgentId, connectionManager);
  await adapter.init();

  // Create a test character without an ID so the agentId gets used instead
  const testCharacter = {
    ...mockCharacter,
    id: undefined, // Ensure character.id doesn't override agentId
  };

  // Create a runtime with the specific agentId
  const runtime = new AgentRuntime({
    character: testCharacter,
    agentId: testAgentId,
    plugins: [sqlPlugin, ...testPlugins],
  });

  // Manually register the adapter with this runtime instance
  (runtime as any).databaseAdapter = adapter;

  // Manually create and initialize the migration service
  const migrationService = new DatabaseMigrationService(runtime);
  await migrationService.initializeWithDatabase(adapter.getDatabase());

  // Discover and run migrations for all provided plugins
  migrationService.discoverAndRegisterPluginSchemas([sqlPlugin, ...testPlugins]);
  await migrationService.runAllPluginMigrations();

  return { connectionManager, adapter, runtime };
}
