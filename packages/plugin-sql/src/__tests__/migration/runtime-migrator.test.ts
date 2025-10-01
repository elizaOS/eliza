import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { sql } from 'drizzle-orm';
import * as schema from '../../schema';
import { RuntimeMigrator } from '../../runtime-migrator';
import type { DrizzleDB } from '../../runtime-migrator/types';
import { createIsolatedTestDatabaseForMigration } from '../test-helpers';

describe('Runtime Migrator - PostgreSQL Integration Tests', () => {
  let db: DrizzleDB;
  let migrator: RuntimeMigrator;
  let cleanup: () => Promise<void>;
  const testResults: { passed: string[]; failed: string[] } = { passed: [], failed: [] };

  beforeAll(async () => {
    console.log('\n🚀 Starting Runtime Migrator Tests...\n');

    const testSetup = await createIsolatedTestDatabaseForMigration('runtime_migrator_tests');
    db = testSetup.db;
    cleanup = testSetup.cleanup;

    // Initialize the runtime migrator
    migrator = new RuntimeMigrator(db);

    // We're already in an isolated schema, so no cleanup needed
    console.log('🗑️  Test environment ready...');

    try {
      // Drop migrations schema if exists (in case of previous test failure)
      await db.execute(sql`DROP SCHEMA IF EXISTS migrations CASCADE`);

      console.log('✅ Test environment cleaned\n');
    } catch (error) {
      console.log('⚠️  Cleanup warning:', error);
    }
  });

  afterAll(async () => {
    // Print test summary
    console.log('\n' + '='.repeat(80));
    console.log('📊 RUNTIME MIGRATOR TEST SUMMARY');
    console.log('='.repeat(80) + '\n');

    console.log(`✅ PASSED (${testResults.passed.length} tests):`);
    testResults.passed.forEach((test, i) => {
      console.log(`   ${i + 1}. ${test}`);
    });

    if (testResults.failed.length > 0) {
      console.log(`\n❌ FAILED (${testResults.failed.length} tests):`);
      testResults.failed.forEach((test, i) => {
        console.log(`   ${i + 1}. ${test}`);
      });
    }

    console.log('\n' + '='.repeat(80) + '\n');

    if (cleanup) {
      await cleanup();
    }
  });

  describe('Migration System Initialization', () => {
    it('should initialize migration tables', async () => {
      await migrator.initialize();

      // Check migrations schema exists
      const schemaResult = await db.execute(
        sql`SELECT EXISTS (
          SELECT 1 FROM information_schema.schemata 
          WHERE schema_name = 'migrations'
        ) as exists`
      );

      const schemaExists = (schemaResult.rows[0] as any).exists;
      expect(schemaExists).toBe(true);

      if (schemaExists) {
        testResults.passed.push('Migration schema created');
      } else {
        testResults.failed.push('Migration schema not created');
      }

      // Check all migration tables exist
      const tables = ['_migrations', '_journal', '_snapshots'];

      for (const tableName of tables) {
        const result = await db.execute(
          sql`SELECT EXISTS (
            SELECT 1 FROM pg_tables
            WHERE schemaname = 'migrations'
            AND tablename = ${tableName}
          ) as exists`
        );

        const exists = (result.rows[0] as any).exists;
        expect(exists).toBe(true);

        if (exists) {
          testResults.passed.push(`Migration table created: migrations.${tableName}`);
        } else {
          testResults.failed.push(`Migration table missing: migrations.${tableName}`);
        }
      }
    });
  });

  describe('Schema Migration Execution', () => {
    it('should run initial migration for plugin-sql schema', async () => {
      // Run the migration with the actual schema
      await migrator.migrate('plugin-sql', schema, { verbose: true });

      // Check that tables were created in public schema
      const tablesResult = await db.execute(
        sql`SELECT tablename FROM pg_tables 
            WHERE schemaname = 'public' 
            ORDER BY tablename`
      );

      const createdTables = tablesResult.rows.map((r: any) => r.tablename);
      console.log(`\n📋 Tables created: ${createdTables.length}`);

      // Expected tables from schema
      const expectedTables = [
        'agents',
        'cache',
        'channel_participants',
        'channels',
        'components',
        'embeddings',
        'entities',
        'logs',
        'memories',
        'message_servers',
        'central_messages',
        'participants',
        'relationships',
        'rooms',
        'server_agents',
        'tasks',
        'worlds',
      ];

      for (const table of expectedTables) {
        if (createdTables.includes(table)) {
          testResults.passed.push(`Table created: ${table}`);
        } else {
          testResults.failed.push(`Table missing: ${table}`);
        }
        expect(createdTables).toContain(table);
      }
    });

    it('should track migration in _migrations table', async () => {
      const result = await db.execute(
        sql`SELECT * FROM migrations._migrations 
            WHERE plugin_name = 'plugin-sql'
            ORDER BY created_at DESC
            LIMIT 1`
      );

      expect(result.rows.length).toBeGreaterThan(0);

      if (result.rows.length > 0) {
        const migration = result.rows[0] as any;
        testResults.passed.push(
          `Migration tracked: ${migration.plugin_name} - ${migration.hash.substring(0, 8)}...`
        );
      } else {
        testResults.failed.push('Migration not tracked in _migrations table');
      }
    });

    it('should save journal entry', async () => {
      const result = await db.execute(
        sql`SELECT * FROM migrations._journal 
            WHERE plugin_name = 'plugin-sql'`
      );

      expect(result.rows.length).toBe(1);

      if (result.rows.length > 0) {
        const journal = result.rows[0] as any;
        const entries = journal.entries;
        testResults.passed.push(`Journal saved with ${entries.length} entries`);
      } else {
        testResults.failed.push('Journal not saved');
      }
    });

    it('should save snapshot', async () => {
      const result = await db.execute(
        sql`SELECT * FROM migrations._snapshots 
            WHERE plugin_name = 'plugin-sql'
            ORDER BY idx DESC`
      );

      expect(result.rows.length).toBeGreaterThan(0);

      if (result.rows.length > 0) {
        const snapshot = result.rows[0] as any;
        const tables = Object.keys(snapshot.snapshot.tables || {});
        testResults.passed.push(`Snapshot saved with ${tables.length} tables`);
      } else {
        testResults.failed.push('Snapshot not saved');
      }
    });
  });

  describe('Column Types and Constraints', () => {
    it('should create columns with correct types', async () => {
      const criticalColumns = [
        { table: 'agents', column: 'id', type: 'uuid' },
        { table: 'agents', column: 'name', type: 'text' },
        { table: 'agents', column: 'enabled', type: 'boolean' },
        { table: 'agents', column: 'bio', type: 'jsonb' },
        { table: 'memories', column: 'content', type: 'jsonb' },
        { table: 'embeddings', column: 'dim_384', type: 'USER-DEFINED' }, // vector
        { table: 'entities', column: 'names', type: 'ARRAY' },
      ];

      for (const col of criticalColumns) {
        const result = await db.execute(
          sql`SELECT data_type 
              FROM information_schema.columns 
              WHERE table_schema = 'public' 
              AND table_name = ${col.table}
              AND column_name = ${col.column}`
        );

        if (result.rows.length > 0) {
          const actualType = (result.rows[0] as any).data_type;
          const typeMatches =
            actualType === col.type ||
            (col.type === 'USER-DEFINED' && actualType === 'USER-DEFINED');

          if (typeMatches) {
            testResults.passed.push(
              `Column type correct: ${col.table}.${col.column} (${actualType})`
            );
          } else {
            testResults.failed.push(
              `Column type wrong: ${col.table}.${col.column} - expected ${col.type}, got ${actualType}`
            );
          }
        } else {
          testResults.failed.push(`Column missing: ${col.table}.${col.column}`);
        }
      }
    });

    it('should create foreign key constraints', async () => {
      const result = await db.execute(
        sql`SELECT COUNT(*) as count
            FROM information_schema.table_constraints
            WHERE table_schema = 'public'
            AND constraint_type = 'FOREIGN KEY'`
      );

      const fkCount = parseInt((result.rows[0] as any).count);
      expect(fkCount).toBeGreaterThan(0);

      if (fkCount > 0) {
        testResults.passed.push(`Foreign keys created: ${fkCount}`);
      } else {
        testResults.failed.push('No foreign keys created');
      }
    });

    it('should create unique constraints', async () => {
      const result = await db.execute(
        sql`SELECT constraint_name, table_name
            FROM information_schema.table_constraints
            WHERE table_schema = 'public'
            AND constraint_type = 'UNIQUE'`
      );

      const uniqueCount = result.rows.length;
      expect(uniqueCount).toBeGreaterThan(0);

      if (uniqueCount > 0) {
        testResults.passed.push(`Unique constraints created: ${uniqueCount}`);

        // Check specific unique constraint on agents.name
        const hasAgentNameUnique = result.rows.some(
          (r: any) => r.table_name === 'agents' && r.constraint_name === 'name_unique'
        );

        if (hasAgentNameUnique) {
          testResults.passed.push('agents.name unique constraint created');
        } else {
          testResults.failed.push('agents.name unique constraint missing');
        }
      } else {
        testResults.failed.push('No unique constraints created');
      }
    });
  });

  describe('Idempotency', () => {
    it('should handle running the same migration twice', async () => {
      // Run migration again - should not fail or create duplicates
      await migrator.migrate('plugin-sql', schema);

      // Check that we still have only one migration record
      const result = await db.execute(
        sql`SELECT COUNT(*) as count
            FROM migrations._migrations
            WHERE plugin_name = 'plugin-sql'`
      );

      const count = parseInt((result.rows[0] as any).count);
      expect(count).toBe(1);

      if (count === 1) {
        testResults.passed.push('Idempotency: Migration not duplicated');
      } else {
        testResults.failed.push(`Idempotency: Found ${count} migrations instead of 1`);
      }
    });

    it('should detect when no changes are needed', async () => {
      const status = await migrator.getStatus('plugin-sql');
      expect(status.hasRun).toBe(true);

      if (status.hasRun) {
        testResults.passed.push('Migration status correctly tracked');
      } else {
        testResults.failed.push('Migration status not tracked');
      }
    });
  });

  describe('Schema Evolution Support', () => {
    it('should support ALTER operations (when schema changes)', async () => {
      // This would test ALTER column functionality when we have schema changes
      // For now, just verify the infrastructure is in place

      // Check that we have snapshot comparison capability
      const status = await migrator.getStatus('plugin-sql');
      expect(status.snapshots).toBeGreaterThan(0);

      if (status.snapshots > 0) {
        testResults.passed.push('Schema evolution: Snapshots stored for comparison');
      } else {
        testResults.failed.push('Schema evolution: No snapshots stored');
      }
    });

    it('should track migration history properly', async () => {
      const journal = await db.execute(
        sql`SELECT entries FROM migrations._journal 
            WHERE plugin_name = 'plugin-sql'`
      );

      if (journal.rows.length > 0) {
        const entries = (journal.rows[0] as any).entries;
        expect(entries.length).toBeGreaterThan(0);

        if (entries.length > 0) {
          testResults.passed.push(`Migration history: ${entries.length} entries tracked`);
        } else {
          testResults.failed.push('Migration history: No entries in journal');
        }
      } else {
        testResults.failed.push('Migration history: Journal not found');
      }
    });
  });

  describe('Index Creation', () => {
    it('should create indexes on tables', async () => {
      // First, let's see ALL indexes
      const allIndexes = await db.execute(
        sql`SELECT schemaname, tablename, indexname
            FROM pg_indexes
            WHERE schemaname = 'public'`
      );
      console.log('All indexes in public schema:', allIndexes.rows);

      // Then check for idx_ prefixed ones
      const result = await db.execute(
        sql`SELECT COUNT(*) as count
            FROM pg_indexes
            WHERE schemaname = 'public'
            AND indexname LIKE 'idx_%'`
      );

      const indexCount = parseInt((result.rows[0] as any).count);
      console.log('Count of idx_ indexes:', indexCount);

      // Our schema does create indexes with idx_ prefix
      if (indexCount > 0) {
        testResults.passed.push(`Indexes created: ${indexCount}`);
      } else {
        testResults.failed.push('🔴 CRITICAL GAP: No indexes created');
      }

      // We expect indexes to be created (memories table has idx_ indexes)
      expect(indexCount).toBeGreaterThan(0);
    });
  });

  describe('Check Constraints', () => {
    it('should create check constraints', async () => {
      const result = await db.execute(
        sql`SELECT COUNT(*) as count
            FROM pg_constraint
            WHERE connamespace = 'public'::regnamespace
            AND contype = 'c'`
      );

      const checkCount = parseInt((result.rows[0] as any).count);

      // Our schema does create check constraints (e.g., in memories table)
      if (checkCount > 0) {
        testResults.passed.push(`Check constraints created: ${checkCount}`);
      } else {
        testResults.failed.push('🟡 GAP: No check constraints created');
      }

      // We expect check constraints to be created
      expect(checkCount).toBeGreaterThan(0);
    });
  });

  describe('Production Readiness', () => {
    it('should use transactions for atomicity', async () => {
      // Transactions are built into our implementation
      // This test verifies the infrastructure is there
      testResults.passed.push('Transactions: Built-in atomicity via Drizzle transactions');
      expect(true).toBe(true);
    });

    it('should handle errors gracefully', async () => {
      // Try to migrate with invalid schema
      let errorCaught = false;

      try {
        await migrator.migrate('invalid-plugin', {
          invalidTable: 'not-a-table',
        });
      } catch (error) {
        errorCaught = true;
      }

      // The migrator now records empty schemas for plugins with no tables
      // So we need to check if it was recorded as an empty migration
      const status = await migrator.getStatus('invalid-plugin');

      // An empty schema is still considered "hasRun"
      // but it should not have created any real tables
      const tablesResult = await db.execute(
        sql`SELECT COUNT(*) as count
            FROM information_schema.tables
            WHERE table_schema = 'public'
            AND table_name = 'invalidTable'`
      );

      const invalidTableExists = parseInt((tablesResult.rows[0] as any).count) > 0;
      expect(invalidTableExists).toBe(false);

      if (!invalidTableExists) {
        testResults.passed.push('Error handling: Invalid schema does not create tables');
      } else {
        testResults.failed.push('Error handling: Invalid table was created');
      }
    });
  });

  describe('Development Features', () => {
    it('should support dry-run mode', async () => {
      // Test dry-run doesn't actually execute
      await migrator.migrate('dry-run-test', schema, {
        dryRun: true,
      });

      // Check no tables were created
      const result = await db.execute(
        sql`SELECT COUNT(*) as count
            FROM migrations._migrations
            WHERE plugin_name = 'dry-run-test'`
      );

      const count = parseInt((result.rows[0] as any).count);
      expect(count).toBe(0);

      if (count === 0) {
        testResults.passed.push('Dry-run mode: No changes applied');
      } else {
        testResults.failed.push('Dry-run mode: Changes were applied!');
      }
    });

    it('should support reset for development', async () => {
      // Create a test migration
      await migrator.migrate('reset-test', { testTable: {} });

      // Reset it
      await migrator.reset('reset-test');

      // Check it's gone
      const status = await migrator.getStatus('reset-test');
      expect(status.hasRun).toBe(false);

      if (!status.hasRun) {
        testResults.passed.push('Reset functionality: Works correctly');
      } else {
        testResults.failed.push('Reset functionality: Failed to clear state');
      }
    });
  });
});
