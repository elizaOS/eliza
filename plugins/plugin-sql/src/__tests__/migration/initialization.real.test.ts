import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Helper types for database query result rows
interface MigrationRow {
  plugin_name: string;
  hash: string;
  created_at: string | Date;
  [key: string]: unknown;
}

interface JournalRow {
  entries: unknown[];
  [key: string]: unknown;
}

interface SnapshotRow {
  snapshot: {
    tables: Record<string, unknown>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface ColumnInfoRow {
  column_name: string;
  data_type?: string;
  is_nullable?: string;
  [key: string]: unknown;
}

interface TableInfoRow {
  tablename: string;
  [key: string]: unknown;
}

import type { UUID } from "@elizaos/core";
import { sql } from "drizzle-orm";
import { RuntimeMigrator } from "../../runtime-migrator";
import * as originalSchema from "../../schema";
import type { DrizzleDatabase } from "../../types";
import { createIsolatedTestDatabaseForMigration } from "../test-helpers";

describe("Runtime Migrator - Initialization Tests", () => {
  let db: DrizzleDatabase;
  let migrator: RuntimeMigrator;
  let cleanup: () => Promise<void>;
  let _testAgentId: UUID;

  beforeAll(async () => {
    console.log("\n🚀 Testing Runtime Migrator Initialization...\n");

    const testSetup = await createIsolatedTestDatabaseForMigration("initialization_tests");
    cleanup = testSetup.cleanup;
    _testAgentId = testSetup.testAgentId;
    db = testSetup.db;

    // Create a new migrator for testing (don't initialize yet as tests will do that)
    migrator = new RuntimeMigrator(db);
  });

  afterAll(async () => {
    if (cleanup) {
      await cleanup();
    }
  });

  describe("Migration Infrastructure Setup", () => {
    it("should initialize migration schema and tables", async () => {
      // Initialize the migrator - this creates the migration infrastructure
      await migrator.initialize();

      // Check migrations schema exists
      const schemaResult = await db.execute(
        sql.raw(`SELECT EXISTS (
          SELECT 1 FROM information_schema.schemata 
          WHERE schema_name = 'migrations'
        )`)
      );

      const schemaResultRows0 = schemaResult.rows[0];
      expect(schemaResultRows0?.exists).toBe(true);
    });

    it("should create all required migration tables", async () => {
      const expectedTables = ["_migrations", "_journal", "_snapshots"];

      for (const tableName of expectedTables) {
        const result = await db.execute(
          sql.raw(`SELECT EXISTS (
            SELECT 1 FROM pg_tables
            WHERE schemaname = 'migrations'
            AND tablename = '${tableName}'
          )`)
        );

        const resultRows0 = result.rows[0];
        expect(resultRows0?.exists).toBe(true);
      }
    });

    it("should create migration tables with correct structure", async () => {
      // Check _migrations table structure
      const migrationsColumns = await db.execute(
        sql.raw(`SELECT column_name, data_type, is_nullable
                 FROM information_schema.columns
                 WHERE table_schema = 'migrations'
                 AND table_name = '_migrations'
                 ORDER BY ordinal_position`)
      );

      const columnNames = migrationsColumns.rows.map((r: ColumnInfoRow) => r.column_name);
      expect(columnNames).toContain("id");
      expect(columnNames).toContain("plugin_name");
      expect(columnNames).toContain("hash");
      expect(columnNames).toContain("created_at");

      // Check _journal table structure
      const journalColumns = await db.execute(
        sql.raw(`SELECT column_name, data_type
                 FROM information_schema.columns
                 WHERE table_schema = 'migrations'
                 AND table_name = '_journal'`)
      );

      const journalColumnNames = journalColumns.rows.map((r: ColumnInfoRow) => r.column_name);
      expect(journalColumnNames).toContain("plugin_name");
      expect(journalColumnNames).toContain("entries");

      // Check _snapshots table structure
      const snapshotColumns = await db.execute(
        sql.raw(`SELECT column_name, data_type
                 FROM information_schema.columns
                 WHERE table_schema = 'migrations'
                 AND table_name = '_snapshots'`)
      );

      const snapshotColumnNames = snapshotColumns.rows.map((r: ColumnInfoRow) => r.column_name);
      expect(snapshotColumnNames).toContain("plugin_name");
      expect(snapshotColumnNames).toContain("snapshot");
      expect(snapshotColumnNames).toContain("idx");
    });
  });

  describe("Basic Migration Execution", () => {
    it("should run initial schema migration successfully", async () => {
      await migrator.migrate("@elizaos/plugin-sql", originalSchema, {
        verbose: true,
      });

      // Verify tables were created
      const tablesResult = await db.execute(
        sql.raw(`SELECT tablename FROM pg_tables 
                 WHERE schemaname = 'public' 
                 ORDER BY tablename`)
      );

      const createdTables = tablesResult.rows.map((r: TableInfoRow) => r.tablename);

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
        expect(createdTables).toContain(table);
      }
    });

    it("should track migration in _migrations table", async () => {
      const result = await db.execute(
        sql.raw(`SELECT * FROM migrations._migrations 
                 WHERE plugin_name = '@elizaos/plugin-sql'
                 ORDER BY created_at DESC
                 LIMIT 1`)
      );

      expect(result.rows.length).toBeGreaterThan(0);

      const migration = result.rows[0] as MigrationRow;
      expect(migration.plugin_name).toBe("@elizaos/plugin-sql");
      expect(migration.hash).toBeDefined();
      expect(migration.created_at).toBeDefined();
    });

    it("should save journal entry with migration details", async () => {
      const result = await db.execute(
        sql.raw(`SELECT * FROM migrations._journal 
                 WHERE plugin_name = '@elizaos/plugin-sql'`)
      );

      expect(result.rows.length).toBe(1);

      const journal = result.rows[0] as JournalRow;
      expect(journal.entries).toBeDefined();
      expect(Array.isArray(journal.entries)).toBe(true);
      expect(journal.entries.length).toBeGreaterThan(0);
    });

    it("should save schema snapshot", async () => {
      const result = await db.execute(
        sql.raw(`SELECT * FROM migrations._snapshots 
                 WHERE plugin_name = '@elizaos/plugin-sql'
                 ORDER BY idx DESC`)
      );

      expect(result.rows.length).toBeGreaterThan(0);

      const snapshot = result.rows[0] as SnapshotRow;
      expect(snapshot.snapshot).toBeDefined();
      expect(snapshot.snapshot.tables).toBeDefined();
      expect(Object.keys(snapshot.snapshot.tables).length).toBeGreaterThan(0);
    });
  });

  describe("Migration Status and Tracking", () => {
    it("should provide accurate migration status", async () => {
      const status = await migrator.getStatus("@elizaos/plugin-sql");

      expect(status.hasRun).toBe(true);
      expect(status.snapshots).toBeGreaterThan(0);
      expect(status.lastMigration).toBeDefined();
    });

    it("should handle status check for non-existent plugin", async () => {
      const status = await migrator.getStatus("non-existent-plugin");

      expect(status.hasRun).toBe(false);
      expect(status.snapshots).toBe(0);
      expect(status.lastMigration).toBeNull();
    });
  });
});
