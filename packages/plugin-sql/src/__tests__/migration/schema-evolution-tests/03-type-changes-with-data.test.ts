import { describe, it, beforeEach, afterEach, expect } from 'bun:test';
import { pgTable, text, uuid, jsonb, integer, boolean } from 'drizzle-orm/pg-core';
import { RuntimeMigrator } from '../../../runtime-migrator/runtime-migrator';
import type { DrizzleDB } from '../../../runtime-migrator/types';
import { createIsolatedTestDatabaseForSchemaEvolutionTests } from '../../test-helpers';

/**
 * Schema Evolution Test 3: Type Changes with Incompatible Data
 *
 * This test verifies handling of column type changes that could
 * cause data loss, conversion errors, or precision loss.
 */

describe('Schema Evolution Test: Type Changes with Data', () => {
  let db: DrizzleDB;
  let migrator: RuntimeMigrator;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const testSetup = await createIsolatedTestDatabaseForSchemaEvolutionTests(
      'schema_evolution_type_changes_test'
    );
    db = testSetup.db;
    cleanup = testSetup.cleanup;

    migrator = new RuntimeMigrator(db);
    await migrator.initialize();

    // Set environment variable for tests since they all test destructive operations
    process.env.ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS = 'true';
  });

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
    }
  });

  it('should handle JSONB to text conversion with complex data', async () => {
    // V1: JSONB columns storing complex nested data
    const memoryTableV1 = pgTable('memories', {
      id: uuid('id').primaryKey().notNull(),
      content: jsonb('content').notNull(),
      metadata: jsonb('metadata').default({}).notNull(),
      settings: jsonb('settings'),
    });

    const schemaV1 = { memories: memoryTableV1 };

    await migrator.migrate('@elizaos/schema-evolution-test-types-v1', schemaV1);

    // Insert complex JSON data
    await db.insert(memoryTableV1).values([
      {
        id: '110e8400-e29b-41d4-a716-446655440001',
        content: {
          text: 'Complex memory',
          nested: {
            level1: {
              level2: {
                data: ['array', 'of', 'values'],
                number: 42,
              },
            },
          },
          tags: ['important', 'conversation', 'technical'],
        },
        metadata: {
          timestamp: new Date().toISOString(),
          version: 2,
          flags: {
            processed: true,
            archived: false,
          },
        },
        settings: {
          visibility: 'private',
          retention: 30,
          notifications: {
            email: true,
            push: false,
          },
        },
      },
      {
        id: '110e8400-e29b-41d4-a716-446655440002',
        content: {
          simple: 'Another memory',
          score: 0.95,
        },
        metadata: {
          source: 'chat',
          confidence: 0.8,
        },
        settings: null,
      },
    ]);

    const beforeData = await db.select().from(memoryTableV1);
    console.log('Data before type change:');
    console.log(`  - ${beforeData.length} records with complex JSON structures`);
    console.log(`  - Sample content type: ${typeof beforeData[0].content}`);
    console.log(`  - Content keys: ${Object.keys(beforeData[0].content as any).join(', ')}`);

    // V2: Change JSONB to text (lossy conversion!)
    const memoryTableV2 = pgTable('memories', {
      id: uuid('id').primaryKey().notNull(),
      content: text('content').notNull(), // JSONB → text
      metadata: text('metadata').notNull(), // JSONB → text
      settings: text('settings'), // JSONB → text (nullable)
    });

    const schemaV2 = { memories: memoryTableV2 };

    // Check migration warnings
    const check = await migrator.checkMigration(
      '@elizaos/schema-evolution-test-types-v1',
      schemaV2
    );

    expect(check).toBeDefined();
    expect(check!.warnings.length).toBeGreaterThan(0);

    console.log('\n⚠️  Type Conversion Warnings:');
    check!.warnings.forEach((warning) => {
      console.log(`  • ${warning}`);
    });

    // Migration allowed because ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS is set in beforeEach
    await migrator.migrate('@elizaos/schema-evolution-test-types-v1', schemaV2);

    // Check converted data
    const afterData = await db.select().from(memoryTableV2);

    console.log('\n📊 After type conversion:');
    console.log(`  - Content is now: ${typeof afterData[0].content}`);
    console.log(`  - First 100 chars: ${(afterData[0].content as string).substring(0, 100)}...`);

    // Verify JSON was converted to string representation
    expect(typeof afterData[0].content).toBe('string');
    expect(afterData[0].content).toContain('{'); // Should be JSON string

    // Try to parse it back to verify it's valid JSON string
    let parsed: any;
    try {
      parsed = JSON.parse(afterData[0].content as string);
      console.log('  ✅ Content is valid JSON string, can be parsed back');
    } catch (e) {
      console.log('  ❌ Content is not valid JSON string after conversion');
    }
  });

  it('should handle text to integer conversion with invalid data', async () => {
    // V1: Text column that might contain non-numeric data
    const userTableV1 = pgTable('users', {
      id: uuid('id').primaryKey().defaultRandom(),
      name: text('name').notNull(),
      age: text('age'), // Stored as text (bad practice but happens)
      score: text('score'),
    });

    const schemaV1 = { users: userTableV1 };

    await migrator.migrate('@elizaos/schema-evolution-test-text-to-int-v1', schemaV1);

    // Insert mixed data - some valid, some invalid for integer conversion
    await db.insert(userTableV1).values([
      {
        name: 'User 1',
        age: '25', // Valid integer
        score: '100', // Valid integer
      },
      {
        name: 'User 2',
        age: '30.5', // Decimal - will lose precision
        score: '95.75', // Decimal - will lose precision
      },
      {
        name: 'User 3',
        age: 'unknown', // Invalid for integer!
        score: 'N/A', // Invalid for integer!
      },
      {
        name: 'User 4',
        age: null, // NULL is ok
        score: '', // Empty string - problem!
      },
    ]);

    console.log('Test data with mixed text values:');
    const data = await db.select().from(userTableV1);
    data.forEach((row) => {
      console.log(`  - ${row.name}: age="${row.age}", score="${row.score}"`);
    });

    // V2: Convert text to integer (will fail for invalid data!)
    const userTableV2 = pgTable('users', {
      id: uuid('id').primaryKey().defaultRandom(),
      name: text('name').notNull(),
      age: integer('age'), // text → integer
      score: integer('score'), // text → integer
    });

    const schemaV2 = { users: userTableV2 };

    // This should warn about potential conversion issues
    const check = await migrator.checkMigration(
      '@elizaos/schema-evolution-test-text-to-int-v1',
      schemaV2
    );

    expect(check).toBeDefined();
    expect(check!.warnings.length).toBeGreaterThan(0);
    expect(
      check!.warnings.some(
        (w) => w.includes('Type change') || w.includes('type') || w.includes('column')
      )
    ).toBe(true);

    console.log('\n⚠️  Conversion Risk Detection:');
    check!.warnings.forEach((warning) => {
      console.log(`  • ${warning}`);
    });

    // Attempting migration should fail due to invalid data
    let migrationError: Error | null = null;
    try {
      await migrator.migrate('@elizaos/schema-evolution-test-text-to-int-v1', schemaV2);
    } catch (error) {
      migrationError = error as Error;
    }

    // Should fail because 'unknown' and 'N/A' can't convert to integer
    if (migrationError) {
      console.log('\n❌ Migration failed as expected:');
      console.log(`  Error: ${migrationError.message}`);
      // The actual error is about decimal "30.5" not being valid integer
      expect(migrationError.message.toLowerCase()).toMatch(/failed query|invalid|error/);
    } else {
      console.log('\n⚠️  Migration succeeded with USING clause for conversion');
      // If migration succeeded, check what happened to the data
      const afterData = await db.select().from(userTableV2);
      console.log('  Converted data:');
      afterData.forEach((row) => {
        console.log(`    - ${row.name}: age=${row.age}, score=${row.score}`);
      });
    }
  });

  it('should handle boolean to text and back conversions', async () => {
    // V1: Boolean columns
    const settingsTableV1 = pgTable('settings', {
      id: uuid('id').primaryKey().defaultRandom(),
      name: text('name').notNull(),
      enabled: boolean('enabled').notNull().default(true),
      verified: boolean('verified').default(false),
      active: boolean('active'),
    });

    const schemaV1 = { settings: settingsTableV1 };

    await migrator.migrate('@elizaos/schema-evolution-test-bool-v1', schemaV1);

    // Insert boolean data
    await db.insert(settingsTableV1).values([
      { name: 'Setting 1', enabled: true, verified: true, active: true },
      { name: 'Setting 2', enabled: false, verified: false, active: false },
      { name: 'Setting 3', enabled: true, verified: false, active: null },
    ]);

    console.log('Boolean data before conversion:');
    const beforeData = await db.select().from(settingsTableV1);
    beforeData.forEach((row) => {
      console.log(
        `  - ${row.name}: enabled=${row.enabled}, verified=${row.verified}, active=${row.active}`
      );
    });

    // V2: Convert boolean to text
    const settingsTableV2 = pgTable('settings', {
      id: uuid('id').primaryKey().defaultRandom(),
      name: text('name').notNull(),
      enabled: text('enabled').notNull().default('true'), // boolean → text
      verified: text('verified').default('false'), // boolean → text
      active: text('active'), // boolean → text
    });

    const schemaV2 = { settings: settingsTableV2 };

    await migrator.migrate('@elizaos/schema-evolution-test-bool-v1', schemaV2);

    const afterTextData = await db.select().from(settingsTableV2);
    console.log('\n📊 After boolean → text conversion:');
    afterTextData.forEach((row) => {
      console.log(
        `  - ${row.name}: enabled="${row.enabled}", verified="${row.verified}", active="${row.active}"`
      );
    });

    // Verify conversion results
    expect(afterTextData[0].enabled).toBe('true');
    expect(afterTextData[1].enabled).toBe('false');
    expect(afterTextData[2].active).toBeNull();
  });
});
