import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { vi } from 'vitest';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { PGliteClientManager } from '../src/pglite/manager';
import { PgliteDatabaseAdapter } from '../src/pglite/adapter';
import { DatabaseMigrationService } from '../src/migration-service';
import { plugin as sqlPlugin } from '../src/index';
import type { Plugin, UUID } from '@elizaos/core';
import { AgentRuntime, stringToUuid } from '@elizaos/core';
import { mockCharacter } from './fixtures';

export function setupMockedMigrations(): void {
  vi.spyOn(PGliteClientManager.prototype, 'runMigrations').mockImplementation(async function () {
    // 'this' refers to the instance of PGliteClientManager.
    const pgliteInstance = (this as any).client;

    console.log('[TEST MOCK HELPER] PGliteClientManager.runMigrations: Starting mocked migration.');

    try {
      const db = drizzle(pgliteInstance);

      const helperFilePath = fileURLToPath(import.meta.url);
      const testsDir = path.dirname(helperFilePath);
      const packageRoot = path.resolve(testsDir, '..');
      const migrationsPath = path.resolve(packageRoot, 'drizzle/migrations');

      console.log(
        `[TEST MOCK HELPER] PGliteClientManager.runMigrations: Resolved migrations path to: ${migrationsPath}`
      );

      await migrate(db, {
        migrationsFolder: migrationsPath,
        migrationsSchema: 'public',
      });

      console.log(
        '[TEST MOCK HELPER] PGliteClientManager.runMigrations: Mocked migration successful.'
      );
    } catch (error) {
      console.error(
        '[TEST MOCK HELPER] PGliteClientManager.runMigrations: Error during mocked migration:',
        error
      );
      throw error;
    }
  });
}

/**
 * Creates a fully initialized, in-memory PGlite database adapter and a corresponding
 * AgentRuntime instance for testing purposes. It uses the dynamic migration system
 * to set up the schema for the core SQL plugin and any additional plugins provided.
 *
 * This is the standard helper for all integration tests in `plugin-sql`.
 *
 * @param testAgentId - The UUID to use for the agent runtime and adapter.
 * @param testPlugins - An array of additional plugins to load and migrate.
 * @returns A promise that resolves to the initialized adapter and runtime.
 */
export async function createTestDatabase(
  testAgentId: UUID,
  testPlugins: Plugin[] = []
): Promise<{
  adapter: PgliteDatabaseAdapter;
  runtime: AgentRuntime;
  cleanup: () => Promise<void>;
}> {
  console.log('[TEST] Starting createTestDatabase for agent:', testAgentId);

  // Create a unique temporary directory for each test run to ensure isolation.
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eliza-test-'));
  const connectionManager = new PGliteClientManager({ dataDir: tempDir });
  await connectionManager.initialize();
  console.log('[TEST] Connection manager initialized in:', tempDir);

  // Initialize the adapter with the test agent's ID.
  const adapter = new PgliteDatabaseAdapter(testAgentId, connectionManager);
  await adapter.init();
  console.log('[TEST] Adapter initialized');

  // Create a character that won't override the provided agentId.
  const testCharacter = { ...mockCharacter, id: undefined };

  // Create a runtime with the specific agentId and register the adapter.
  const runtime = new AgentRuntime({
    character: testCharacter,
    agentId: testAgentId,
    plugins: [sqlPlugin, ...testPlugins],
  });
  runtime.registerDatabaseAdapter(adapter);
  console.log('[TEST] Runtime created and adapter registered');

  try {
    // Manually run the dynamic migrations.
    console.log('[TEST] Starting dynamic migration system...');
    const migrationService = new DatabaseMigrationService(runtime);
    console.log('[TEST] Migration service created');

    await migrationService.initializeWithDatabase(adapter.getDatabase());
    console.log('[TEST] Migration service initialized with database');

    migrationService.discoverAndRegisterPluginSchemas([sqlPlugin, ...testPlugins]);
    console.log('[TEST] Plugin schemas discovered and registered');

    await migrationService.runAllPluginMigrations();
    console.log('[TEST] All plugin migrations completed');
  } catch (error) {
    console.error('[TEST] Error during migration:', error);
    throw error;
  }

  try {
    // Create an agent record in the database to satisfy foreign key constraints
    console.log('[TEST] Creating agent record...');
    const agentCreated = await adapter.createAgent({
      id: testAgentId,
      name: testCharacter.name,
      settings: testCharacter.settings || {},
      bio: testCharacter.bio || 'Test agent',
      messageExamples: testCharacter.messageExamples || [],
      postExamples: testCharacter.postExamples || [],
      topics: testCharacter.topics || [],
      adjectives: testCharacter.adjectives || [],
      knowledge: testCharacter.knowledge || [],
      plugins: testCharacter.plugins || [],
      createdAt: new Date().getTime(),
      updatedAt: new Date().getTime(),
    });

    if (agentCreated) {
      console.log('[TEST] Agent record created successfully');
    } else {
      console.log('[TEST] Agent already exists (expected in some test scenarios)');
      // Verify the agent exists in the database
      const existingAgent = await adapter.getAgent(testAgentId);
      if (!existingAgent) {
        throw new Error(
          `Agent creation failed and agent does not exist in database: ${testAgentId}`
        );
      }
    }
  } catch (error) {
    console.error('[TEST] Error creating agent record:', error);
    throw error;
  }

  console.log('[TEST] createTestDatabase completed successfully');

  const cleanup = async () => {
    await adapter.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
    console.log('[TEST] Cleaned up temporary database directory:', tempDir);
  };

  return { adapter, runtime, cleanup };
}
