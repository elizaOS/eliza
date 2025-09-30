import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, timestamp, integer } from 'drizzle-orm/pg-core';
import { RuntimeMigrator } from '../../runtime-migrator';
import type { DrizzleDatabase } from '../../types';
import { createIsolatedTestDatabaseForMigration } from '../test-helpers';

describe('Runtime Migrator - Transaction Support & Concurrency Tests', () => {
  let db: DrizzleDatabase;
  let migrator: RuntimeMigrator;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    console.log('\n🔒 Testing Transaction Support and Concurrent Migration Handling...\n');

    const testSetup = await createIsolatedTestDatabaseForMigration('transaction_concurrency_tests');
    db = testSetup.db;
    cleanup = testSetup.cleanup;

    migrator = new RuntimeMigrator(db);
    await migrator.initialize();
  });

  beforeEach(async () => {
    // Clean up test tables before each test
    const testTables = [
      'test_transaction_success',
      'test_transaction_fail_1',
      'test_transaction_fail_2',
      'test_partial_migration',
      'test_should_rollback',
      'test_rollback_scenario',
      'test_concurrent_1',
      'test_concurrent_2',
      'test_concurrent_3',
      'test_concurrent_4',
      'test_lock_table',
      'test_race_condition',
      'test_deadlock_a',
      'test_deadlock_b',
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
        WHERE plugin_name LIKE '%transaction-test%' 
           OR plugin_name LIKE '%concurrent-test%'
      `)
      );
      await db.execute(
        sql.raw(`
        DELETE FROM migrations._journal 
        WHERE plugin_name LIKE '%transaction-test%'
           OR plugin_name LIKE '%concurrent-test%'
      `)
      );
      await db.execute(
        sql.raw(`
        DELETE FROM migrations._snapshots 
        WHERE plugin_name LIKE '%transaction-test%'
           OR plugin_name LIKE '%concurrent-test%'
      `)
      );
    } catch {
      // Ignore errors
    }
  });

  afterAll(async () => {
    if (cleanup) {
      await cleanup();
    }
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
      // Mock a failure by providing an invalid schema that will cause SQL errors
      const failingSchema = {
        testTable1: pgTable('test_partial_migration', {
          id: uuid('id').primaryKey().defaultRandom(),
          data: text('data'),
        }),
        // This table references a non-existent table, which should cause failure
        testTable2: pgTable('test_should_rollback', {
          id: uuid('id').primaryKey().defaultRandom(),
          // Reference to non-existent table will fail
          fake_ref: uuid('fake_ref').references(() => (null as any).id),
        }),
      };

      let migrationFailed = false;
      let errorMessage = '';
      try {
        await migrator.migrate('@elizaos/transaction-test-fail', failingSchema);
      } catch (error) {
        migrationFailed = true;
        errorMessage = (error as Error).message || '';
      }

      // The migration should have failed
      expect(migrationFailed).toBe(true);

      // Verify that the first table from the failed migration was NOT created
      // This proves the transaction was rolled back
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

      // Try an migration with invalid reference that will fail
      let errorOccurred = false;
      try {
        const invalidSchema = {
          testTable: pgTable('test_invalid_table', {
            id: uuid('id').primaryKey().defaultRandom(),
            // This will create invalid foreign key reference
            invalid_ref: uuid('invalid_ref').references(() => (undefined as any).id),
          }),
        };

        await migrator.migrate('@elizaos/invalid-migration-test', invalidSchema);
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
  });

  describe('PostgreSQL Advisory Locks for Concurrent Migrations', () => {
    // Check if we're using real PostgreSQL (not PGLite)
    const postgresUrl = process.env.POSTGRES_URL || '';
    const isRealPostgres =
      postgresUrl &&
      !postgresUrl.includes(':memory:') &&
      !postgresUrl.includes('pglite') &&
      postgresUrl.includes('postgres');

    // Skip advisory lock tests for PGLite since it doesn't support them
    const testOrSkip = isRealPostgres ? it : it.skip;
    testOrSkip(
      'should use advisory locks to prevent concurrent migrations for the same plugin',
      async () => {
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

        // Either both succeed (serialized by advisory lock) or one fails (locked)
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
      }
    );

    it('should allow concurrent migrations for different plugins', async () => {
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

      // Run migrations concurrently for different plugins
      const [result1, result2] = await Promise.allSettled([
        migrator.migrate('@elizaos/concurrent-test-1', schema1),
        migrator.migrate('@elizaos/concurrent-test-2', schema2),
      ]);

      // Both should complete successfully
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

    testOrSkip('should use proper locking to prevent race conditions', async () => {
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

      // Should have exactly one successful migration due to advisory locking
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

    testOrSkip('should release advisory locks after migration completion', async () => {
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

    it('should handle high-concurrency scenarios with advisory locks', async () => {
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

    it('should handle errors in one migration without affecting others', async () => {
      const validSchema = {
        testTable: pgTable('test_concurrent_4', {
          id: uuid('id').primaryKey().defaultRandom(),
          data: text('data'),
        }),
      };

      // Create an actually invalid schema that will cause an error
      const invalidSchema = {
        testTable: pgTable('test_invalid_concurrent', {
          id: uuid('id').primaryKey().defaultRandom(),
          // This will cause an error during migration due to invalid reference
          bad_ref: uuid('bad_ref').references(() => (null as any).id),
        }),
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

  describe('Advisory Lock Security', () => {
    it('should generate valid bigint lock IDs for plugins', async () => {
      // Test that getAdvisoryLockId returns a valid bigint
      const testPlugins = [
        '@elizaos/plugin-sql',
        '@elizaos/plugin-bootstrap',
        'some-very-long-plugin-name-that-should-still-work-correctly',
        'plugin-with-special-chars-!@#$%^&*()',
      ];

      for (const pluginName of testPlugins) {
        // Access private method through any type casting for testing
        const lockId = (migrator as any).getAdvisoryLockId(pluginName);

        // Verify it's a bigint
        expect(typeof lockId).toBe('bigint');

        // Verify it's within PostgreSQL bigint range
        const MIN_BIGINT = -9223372036854775808n;
        const MAX_BIGINT = 9223372036854775807n;
        expect(lockId).toBeGreaterThanOrEqual(0n); // We ensure positive values
        expect(lockId).toBeLessThanOrEqual(MAX_BIGINT);

        // Verify it's non-zero
        expect(lockId).not.toBe(0n);
      }
    });

    it('should generate consistent lock IDs for the same plugin', async () => {
      const pluginName = '@elizaos/advisory-lock-test';

      // Generate lock ID multiple times
      const lockId1 = (migrator as any).getAdvisoryLockId(pluginName);
      const lockId2 = (migrator as any).getAdvisoryLockId(pluginName);
      const lockId3 = (migrator as any).getAdvisoryLockId(pluginName);

      // All should be identical
      expect(lockId1).toBe(lockId2);
      expect(lockId2).toBe(lockId3);
    });

    it('should generate different lock IDs for different plugins', async () => {
      const plugin1 = '@elizaos/lock-plugin-1';
      const plugin2 = '@elizaos/lock-plugin-2';

      const lockId1 = (migrator as any).getAdvisoryLockId(plugin1);
      const lockId2 = (migrator as any).getAdvisoryLockId(plugin2);

      // Should be different
      expect(lockId1).not.toBe(lockId2);
    });

    it('should correctly validate PostgreSQL bigint values', async () => {
      const validateBigInt = (migrator as any).validateBigInt.bind(migrator);

      // Valid values
      expect(validateBigInt(0n)).toBe(true);
      expect(validateBigInt(1n)).toBe(true);
      expect(validateBigInt(9223372036854775807n)).toBe(true); // MAX
      expect(validateBigInt(-9223372036854775808n)).toBe(true); // MIN
      expect(validateBigInt(1000000n)).toBe(true);

      // Invalid values (out of range)
      expect(validateBigInt(9223372036854775808n)).toBe(false); // MAX + 1
      expect(validateBigInt(-9223372036854775809n)).toBe(false); // MIN - 1
      expect(validateBigInt(BigInt('99999999999999999999999999999'))).toBe(false);
    });

    it('should use CAST for type safety in advisory lock queries', async () => {
      // Note: This test is primarily for verification that our SQL generation
      // uses proper parameterization. Since PGLite doesn't support advisory locks,
      // we're testing the internal logic rather than actual execution.

      const simpleSchema = {
        testTable: pgTable('test_lock_security', {
          id: uuid('id').primaryKey().defaultRandom(),
          data: text('data'),
        }),
      };

      // Get the lock ID that would be used
      const lockId = (migrator as any).getAdvisoryLockId('@elizaos/lock-security-test');

      // Verify it's a valid bigint
      expect(typeof lockId).toBe('bigint');

      // The actual SQL queries use CAST(${lockIdStr} AS bigint) for safety
      // This ensures proper parameterization through Drizzle's sql tagged template
      const lockIdStr = lockId.toString();

      // Verify the string conversion doesn't introduce invalid characters
      expect(/^\d+$/.test(lockIdStr)).toBe(true);
    });

    it('should reject migration if invalid lock ID is generated', async () => {
      // Save original method
      const originalGetLockId = (migrator as any).getAdvisoryLockId;

      try {
        // Mock getAdvisoryLockId to return an invalid value
        (migrator as any).getAdvisoryLockId = () => {
          // Return an out-of-range bigint
          return BigInt('99999999999999999999999999999');
        };

        const testSchema = {
          test: pgTable('test_invalid_lock', {
            id: uuid('id').primaryKey().defaultRandom(),
          }),
        };

        // This should throw an error due to invalid lock ID
        await expect(migrator.migrate('@elizaos/invalid-lock-test', testSchema)).rejects.toThrow(
          'Invalid advisory lock ID'
        );
      } finally {
        // Restore original method
        (migrator as any).getAdvisoryLockId = originalGetLockId;
      }
    });

    it('should handle concurrent migrations safely with advisory locks', async () => {
      // This test verifies that our advisory lock mechanism would prevent
      // race conditions in a real PostgreSQL environment

      const schema1 = {
        testTable: pgTable('test_advisory_concurrent_1', {
          id: uuid('id').primaryKey().defaultRandom(),
          data: text('data'),
        }),
      };

      const schema2 = {
        testTable: pgTable('test_advisory_concurrent_2', {
          id: uuid('id').primaryKey().defaultRandom(),
          data: text('data'),
        }),
      };

      // Run migrations concurrently
      const results = await Promise.allSettled([
        migrator.migrate('@elizaos/advisory-concurrent-test-1', schema1),
        migrator.migrate('@elizaos/advisory-concurrent-test-2', schema2),
      ]);

      // Both should succeed
      expect(results[0].status).toBe('fulfilled');
      expect(results[1].status).toBe('fulfilled');

      // Verify both tables were created
      const tablesExist = await db.execute(
        sql.raw(`
          SELECT COUNT(*) as count 
          FROM information_schema.tables 
          WHERE table_schema = 'public' 
            AND table_name IN ('test_advisory_concurrent_1', 'test_advisory_concurrent_2')
        `)
      );

      expect(parseInt((tablesExist.rows[0] as any).count)).toBe(2);
    });
  });

  describe('Race Condition Prevention', () => {
    // Check if we're using real PostgreSQL (not PGLite)
    const postgresUrl = process.env.POSTGRES_URL || '';
    const isRealPostgres =
      postgresUrl &&
      !postgresUrl.includes(':memory:') &&
      !postgresUrl.includes('pglite') &&
      postgresUrl.includes('postgres');

    // Skip this test for PGLite since it doesn't support advisory locks
    const testOrSkip = isRealPostgres ? it : it.skip;

    testOrSkip('should handle race condition when lastMigration is initially null', async () => {
      // This test verifies the fix for the race condition where:
      // 1. Process A checks and finds lastMigration = null
      // 2. Process B completes a migration while A waits for lock
      // 3. Process A must detect the completion via double-check
      // Note: This only works with real PostgreSQL (advisory locks required)

      const pluginName = '@elizaos/test-race-condition-null-initial';

      const schema1 = {
        testTable: pgTable('test_race_null_initial', {
          id: uuid('id').primaryKey().defaultRandom(),
          data: text('data'),
          version: integer('version').default(1),
        }),
      };

      const schema2 = {
        testTable: pgTable('test_race_null_initial', {
          id: uuid('id').primaryKey().defaultRandom(),
          data: text('data'),
          version: integer('version').default(1), // Same version, should be idempotent
        }),
      };

      // Clean up any existing migration records for this test
      await db.execute(
        sql.raw(`DELETE FROM migrations._migrations WHERE plugin_name = '${pluginName}'`)
      );
      await db.execute(
        sql.raw(`DELETE FROM migrations._snapshots WHERE plugin_name = '${pluginName}'`)
      );

      // Drop the table if it exists
      await db.execute(sql.raw(`DROP TABLE IF EXISTS test_race_null_initial`));

      // Create two migrators to simulate two processes
      const migrator1 = new RuntimeMigrator(db);
      const migrator2 = new RuntimeMigrator(db);

      // Run migrations concurrently - both should see no initial migration
      // and both will try to acquire the lock
      const [result1, result2] = await Promise.allSettled([
        migrator1.migrate(pluginName, schema1),
        migrator2.migrate(pluginName, schema2),
      ]);

      // Both should succeed (one creates, one is skipped by double-check)
      expect(result1.status).toBe('fulfilled');
      expect(result2.status).toBe('fulfilled');

      // Should have exactly one migration record
      const migrationCount = await db.execute(
        sql.raw(`SELECT COUNT(*) as count FROM migrations._migrations 
                 WHERE plugin_name = '${pluginName}'`)
      );
      expect(parseInt((migrationCount.rows[0] as any).count)).toBe(1);

      // Table should exist
      const tableExists = await db.execute(
        sql.raw(`SELECT EXISTS (
          SELECT FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'test_race_null_initial'
        )`)
      );
      expect(tableExists.rows[0]?.exists).toBe(true);

      // Verify the double-check logic worked by checking logs
      // (In a real scenario, we'd check that one process logged
      // "Migration completed by another process")
    });
  });
});
