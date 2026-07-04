/**
 * End-to-end `RuntimeMigrator` tests for transaction atomicity, PostgreSQL
 * advisory-lock-based concurrency control, and advisory-lock ID security.
 * Covers: full commit/rollback on migration success/failure, concurrent
 * migrate() calls for the same vs. different plugins, high-concurrency
 * (10-way) migration, lock-ID generation/validation/range-checking, and a
 * race-condition regression where a double-check-after-acquiring-the-lock
 * must catch a migration completed by another process while this one waited.
 * Advisory-lock-specific tests are skipped unless running against real
 * Postgres (`POSTGRES_URL` set), since PGlite doesn't support them.
 */
import { sql } from "drizzle-orm";
import { integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RuntimeMigrator } from "../../runtime-migrator";
import type { DrizzleDatabase } from "../../types";
import { createIsolatedTestDatabaseForMigration } from "../test-helpers";

interface CountRow {
  count: string | number;
}

interface TestableRuntimeMigrator extends RuntimeMigrator {
  getAdvisoryLockId(pluginName: string): bigint;
  validateBigInt(value: bigint): boolean;
}

function getTestableMigrator(migrator: RuntimeMigrator): TestableRuntimeMigrator {
  return migrator as TestableRuntimeMigrator;
}

// Deliberately-invalid FK target, used to force a migration failure for the
// rollback/error-isolation tests below.
function createInvalidTableReference(): { id: ReturnType<typeof uuid> } {
  return null as { id: ReturnType<typeof uuid> };
}

