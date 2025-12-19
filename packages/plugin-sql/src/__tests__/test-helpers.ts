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
    // PostgreSQL testing - use superuser for full permissions
    // Transform URL to use postgres:postgres credentials
    const originalUrl = process.env.POSTGRES_URL;
    const superuserUrl = new URL(originalUrl);
    superuserUrl.username = 'postgres';
    superuserUrl.password = 'postgres';

    console.log('[TEST] Using PostgreSQL (superuser) for test database');
    const connectionManager = new PostgresConnectionManager(superuserUrl.toString());
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
    // PostgreSQL - use superuser for full control over schema
    // Transform URL to use postgres:postgres credentials (superuser)
    // This ensures tests have full permissions to create/drop tables
    const originalUrl = process.env.POSTGRES_URL;
    const superuserUrl = new URL(originalUrl);
    superuserUrl.username = 'postgres';
    superuserUrl.password = 'postgres';

    console.log(`[TEST] Using PostgreSQL with superuser for: ${testId}`);

    const connectionManager = new PostgresConnectionManager(superuserUrl.toString());
    const adapter = new PgDatabaseAdapter(testAgentId, connectionManager);
    await adapter.init();

    const db = connectionManager.getDatabase();

    // Clean up custom schemas and migration tables for fresh start
    await db.execute(sql.raw(`DROP SCHEMA IF EXISTS migrations CASCADE`));
    await db.execute(sql.raw(`DROP TABLE IF EXISTS _snapshots CASCADE`));
    await db.execute(sql.raw(`DROP TABLE IF EXISTS _journal CASCADE`));
    await db.execute(sql.raw(`DROP TABLE IF EXISTS _migrations CASCADE`));

    // Drop ALL tables in public schema for clean slate
    await db.execute(
      sql.raw(`
      DO $$ DECLARE
        r RECORD;
      BEGIN
        FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public') LOOP
          EXECUTE 'DROP TABLE IF EXISTS public.' || quote_ident(r.tablename) || ' CASCADE';
        END LOOP;
      END $$;
    `)
    );

    const runtime = new AgentRuntime({
      character: { ...mockCharacter, id: undefined },
      agentId: testAgentId,
      plugins: [sqlPlugin, ...testPlugins],
    });
    runtime.registerDatabaseAdapter(adapter);

    // Run migrations on clean database
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
      // Just close the connection - don't drop tables
      // Tables are dropped at the START of each test, not at the end
      // This ensures tests can run in any order
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

/**
 * Creates an isolated test database specifically for migration testing.
 * This helper provides a clean database with NO migrations run,
 * allowing migration tests to control the entire migration process.
 *
 * @param testName - A unique name for this test to ensure isolation
 * @returns Database connection, adapter, and cleanup function
 */
