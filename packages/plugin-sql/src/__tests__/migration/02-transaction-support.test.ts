import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { pgTable, uuid, text, timestamp } from 'drizzle-orm/pg-core';
import pg from 'pg';
import * as originalSchema from '../../schema';
import { RuntimeMigrator } from '../../runtime-migrator';
import type { DrizzleDatabase } from '../../types';

const { Client } = pg;

describe('Runtime Migrator - Transaction Support Tests', () => {
  let db: DrizzleDatabase;
  let client: pg.Client;
  let migrator: RuntimeMigrator;

  const POSTGRES_URL =
    process.env.POSTGRES_URL || 'postgresql://postgres:postgres@localhost:5555/eliza2';

  beforeAll(async () => {
    console.log('\n🔄 Testing Transaction Support and Atomicity...\n');

    client = new Client({ connectionString: POSTGRES_URL });
    await client.connect();
    db = drizzle(client, { schema: originalSchema }) as unknown as DrizzleDatabase;

    migrator = new RuntimeMigrator(db);
    await migrator.initialize();
  });

  beforeEach(async () => {
    // Clean up test tables before each test
    const testTables = [
      'test_transaction_success',
      'test_transaction_fail_1',
      'test_transaction_fail_2',
      'test_atomic_operation',
      'test_partial_migration',
      'test_rollback_scenario',
    ];

    for (const table of testTables) {
      try {
        await db.execute(sql.raw(`DROP TABLE IF EXISTS ${table} CASCADE`));
      } catch {
        // Ignore errors
      }
    }

    // Clean up test migration records
    try {
      await db.execute(
        sql.raw(`
        DELETE FROM migrations._migrations 
        WHERE plugin_name LIKE '%transaction-test%'
      `)
      );
      await db.execute(
        sql.raw(`
        DELETE FROM migrations._journal 
        WHERE plugin_name LIKE '%transaction-test%'
      `)
      );
      await db.execute(
        sql.raw(`
        DELETE FROM migrations._snapshots 
        WHERE plugin_name LIKE '%transaction-test%'
      `)
      );
    } catch {
      // Ignore errors
    }
  });

  afterAll(async () => {
    await client.end();
  });

  describe('Transaction Atomicity', () => {
    it('should commit all changes when migration succeeds', async () => {
      const validSchema = {
        testTable: pgTable('test_transaction_success', {
          id: uuid('id').primaryKey().defaultRandom(),
          data: text('data'),
          created_at: timestamp('created_at').defaultNow(),
        }),
      };

      await migrator.migrate('@elizaos/transaction-test-success', validSchema);

      // Verify table was created
      const tableExists = await db.execute(
        sql.raw(`SELECT EXISTS (
          SELECT FROM information_schema.tables
          WHERE table_schema = 'public'
          AND table_name = 'test_transaction_success'
        )`)
      );

      expect(tableExists.rows[0]?.exists).toBe(true);

      // Verify migration was recorded
      const migrationRecorded = await db.execute(
        sql.raw(`SELECT COUNT(*) as count
                 FROM migrations._migrations
                 WHERE plugin_name = '@elizaos/transaction-test-success'`)
      );

      expect(parseInt((migrationRecorded.rows[0] as any).count)).toBe(1);

      // Verify journal was recorded
      const journalRecorded = await db.execute(
        sql.raw(`SELECT COUNT(*) as count
                 FROM migrations._journal
                 WHERE plugin_name = '@elizaos/transaction-test-success'`)
      );

      expect(parseInt((journalRecorded.rows[0] as any).count)).toBe(1);
    });

    it('should rollback all changes when migration fails', async () => {
      // First create a valid table
      const initialSchema = {
        testTable: pgTable('test_atomic_operation', {
          id: uuid('id').primaryKey().defaultRandom(),
          data: text('data'),
        }),
      };

      await migrator.migrate('@elizaos/transaction-test-initial', initialSchema);

      // Now try to create a conflicting schema that should fail
      const conflictingSchema = {
        testTable1: pgTable('test_partial_migration', {
          id: uuid('id').primaryKey().defaultRandom(),
          data: text('data'),
        }),
        // This should cause a conflict
        testTable2: pgTable('test_atomic_operation', {
          id: uuid('id').primaryKey().defaultRandom(),
          different_data: text('different_data'), // Different structure
        }),
      };

      let migrationFailed = false;
      try {
        await migrator.migrate('@elizaos/transaction-test-fail', conflictingSchema);
      } catch (error) {
        migrationFailed = true;
      }

      expect(migrationFailed).toBe(true);

      // Verify that the first table from the failed migration was NOT created
      const partialTableExists = await db.execute(
        sql.raw(`SELECT EXISTS (
          SELECT FROM information_schema.tables
          WHERE table_schema = 'public'
          AND table_name = 'test_partial_migration'
        )`)
      );

      expect(partialTableExists.rows[0]?.exists).toBe(false);

      // Verify no migration record was created for the failed migration
      const failedMigrationRecorded = await db.execute(
        sql.raw(`SELECT COUNT(*) as count
                 FROM migrations._migrations
                 WHERE plugin_name = '@elizaos/transaction-test-fail'`)
      );

      expect(parseInt((failedMigrationRecorded.rows[0] as any).count)).toBe(0);

      // Verify no journal entry was created for the failed migration
      const failedJournalRecorded = await db.execute(
        sql.raw(`SELECT COUNT(*) as count
                 FROM migrations._journal
                 WHERE plugin_name = '@elizaos/transaction-test-fail'`)
      );

      expect(parseInt((failedJournalRecorded.rows[0] as any).count)).toBe(0);
    });

    it('should handle constraint violations atomically', async () => {
      // Create a schema with constraints
      const schemaWithConstraints = {
        testTable: pgTable('test_rollback_scenario', {
          id: uuid('id').primaryKey().defaultRandom(),
          email: text('email').notNull().unique(),
          username: text('username').notNull(),
        }),
      };

      await migrator.migrate('@elizaos/transaction-constraint-test', schemaWithConstraints);

      // Insert test data
      await db.execute(
        sql.raw(`
        INSERT INTO test_rollback_scenario (email, username) 
        VALUES ('test@example.com', 'testuser')
      `)
      );

      // Try to create another table and also insert duplicate data (should fail)
      const conflictingSchemaAndData = {
        testTable1: pgTable('test_rollback_scenario', {
          id: uuid('id').primaryKey().defaultRandom(),
          email: text('email').notNull().unique(),
          username: text('username').notNull(),
        }),
        testTable2: pgTable('test_transaction_fail_2', {
          id: uuid('id').primaryKey().defaultRandom(),
          data: text('data'),
        }),
      };

      let constraintViolation = false;
      try {
        await migrator.migrate('@elizaos/transaction-constraint-fail', conflictingSchemaAndData);

        // If migration succeeds, try to insert duplicate data to cause constraint violation
        await db.execute(
          sql.raw(`
          INSERT INTO test_rollback_scenario (email, username) 
          VALUES ('test@example.com', 'duplicate')
        `)
        );
      } catch (error) {
        constraintViolation = true;
      }

      // The migration should either fail completely or succeed completely
      // Check if the second table was created
      const secondTableExists = await db.execute(
        sql.raw(`SELECT EXISTS (
          SELECT FROM information_schema.tables
          WHERE table_schema = 'public'
          AND table_name = 'test_transaction_fail_2'
        )`)
      );

      // If constraint violation occurred, no new tables should be created
      if (constraintViolation) {
        expect(secondTableExists.rows[0]?.exists).toBe(false);
      }
    });
  });

  describe('Migration State Consistency', () => {
    it('should maintain consistent state across migration failures', async () => {
      // Get initial state
      const initialMigrationCount = await db.execute(
        sql.raw(`SELECT COUNT(*) as count FROM migrations._migrations`)
      );

      const initialTableCount = await db.execute(
        sql.raw(`SELECT COUNT(*) as count 
                 FROM information_schema.tables 
                 WHERE table_schema = 'public'`)
      );

      // Try an invalid migration
      let errorOccurred = false;
      try {
        await migrator.migrate('@elizaos/invalid-migration', {
          invalidTable: 'this-is-not-a-table-definition' as any,
        });
      } catch (error) {
        errorOccurred = true;
      }

      expect(errorOccurred).toBe(true);

      // Verify state is unchanged
      const finalMigrationCount = await db.execute(
        sql.raw(`SELECT COUNT(*) as count FROM migrations._migrations`)
      );

      const finalTableCount = await db.execute(
        sql.raw(`SELECT COUNT(*) as count 
                 FROM information_schema.tables 
                 WHERE table_schema = 'public'`)
      );

      expect(parseInt((finalMigrationCount.rows[0] as any).count)).toBe(
        parseInt((initialMigrationCount.rows[0] as any).count)
      );

      expect(parseInt((finalTableCount.rows[0] as any).count)).toBe(
        parseInt((initialTableCount.rows[0] as any).count)
      );
    });

    it('should handle nested transaction scenarios', async () => {
      // This test simulates what happens when the runtime migrator
      // needs to handle nested transactions or multiple operations

      const complexSchema = {
        table1: pgTable('test_transaction_fail_1', {
          id: uuid('id').primaryKey().defaultRandom(),
          data: text('data'),
          ref_id: uuid('ref_id'), // Will reference table2
        }),
        table2: pgTable('test_transaction_fail_2', {
          id: uuid('id').primaryKey().defaultRandom(),
          name: text('name').notNull(),
        }),
      };

      // This should either succeed completely or fail completely
      let migrationResult = 'unknown';
      try {
        await migrator.migrate('@elizaos/complex-transaction-test', complexSchema);
        migrationResult = 'success';
      } catch (error) {
        migrationResult = 'failed';
      }

      if (migrationResult === 'success') {
        // Both tables should exist
        const table1Exists = await db.execute(
          sql.raw(`SELECT EXISTS (
            SELECT FROM information_schema.tables
            WHERE table_schema = 'public' AND table_name = 'test_transaction_fail_1'
          )`)
        );

        const table2Exists = await db.execute(
          sql.raw(`SELECT EXISTS (
            SELECT FROM information_schema.tables
            WHERE table_schema = 'public' AND table_name = 'test_transaction_fail_2'
          )`)
        );

        expect(table1Exists.rows[0]?.exists).toBe(true);
        expect(table2Exists.rows[0]?.exists).toBe(true);
      } else {
        // Neither table should exist
        const table1Exists = await db.execute(
          sql.raw(`SELECT EXISTS (
            SELECT FROM information_schema.tables
            WHERE table_schema = 'public' AND table_name = 'test_transaction_fail_1'
          )`)
        );

        const table2Exists = await db.execute(
          sql.raw(`SELECT EXISTS (
            SELECT FROM information_schema.tables
            WHERE table_schema = 'public' AND table_name = 'test_transaction_fail_2'
          )`)
        );

        expect(table1Exists.rows[0]?.exists).toBe(false);
        expect(table2Exists.rows[0]?.exists).toBe(false);
      }

      // Migration tracking should be consistent
      const migrationCount = await db.execute(
        sql.raw(`SELECT COUNT(*) as count
                 FROM migrations._migrations
                 WHERE plugin_name = '@elizaos/complex-transaction-test'`)
      );

      const expectedCount = migrationResult === 'success' ? 1 : 0;
      expect(parseInt((migrationCount.rows[0] as any).count)).toBe(expectedCount);
    });
  });

  describe('Error Recovery', () => {
    it('should recover gracefully from database connection issues', async () => {
      // This test would simulate connection drops during migration
      // For now, we just verify the migrator can handle basic errors

      let connectionError = false;
      try {
        // Try to use a closed connection (simulate connection issue)
        const badClient = new Client({
          connectionString: 'postgresql://invalid:invalid@localhost:9999/invalid',
        });
        const badDb = drizzle(badClient) as unknown as DrizzleDatabase;
        const badMigrator = new RuntimeMigrator(badDb);

        await badMigrator.initialize();
      } catch (error) {
        connectionError = true;
      }

      expect(connectionError).toBe(true);

      // Verify our good migrator still works
      const status = await migrator.getStatus('@elizaos/plugin-sql');
      expect(status.hasRun).toBe(true);
    });

    it('should handle partial schema definitions gracefully', async () => {
      const partialSchema = {
        validTable: pgTable('test_partial_valid', {
          id: uuid('id').primaryKey().defaultRandom(),
          data: text('data'),
        }),
        // This might cause issues depending on implementation
        emptyTable: pgTable('test_partial_empty', {}),
      };

      let partialMigrationError = false;
      try {
        await migrator.migrate('@elizaos/partial-schema-test', partialSchema);
      } catch (error) {
        partialMigrationError = true;
      }

      // Whether it succeeds or fails, it should be atomic
      const validTableExists = await db.execute(
        sql.raw(`SELECT EXISTS (
          SELECT FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'test_partial_valid'
        )`)
      );

      const emptyTableExists = await db.execute(
        sql.raw(`SELECT EXISTS (
          SELECT FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'test_partial_empty'
        )`)
      );

      if (partialMigrationError) {
        // If migration failed, no tables should be created
        expect(validTableExists.rows[0]?.exists).toBe(false);
        expect(emptyTableExists.rows[0]?.exists).toBe(false);
      } else {
        // If migration succeeded, check consistency
        const migrationRecorded = await db.execute(
          sql.raw(`SELECT COUNT(*) as count
                   FROM migrations._migrations
                   WHERE plugin_name = '@elizaos/partial-schema-test'`)
        );
        expect(parseInt((migrationRecorded.rows[0] as any).count)).toBe(1);
      }
    });
  });
});
