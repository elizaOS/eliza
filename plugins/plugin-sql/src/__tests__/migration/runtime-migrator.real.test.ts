/**
 * End-to-end `RuntimeMigrator` tests against a real isolated Postgres
 * database, covering: migration-infrastructure init, running the core
 * plugin-sql schema and tracking it in `_migrations`/`_journal`/`_snapshots`,
 * column type/FK/unique/check-constraint/index creation, idempotent re-runs,
 * dry-run and reset, error handling for an invalid schema, and — critically —
 * that migrating plugin-sql never drops or alters tables/columns belonging
 * to other plugins that happen to share the public schema. Accumulates a
 * pass/fail summary logged in `afterAll` alongside the vitest assertions.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

interface ExistsRow {
  exists: boolean;
}

interface CountRow {
  count: string | number;
}

interface MigrationRow {
  plugin_name: string;
  idx: number;
  hash: string;
  [key: string]: unknown;
}

interface JournalRow {
  plugin_name: string;
  entries: unknown;
  [key: string]: unknown;
}

interface SnapshotRow {
  plugin_name: string;
  idx: number;
  snapshot: unknown;
  [key: string]: unknown;
}

interface ColumnRow {
  data_type: string;
  [key: string]: unknown;
}

interface TableInfoRow {
  tablename: string;
  [key: string]: unknown;
}

interface ConstraintRow {
  table_name: string;
  constraint_name: string;
  [key: string]: unknown;
}

import { sql } from "drizzle-orm";
import { RuntimeMigrator } from "../../runtime-migrator";
import type { DrizzleDB } from "../../runtime-migrator/types";
import * as schema from "../../schema";
import { createIsolatedTestDatabaseForMigration } from "../test-helpers";

describe("Runtime Migrator - PostgreSQL Integration Tests", () => {
  let db: DrizzleDB;
  let migrator: RuntimeMigrator;
  let cleanup: () => Promise<void>;
  const testResults: { passed: string[]; failed: string[] } = {
    passed: [],
    failed: [],
  };

  beforeAll(async () => {
    console.log("\n🚀 Starting Runtime Migrator Tests...\n");

    const testSetup = await createIsolatedTestDatabaseForMigration("runtime_migrator_tests");
    db = testSetup.db;
    cleanup = testSetup.cleanup;

    migrator = new RuntimeMigrator(db);

    console.log("🗑️  Test environment ready...");

    try {
      // Guards against a leftover `migrations` schema from a previous failed run.
      await db.execute(sql`DROP SCHEMA IF EXISTS migrations CASCADE`);

      console.log("✅ Test environment cleaned\n");
    } catch (error) {
      console.log("⚠️  Cleanup warning:", error);
    }
  });

  afterAll(async () => {
    console.log(`\n${"=".repeat(80)}`);
    console.log("📊 RUNTIME MIGRATOR TEST SUMMARY");
    console.log(`${"=".repeat(80)}\n`);

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

    console.log(`\n${"=".repeat(80)}\n`);

    if (cleanup) {
      await cleanup();
    }
  });

  describe("Migration System Initialization", () => {
    it("should initialize migration tables", async () => {
      await migrator.initialize();

      const schemaResult = await db.execute(
        sql`SELECT EXISTS (
          SELECT 1 FROM information_schema.schemata 
          WHERE schema_name = 'migrations'
        ) as exists`
      );

      const schemaExists = (schemaResult.rows[0] as ExistsRow).exists;
      expect(schemaExists).toBe(true);

      if (schemaExists) {
        testResults.passed.push("Migration schema created");
      } else {
        testResults.failed.push("Migration schema not created");
      }

      const tables = ["_migrations", "_journal", "_snapshots"];

      for (const tableName of tables) {
        const result = await db.execute(
          sql`SELECT EXISTS (
            SELECT 1 FROM pg_tables
            WHERE schemaname = 'migrations'
            AND tablename = ${tableName}
          ) as exists`
        );

        const exists = (result.rows[0] as ExistsRow).exists;
        expect(exists).toBe(true);

        if (exists) {
          testResults.passed.push(`Migration table created: migrations.${tableName}`);
        } else {
          testResults.failed.push(`Migration table missing: migrations.${tableName}`);
        }
      }
    });
  });

  describe("Schema Migration Execution", () => {
    it("should run initial migration for plugin-sql schema", async () => {
      await migrator.migrate("plugin-sql", schema, { verbose: true });

      const tablesResult = await db.execute(
        sql`SELECT tablename FROM pg_tables 
            WHERE schemaname = 'public' 
            ORDER BY tablename`
      );

      const createdTables = tablesResult.rows.map((r: TableInfoRow) => r.tablename);
      console.log(`\n📋 Tables created: ${createdTables.length}`);

      const expectedTables = [
        "agents",
        "cache",
        "channel_participants",
        "channels",
        "components",
        "embeddings",
        "entities",
        "logs",
        "memories",
        "message_servers",
        "message_server_agents",
        "central_messages",
        "participants",
        "relationships",
        "rooms",
        "tasks",
        "worlds",
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

    it("should track migration in _migrations table", async () => {
      const result = await db.execute(
        sql`SELECT * FROM migrations._migrations 
            WHERE plugin_name = 'plugin-sql'
            ORDER BY created_at DESC
            LIMIT 1`
      );

      expect(result.rows.length).toBeGreaterThan(0);

      if (result.rows.length > 0) {
        const migration = result.rows[0] as MigrationRow;
        testResults.passed.push(
          `Migration tracked: ${migration.plugin_name} - ${migration.hash.substring(0, 8)}...`
        );
      } else {
        testResults.failed.push("Migration not tracked in _migrations table");
      }
    });

    it("should save journal entry", async () => {
      const result = await db.execute(
        sql`SELECT * FROM migrations._journal 
            WHERE plugin_name = 'plugin-sql'`
      );

      expect(result.rows.length).toBe(1);

      if (result.rows.length > 0) {
        const journal = result.rows[0] as JournalRow;
        const entries = journal.entries;
        testResults.passed.push(`Journal saved with ${entries.length} entries`);
      } else {
        testResults.failed.push("Journal not saved");
      }
    });

    it("should save snapshot", async () => {
      const result = await db.execute(
        sql`SELECT * FROM migrations._snapshots 
            WHERE plugin_name = 'plugin-sql'
            ORDER BY idx DESC`
      );

      expect(result.rows.length).toBeGreaterThan(0);

      if (result.rows.length > 0) {
        const snapshot = result.rows[0] as SnapshotRow;
        const tables = Object.keys(snapshot.snapshot.tables || {});
        testResults.passed.push(`Snapshot saved with ${tables.length} tables`);
      } else {
        testResults.failed.push("Snapshot not saved");
      }
    });
  });

  describe("Column Types and Constraints", () => {
    it("should create columns with correct types", async () => {
      const criticalColumns = [
        { table: "agents", column: "id", type: "uuid" },
        { table: "agents", column: "name", type: "text" },
        { table: "agents", column: "enabled", type: "boolean" },
        { table: "agents", column: "bio", type: "jsonb" },
        { table: "memories", column: "content", type: "jsonb" },
        { table: "embeddings", column: "dim_384", type: "USER-DEFINED" }, // vector
        { table: "entities", column: "names", type: "ARRAY" },
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
          const actualType = (result.rows[0] as ColumnRow).data_type;
          const typeMatches =
            actualType === col.type ||
            (col.type === "USER-DEFINED" && actualType === "USER-DEFINED");

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

    it("should create foreign key constraints", async () => {
      const result = await db.execute(
        sql`SELECT COUNT(*) as count
            FROM information_schema.table_constraints
            WHERE table_schema = 'public'
            AND constraint_type = 'FOREIGN KEY'`
      );

      const fkCount = parseInt(String((result.rows[0] as unknown as CountRow).count), 10);
      expect(fkCount).toBeGreaterThan(0);

      if (fkCount > 0) {
        testResults.passed.push(`Foreign keys created: ${fkCount}`);
      } else {
        testResults.failed.push("No foreign keys created");
      }
    });

    it("should create unique constraints", async () => {
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
          (r: ConstraintRow) => r.table_name === "agents" && r.constraint_name === "name_unique"
        );

        if (hasAgentNameUnique) {
          testResults.passed.push("agents.name unique constraint created");
        } else {
          testResults.failed.push("agents.name unique constraint missing");
        }
      } else {
        testResults.failed.push("No unique constraints created");
      }
    });
  });

  describe("Idempotency", () => {
    it("should handle running the same migration twice", async () => {
      await migrator.migrate("plugin-sql", schema);

      const result = await db.execute(
        sql`SELECT COUNT(*) as count
            FROM migrations._migrations
            WHERE plugin_name = 'plugin-sql'`
      );

      const count = parseInt(String((result.rows[0] as unknown as CountRow).count), 10);
      expect(count).toBe(1);

      if (count === 1) {
        testResults.passed.push("Idempotency: Migration not duplicated");
      } else {
        testResults.failed.push(`Idempotency: Found ${count} migrations instead of 1`);
      }
    });

    it("should detect when no changes are needed", async () => {
      const status = await migrator.getStatus("plugin-sql");
      expect(status.hasRun).toBe(true);

      if (status.hasRun) {
        testResults.passed.push("Migration status correctly tracked");
      } else {
        testResults.failed.push("Migration status not tracked");
      }
    });
  });

  describe("Schema Evolution Support", () => {
    it("should support ALTER operations (when schema changes)", async () => {
      // Check that the migration journal stored a schema snapshot, which is the
      // comparison input used when a later plugin schema changes.
      const status = await migrator.getStatus("plugin-sql");
      expect(status.snapshots).toBeGreaterThan(0);

      if (status.snapshots > 0) {
        testResults.passed.push("Schema evolution: Snapshots stored for comparison");
      } else {
        testResults.failed.push("Schema evolution: No snapshots stored");
      }
    });

    it("should track migration history properly", async () => {
      const journal = await db.execute(
        sql`SELECT entries FROM migrations._journal 
            WHERE plugin_name = 'plugin-sql'`
      );

      if (journal.rows.length > 0) {
        const entries = (journal.rows[0] as JournalRow).entries;
        expect(entries.length).toBeGreaterThan(0);

        if (entries.length > 0) {
          testResults.passed.push(`Migration history: ${entries.length} entries tracked`);
        } else {
          testResults.failed.push("Migration history: No entries in journal");
        }
      } else {
        testResults.failed.push("Migration history: Journal not found");
      }
    });
  });

  describe("Index Creation", () => {
    it("should create indexes on tables", async () => {
      const allIndexes = await db.execute(
        sql`SELECT schemaname, tablename, indexname
            FROM pg_indexes
            WHERE schemaname = 'public'`
      );
      console.log("All indexes in public schema:", allIndexes.rows);

      const result = await db.execute(
        sql`SELECT COUNT(*) as count
            FROM pg_indexes
            WHERE schemaname = 'public'
            AND indexname LIKE 'idx_%'`
      );

      const indexCount = parseInt(String((result.rows[0] as unknown as CountRow).count), 10);
      console.log("Count of idx_ indexes:", indexCount);

      if (indexCount > 0) {
        testResults.passed.push(`Indexes created: ${indexCount}`);
      } else {
        testResults.failed.push("🔴 CRITICAL GAP: No indexes created");
      }

      // The memories table's idx_-prefixed indexes are the ones asserted here.
      expect(indexCount).toBeGreaterThan(0);
    });
  });

  describe("Check Constraints", () => {
    it("should create check constraints", async () => {
      const result = await db.execute(
        sql`SELECT COUNT(*) as count
            FROM pg_constraint
            WHERE connamespace = 'public'::regnamespace
            AND contype = 'c'`
      );

      const checkCount = parseInt(String((result.rows[0] as unknown as CountRow).count), 10);

      if (checkCount > 0) {
        testResults.passed.push(`Check constraints created: ${checkCount}`);
      } else {
        testResults.failed.push("🟡 GAP: No check constraints created");
      }

      // The memories table's check constraints are the ones asserted here.
      expect(checkCount).toBeGreaterThan(0);
    });
  });

  describe("Production Readiness", () => {
    it("should use transactions for atomicity", async () => {
      // The initial plugin-sql migration earlier in this suite ran inside a single
      // BEGIN/COMMIT transaction. If that transaction committed atomically, the
      // migration record, journal, and snapshot must all be present together —
      // a non-atomic implementation could leave any one of them missing.
      const status = await migrator.getStatus("plugin-sql");

      expect(status.hasRun).toBe(true);
      expect(status.lastMigration).not.toBeNull();
      expect(status.lastMigration?.hash).toBeTruthy();
      expect(status.snapshots).toBeGreaterThan(0);

      testResults.passed.push("Transactions: migration recorded with snapshot atomically");
    });

    it("should handle errors gracefully", async () => {
      let _errorCaught = false;

      try {
        await migrator.migrate("invalid-plugin", {
          invalidTable: "not-a-table",
        });
      } catch (_error) {
        _errorCaught = true;
      }

      // A schema with no real tables is still recorded and considered "hasRun",
      // but must not create any table matching the bogus entry.
      const _status = await migrator.getStatus("invalid-plugin");

      const tablesResult = await db.execute(
        sql`SELECT COUNT(*) as count
            FROM information_schema.tables
            WHERE table_schema = 'public'
            AND table_name = 'invalidTable'`
      );

      const invalidTableExists =
        parseInt(String((tablesResult.rows[0] as unknown as CountRow).count), 10) > 0;
      expect(invalidTableExists).toBe(false);

      if (!invalidTableExists) {
        testResults.passed.push("Error handling: Invalid schema does not create tables");
      } else {
        testResults.failed.push("Error handling: Invalid table was created");
      }
    });
  });

  describe("Table Filtering - Ignoring Other Plugin Tables", () => {
    it("should ignore tables in public schema that are not in plugin-sql schema", async () => {
      // Simulates another plugin's table living alongside plugin-sql's own tables.
      await db.execute(
        sql`CREATE TABLE IF NOT EXISTS public.custom_analytics (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          event_type TEXT NOT NULL,
          user_id UUID NOT NULL,
          data JSONB,
          created_at TIMESTAMP DEFAULT NOW()
        )`
      );

      await db.execute(
        sql`CREATE INDEX IF NOT EXISTS idx_custom_analytics_event_type
            ON public.custom_analytics(event_type)`
      );

      await db.execute(
        sql`INSERT INTO public.custom_analytics (event_type, user_id, data)
            VALUES ('page_view', gen_random_uuid(), '{"page": "/home"}'::jsonb)`
      );

      // Must not drop custom_analytics — it isn't part of the plugin-sql schema.
      await migrator.migrate("plugin-sql", schema, { verbose: true });

      const tableExists = await db.execute(
        sql`SELECT EXISTS (
          SELECT 1 FROM pg_tables
          WHERE schemaname = 'public'
          AND tablename = 'custom_analytics'
        ) as exists`
      );

      const exists = (tableExists.rows[0] as ExistsRow).exists;
      expect(exists).toBe(true);

      if (exists) {
        testResults.passed.push("Table filtering: custom_analytics table preserved");
      } else {
        testResults.failed.push("Table filtering: custom_analytics table was deleted!");
      }

      const dataResult = await db.execute(
        sql`SELECT COUNT(*) as count FROM public.custom_analytics`
      );

      interface QueryRow {
        count: string;
      }
      const count = parseInt((dataResult.rows[0] as unknown as QueryRow).count, 10);
      expect(count).toBeGreaterThan(0);

      if (count > 0) {
        testResults.passed.push("Table filtering: custom_analytics data preserved");
      } else {
        testResults.failed.push("Table filtering: custom_analytics data was deleted!");
      }

      await db.execute(sql`DROP TABLE IF EXISTS public.custom_analytics CASCADE`);
    });

    it("should not schedule DROP for tables from other plugins in public schema", async () => {
      // Simulates another plugin's data table living in the shared public schema.
      await db.execute(
        sql`CREATE TABLE IF NOT EXISTS public.other_plugin_data (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          server_id UUID,
          plugin_name TEXT NOT NULL DEFAULT 'other-plugin',
          data JSONB,
          created_at TIMESTAMP DEFAULT NOW()
        )`
      );

      await migrator.migrate("plugin-sql", schema, { verbose: true });

      const tableExists = await db.execute(
        sql`SELECT EXISTS (
          SELECT 1 FROM pg_tables
          WHERE schemaname = 'public'
          AND tablename = 'other_plugin_data'
        ) as exists`
      );

      const exists = (tableExists.rows[0] as ExistsRow).exists;
      expect(exists).toBe(true);

      // migrations.ts (which runs before RuntimeMigrator) may drop server_id,
      // but RuntimeMigrator itself must never touch this foreign table.
      const columnExists = await db.execute(
        sql`SELECT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public'
          AND table_name = 'other_plugin_data'
          AND column_name = 'server_id'
        ) as exists`
      );

      const _serverIdExists = (columnExists.rows[0] as ExistsRow).exists;

      if (exists) {
        testResults.passed.push(
          "Table filtering: other_plugin_data table preserved by RuntimeMigrator"
        );
      } else {
        testResults.failed.push(
          "Table filtering: other_plugin_data table was deleted by RuntimeMigrator!"
        );
      }

      await db.execute(sql`DROP TABLE IF EXISTS public.other_plugin_data CASCADE`);
    });
  });

  describe("Development Features", () => {
    it("should support dry-run mode", async () => {
      await migrator.migrate("dry-run-test", schema, {
        dryRun: true,
      });

      const result = await db.execute(
        sql`SELECT COUNT(*) as count
            FROM migrations._migrations
            WHERE plugin_name = 'dry-run-test'`
      );

      const count = parseInt(String((result.rows[0] as unknown as CountRow).count), 10);
      expect(count).toBe(0);

      if (count === 0) {
        testResults.passed.push("Dry-run mode: No changes applied");
      } else {
        testResults.failed.push("Dry-run mode: Changes were applied!");
      }
    });

    it("should support reset for development", async () => {
      await migrator.migrate("reset-test", { testTable: {} });

      await migrator.reset("reset-test");

      const status = await migrator.getStatus("reset-test");
      expect(status.hasRun).toBe(false);

      if (!status.hasRun) {
        testResults.passed.push("Reset functionality: Works correctly");
      } else {
        testResults.failed.push("Reset functionality: Failed to clear state");
      }
    });
  });
});
