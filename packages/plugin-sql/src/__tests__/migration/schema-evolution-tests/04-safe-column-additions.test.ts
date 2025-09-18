import { describe, it, beforeEach, afterEach, expect } from 'bun:test';
import { pgTable, text, uuid, jsonb, boolean, timestamp, integer } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { RuntimeMigrator } from '../../../runtime-migrator/runtime-migrator';
import type { DrizzleDB } from '../../../runtime-migrator/types';
import { createIsolatedTestDatabaseForSchemaEvolutionTests } from '../../test-helpers';

/**
 * Schema Evolution Test 4 & 5: Safe Column Additions
 *
 * This test verifies that adding nullable columns and columns with defaults
 * works correctly without data loss warnings.
 */

describe('Schema Evolution Test: Safe Column Additions', () => {
  let db: DrizzleDB;
  let migrator: RuntimeMigrator;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const testSetup = await createIsolatedTestDatabaseForSchemaEvolutionTests(
      'schema_evolution_safe_column_additions_test'
    );
    db = testSetup.db;
    cleanup = testSetup.cleanup;

    migrator = new RuntimeMigrator(db);
    await migrator.initialize();
  });

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
    }
  });

  it('should add nullable columns without warnings', async () => {
    // V1: Basic agent table
    const agentTableV1 = pgTable('agents', {
      id: uuid('id').primaryKey().defaultRandom(),
      name: text('name').notNull(),
      enabled: boolean('enabled').default(true).notNull(),
    });

    const schemaV1 = { agents: agentTableV1 };

    // Apply V1 and add data
    console.log('📦 Creating initial schema...');
    await migrator.migrate('@elizaos/safe-additions-v1', schemaV1);

    // Insert test data
    await db.insert(agentTableV1).values([
      { name: 'Agent Alpha', enabled: true },
      { name: 'Agent Beta', enabled: false },
    ]);

    const beforeData = await db.select().from(agentTableV1);
    console.log(`  ✅ Created ${beforeData.length} agents`);

    // V2: Add nullable columns
    const agentTableV2 = pgTable('agents', {
      id: uuid('id').primaryKey().defaultRandom(),
      name: text('name').notNull(),
      enabled: boolean('enabled').default(true).notNull(),
      // New nullable columns - safe additions
      description: text('description'),
      avatar: text('avatar'),
      tags: text('tags').array(),
      metadata: jsonb('metadata'),
    });

    const schemaV2 = { agents: agentTableV2 };

    // Check migration - should have no warnings
    console.log('\n🔍 Checking for data loss warnings...');
    const check = await migrator.checkMigration('@elizaos/safe-additions-v1', schemaV2);

    if (check) {
      expect(check.hasDataLoss).toBe(false);
      expect(check.warnings.length).toBe(0);
      console.log('  ✅ No data loss warnings (as expected for nullable columns)');
    } else {
      console.log('  ✅ No changes detected that would cause data loss');
    }

    // Apply migration - should succeed without any environment variable
    console.log('\n📦 Applying safe migration...');
    await migrator.migrate('@elizaos/safe-additions-v1', schemaV2);
    console.log('  ✅ Migration completed successfully');

    // Verify data is preserved and new columns are null
    const afterData = await db.execute(sql`SELECT * FROM agents ORDER BY name`);

    expect(afterData.rows.length).toBe(2);
    const firstAgent = afterData.rows[0] as any;
    expect(firstAgent.name).toBe('Agent Alpha');
    expect(firstAgent.description).toBeNull();
    expect(firstAgent.avatar).toBeNull();
    expect(firstAgent.tags).toBeNull();
    expect(firstAgent.metadata).toBeNull();

    console.log('\n✅ Nullable columns added successfully:');
    console.log('  - All existing data preserved');
    console.log('  - New columns are NULL for existing rows');
  });

  it('should add NOT NULL columns with defaults without warnings', async () => {
    // V1: Basic entity table
    const entityTableV1 = pgTable('entities', {
      id: uuid('id').primaryKey().defaultRandom(),
      name: text('name').notNull(),
    });

    const schemaV1 = { entities: entityTableV1 };

    console.log('📦 Creating initial schema...');
    await migrator.migrate('@elizaos/defaults-test-v1', schemaV1);

    // Insert test data
    await db
      .insert(entityTableV1)
      .values([{ name: 'Entity One' }, { name: 'Entity Two' }, { name: 'Entity Three' }]);

    console.log('  ✅ Created 3 entities');

    // V2: Add NOT NULL columns with defaults
    const entityTableV2 = pgTable('entities', {
      id: uuid('id').primaryKey().defaultRandom(),
      name: text('name').notNull(),
      // New NOT NULL columns with defaults - safe because of defaults
      enabled: boolean('enabled').default(true).notNull(),
      createdAt: timestamp('created_at', { withTimezone: true })
        .default(sql`now()`)
        .notNull(),
      priority: integer('priority').default(0).notNull(),
      status: text('status').default('active').notNull(),
      settings: jsonb('settings').default({}).notNull(),
    });

    const schemaV2 = { entities: entityTableV2 };

    // Check migration - should have no warnings
    console.log('\n🔍 Checking for data loss warnings...');
    const check = await migrator.checkMigration('@elizaos/defaults-test-v1', schemaV2);

    if (check) {
      expect(check.hasDataLoss).toBe(false);
      console.log('  ✅ No data loss (defaults protect existing rows)');
    }

    // Apply migration
    console.log('\n📦 Applying migration with NOT NULL + defaults...');
    await migrator.migrate('@elizaos/defaults-test-v1', schemaV2);
    console.log('  ✅ Migration completed successfully');

    // Verify defaults were applied to existing rows
    const afterData = await db.execute(sql`SELECT * FROM entities ORDER BY name`);

    expect(afterData.rows.length).toBe(3);

    for (const row of afterData.rows) {
      const entity = row as any;
      expect(entity.enabled).toBe(true); // Got default value
      expect(entity.priority).toBe(0); // Got default value
      expect(entity.status).toBe('active'); // Got default value
      expect(entity.settings).toEqual({}); // Got default value
      expect(entity.created_at).toBeDefined(); // Got NOW() default
      console.log(`  ✅ ${entity.name}: defaults applied correctly`);
    }

    console.log('\n✅ NOT NULL columns with defaults added successfully');
  });

  it('should handle adding columns with valid DEFAULT expressions', async () => {
    // V1: Basic table
    const testTableV1 = pgTable('test_complex', {
      id: uuid('id').primaryKey().defaultRandom(),
      name: text('name').notNull(),
    });

    const schemaV1 = { test_complex: testTableV1 };

    console.log('📦 Creating initial schema...');
    await migrator.migrate('@elizaos/complex-columns-v1', schemaV1);

    await db.insert(testTableV1).values([{ name: 'Test Record 1' }, { name: 'Test Record 2' }]);

    // V2: Add columns with DEFAULT expressions (that don't reference columns)
    // and GENERATED columns (that can reference columns)
    const testTableV2 = pgTable('test_complex', {
      id: uuid('id').primaryKey().defaultRandom(),
      name: text('name').notNull(),
      // DEFAULT expressions (no column references allowed)
      createdAt: timestamp('created_at')
        .default(sql`now()`)
        .notNull(),
      status: text('status').default('active').notNull(),
      randomValue: integer('random_value').default(sql`floor(random() * 100)`),
      timestampWithOffset: timestamp('timestamp_with_offset').default(
        sql`now() + interval '1 hour'`
      ),
      // Note: Expressions like to_tsvector('english', name) would need
      // generatedAlwaysAs() which isn't fully supported in all contexts
      // So we use only valid DEFAULT expressions that don't reference columns
    });

    const schemaV2 = { test_complex: testTableV2 };

    // Check and apply migration
    console.log('\n🔍 Testing complex column defaults...');
    const check = await migrator.checkMigration('@elizaos/complex-columns-v1', schemaV2);

    if (check) {
      expect(check.hasDataLoss).toBe(false);
      console.log('  ✅ No data loss with complex defaults');
    }

    await migrator.migrate('@elizaos/complex-columns-v1', schemaV2);

    // Verify defaults worked
    const afterData = await db.execute(sql`SELECT * FROM test_complex ORDER BY name`);

    for (const row of afterData.rows) {
      const record = row as any;
      expect(record.created_at).toBeDefined();
      expect(record.status).toBe('active');
      expect(record.timestamp_with_offset).toBeDefined();
      // random_value can be null or a number
      if (record.random_value !== null) {
        expect(typeof record.random_value).toBe('number');
      }
      console.log(`  ✅ ${record.name}: default expressions applied correctly`);
    }

    console.log('\n✅ Valid DEFAULT expressions handled correctly');
  });

  it('should add multiple columns in single migration', async () => {
    // V1: Minimal table
    const tableV1 = pgTable('multi_test', {
      id: uuid('id').primaryKey().defaultRandom(),
    });

    const schemaV1 = { multi_test: tableV1 };

    console.log('📦 Creating minimal initial schema...');
    await migrator.migrate('@elizaos/multi-column-v1', schemaV1);

    // V2: Add many columns at once
    const tableV2 = pgTable('multi_test', {
      id: uuid('id').primaryKey().defaultRandom(),
      // Add 10+ columns in one migration
      name: text('name').default('unnamed').notNull(),
      description: text('description'),
      enabled: boolean('enabled').default(true).notNull(),
      priority: integer('priority').default(0).notNull(),
      tags: text('tags').array(),
      metadata: jsonb('metadata').default({}),
      createdAt: timestamp('created_at')
        .default(sql`now()`)
        .notNull(),
      updatedAt: timestamp('updated_at'),
      deletedAt: timestamp('deleted_at'),
      version: integer('version').default(1).notNull(),
      status: text('status').default('active'),
      config: jsonb('config'),
    });

    const schemaV2 = { multi_test: tableV2 };

    console.log('\n📦 Adding 12 columns in single migration...');
    const check = await migrator.checkMigration('@elizaos/multi-column-v1', schemaV2);

    if (check) {
      expect(check.hasDataLoss).toBe(false);
      console.log('  ✅ No data loss adding multiple columns');
    }

    await migrator.migrate('@elizaos/multi-column-v1', schemaV2);

    // Verify all columns exist
    const columns = await db.execute(
      sql`SELECT column_name, data_type, is_nullable, column_default 
          FROM information_schema.columns 
          WHERE table_name = 'multi_test' 
          ORDER BY ordinal_position`
    );

    expect(columns.rows.length).toBe(13); // id + 12 new columns
    console.log(`  ✅ All ${columns.rows.length} columns created successfully`);

    // List all columns
    for (const col of columns.rows) {
      const column = col as any;
      const nullable = column.is_nullable === 'YES' ? 'NULL' : 'NOT NULL';
      const defaultVal = column.column_default
        ? `DEFAULT ${column.column_default.substring(0, 20)}...`
        : '';
      console.log(`     - ${column.column_name}: ${column.data_type} ${nullable} ${defaultVal}`);
    }

    console.log('\n✅ Bulk column addition completed successfully');
  });
});
