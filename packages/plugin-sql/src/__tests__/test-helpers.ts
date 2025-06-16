import type { Plugin, UUID } from '@elizaos/core';
import { AgentRuntime } from '@elizaos/core';
import { sql } from 'drizzle-orm';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { v4 } from 'uuid';
import { plugin as sqlPlugin } from '../index';
import { DatabaseMigrationService } from '../migration-service';
import { PgDatabaseAdapter } from '../pg/adapter';
import { PostgresConnectionManager } from '../pg/manager';
import { PgliteDatabaseAdapter } from '../pglite/adapter';
import { PGliteClientManager } from '../pglite/manager';
import { mockCharacter } from './fixtures';

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
  adapter: PgliteDatabaseAdapter | PgDatabaseAdapter;
  runtime: AgentRuntime;
  cleanup: () => Promise<void>;
}> {
  if (process.env.POSTGRES_URL) {
    // PostgreSQL testing
    console.log('[TEST] Using PostgreSQL for test database');
    const connectionManager = new PostgresConnectionManager(process.env.POSTGRES_URL);
    const adapter = new PgDatabaseAdapter(testAgentId, connectionManager);
    await adapter.init();

    const runtime = new AgentRuntime({
      character: { ...mockCharacter, id: undefined },
      agentId: testAgentId,
      plugins: [sqlPlugin, ...testPlugins],
    });
    runtime.registerDatabaseAdapter(adapter);

    const schemaName = `test_${testAgentId.replace(/-/g, '_')}`;
    const db = connectionManager.getDatabase();

    // Drop schema if it exists to ensure clean state
    await db.execute(sql.raw(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`));
    await db.execute(sql.raw(`CREATE SCHEMA IF NOT EXISTS ${schemaName}`));
    await db.execute(sql.raw(`SET search_path TO ${schemaName}, public`));

    const migrationService = new DatabaseMigrationService();
    await migrationService.initializeWithDatabase(db);
    migrationService.discoverAndRegisterPluginSchemas([sqlPlugin, ...testPlugins]);
    await migrationService.runAllPluginMigrations();

    await adapter.createAgent({
      id: testAgentId,
      ...mockCharacter,
    } as any);

    const cleanup = async () => {
      await db.execute(sql.raw(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`));
      await adapter.close();
    };

    return { adapter, runtime, cleanup };
  } else {
    // PGlite testing
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eliza-test-'));
    const connectionManager = new PGliteClientManager({ dataDir: tempDir });
    await connectionManager.initialize();
    const adapter = new PgliteDatabaseAdapter(testAgentId, connectionManager);
    await adapter.init();

    const runtime = new AgentRuntime({
      character: { ...mockCharacter, id: undefined },
      agentId: testAgentId,
      plugins: [sqlPlugin, ...testPlugins],
    });
    runtime.registerDatabaseAdapter(adapter);

    const migrationService = new DatabaseMigrationService();
    await migrationService.initializeWithDatabase(adapter.getDatabase());
    migrationService.discoverAndRegisterPluginSchemas([sqlPlugin, ...testPlugins]);
    await migrationService.runAllPluginMigrations();

    await adapter.createAgent({
      id: testAgentId,
      ...mockCharacter,
    } as any);

    const cleanup = async () => {
      await adapter.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    };

    return { adapter, runtime, cleanup };
  }
}

/**
 * Creates a properly isolated test database with automatic cleanup.
 * This function ensures each test has its own isolated database state.
 *
 * @param testName - A unique name for this test to ensure isolation
 * @param testPlugins - Additional plugins to load
 * @returns Database adapter, runtime, and cleanup function
 */
export async function createIsolatedTestDatabase(
  testName: string,
  testPlugins: Plugin[] = []
): Promise<{
  adapter: PgliteDatabaseAdapter | PgDatabaseAdapter;
  runtime: AgentRuntime;
  cleanup: () => Promise<void>;
  testAgentId: UUID;
}> {
  // Generate a unique agent ID for this test
  const testAgentId = v4() as UUID;
  const testId = testName.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();

  if (process.env.POSTGRES_URL) {
    // PostgreSQL - use unique schema per test
    const schemaName = `test_${testId}_${Date.now()}`;
    console.log(`[TEST] Creating isolated PostgreSQL schema: ${schemaName}`);

    const connectionManager = new PostgresConnectionManager(process.env.POSTGRES_URL);
    const adapter = new PgDatabaseAdapter(testAgentId, connectionManager);
    await adapter.init();

    const runtime = new AgentRuntime({
      character: { ...mockCharacter, id: undefined },
      agentId: testAgentId,
      plugins: [sqlPlugin, ...testPlugins],
    });
    runtime.registerDatabaseAdapter(adapter);

    const db = connectionManager.getDatabase();

    // Create isolated schema
    await db.execute(sql.raw(`CREATE SCHEMA ${schemaName}`));
    // Include public in search path so we can access the vector extension
    await db.execute(sql.raw(`SET search_path TO ${schemaName}, public`));

    // Run migrations in isolated schema
    const migrationService = new DatabaseMigrationService();
    await migrationService.initializeWithDatabase(db);
    migrationService.discoverAndRegisterPluginSchemas([sqlPlugin, ...testPlugins]);
    await migrationService.runAllPluginMigrations();

    // Create test agent
    await adapter.createAgent({
      id: testAgentId,
      ...mockCharacter,
    } as any);

    const cleanup = async () => {
      try {
        await db.execute(sql.raw(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`));
      } catch (error) {
        console.error(`[TEST] Failed to drop schema ${schemaName}:`, error);
      }
      await adapter.close();
    };

    return { adapter, runtime, cleanup, testAgentId };
  } else {
    // PGLite - use unique directory per test
    const tempDir = path.join(os.tmpdir(), `eliza-test-${testId}-${Date.now()}`);
    console.log(`[TEST] Creating isolated PGLite database: ${tempDir}`);

    const connectionManager = new PGliteClientManager({ dataDir: tempDir });
    await connectionManager.initialize();
    const adapter = new PgliteDatabaseAdapter(testAgentId, connectionManager);
    await adapter.init();

    const runtime = new AgentRuntime({
      character: { ...mockCharacter, id: undefined },
      agentId: testAgentId,
      plugins: [sqlPlugin, ...testPlugins],
    });
    runtime.registerDatabaseAdapter(adapter);

    // Run migrations
    const migrationService = new DatabaseMigrationService();
    await migrationService.initializeWithDatabase(adapter.getDatabase());
    migrationService.discoverAndRegisterPluginSchemas([sqlPlugin, ...testPlugins]);
    await migrationService.runAllPluginMigrations();

    // Create test agent
    await adapter.createAgent({
      id: testAgentId,
      ...mockCharacter,
    } as any);

    const cleanup = async () => {
      await adapter.close();
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch (error) {
        console.error(`[TEST] Failed to remove temp directory ${tempDir}:`, error);
      }
    };

    return { adapter, runtime, cleanup, testAgentId };
  }
}