export async function createIsolatedTestDatabaseForMigration(testName: string): Promise<{
  db: any; // DrizzleDatabase
  adapter: PgliteDatabaseAdapter | PgDatabaseAdapter;
  cleanup: () => Promise<void>;
  testAgentId: UUID;
}> {
  const testAgentId = v4() as UUID;
  const testId = testName.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();

  if (process.env.POSTGRES_URL) {
    // PostgreSQL - use superuser for migration tests (needs DROP SCHEMA permissions)
    // Transform the URL to use postgres:postgres credentials
    const originalUrl = process.env.POSTGRES_URL;
    const url = new URL(originalUrl);
    url.username = 'postgres';
    url.password = 'postgres';
    const superuserUrl = url.toString();

    console.log(`[MIGRATION TEST] Using PostgreSQL superuser for: ${testId}`);

    const connectionManager = new PostgresConnectionManager(superuserUrl);
    const adapter = new PgDatabaseAdapter(testAgentId, connectionManager);
    await adapter.init();

    const db = connectionManager.getDatabase();

    // Drop custom schemas first (like polymarket, migrations)
    // These are created by plugin tests and need to be cleaned
    await db.execute(sql.raw(`DROP SCHEMA IF EXISTS polymarket CASCADE`));
    await db.execute(sql.raw(`DROP SCHEMA IF EXISTS migrations CASCADE`));

    // Drop ALL tables in public schema for clean slate
    // This ensures each test starts fresh without leftover state from previous tests
    // WARNING: This is destructive - only use for testing!
    await db.execute(
      sql.raw(`
      DO $$ DECLARE
        r RECORD;
      BEGIN
        FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public') LOOP
          EXECUTE 'DROP TABLE IF EXISTS public.' || quote_ident(r.tablename) || ' CASCADE';
        END LOOP;
      END $$;
    `)
    );

    // Ensure grants for eliza_test user (PostgreSQL 15+ requires explicit grants on public schema)
    // These must be set at the start of each test to ensure eliza_test can create tables
    await db.execute(sql.raw(`GRANT ALL ON SCHEMA public TO eliza_test`));
    await db.execute(sql.raw(`GRANT USAGE ON SCHEMA public TO eliza_test`));
    await db.execute(sql.raw(`GRANT CREATE ON SCHEMA public TO eliza_test`));

    const cleanup = async () => {
      try {
        // Clean up custom schemas
        await db.execute(sql.raw(`DROP SCHEMA IF EXISTS polymarket CASCADE`));
        await db.execute(sql.raw(`DROP SCHEMA IF EXISTS migrations CASCADE`));
        // Clean up migration tables in public schema
        await db.execute(sql.raw(`DROP TABLE IF EXISTS _snapshots CASCADE`));
        await db.execute(sql.raw(`DROP TABLE IF EXISTS _journal CASCADE`));
        await db.execute(sql.raw(`DROP TABLE IF EXISTS _migrations CASCADE`));

        // Restore grants for eliza_test user (PostgreSQL 15+ requires explicit grants on public schema)
        // This is needed because migration tests run as superuser and may affect schema ownership
        await db.execute(sql.raw(`GRANT ALL ON SCHEMA public TO eliza_test`));
        await db.execute(sql.raw(`GRANT USAGE ON SCHEMA public TO eliza_test`));
        await db.execute(sql.raw(`GRANT CREATE ON SCHEMA public TO eliza_test`));
      } catch (error) {
        console.error(`[MIGRATION TEST] Failed to cleanup:`, error);
      }
      await adapter.close();
    };

    return { db, adapter, cleanup, testAgentId };
  } else {
    // PGLite - use unique directory per test
    const tempDir = path.join(os.tmpdir(), `eliza-migration-test-${testId}-${Date.now()}`);
    console.log(`[MIGRATION TEST] Creating isolated PGLite database: ${tempDir}`);

    const connectionManager = new PGliteClientManager({ dataDir: tempDir });
    await connectionManager.initialize();
    const adapter = new PgliteDatabaseAdapter(testAgentId, connectionManager);
    await adapter.init();

    const db = adapter.getDatabase();

    const cleanup = async () => {
      await adapter.close();
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch (error) {
        console.error(`[MIGRATION TEST] Failed to remove temp directory ${tempDir}:`, error);
      }
    };

    return { db, adapter, cleanup, testAgentId };
  }
}

/**
 * Creates an isolated test database for schema evolution tests that need to test schema evolution
 * with destructive migrations. This helper manages the ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS
 * environment variable and provides a clean database for each test.
 *
 * @param testName - A unique name for this test to ensure isolation
 * @returns Database connection, adapter, cleanup function, and environment management
 */
export async function createIsolatedTestDatabaseForSchemaEvolutionTests(testName: string): Promise<{
  db: any; // DrizzleDatabase
  adapter: PgliteDatabaseAdapter | PgDatabaseAdapter;
  cleanup: () => Promise<void>;
  testAgentId: UUID;
  originalDestructiveSetting?: string;
}> {
  // Save original environment variable
  const originalDestructiveSetting = process.env.ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS;

  // Get the base setup
  const baseSetup = await createIsolatedTestDatabaseForMigration(testName);

  // Enhance cleanup to restore environment variable
  const enhancedCleanup = async () => {
    // Restore original environment variable
    if (originalDestructiveSetting !== undefined) {
      process.env.ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS = originalDestructiveSetting;
    } else {
      delete process.env.ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS;
    }

    // Call original cleanup
    await baseSetup.cleanup();
  };

  return {
    ...baseSetup,
    cleanup: enhancedCleanup,
    originalDestructiveSetting,
  };
}
