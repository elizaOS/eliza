/**
 * End-to-end simulation of how `RuntimeMigrator` behaves across the real
 * multi-plugin boot sequence — separate migrator instances per plugin (as
 * each plugin's `init` would create), a simulated app restart, and a single
 * migrator shared across plugins — asserting migrations stay idempotent and
 * both plugin schemas (`@elizaos/plugin-sql`, `polymarket`) coexist. Runs
 * against a real Postgres/PGlite database via `createIsolatedTestDatabaseForMigration`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

interface MigrationRow {
  plugin_name: string;
  hash: string;
  created_at: string | Date;
  [key: string]: unknown;
}

interface SnapshotRow {
  plugin_name: string;
  count: string | number;
  [key: string]: unknown;
}

interface SchemaRow {
  schema_name: string;
  [key: string]: unknown;
}

interface TablesPerSchemaRow {
  schemaname: string;
  table_count: string | number;
  [key: string]: unknown;
}

interface TableRow {
  tablename: string;
  [key: string]: unknown;
}

interface SchemaExistsRow {
  public_exists: boolean;
  polymarket_exists: boolean;
  [key: string]: unknown;
}

import { sql } from "drizzle-orm";
import { RuntimeMigrator } from "../../runtime-migrator";
import * as coreSchema from "../../schema";
import type { DrizzleDatabase } from "../../types";
import { testPolymarketSchema } from "../schema-data/test-plugin-schema";
import { createIsolatedTestDatabaseForMigration } from "../test-helpers";

describe("Actual Runtime Scenario - Plugin Loading Simulation", () => {
  let db: DrizzleDatabase;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    console.log("\n🚀 Simulating actual runtime plugin loading scenario...\n");

    const testSetup = await createIsolatedTestDatabaseForMigration("actual_runtime");
    cleanup = testSetup.cleanup;
    db = testSetup.db;
  });

  afterAll(async () => {
    if (cleanup) {
      await cleanup();
    }
  });

  it("should handle plugin migrations as they would be loaded at runtime", async () => {
    console.log("=".repeat(80));
    console.log("SCENARIO: Application Startup");
    console.log("=".repeat(80));

    console.log("\n📦 Step 1: Loading plugin-sql (database adapter)...");

    const sqlPluginMigrator = new RuntimeMigrator(db);
    await sqlPluginMigrator.initialize();

    await sqlPluginMigrator.migrate("@elizaos/plugin-sql", coreSchema, {
      verbose: false,
    });

    console.log("✅ plugin-sql loaded and migrated");

    const afterSqlPlugin = await db.execute(sql`
      SELECT plugin_name, hash, created_at 
      FROM migrations._migrations 
      ORDER BY created_at ASC
    `);
    console.log(`\n📊 Migrations after plugin-sql: ${afterSqlPlugin.rows.length}`);
    for (const m of afterSqlPlugin.rows as MigrationRow[]) {
      console.log(`  - ${m.plugin_name}`);
    }

    console.log("\n📦 Step 2: Loading polymarket plugin...");

    console.log("\n--- Testing Scenario A: Polymarket creates its own migrator ---");
    const polymarketMigrator = new RuntimeMigrator(db);
    // initialize() is idempotent: it detects the existing migration tables.
    await polymarketMigrator.initialize();

    await polymarketMigrator.migrate("polymarket", testPolymarketSchema, {
      verbose: false,
    });

    console.log("✅ polymarket loaded and migrated (own migrator)");

    const afterPolymarket = await db.execute(sql`
      SELECT plugin_name, hash, created_at 
      FROM migrations._migrations 
      ORDER BY created_at ASC
    `);
    console.log(`\n📊 Migrations after polymarket: ${afterPolymarket.rows.length}`);
    for (const m of afterPolymarket.rows as MigrationRow[]) {
      console.log(`  - ${m.plugin_name}`);
    }

    expect(afterPolymarket.rows.length).toBe(2);

    console.log(`\n${"=".repeat(80)}`);
    console.log("SCENARIO: Application Restart");
    console.log("=".repeat(80));

    console.log("\n🔄 Simulating application restart...");

    // New migrator instances, as each plugin's init would create on restart.
    const sqlPluginMigrator2 = new RuntimeMigrator(db);
    await sqlPluginMigrator2.initialize();

    await sqlPluginMigrator2.migrate("@elizaos/plugin-sql", coreSchema, {
      verbose: false,
    });

    const polymarketMigrator2 = new RuntimeMigrator(db);
    await polymarketMigrator2.initialize();

    await polymarketMigrator2.migrate("polymarket", testPolymarketSchema, {
      verbose: false,
    });

    // Re-migrating on restart must stay idempotent: still exactly 2 rows.
    const afterRestart = await db.execute(sql`
      SELECT plugin_name, hash, created_at 
      FROM migrations._migrations 
      ORDER BY created_at ASC
    `);
    console.log(`\n📊 Migrations after restart: ${afterRestart.rows.length}`);
    expect(afterRestart.rows.length).toBe(2);

    console.log(`\n${"=".repeat(80)}`);
    console.log("DIAGNOSTICS");
    console.log("=".repeat(80));

    console.log("\n🔍 Checking snapshots:");
    const snapshots = await db.execute(sql`
      SELECT plugin_name, COUNT(*) as count 
      FROM migrations._snapshots 
      GROUP BY plugin_name
    `);
    for (const s of snapshots.rows as SnapshotRow[]) {
      console.log(`  - ${s.plugin_name}: ${s.count} snapshots`);
    }

    console.log("\n🔍 Checking schemas:");
    const schemas = await db.execute(sql`
      SELECT schema_name 
      FROM information_schema.schemata 
      WHERE schema_name NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
      ORDER BY schema_name
    `);
    console.log("Schemas:", schemas.rows.map((r: SchemaRow) => r.schema_name).join(", "));

    console.log("\n🔍 Tables per schema:");
    const tablesPerSchema = await db.execute(sql`
      SELECT schemaname, COUNT(*) as table_count 
      FROM pg_tables 
      WHERE schemaname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
      GROUP BY schemaname 
      ORDER BY schemaname
    `);
    for (const t of tablesPerSchema.rows as TablesPerSchemaRow[]) {
      console.log(`  - ${t.schemaname}: ${t.table_count} tables`);
    }
  });

  it("should test shared migrator scenario", async () => {
    console.log(`\n${"=".repeat(80)}`);
    console.log("SCENARIO: Shared Migrator Instance");
    console.log("=".repeat(80));

    console.log("\n🧹 Cleaning up database from previous test...");

    await db.execute(sql`DROP SCHEMA IF EXISTS polymarket CASCADE`);

    // Migration tables (`migrations` schema) are dropped separately below.
    const tables = await db.execute(sql`
      SELECT tablename FROM pg_tables 
      WHERE schemaname = 'public' 
      AND tablename NOT LIKE 'spatial_ref_sys'
      AND tablename NOT LIKE 'geography_columns' 
      AND tablename NOT LIKE 'geometry_columns'
      AND tablename NOT LIKE 'raster_columns'
      AND tablename NOT LIKE 'raster_overviews'
    `);

    for (const table of tables.rows as TableRow[]) {
      await db.execute(sql.raw(`DROP TABLE IF EXISTS public."${table.tablename}" CASCADE`));
    }

    // Dropped entirely; `initialize()` below recreates it.
    await db.execute(sql`DROP SCHEMA IF EXISTS migrations CASCADE`);

    console.log("\n🔄 Testing with shared migrator instance...");

    const sharedMigrator = new RuntimeMigrator(db);
    await sharedMigrator.initialize();

    console.log("\n📦 plugin-sql using shared migrator...");
    await sharedMigrator.migrate("@elizaos/plugin-sql", coreSchema, {
      verbose: false,
    });

    console.log("📦 polymarket using shared migrator...");
    await sharedMigrator.migrate("polymarket", testPolymarketSchema, {
      verbose: false,
    });

    const finalMigrations = await db.execute(sql`
      SELECT plugin_name, hash, created_at 
      FROM migrations._migrations 
      ORDER BY created_at ASC
    `);

    console.log(`\n📊 Final migrations with shared migrator: ${finalMigrations.rows.length}`);
    for (const m of finalMigrations.rows as MigrationRow[]) {
      console.log(`  - ${m.plugin_name}`);
    }

    expect(finalMigrations.rows.length).toBe(2);

    const schemasExist = await db.execute(sql`
      SELECT 
        EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'public') as public_exists,
        EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'polymarket') as polymarket_exists
    `);

    const result = schemasExist.rows[0] as SchemaExistsRow;
    console.log("\n✅ Schema verification:");
    console.log(`  - public schema: ${result.public_exists ? "exists" : "missing"}`);
    console.log(`  - polymarket schema: ${result.polymarket_exists ? "exists" : "missing"}`);

    expect(result.public_exists).toBe(true);
    expect(result.polymarket_exists).toBe(true);
  });
});
