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
