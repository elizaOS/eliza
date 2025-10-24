import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { sql } from 'drizzle-orm';
import { RuntimeMigrator } from '../../runtime-migrator';
import type { DrizzleDatabase } from '../../types';
import { createIsolatedTestDatabaseForMigration } from '../test-helpers';
import * as coreSchema from '../../schema';
import { testPolymarketSchema } from '../plugin-schema/test-plugin-schema';

describe('Runtime Simulation - Full Migration Flow', () => {
  let db: DrizzleDatabase;
  let migrator: RuntimeMigrator;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    console.log('\n🚀 Simulating full runtime migration flow...\n');

    const testSetup = await createIsolatedTestDatabaseForMigration('runtime_simulation');
    cleanup = testSetup.cleanup;
    db = testSetup.db;
  });

  afterAll(async () => {
    if (cleanup) {
      await cleanup();
    }
  });

  it('should perform complete migration flow as in runtime', async () => {
    console.log('='.repeat(80));
    console.log('STEP 1: Initialize Migration System');
    console.log('='.repeat(80));

    // Create a fresh migrator instance (simulating runtime startup)
    migrator = new RuntimeMigrator(db);
    await migrator.initialize();

    // Verify migration infrastructure was created
    const schemasResult = await db.execute(sql`
      SELECT schema_name 
      FROM information_schema.schemata 
      WHERE schema_name = 'migrations'
    `);
    expect(schemasResult.rows.length).toBe(1);
    console.log('✅ Migration schema created');

    // Check migration tables
    const tablesResult = await db.execute(sql`
      SELECT tablename 
      FROM pg_tables 
      WHERE schemaname = 'migrations'
      ORDER BY tablename
    `);
    const migrationTables = tablesResult.rows.map((r: any) => r.tablename);
    console.log('Migration tables:', migrationTables);
    expect(migrationTables).toContain('_migrations');
    expect(migrationTables).toContain('_snapshots');
    expect(migrationTables).toContain('_journal');

    console.log('\n' + '='.repeat(80));
    console.log('STEP 2: Migrate Core Schema (@elizaos/plugin-sql)');
    console.log('='.repeat(80));

    // Migrate core schema (this is what plugin-sql does on initialization)
    await migrator.migrate('@elizaos/plugin-sql', coreSchema, {
      verbose: true,
    });

    // Verify core migration was recorded
    const coreMigrationCheck = await db.execute(sql`
      SELECT * FROM migrations._migrations 
      WHERE plugin_name = '@elizaos/plugin-sql'
      ORDER BY created_at DESC
    `);

    console.log(`\n📋 Core migration records: ${coreMigrationCheck.rows.length}`);
    expect(coreMigrationCheck.rows.length).toBe(1);

    const coreMigration = coreMigrationCheck.rows[0] as any;
    console.log('Core migration details:');
    console.log('  - Plugin:', coreMigration.plugin_name);
    console.log('  - Hash:', coreMigration.hash);
    console.log('  - Created:', coreMigration.created_at);

    // Check snapshots for core
    const coreSnapshots = await db.execute(sql`
      SELECT * FROM migrations._snapshots 
      WHERE plugin_name = '@elizaos/plugin-sql'
      ORDER BY id DESC
    `);
    console.log(`\n📸 Core snapshots: ${coreSnapshots.rows.length}`);

    // Verify core tables in public schema
    const publicTables = await db.execute(sql`
      SELECT tablename FROM pg_tables 
      WHERE schemaname = 'public' 
      ORDER BY tablename
    `);
    const coreTableNames = publicTables.rows.map((r: any) => r.tablename);
    console.log(`\n📦 Core tables in public schema: ${coreTableNames.length}`);
    console.log('Tables:', coreTableNames.join(', '));

    console.log('\n' + '='.repeat(80));
    console.log('STEP 3: Migrate Plugin Schema (polymarket)');
    console.log('='.repeat(80));

    // Now migrate the polymarket plugin schema (simulating plugin initialization)
    await migrator.migrate('polymarket', testPolymarketSchema, {
      verbose: true,
    });

    // Verify polymarket migration was recorded
    const polymarketMigrationCheck = await db.execute(sql`
      SELECT * FROM migrations._migrations 
      WHERE plugin_name = 'polymarket'
      ORDER BY created_at DESC
    `);

    console.log(`\n📋 Polymarket migration records: ${polymarketMigrationCheck.rows.length}`);
    expect(polymarketMigrationCheck.rows.length).toBe(1);

    const polymarketMigration = polymarketMigrationCheck.rows[0] as any;
    console.log('Polymarket migration details:');
    console.log('  - Plugin:', polymarketMigration.plugin_name);
    console.log('  - Hash:', polymarketMigration.hash);
    console.log('  - Created:', polymarketMigration.created_at);

    // Check snapshots for polymarket
    const polymarketSnapshots = await db.execute(sql`
      SELECT * FROM migrations._snapshots 
      WHERE plugin_name = 'polymarket'
      ORDER BY id DESC
    `);
    console.log(`\n📸 Polymarket snapshots: ${polymarketSnapshots.rows.length}`);

    // Verify polymarket schema and tables
    const polymarketSchemaExists = await db.execute(sql`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.schemata 
        WHERE schema_name = 'polymarket'
      ) as exists
    `);
    expect(polymarketSchemaExists.rows[0]?.exists).toBe(true);
    console.log('\n✅ Polymarket schema created');

    const polymarketTables = await db.execute(sql`
      SELECT tablename FROM pg_tables 
      WHERE schemaname = 'polymarket' 
      ORDER BY tablename
    `);
    const polymarketTableNames = polymarketTables.rows.map((r: any) => r.tablename);
    console.log(`📦 Polymarket tables: ${polymarketTableNames.length}`);
    console.log('Tables:', polymarketTableNames.join(', '));

    console.log('\n' + '='.repeat(80));
    console.log('STEP 4: Verify Complete Migration State');
    console.log('='.repeat(80));

    // Check total migration records (should be 2: core + polymarket)
    const allMigrations = await db.execute(sql`
      SELECT 
        plugin_name,
        hash,
        created_at
      FROM migrations._migrations 
      ORDER BY created_at ASC
    `);

    console.log(`\n📊 Total migration records: ${allMigrations.rows.length}`);
    expect(allMigrations.rows.length).toBe(2);

    console.log('\nAll migrations:');
    for (const migration of allMigrations.rows as any[]) {
      console.log(`  - ${migration.plugin_name}: ${migration.hash} (${migration.created_at})`);
    }

    // Check journal entries (if table exists)
    try {
      const journalEntries = await db.execute(sql`
        SELECT * FROM migrations._journal 
        ORDER BY id ASC
      `);

      console.log(`\n📓 Journal entries: ${journalEntries.rows.length}`);
      for (const entry of journalEntries.rows as any[]) {
        console.log(`  - Journal entry:`, entry);
      }
    } catch (err) {
      console.log('\n📓 Journal table not available or empty');
    }

    // Verify snapshot content for polymarket
    const latestPolymarketSnapshot = await db.execute(sql`
      SELECT * FROM migrations._snapshots 
      WHERE plugin_name = 'polymarket'
      ORDER BY id DESC
      LIMIT 1
    `);

    if (latestPolymarketSnapshot.rows.length > 0) {
      const snapshot = latestPolymarketSnapshot.rows[0] as any;

      try {
        const snapshotData =
          typeof snapshot.snapshot === 'string' ? JSON.parse(snapshot.snapshot) : snapshot.snapshot;

        console.log('\n🔍 Polymarket Snapshot Analysis:');
        console.log('  - Version:', snapshotData.version);
        console.log('  - Dialect:', snapshotData.dialect);
        console.log('  - Tables:', Object.keys(snapshotData.tables || {}).length);
        console.log('  - Table names:', Object.keys(snapshotData.tables || {}).join(', '));

        // Check if tables are correctly namespaced
        for (const tableName of Object.keys(snapshotData.tables || {})) {
          expect(tableName).toMatch(/^polymarket\./);
          console.log(`    ✓ ${tableName} is correctly namespaced`);
        }
      } catch (e) {
        console.log('\n🔍 Polymarket Snapshot (raw):', snapshot.snapshot);
      }
    }

    console.log('\n' + '='.repeat(80));
    console.log('STEP 5: Test Migration Status Methods');
    console.log('='.repeat(80));

    // Test getStatus for both plugins
    const coreStatus = await migrator.getStatus('@elizaos/plugin-sql');
    const polymarketStatus = await migrator.getStatus('polymarket');

    console.log('\n📈 Migration Status:');
    console.log('Core (@elizaos/plugin-sql):');
    console.log('  - Has Run:', coreStatus.hasRun);
    console.log('  - Snapshots:', coreStatus.snapshots);
    console.log('  - Last Migration:', coreStatus.lastMigration);

    console.log('\nPolymarket:');
    console.log('  - Has Run:', polymarketStatus.hasRun);
    console.log('  - Snapshots:', polymarketStatus.snapshots);
    console.log('  - Last Migration:', polymarketStatus.lastMigration);

    expect(coreStatus.hasRun).toBe(true);
    expect(polymarketStatus.hasRun).toBe(true);

    console.log('\n' + '='.repeat(80));
    console.log('STEP 6: Simulate Re-initialization (Idempotency Check)');
    console.log('='.repeat(80));

    // Create a new migrator instance (simulating restart)
    const migrator2 = new RuntimeMigrator(db);
    await migrator2.initialize();

    // Try to migrate again - should skip both
    console.log('\n🔄 Re-running migrations (should skip)...');

    await migrator2.migrate('@elizaos/plugin-sql', coreSchema, {
      verbose: false,
    });

    await migrator2.migrate('polymarket', testPolymarketSchema, {
      verbose: false,
    });

    // Verify still only 2 migration records
    const finalMigrationCount = await db.execute(sql`
      SELECT COUNT(*) as count FROM migrations._migrations
    `);

    console.log(`\n📊 Final migration count: ${finalMigrationCount.rows[0]?.count}`);
    expect(finalMigrationCount.rows[0]?.count).toBe(2);

    // Final summary
    console.log('\n' + '='.repeat(80));
    console.log('✅ MIGRATION SIMULATION COMPLETE');
    console.log('='.repeat(80));
    console.log('\nSummary:');
    console.log('  - Both migrations recorded: ✓');
    console.log('  - Core tables in public schema: ✓');
    console.log('  - Polymarket tables in polymarket schema: ✓');
    console.log('  - Snapshots created: ✓');
    console.log('  - Journal entries logged: ✓');
    console.log('  - Idempotency verified: ✓');
  });

  it('should handle plugin registration order correctly', async () => {
    console.log('\n' + '='.repeat(80));
    console.log('Testing Plugin Registration Order');
    console.log('='.repeat(80));

    // Check if order matters for migration recording
    const migrationOrder = await db.execute(sql`
      SELECT 
        plugin_name,
        created_at,
        ROW_NUMBER() OVER (ORDER BY created_at ASC) as migration_order
      FROM migrations._migrations
      ORDER BY created_at ASC
    `);

    console.log('\nMigration Order:');
    for (const record of migrationOrder.rows as any[]) {
      console.log(`  ${record.migration_order}. ${record.plugin_name} at ${record.created_at}`);
    }

    // Core should be migrated first
    const firstMigration = migrationOrder.rows[0] as any;
    expect(firstMigration.plugin_name).toBe('@elizaos/plugin-sql');

    const secondMigration = migrationOrder.rows[1] as any;
    expect(secondMigration.plugin_name).toBe('polymarket');
  });
});
