import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { sql } from 'drizzle-orm';
import { RuntimeMigrator } from '../../runtime-migrator';
import type { DrizzleDatabase } from '../../types';
import { createIsolatedTestDatabaseForMigration } from '../test-helpers';
import * as coreSchema from '../../schema';
import { testPolymarketSchema } from '../plugin-schema/test-plugin-schema';

describe('Actual Runtime Scenario - Plugin Loading Simulation', () => {
  let db: DrizzleDatabase;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    console.log('\n🚀 Simulating actual runtime plugin loading scenario...\n');

    const testSetup = await createIsolatedTestDatabaseForMigration('actual_runtime');
    cleanup = testSetup.cleanup;
    db = testSetup.db;
  });

  afterAll(async () => {
    if (cleanup) {
      await cleanup();
    }
  });

  it('should handle plugin migrations as they would be loaded at runtime', async () => {
    console.log('='.repeat(80));
    console.log('SCENARIO: Application Startup');
    console.log('='.repeat(80));

    // Step 1: Application starts and initializes the database adapter (plugin-sql)
    console.log('\n📦 Step 1: Loading plugin-sql (database adapter)...');

    // This is what happens in plugin-sql's initialization
    const sqlPluginMigrator = new RuntimeMigrator(db);
    await sqlPluginMigrator.initialize();

    // Plugin-sql migrates its own schema
    await sqlPluginMigrator.migrate('@elizaos/plugin-sql', coreSchema, {
      verbose: false,
    });

    console.log('✅ plugin-sql loaded and migrated');

    // Check migration state after plugin-sql
    const afterSqlPlugin = await db.execute(sql`
      SELECT plugin_name, hash, created_at 
      FROM migrations._migrations 
      ORDER BY created_at ASC
    `);
    console.log(`\n📊 Migrations after plugin-sql: ${afterSqlPlugin.rows.length}`);
    for (const m of afterSqlPlugin.rows as any[]) {
      console.log(`  - ${m.plugin_name}`);
    }

    // Step 2: Application loads other plugins (polymarket)
    console.log('\n📦 Step 2: Loading polymarket plugin...');

    // This is what would happen in polymarket plugin's initialization
    // IMPORTANT: In real runtime, would polymarket create its own migrator instance?
    // Or would it use a shared one? Let's test both scenarios.

    console.log('\n--- Testing Scenario A: Polymarket creates its own migrator ---');
    const polymarketMigrator = new RuntimeMigrator(db);
    // Note: initialize() is idempotent, so it should detect existing migration tables
    await polymarketMigrator.initialize();

    await polymarketMigrator.migrate('polymarket', testPolymarketSchema, {
      verbose: false,
    });

    console.log('✅ polymarket loaded and migrated (own migrator)');

    // Check migration state after polymarket
    const afterPolymarket = await db.execute(sql`
      SELECT plugin_name, hash, created_at 
      FROM migrations._migrations 
      ORDER BY created_at ASC
    `);
    console.log(`\n📊 Migrations after polymarket: ${afterPolymarket.rows.length}`);
    for (const m of afterPolymarket.rows as any[]) {
      console.log(`  - ${m.plugin_name}`);
    }

    expect(afterPolymarket.rows.length).toBe(2);

    // Step 3: Simulate app restart - what happens?
    console.log('\n' + '='.repeat(80));
    console.log('SCENARIO: Application Restart');
    console.log('='.repeat(80));

    console.log('\n🔄 Simulating application restart...');

    // Create new migrator instances (as would happen on restart)
    const sqlPluginMigrator2 = new RuntimeMigrator(db);
    await sqlPluginMigrator2.initialize();

    // Plugin-sql tries to migrate again
    await sqlPluginMigrator2.migrate('@elizaos/plugin-sql', coreSchema, {
      verbose: false,
    });

    const polymarketMigrator2 = new RuntimeMigrator(db);
    await polymarketMigrator2.initialize();

    // Polymarket tries to migrate again
    await polymarketMigrator2.migrate('polymarket', testPolymarketSchema, {
      verbose: false,
    });

    // Should still be only 2 migrations
    const afterRestart = await db.execute(sql`
      SELECT plugin_name, hash, created_at 
      FROM migrations._migrations 
      ORDER BY created_at ASC
    `);
    console.log(`\n📊 Migrations after restart: ${afterRestart.rows.length}`);
    expect(afterRestart.rows.length).toBe(2);

    console.log('\n' + '='.repeat(80));
    console.log('DIAGNOSTICS');
    console.log('='.repeat(80));

    // Detailed diagnostic information
    console.log('\n🔍 Checking snapshots:');
    const snapshots = await db.execute(sql`
      SELECT plugin_name, COUNT(*) as count 
      FROM migrations._snapshots 
      GROUP BY plugin_name
    `);
    for (const s of snapshots.rows as any[]) {
      console.log(`  - ${s.plugin_name}: ${s.count} snapshots`);
    }

    // Check if schemas are correctly created
    console.log('\n🔍 Checking schemas:');
    const schemas = await db.execute(sql`
      SELECT schema_name 
      FROM information_schema.schemata 
      WHERE schema_name NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
      ORDER BY schema_name
    `);
    console.log('Schemas:', schemas.rows.map((r: any) => r.schema_name).join(', '));

    // Verify tables in each schema
    console.log('\n🔍 Tables per schema:');
    const tablesPerSchema = await db.execute(sql`
      SELECT schemaname, COUNT(*) as table_count 
      FROM pg_tables 
      WHERE schemaname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
      GROUP BY schemaname 
      ORDER BY schemaname
    `);
    for (const t of tablesPerSchema.rows as any[]) {
      console.log(`  - ${t.schemaname}: ${t.table_count} tables`);
    }
  });

  it('should test shared migrator scenario', async () => {
    console.log('\n' + '='.repeat(80));
    console.log('SCENARIO: Shared Migrator Instance');
    console.log('='.repeat(80));

    // Clear all existing data from previous test
    console.log('\n🧹 Cleaning up database from previous test...');

    // Drop polymarket schema if it exists
    await db.execute(sql`DROP SCHEMA IF EXISTS polymarket CASCADE`);

    // Drop all tables in public schema (except the migration tables which we'll handle separately)
    const tables = await db.execute(sql`
      SELECT tablename FROM pg_tables 
      WHERE schemaname = 'public' 
      AND tablename NOT LIKE 'spatial_ref_sys'
      AND tablename NOT LIKE 'geography_columns' 
      AND tablename NOT LIKE 'geometry_columns'
      AND tablename NOT LIKE 'raster_columns'
      AND tablename NOT LIKE 'raster_overviews'
    `);

    for (const table of tables.rows as any[]) {
      await db.execute(sql.raw(`DROP TABLE IF EXISTS public."${table.tablename}" CASCADE`));
    }

    // Drop migrations schema entirely (it will be recreated)
    await db.execute(sql`DROP SCHEMA IF EXISTS migrations CASCADE`);

    console.log('\n🔄 Testing with shared migrator instance...');

    // Single migrator instance shared across plugins
    const sharedMigrator = new RuntimeMigrator(db);
    await sharedMigrator.initialize();

    // Plugin-sql uses shared migrator
    console.log('\n📦 plugin-sql using shared migrator...');
    await sharedMigrator.migrate('@elizaos/plugin-sql', coreSchema, {
      verbose: false,
    });

    // Polymarket uses same shared migrator
    console.log('📦 polymarket using shared migrator...');
    await sharedMigrator.migrate('polymarket', testPolymarketSchema, {
      verbose: false,
    });

    // Check final state
    const finalMigrations = await db.execute(sql`
      SELECT plugin_name, hash, created_at 
      FROM migrations._migrations 
      ORDER BY created_at ASC
    `);

    console.log(`\n📊 Final migrations with shared migrator: ${finalMigrations.rows.length}`);
    for (const m of finalMigrations.rows as any[]) {
      console.log(`  - ${m.plugin_name}`);
    }

    expect(finalMigrations.rows.length).toBe(2);

    // Test if both schemas exist
    const schemasExist = await db.execute(sql`
      SELECT 
        EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'public') as public_exists,
        EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'polymarket') as polymarket_exists
    `);

    const result = schemasExist.rows[0] as any;
    console.log('\n✅ Schema verification:');
    console.log(`  - public schema: ${result.public_exists ? 'exists' : 'missing'}`);
    console.log(`  - polymarket schema: ${result.polymarket_exists ? 'exists' : 'missing'}`);

    expect(result.public_exists).toBe(true);
    expect(result.polymarket_exists).toBe(true);
  });
});
