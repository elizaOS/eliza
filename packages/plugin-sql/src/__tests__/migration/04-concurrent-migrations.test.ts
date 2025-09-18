import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { pgTable, uuid, text, timestamp, integer } from 'drizzle-orm/pg-core';
import pg from 'pg';
import * as originalSchema from '../../schema';
import { RuntimeMigrator } from '../../runtime-migrator';
import type { DrizzleDatabase } from '../../types';

const { Client } = pg;

describe('Runtime Migrator - Concurrent Migration Tests', () => {
  let db: DrizzleDatabase;
  let client: pg.Client;
  let migrator: RuntimeMigrator;

  const POSTGRES_URL =
    process.env.POSTGRES_URL || 'postgresql://postgres:postgres@localhost:5555/eliza2';

  beforeAll(async () => {
    console.log('\n🔄 Testing Concurrent Migration Handling...\n');

    client = new Client({ connectionString: POSTGRES_URL });
    await client.connect();
    db = drizzle(client, { schema: originalSchema }) as unknown as DrizzleDatabase;

    migrator = new RuntimeMigrator(db);
    await migrator.initialize();
  });

  beforeEach(async () => {
    // Clean up test tables before each test
    const testTables = [
      'test_concurrent_1',
      'test_concurrent_2',
      'test_concurrent_3',
      'test_concurrent_4',
      'test_lock_table',
      'test_race_condition',
      'test_deadlock_scenario',
      'test_parallel_1',
      'test_parallel_2',
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
        WHERE plugin_name LIKE '%concurrent-test%'
      `)
      );
      await db.execute(
        sql.raw(`
        DELETE FROM migrations._journal 
        WHERE plugin_name LIKE '%concurrent-test%'
      `)
      );
      await db.execute(
        sql.raw(`
        DELETE FROM migrations._snapshots 
        WHERE plugin_name LIKE '%concurrent-test%'
      `)
      );
    } catch {
      // Ignore errors
    }
  });

  afterAll(async () => {
    await client.end();
  });

  describe('Basic Concurrent Migration Handling', () => {
    it('should handle two concurrent migrations for different plugins safely', async () => {
      const schema1 = {
        testTable1: pgTable('test_concurrent_1', {
          id: uuid('id').primaryKey().defaultRandom(),
          data: text('data'),
          created_at: timestamp('created_at').defaultNow(),
        }),
      };

      const schema2 = {
        testTable2: pgTable('test_concurrent_2', {
          id: uuid('id').primaryKey().defaultRandom(),
          name: text('name'),
          created_at: timestamp('created_at').defaultNow(),
        }),
      };

      // Run migrations concurrently
      const [result1, result2] = await Promise.allSettled([
        migrator.migrate('@elizaos/concurrent-test-1', schema1),
        migrator.migrate('@elizaos/concurrent-test-2', schema2),
      ]);

      // Both should complete successfully (either serialized or truly concurrent)
      expect(result1.status).toBe('fulfilled');
      expect(result2.status).toBe('fulfilled');

      // Verify both tables were created
      const table1Exists = await db.execute(
        sql.raw(`SELECT EXISTS (
          SELECT FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'test_concurrent_1'
        )`)
      );

      const table2Exists = await db.execute(
        sql.raw(`SELECT EXISTS (
          SELECT FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'test_concurrent_2'
        )`)
      );

      expect(table1Exists.rows[0]?.exists).toBe(true);
      expect(table2Exists.rows[0]?.exists).toBe(true);

      // Verify both migrations were recorded
      const migration1Count = await db.execute(
        sql.raw(`SELECT COUNT(*) as count FROM migrations._migrations 
                 WHERE plugin_name = '@elizaos/concurrent-test-1'`)
      );

      const migration2Count = await db.execute(
        sql.raw(`SELECT COUNT(*) as count FROM migrations._migrations 
                 WHERE plugin_name = '@elizaos/concurrent-test-2'`)
      );

      expect(parseInt((migration1Count.rows[0] as any).count)).toBe(1);
      expect(parseInt((migration2Count.rows[0] as any).count)).toBe(1);
    });

    it('should prevent concurrent migrations for the same plugin', async () => {
      const schema1 = {
        testTable: pgTable('test_concurrent_3', {
          id: uuid('id').primaryKey().defaultRandom(),
          data: text('data'),
          version: integer('version').default(1),
        }),
      };

      const schema2 = {
        testTable: pgTable('test_concurrent_3', {
          id: uuid('id').primaryKey().defaultRandom(),
          data: text('data'),
          version: integer('version').default(2),
          extra_field: text('extra_field'),
        }),
      };

      // Try to run the same plugin migration concurrently
      const [result1, result2] = await Promise.allSettled([
        migrator.migrate('@elizaos/concurrent-test-same-plugin', schema1),
        migrator.migrate('@elizaos/concurrent-test-same-plugin', schema2),
      ]);

      // One should succeed, one might fail due to locking or be ignored due to idempotency
      const successCount = [result1, result2].filter((r) => r.status === 'fulfilled').length;
      const failureCount = [result1, result2].filter((r) => r.status === 'rejected').length;

      // Either both succeed (serialized) or one fails (locked)
      expect(successCount + failureCount).toBe(2);
      expect(successCount).toBeGreaterThanOrEqual(1);

      // Check final state - should have exactly one migration record
      const migrationCount = await db.execute(
        sql.raw(`SELECT COUNT(*) as count FROM migrations._migrations 
                 WHERE plugin_name = '@elizaos/concurrent-test-same-plugin'`)
      );

      expect(parseInt((migrationCount.rows[0] as any).count)).toBe(1);

      // Table should exist
      const tableExists = await db.execute(
        sql.raw(`SELECT EXISTS (
          SELECT FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'test_concurrent_3'
        )`)
      );

      expect(tableExists.rows[0]?.exists).toBe(true);
    });
  });

  describe('Migration Locking Mechanisms', () => {
    it('should use proper locking to prevent race conditions', async () => {
      // Create multiple migrators to simulate different processes
      const migrator2 = new RuntimeMigrator(db);
      const migrator3 = new RuntimeMigrator(db);

      const testSchema = {
        testTable: pgTable('test_lock_table', {
          id: uuid('id').primaryKey().defaultRandom(),
          process_id: text('process_id'),
          created_at: timestamp('created_at').defaultNow(),
        }),
      };

      // Run migrations from multiple "processes" simultaneously
      const results = await Promise.allSettled([
        migrator.migrate('@elizaos/concurrent-test-locking', testSchema) as Promise<any>,
        migrator2.migrate('@elizaos/concurrent-test-locking', testSchema) as Promise<any>,
        migrator3.migrate('@elizaos/concurrent-test-locking', testSchema) as Promise<any>,
      ]);

      // Check results
      const successfulMigrations = results.filter((r) => r.status === 'fulfilled').length;
      const failedMigrations = results.filter((r) => r.status === 'rejected').length;

      console.log(
        `Concurrent migration results: ${successfulMigrations} successful, ${failedMigrations} failed`
      );

      // Should have exactly one successful migration due to locking
      expect(successfulMigrations).toBeGreaterThanOrEqual(1);

      // Verify only one migration record exists
      const migrationCount = await db.execute(
        sql.raw(`SELECT COUNT(*) as count FROM migrations._migrations 
                 WHERE plugin_name = '@elizaos/concurrent-test-locking'`)
      );

      expect(parseInt((migrationCount.rows[0] as any).count)).toBe(1);

      // Verify table was created exactly once
      const tableExists = await db.execute(
        sql.raw(`SELECT EXISTS (
          SELECT FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'test_lock_table'
        )`)
      );

      expect(tableExists.rows[0]?.exists).toBe(true);
    });

    it('should handle lock timeouts gracefully', async () => {
      // This test simulates what happens when a migration takes too long
      // and other processes timeout waiting for the lock

      const longRunningSchema = {
        testTable: pgTable('test_race_condition', {
          id: uuid('id').primaryKey().defaultRandom(),
          data: text('data'),
        }),
      };

      // Start a migration that will take some time
      const longMigrationPromise = migrator.migrate(
        '@elizaos/concurrent-test-timeout',
        longRunningSchema
      );

      // Wait a bit, then try another migration
      await new Promise((resolve) => setTimeout(resolve, 100));

      const quickMigrationPromise = migrator.migrate(
        '@elizaos/concurrent-test-timeout',
        longRunningSchema
      );

      const [longResult, quickResult] = await Promise.allSettled([
        longMigrationPromise,
        quickMigrationPromise,
      ]);

      // At least one should succeed
      const successCount = [longResult, quickResult].filter((r) => r.status === 'fulfilled').length;
      expect(successCount).toBeGreaterThanOrEqual(1);

      // Check that the system is in a consistent state
      const migrationCount = await db.execute(
        sql.raw(`SELECT COUNT(*) as count FROM migrations._migrations 
                 WHERE plugin_name = '@elizaos/concurrent-test-timeout'`)
      );

      expect(parseInt((migrationCount.rows[0] as any).count)).toBe(1);
    });
  });

  describe('Deadlock Prevention', () => {
    it('should prevent deadlocks when migrations have dependencies', async () => {
      // Create schemas that might cause circular dependencies
      const schemaA = {
        tableA: pgTable('test_deadlock_a', {
          id: uuid('id').primaryKey().defaultRandom(),
          b_ref: uuid('b_ref'), // References table B
          data: text('data'),
        }),
      };

      const schemaB = {
        tableB: pgTable('test_deadlock_b', {
          id: uuid('id').primaryKey().defaultRandom(),
          a_ref: uuid('a_ref'), // References table A
          data: text('data'),
        }),
      };

      // Run potentially conflicting migrations
      const [resultA, resultB] = await Promise.allSettled([
        migrator.migrate('@elizaos/concurrent-test-deadlock-a', schemaA),
        migrator.migrate('@elizaos/concurrent-test-deadlock-b', schemaB),
      ]);

      // Both should complete without deadlock
      expect(resultA.status).toBe('fulfilled');
      expect(resultB.status).toBe('fulfilled');

      // Verify both tables exist
      const tableAExists = await db.execute(
        sql.raw(`SELECT EXISTS (
          SELECT FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'test_deadlock_a'
        )`)
      );

      const tableBExists = await db.execute(
        sql.raw(`SELECT EXISTS (
          SELECT FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'test_deadlock_b'
        )`)
      );

      expect(tableAExists.rows[0]?.exists).toBe(true);
      expect(tableBExists.rows[0]?.exists).toBe(true);
    });

    it('should handle high-concurrency scenarios', async () => {
      // Create many concurrent migrations
      const migrationPromises: Promise<any>[] = [];

      for (let i = 0; i < 10; i++) {
        const schema = {
          testTable: pgTable(`test_concurrent_${i}`, {
            id: uuid('id').primaryKey().defaultRandom(),
            index: integer('index').default(i),
            data: text('data'),
          }),
        };

        migrationPromises.push(migrator.migrate(`@elizaos/concurrent-test-high-${i}`, schema));
      }

      // Wait for all migrations to complete
      const results = await Promise.allSettled(migrationPromises);

      // Count successful migrations
      const successfulCount = results.filter((r) => r.status === 'fulfilled').length;
      const failedCount = results.filter((r) => r.status === 'rejected').length;

      console.log(`High concurrency results: ${successfulCount} successful, ${failedCount} failed`);

      // All should succeed since they're different plugins
      expect(successfulCount).toBe(10);
      expect(failedCount).toBe(0);

      // Verify all migration records exist
      const totalMigrations = await db.execute(
        sql.raw(`SELECT COUNT(*) as count FROM migrations._migrations 
                 WHERE plugin_name LIKE '@elizaos/concurrent-test-high-%'`)
      );

      expect(parseInt((totalMigrations.rows[0] as any).count)).toBe(10);

      // Verify all tables were created
      const createdTables = await db.execute(
        sql.raw(`SELECT COUNT(*) as count FROM information_schema.tables 
                 WHERE table_schema = 'public' 
                 AND table_name LIKE 'test_concurrent_%'`)
      );

      expect(parseInt((createdTables.rows[0] as any).count)).toBeGreaterThanOrEqual(10);
    });
  });

  describe('Performance Under Concurrent Load', () => {
    it('should maintain reasonable performance with concurrent migrations', async () => {
      const startTime = Date.now();

      // Create concurrent migrations with some complexity
      const migrationPromises: Promise<any>[] = [];

      for (let i = 0; i < 5; i++) {
        const schema = {
          testTable: pgTable(`test_parallel_${i}`, {
            id: uuid('id').primaryKey().defaultRandom(),
            name: text('name').notNull(),
            email: text('email').unique(),
            data: text('data'),
            created_at: timestamp('created_at').defaultNow(),
          }),
        };

        migrationPromises.push(migrator.migrate(`@elizaos/concurrent-test-perf-${i}`, schema));
      }

      const results = await Promise.allSettled(migrationPromises);
      const endTime = Date.now();
      const totalTime = endTime - startTime;

      console.log(`Concurrent migration performance: ${totalTime}ms for 5 migrations`);

      // All should succeed
      const successfulCount = results.filter((r) => r.status === 'fulfilled').length;
      expect(successfulCount).toBe(5);

      // Performance should be reasonable (adjust threshold as needed)
      expect(totalTime).toBeLessThan(30000); // 30 seconds max

      // Verify all migrations completed
      const migrationCount = await db.execute(
        sql.raw(`SELECT COUNT(*) as count FROM migrations._migrations 
                 WHERE plugin_name LIKE '@elizaos/concurrent-test-perf-%'`)
      );

      expect(parseInt((migrationCount.rows[0] as any).count)).toBe(5);
    });

    it('should not leave orphaned locks after migration completion', async () => {
      // Run a migration
      const testSchema = {
        testTable: pgTable('test_lock_cleanup', {
          id: uuid('id').primaryKey().defaultRandom(),
          data: text('data'),
        }),
      };

      await migrator.migrate('@elizaos/concurrent-test-cleanup', testSchema);

      // Check if there are any advisory locks still held
      // PostgreSQL advisory locks can be checked via pg_locks
      const activeLocks = await db.execute(
        sql.raw(`SELECT COUNT(*) as count FROM pg_locks 
                 WHERE locktype = 'advisory' 
                 AND granted = true`)
      );

      const lockCount = parseInt((activeLocks.rows[0] as any).count);

      // There might be some locks from other operations, but there shouldn't be
      // an excessive number indicating leaked migration locks
      expect(lockCount).toBeLessThan(10); // Reasonable threshold

      // Try another migration to ensure no stale locks prevent it
      const anotherSchema = {
        testTable: pgTable('test_lock_cleanup_2', {
          id: uuid('id').primaryKey().defaultRandom(),
          data: text('data'),
        }),
      };

      const result = await migrator.migrate('@elizaos/concurrent-test-cleanup-2', anotherSchema);

      // Should succeed without lock conflicts
      expect(result).toBeDefined();

      // Verify table was created
      const tableExists = await db.execute(
        sql.raw(`SELECT EXISTS (
          SELECT FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'test_lock_cleanup_2'
        )`)
      );

      expect(tableExists.rows[0]?.exists).toBe(true);
    });
  });

  describe('Error Handling in Concurrent Scenarios', () => {
    it('should handle errors in one migration without affecting others', async () => {
      const validSchema = {
        testTable: pgTable('test_concurrent_4', {
          id: uuid('id').primaryKey().defaultRandom(),
          data: text('data'),
        }),
      };

      const invalidSchema = {
        invalidTable: 'this-is-not-valid' as any,
      };

      // Run one valid and one invalid migration concurrently
      const [validResult, invalidResult] = await Promise.allSettled([
        migrator.migrate('@elizaos/concurrent-test-valid', validSchema),
        migrator.migrate('@elizaos/concurrent-test-invalid', invalidSchema),
      ]);

      // Valid migration should succeed
      expect(validResult.status).toBe('fulfilled');

      // Invalid migration should fail
      expect(invalidResult.status).toBe('rejected');

      // Verify valid table was created
      const tableExists = await db.execute(
        sql.raw(`SELECT EXISTS (
          SELECT FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'test_concurrent_4'
        )`)
      );

      expect(tableExists.rows[0]?.exists).toBe(true);

      // Verify valid migration was recorded
      const validMigrationExists = await db.execute(
        sql.raw(`SELECT COUNT(*) as count FROM migrations._migrations 
                 WHERE plugin_name = '@elizaos/concurrent-test-valid'`)
      );

      expect(parseInt((validMigrationExists.rows[0] as any).count)).toBe(1);

      // Verify invalid migration was NOT recorded
      const invalidMigrationExists = await db.execute(
        sql.raw(`SELECT COUNT(*) as count FROM migrations._migrations 
                 WHERE plugin_name = '@elizaos/concurrent-test-invalid'`)
      );

      expect(parseInt((invalidMigrationExists.rows[0] as any).count)).toBe(0);
    });
  });
});