describe("Runtime Migrator - Transaction Support & Concurrency Tests", () => {
  let db: DrizzleDatabase;
  let migrator: RuntimeMigrator;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    console.log("\n🔒 Testing Transaction Support and Concurrent Migration Handling...\n");

    const testSetup = await createIsolatedTestDatabaseForMigration("transaction_concurrency_tests");
    db = testSetup.db;
    cleanup = testSetup.cleanup;

    migrator = new RuntimeMigrator(db);
    await migrator.initialize();
  });

  beforeEach(async () => {
    const testTables = [
      "test_transaction_success",
      "test_transaction_fail_1",
      "test_transaction_fail_2",
      "test_partial_migration",
      "test_should_rollback",
      "test_rollback_scenario",
      "test_concurrent_1",
      "test_concurrent_2",
      "test_concurrent_3",
      "test_concurrent_4",
      "test_lock_table",
      "test_race_condition",
      "test_deadlock_a",
      "test_deadlock_b",
      "test_parallel_1",
      "test_parallel_2",
    ];

    for (const table of testTables) {
      try {
        await db.execute(sql.raw(`DROP TABLE IF EXISTS ${table} CASCADE`));
      } catch {
        // Ignore errors
      }
    }

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

  describe("Transaction Atomicity", () => {
    it("should commit all changes when migration succeeds", async () => {
      const validSchema = {
        testTable: pgTable("test_transaction_success", {
          id: uuid("id").primaryKey().defaultRandom(),
          data: text("data"),
          created_at: timestamp("created_at").defaultNow(),
        }),
      };

      await migrator.migrate("@elizaos/transaction-test-success", validSchema);

      const tableExists = await db.execute(
        sql.raw(`SELECT EXISTS (
          SELECT FROM information_schema.tables
          WHERE table_schema = 'public'
          AND table_name = 'test_transaction_success'
        )`)
      );

      expect(tableExists.rows[0]?.exists).toBe(true);

      const migrationRecorded = await db.execute(
        sql.raw(`SELECT COUNT(*) as count
                 FROM migrations._migrations
                 WHERE plugin_name = '@elizaos/transaction-test-success'`)
      );

      expect(parseInt(String((migrationRecorded.rows[0] as unknown as CountRow).count), 10)).toBe(
        1
      );

      const journalRecorded = await db.execute(
        sql.raw(`SELECT COUNT(*) as count
                 FROM migrations._journal
                 WHERE plugin_name = '@elizaos/transaction-test-success'`)
      );

      expect(parseInt(String((journalRecorded.rows[0] as unknown as CountRow).count), 10)).toBe(1);
    });

    it("should rollback all changes when migration fails", async () => {
      const failingSchema = {
        testTable1: pgTable("test_partial_migration", {
          id: uuid("id").primaryKey().defaultRandom(),
          data: text("data"),
        }),
        // References a non-existent table, forcing the migration to fail.
        testTable2: pgTable("test_should_rollback", {
          id: uuid("id").primaryKey().defaultRandom(),
          fake_ref: uuid("fake_ref").references(() => createInvalidTableReference().id),
        }),
      };

      let migrationFailed = false;
      let _errorMessage = "";
      try {
        await migrator.migrate("@elizaos/transaction-test-fail", failingSchema);
      } catch (error) {
        migrationFailed = true;
        _errorMessage = (error as Error).message || "";
      }

      expect(migrationFailed).toBe(true);

      // The first table from the failed migration must not exist — proof the
      // whole transaction rolled back rather than partially applying.
      const partialTableExists = await db.execute(
        sql.raw(`SELECT EXISTS (
          SELECT FROM information_schema.tables
          WHERE table_schema = 'public'
          AND table_name = 'test_partial_migration'
        )`)
      );

      expect(partialTableExists.rows[0]?.exists).toBe(false);

      const failedMigrationRecorded = await db.execute(
        sql.raw(`SELECT COUNT(*) as count
                 FROM migrations._migrations
                 WHERE plugin_name = '@elizaos/transaction-test-fail'`)
      );

      expect(
        parseInt(String((failedMigrationRecorded.rows[0] as unknown as CountRow).count), 10)
      ).toBe(0);

      const failedJournalRecorded = await db.execute(
        sql.raw(`SELECT COUNT(*) as count
                 FROM migrations._journal
                 WHERE plugin_name = '@elizaos/transaction-test-fail'`)
      );

      expect(
        parseInt(String((failedJournalRecorded.rows[0] as unknown as CountRow).count), 10)
      ).toBe(0);
    });

    it("should maintain consistent state across migration failures", async () => {
      const initialMigrationCount = await db.execute(
        sql.raw(`SELECT COUNT(*) as count FROM migrations._migrations`)
      );

      const initialTableCount = await db.execute(
        sql.raw(`SELECT COUNT(*) as count 
                 FROM information_schema.tables 
                 WHERE table_schema = 'public'`)
      );

      let errorOccurred = false;
      try {
        const invalidSchema = {
          testTable: pgTable("test_invalid_table", {
            id: uuid("id").primaryKey().defaultRandom(),
            invalid_ref: uuid("invalid_ref").references(() => createInvalidTableReference().id),
          }),
        };

        await migrator.migrate("@elizaos/invalid-migration-test", invalidSchema);
      } catch (_error) {
        errorOccurred = true;
      }

      expect(errorOccurred).toBe(true);

      const finalMigrationCount = await db.execute(
        sql.raw(`SELECT COUNT(*) as count FROM migrations._migrations`)
      );

      const finalTableCount = await db.execute(
        sql.raw(`SELECT COUNT(*) as count 
                 FROM information_schema.tables 
                 WHERE table_schema = 'public'`)
      );

      expect(parseInt(String((finalMigrationCount.rows[0] as unknown as CountRow).count), 10)).toBe(
        parseInt(String((initialMigrationCount.rows[0] as unknown as CountRow).count), 10)
      );

      expect(parseInt(String((finalTableCount.rows[0] as unknown as CountRow).count), 10)).toBe(
        parseInt(String((initialTableCount.rows[0] as unknown as CountRow).count), 10)
      );
    });
  });

  describe("PostgreSQL Advisory Locks for Concurrent Migrations", () => {
    const postgresUrl = process.env.POSTGRES_URL || "";
    const isRealPostgres =
      postgresUrl &&
      !postgresUrl.includes(":memory:") &&
      !postgresUrl.includes("pglite") &&
      postgresUrl.includes("postgres");

    const testOrSkip = isRealPostgres ? it : it.skip;
    testOrSkip(
      "should use advisory locks to prevent concurrent migrations for the same plugin",
      async () => {
        // Identical schemas exercise idempotency under concurrent calls:
        // advisory locks should serialize the two calls, and the second
        // should be a no-op skip rather than a duplicate migration.
        const schema = {
          testTable: pgTable("test_concurrent_3", {
            id: uuid("id").primaryKey().defaultRandom(),
            data: text("data"),
            version: integer("version").default(1),
          }),
        };

        const [result1, result2] = await Promise.allSettled([
          migrator.migrate("@elizaos/concurrent-test-same-plugin", schema),
          migrator.migrate("@elizaos/concurrent-test-same-plugin", schema),
        ]);

        // One should succeed, one might fail due to locking or be ignored due to idempotency
        const successCount = [result1, result2].filter((r) => r.status === "fulfilled").length;
        const failureCount = [result1, result2].filter((r) => r.status === "rejected").length;

        // Either both succeed (serialized by advisory lock) or one fails (locked)
        expect(successCount + failureCount).toBe(2);
        expect(successCount).toBeGreaterThanOrEqual(1);

        // Should have exactly one migration record.
        const migrationCount = await db.execute(
          sql.raw(`SELECT COUNT(*) as count FROM migrations._migrations 
                 WHERE plugin_name = '@elizaos/concurrent-test-same-plugin'`)
        );

        expect(parseInt(String((migrationCount.rows[0] as unknown as CountRow).count), 10)).toBe(1);

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

    it("should allow concurrent migrations for different plugins", async () => {
      const schema1 = {
        testTable1: pgTable("test_concurrent_1", {
          id: uuid("id").primaryKey().defaultRandom(),
          data: text("data"),
          created_at: timestamp("created_at").defaultNow(),
        }),
      };

      const schema2 = {
        testTable2: pgTable("test_concurrent_2", {
          id: uuid("id").primaryKey().defaultRandom(),
          name: text("name"),
          created_at: timestamp("created_at").defaultNow(),
        }),
      };

      const [result1, result2] = await Promise.allSettled([
        migrator.migrate("@elizaos/concurrent-test-1", schema1),
        migrator.migrate("@elizaos/concurrent-test-2", schema2),
      ]);

      expect(result1.status).toBe("fulfilled");
      expect(result2.status).toBe("fulfilled");

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

      const migration1Count = await db.execute(
        sql.raw(`SELECT COUNT(*) as count FROM migrations._migrations 
                 WHERE plugin_name = '@elizaos/concurrent-test-1'`)
      );

      const migration2Count = await db.execute(
        sql.raw(`SELECT COUNT(*) as count FROM migrations._migrations 
                 WHERE plugin_name = '@elizaos/concurrent-test-2'`)
      );

      expect(parseInt(String((migration1Count.rows[0] as unknown as CountRow).count), 10)).toBe(1);
      expect(parseInt(String((migration2Count.rows[0] as unknown as CountRow).count), 10)).toBe(1);
    });

    testOrSkip("should use proper locking to prevent race conditions", async () => {
      // Three separate RuntimeMigrator instances simulate three concurrent processes.
      const migrator2 = new RuntimeMigrator(db);
      const migrator3 = new RuntimeMigrator(db);

      const testSchema = {
        testTable: pgTable("test_lock_table", {
          id: uuid("id").primaryKey().defaultRandom(),
          process_id: text("process_id"),
          created_at: timestamp("created_at").defaultNow(),
        }),
      };

      const results = await Promise.allSettled([
        migrator.migrate("@elizaos/concurrent-test-locking", testSchema) as Promise<void>,
        migrator2.migrate("@elizaos/concurrent-test-locking", testSchema) as Promise<void>,
        migrator3.migrate("@elizaos/concurrent-test-locking", testSchema) as Promise<void>,
      ]);

      const successfulMigrations = results.filter((r) => r.status === "fulfilled").length;
      const failedMigrations = results.filter((r) => r.status === "rejected").length;

      console.log(
        `Concurrent migration results: ${successfulMigrations} successful, ${failedMigrations} failed`
      );

      // Advisory locking should let exactly one migration through.
      expect(successfulMigrations).toBeGreaterThanOrEqual(1);

      const migrationCount = await db.execute(
        sql.raw(`SELECT COUNT(*) as count FROM migrations._migrations 
                 WHERE plugin_name = '@elizaos/concurrent-test-locking'`)
      );

      expect(parseInt(String((migrationCount.rows[0] as unknown as CountRow).count), 10)).toBe(1);

      const tableExists = await db.execute(
        sql.raw(`SELECT EXISTS (
          SELECT FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'test_lock_table'
        )`)
      );

      expect(tableExists.rows[0]?.exists).toBe(true);
    });

    testOrSkip("should release advisory locks after migration completion", async () => {
      const testSchema = {
        testTable: pgTable("test_lock_cleanup", {
          id: uuid("id").primaryKey().defaultRandom(),
          data: text("data"),
        }),
      };

      await migrator.migrate("@elizaos/concurrent-test-cleanup", testSchema);

      // pg_locks exposes currently-held advisory locks.
      const activeLocks = await db.execute(
        sql.raw(`SELECT COUNT(*) as count FROM pg_locks 
                 WHERE locktype = 'advisory' 
                 AND granted = true`)
      );

      const lockCount = parseInt(String((activeLocks.rows[0] as unknown as CountRow).count), 10);

      // There might be some locks from other operations, but there shouldn't be
      // an excessive number indicating leaked migration locks
      expect(lockCount).toBeLessThan(10); // Reasonable threshold

      // Try another migration to ensure no stale locks prevent it
      const anotherSchema = {
        testTable: pgTable("test_lock_cleanup_2", {
          id: uuid("id").primaryKey().defaultRandom(),
          data: text("data"),
        }),
      };

      await migrator.migrate("@elizaos/concurrent-test-cleanup-2", anotherSchema);

      const tableExists = await db.execute(
        sql.raw(`SELECT EXISTS (
          SELECT FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'test_lock_cleanup_2'
        )`)
      );

      expect(tableExists.rows[0]?.exists).toBe(true);
    });

    it("should handle high-concurrency scenarios with advisory locks", async () => {
      const migrationPromises: Promise<void>[] = [];

      for (let i = 0; i < 10; i++) {
        const schema = {
          testTable: pgTable(`test_concurrent_${i}`, {
            id: uuid("id").primaryKey().defaultRandom(),
            index: integer("index").default(i),
            data: text("data"),
          }),
        };

        migrationPromises.push(migrator.migrate(`@elizaos/concurrent-test-high-${i}`, schema));
      }

      const results = await Promise.allSettled(migrationPromises);

      const successfulCount = results.filter((r) => r.status === "fulfilled").length;
      const failedCount = results.filter((r) => r.status === "rejected").length;

      console.log(`High concurrency results: ${successfulCount} successful, ${failedCount} failed`);

      // All should succeed since they're different plugins
      expect(successfulCount).toBe(10);
      expect(failedCount).toBe(0);

      const totalMigrations = await db.execute(
        sql.raw(`SELECT COUNT(*) as count FROM migrations._migrations 
                 WHERE plugin_name LIKE '@elizaos/concurrent-test-high-%'`)
      );

      interface QueryRow {
        count: string;
      }
      expect(parseInt((totalMigrations.rows[0] as unknown as QueryRow).count, 10)).toBe(10);

      const createdTables = await db.execute(
        sql.raw(`SELECT COUNT(*) as count FROM information_schema.tables 
                 WHERE table_schema = 'public' 
                 AND table_name LIKE 'test_concurrent_%'`)
      );

      interface QueryRow {
        count: string;
      }
      expect(
        parseInt((createdTables.rows[0] as unknown as QueryRow).count, 10)
      ).toBeGreaterThanOrEqual(10);
    });

    it("should handle errors in one migration without affecting others", async () => {
      const validSchema = {
        testTable: pgTable("test_concurrent_4", {
          id: uuid("id").primaryKey().defaultRandom(),
          data: text("data"),
        }),
      };

      const invalidSchema = {
        testTable: pgTable("test_invalid_concurrent", {
          id: uuid("id").primaryKey().defaultRandom(),
          bad_ref: uuid("bad_ref").references(() => createInvalidTableReference().id),
        }),
      };

      const [validResult, invalidResult] = await Promise.allSettled([
        migrator.migrate("@elizaos/concurrent-test-valid", validSchema),
        migrator.migrate("@elizaos/concurrent-test-invalid", invalidSchema),
      ]);

      expect(validResult.status).toBe("fulfilled");
      expect(invalidResult.status).toBe("rejected");

      const tableExists = await db.execute(
        sql.raw(`SELECT EXISTS (
          SELECT FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'test_concurrent_4'
        )`)
      );

      expect(tableExists.rows[0]?.exists).toBe(true);

      const validMigrationExists = await db.execute(
        sql.raw(`SELECT COUNT(*) as count FROM migrations._migrations 
                 WHERE plugin_name = '@elizaos/concurrent-test-valid'`)
      );

      expect(
        parseInt(String((validMigrationExists.rows[0] as unknown as CountRow).count), 10)
      ).toBe(1);

      const invalidMigrationExists = await db.execute(
        sql.raw(`SELECT COUNT(*) as count FROM migrations._migrations 
                 WHERE plugin_name = '@elizaos/concurrent-test-invalid'`)
      );

      expect(
        parseInt(String((invalidMigrationExists.rows[0] as unknown as CountRow).count), 10)
      ).toBe(0);
    });
  });

  describe("Advisory Lock Security", () => {
    it("should generate valid bigint lock IDs for plugins", async () => {
      const testPlugins = [
        "@elizaos/plugin-sql",
        "@elizaos/plugin-openai",
        "some-very-long-plugin-name-that-should-still-work-correctly",
        "plugin-with-special-chars-!@#$%^&*()",
      ];

      for (const pluginName of testPlugins) {
        const lockId = getTestableMigrator(migrator).getAdvisoryLockId(pluginName);

        expect(typeof lockId).toBe("bigint");

        const _MIN_BIGINT = -9223372036854775808n;
        const MAX_BIGINT = 9223372036854775807n;
        expect(lockId).toBeGreaterThanOrEqual(0n); // We ensure positive values
        expect(lockId).toBeLessThanOrEqual(MAX_BIGINT);

        expect(lockId).not.toBe(0n);
      }
    });

    it("should generate consistent lock IDs for the same plugin", async () => {
      const pluginName = "@elizaos/advisory-lock-test";

      const testMigrator = getTestableMigrator(migrator);
      const lockId1 = testMigrator.getAdvisoryLockId(pluginName);
      const lockId2 = testMigrator.getAdvisoryLockId(pluginName);
      const lockId3 = testMigrator.getAdvisoryLockId(pluginName);

      expect(lockId1).toBe(lockId2);
      expect(lockId2).toBe(lockId3);
    });

    it("should generate different lock IDs for different plugins", async () => {
      const plugin1 = "@elizaos/lock-plugin-1";
      const plugin2 = "@elizaos/lock-plugin-2";

      const testMigrator = getTestableMigrator(migrator);
      const lockId1 = testMigrator.getAdvisoryLockId(plugin1);
      const lockId2 = testMigrator.getAdvisoryLockId(plugin2);

      expect(lockId1).not.toBe(lockId2);
    });

    it("should correctly validate PostgreSQL bigint values", async () => {
      const testMigrator = getTestableMigrator(migrator);
      const validateBigInt = testMigrator.validateBigInt.bind(testMigrator);

      expect(validateBigInt(0n)).toBe(true);
      expect(validateBigInt(1n)).toBe(true);
      expect(validateBigInt(9223372036854775807n)).toBe(true); // MAX
      expect(validateBigInt(-9223372036854775808n)).toBe(true); // MIN
      expect(validateBigInt(1000000n)).toBe(true);

      // Invalid values (out of range)
      expect(validateBigInt(9223372036854775808n)).toBe(false); // MAX + 1
      expect(validateBigInt(-9223372036854775809n)).toBe(false); // MIN - 1
      expect(validateBigInt(BigInt("99999999999999999999999999999"))).toBe(false);
    });

    it("should use CAST for type safety in advisory lock queries", async () => {
      // Verifying SQL generation uses proper parameterization.
      // PGLite doesn't support advisory locks, so testing internal logic only.

      const _simpleSchema = {
        testTable: pgTable("test_lock_security", {
          id: uuid("id").primaryKey().defaultRandom(),
          data: text("data"),
        }),
      };

      const testMigrator = getTestableMigrator(migrator);
      const lockId = testMigrator.getAdvisoryLockId("@elizaos/lock-security-test");

      expect(typeof lockId).toBe("bigint");

      // The real lock queries use CAST(${lockIdStr} AS bigint), relying on
      // Drizzle's sql tagged template for parameterization; the string form
      // must therefore contain only digits.
      const lockIdStr = lockId.toString();

      expect(/^\d+$/.test(lockIdStr)).toBe(true);
    });

    it("should reject migration if invalid lock ID is generated", async () => {
      const testMigrator = getTestableMigrator(migrator);
      const originalGetLockId = testMigrator.getAdvisoryLockId.bind(testMigrator);

      try {
        // Force an out-of-bigint-range lock ID to exercise the validation path.
        testMigrator.getAdvisoryLockId = () => {
          return BigInt("99999999999999999999999999999");
        };

        const testSchema = {
          test: pgTable("test_invalid_lock", {
            id: uuid("id").primaryKey().defaultRandom(),
          }),
        };

        await expect(migrator.migrate("@elizaos/invalid-lock-test", testSchema)).rejects.toThrow(
          "Invalid advisory lock ID"
        );
      } finally {
        testMigrator.getAdvisoryLockId = originalGetLockId;
      }
    });

    it("should handle concurrent migrations safely with advisory locks", async () => {
      const schema1 = {
        testTable: pgTable("test_advisory_concurrent_1", {
          id: uuid("id").primaryKey().defaultRandom(),
          data: text("data"),
        }),
      };

      const schema2 = {
        testTable: pgTable("test_advisory_concurrent_2", {
          id: uuid("id").primaryKey().defaultRandom(),
          data: text("data"),
        }),
      };

      const results = await Promise.allSettled([
        migrator.migrate("@elizaos/advisory-concurrent-test-1", schema1),
        migrator.migrate("@elizaos/advisory-concurrent-test-2", schema2),
      ]);

      expect(results[0].status).toBe("fulfilled");
      expect(results[1].status).toBe("fulfilled");

      const tablesExist = await db.execute(
        sql.raw(`
          SELECT COUNT(*) as count 
          FROM information_schema.tables 
          WHERE table_schema = 'public' 
            AND table_name IN ('test_advisory_concurrent_1', 'test_advisory_concurrent_2')
        `)
      );

      expect(parseInt(String((tablesExist.rows[0] as unknown as CountRow).count), 10)).toBe(2);
    });
  });

  describe("Race Condition Prevention", () => {
    const postgresUrl = process.env.POSTGRES_URL || "";
    const isRealPostgres =
      postgresUrl &&
      !postgresUrl.includes(":memory:") &&
      !postgresUrl.includes("pglite") &&
      postgresUrl.includes("postgres");

    const testOrSkip = isRealPostgres ? it : it.skip;

    testOrSkip("should handle race condition when lastMigration is initially null", async () => {
      // Regression coverage for: (1) process A checks and finds
      // lastMigration = null, (2) process B completes the migration while A
      // waits for the advisory lock, (3) A must detect B's completion via a
      // double-check after acquiring the lock rather than re-running the
      // migration. Requires real Postgres — PGlite has no advisory locks.
      const pluginName = "@elizaos/test-race-condition-null-initial";

      const schema1 = {
        testTable: pgTable("test_race_null_initial", {
          id: uuid("id").primaryKey().defaultRandom(),
          data: text("data"),
          version: integer("version").default(1),
        }),
      };

      const schema2 = {
        testTable: pgTable("test_race_null_initial", {
          id: uuid("id").primaryKey().defaultRandom(),
          data: text("data"),
          version: integer("version").default(1), // Same version, should be idempotent
        }),
      };

      await db.execute(
        sql.raw(`DELETE FROM migrations._migrations WHERE plugin_name = '${pluginName}'`)
      );
      await db.execute(
        sql.raw(`DELETE FROM migrations._snapshots WHERE plugin_name = '${pluginName}'`)
      );

      await db.execute(sql.raw(`DROP TABLE IF EXISTS test_race_null_initial`));

      const migrator1 = new RuntimeMigrator(db);
      const migrator2 = new RuntimeMigrator(db);

      // Both instances see lastMigration = null and race to acquire the lock.
      const [result1, result2] = await Promise.allSettled([
        migrator1.migrate(pluginName, schema1),
        migrator2.migrate(pluginName, schema2),
      ]);

      // Both should succeed (one creates, one is skipped by double-check)
      expect(result1.status).toBe("fulfilled");
      expect(result2.status).toBe("fulfilled");

      // Should have exactly one migration record
      const migrationCount = await db.execute(
        sql.raw(`SELECT COUNT(*) as count FROM migrations._migrations 
                 WHERE plugin_name = '${pluginName}'`)
      );
      expect(parseInt(String((migrationCount.rows[0] as unknown as CountRow).count), 10)).toBe(1);

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
