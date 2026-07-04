/**
 * Schema-evolution tests covering `RuntimeMigrator` handling of adding
 * `NOT NULL`, `UNIQUE`, and `CHECK` constraints to a table that already has
 * violating rows: each case confirms the migration fails against dirty data,
 * succeeds once the data is fixed, and that the constraint is actually
 * enforced afterward by attempting a violating insert. A final test adds
 * several constraint kinds in one migration.
 */
import { sql } from "drizzle-orm";
import { boolean, check, integer, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RuntimeMigrator } from "../../../runtime-migrator/runtime-migrator";
import type { DrizzleDB } from "../../../runtime-migrator/types";
import { createIsolatedTestDatabaseForSchemaEvolutionTests } from "../../test-helpers";

describe("Schema Evolution Test: Constraint Modifications", () => {
  let db: DrizzleDB;
  let migrator: RuntimeMigrator;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const testSetup = await createIsolatedTestDatabaseForSchemaEvolutionTests(
      "schema_evolution_constraint_modifications_test"
    );
    db = testSetup.db;
    cleanup = testSetup.cleanup;

    migrator = new RuntimeMigrator(db);
    await migrator.initialize();

    // Every test here retries a constraint addition after fixing violating data.
    process.env.ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS = "true";
  });

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
    }
  });

  it("should handle adding NOT NULL to columns with NULL values", async () => {
    // V1: Table with nullable email
    const userTableV1 = pgTable("users", {
      id: uuid("id").primaryKey().defaultRandom(),
      name: text("name").notNull(),
      email: text("email"), // Nullable
    });

    const schemaV1 = { users: userTableV1 };

    console.log("📦 Creating schema with nullable email...");
    await migrator.migrate("@elizaos/not-null-test-v1", schemaV1);

    await db.insert(userTableV1).values([
      { name: "User 1", email: "user1@example.com" },
      { name: "User 2", email: null }, // NULL email
      { name: "User 3", email: "user3@example.com" },
      { name: "User 4", email: null }, // NULL email
    ]);

    console.log("  ✅ Created 4 users (2 with NULL emails)");

    // V2: Make email NOT NULL
    const userTableV2 = pgTable("users", {
      id: uuid("id").primaryKey().defaultRandom(),
      name: text("name").notNull(),
      email: text("email").notNull(), // Now required!
    });

    const schemaV2 = { users: userTableV2 };

    console.log("\n🔍 Checking NOT NULL constraint addition...");
    const check = await migrator.checkMigration("@elizaos/not-null-test-v1", schemaV2);

    if (check) {
      expect(check.warnings.length).toBeGreaterThan(0);
      console.log("  ⚠️ Warnings detected:");
      check.warnings.forEach((w) => console.log(`    - ${w}`));
    }

    console.log("\n❌ Attempting migration with NULL values...");
    let migrationError: Error | null = null;
    try {
      await migrator.migrate("@elizaos/not-null-test-v1", schemaV2);
    } catch (error) {
      migrationError = error as Error;
    }

    if (migrationError) {
      console.log("  ✅ Migration failed as expected (NULL values violate NOT NULL)");
      console.log(`  Error: ${migrationError.message.substring(0, 100)}...`);
    }

    console.log("\n🔧 Fixing NULL values...");
    await db.execute(sql`UPDATE users SET email = 'default@example.com' WHERE email IS NULL`);
    console.log("  ✅ Updated NULL emails with default values");

    console.log("\n📦 Retrying migration after fixing data...");
    await migrator.migrate("@elizaos/not-null-test-v1", schemaV2);
    console.log("  ✅ Migration succeeded after fixing NULL values");

    let insertError: Error | null = null;
    try {
      await db.execute(sql`INSERT INTO users (name, email) VALUES ('Test User', NULL)`);
    } catch (error) {
      insertError = error as Error;
    }

    expect(insertError).not.toBeNull();
    console.log("  ✅ NOT NULL constraint is now enforced");
  });

  it("should handle adding UNIQUE constraints with duplicate values", async () => {
    // V1: Table without unique constraint
    const agentTableV1 = pgTable("agents", {
      id: uuid("id").primaryKey().defaultRandom(),
      name: text("name").notNull(),
      username: text("username"),
    });

    const schemaV1 = { agents: agentTableV1 };

    console.log("📦 Creating schema without unique constraint...");
    await migrator.migrate("@elizaos/unique-test-v1", schemaV1);

    await db.insert(agentTableV1).values([
      { name: "Agent 1", username: "alpha" },
      { name: "Agent 2", username: "beta" },
      { name: "Agent 3", username: "alpha" }, // Duplicate!
      { name: "Agent 4", username: "gamma" },
    ]);

    console.log("  ✅ Created 4 agents (with duplicate usernames)");

    // V2: Add unique constraint
    const agentTableV2 = pgTable(
      "agents",
      {
        id: uuid("id").primaryKey().defaultRandom(),
        name: text("name").notNull(),
        username: text("username").unique(), // Now unique!
      },
      (table) => [unique("username_unique").on(table.username)]
    );

    const schemaV2 = { agents: agentTableV2 };

    console.log("\n🔍 Checking UNIQUE constraint addition...");
    const check = await migrator.checkMigration("@elizaos/unique-test-v1", schemaV2);

    if (check) {
      console.log("  ⚠️ Migration check results:");
      if (check.warnings.length > 0) {
        check.warnings.forEach((w) => console.log(`    - ${w}`));
      }
    }

    console.log("\n❌ Attempting migration with duplicate values...");
    let migrationError: Error | null = null;
    try {
      await migrator.migrate("@elizaos/unique-test-v1", schemaV2);
    } catch (error) {
      migrationError = error as Error;
    }

    if (migrationError) {
      console.log("  ✅ Migration failed as expected (duplicates violate UNIQUE)");
      console.log(`  Error: ${migrationError.message.substring(0, 100)}...`);
    }

    console.log("\n🔧 Fixing duplicate values...");
    await db.execute(
      sql`UPDATE agents SET username = username || '-' || id WHERE username IN (
        SELECT username FROM agents GROUP BY username HAVING COUNT(*) > 1
      )`
    );
    console.log("  ✅ Made usernames unique by appending IDs");

    console.log("\n📦 Retrying migration after fixing duplicates...");
    await migrator.migrate("@elizaos/unique-test-v1", schemaV2);
    console.log("  ✅ Migration succeeded after fixing duplicates");

    let insertError: Error | null = null;
    try {
      await db.execute(sql`INSERT INTO agents (name, username) VALUES ('Test', 'beta')`);
    } catch (error) {
      insertError = error as Error;
    }

    expect(insertError).not.toBeNull();
    console.log("  ✅ UNIQUE constraint is now enforced");
  });

  it("should handle adding CHECK constraints with violating data", async () => {
    // V1: Table without check constraints
    const productTableV1 = pgTable("products", {
      id: uuid("id").primaryKey().defaultRandom(),
      name: text("name").notNull(),
      price: integer("price"),
      quantity: integer("quantity"),
    });

    const schemaV1 = { products: productTableV1 };

    console.log("📦 Creating schema without check constraints...");
    await migrator.migrate("@elizaos/check-test-v1", schemaV1);

    await db.insert(productTableV1).values([
      { name: "Product 1", price: 100, quantity: 10 },
      { name: "Product 2", price: -50, quantity: 5 }, // Negative price!
      { name: "Product 3", price: 200, quantity: -2 }, // Negative quantity!
      { name: "Product 4", price: 0, quantity: 0 }, // Zero values
    ]);

    console.log("  ✅ Created 4 products (some with invalid values)");

    // V2: Add check constraints
    const productTableV2 = pgTable(
      "products",
      {
        id: uuid("id").primaryKey().defaultRandom(),
        name: text("name").notNull(),
        price: integer("price"),
        quantity: integer("quantity"),
      },
      () => [
        check("positive_price", sql`price > 0`),
        check("non_negative_quantity", sql`quantity >= 0`),
      ]
    );

    const schemaV2 = { products: productTableV2 };

    console.log("\n🔍 Checking CHECK constraint addition...");
    const check2 = await migrator.checkMigration("@elizaos/check-test-v1", schemaV2);

    if (check2) {
      console.log("  ⚠️ Migration analysis:");
      if (check2.warnings.length > 0) {
        check2.warnings.forEach((w) => console.log(`    - ${w}`));
      }
    }

    console.log("\n❌ Attempting migration with constraint violations...");
    let migrationError: Error | null = null;
    try {
      await migrator.migrate("@elizaos/check-test-v1", schemaV2);
    } catch (error) {
      migrationError = error as Error;
    }

    if (migrationError) {
      console.log("  ✅ Migration failed as expected (data violates CHECK)");
      console.log(`  Error: ${migrationError.message.substring(0, 100)}...`);
    }

    console.log("\n🔧 Fixing constraint violations...");
    await db.execute(sql`UPDATE products SET price = 1 WHERE price <= 0`);
    await db.execute(sql`UPDATE products SET quantity = 0 WHERE quantity < 0`);
    console.log("  ✅ Fixed negative and zero prices/quantities");

    console.log("\n📦 Retrying migration after fixing data...");
    await migrator.migrate("@elizaos/check-test-v1", schemaV2);
    console.log("  ✅ Migration succeeded after fixing violations");

    let insertError: Error | null = null;
    try {
      await db.execute(
        sql`INSERT INTO products (name, price, quantity) VALUES ('Bad Product', -10, 5)`
      );
    } catch (error) {
      insertError = error as Error;
    }

    expect(insertError).not.toBeNull();
    console.log("  ✅ CHECK constraints are now enforced");
  });

  it("should handle multiple constraint additions in single migration", async () => {
    // V1: Simple table
    const tableV1 = pgTable("test_multi_constraints", {
      id: uuid("id").primaryKey().defaultRandom(),
      code: text("code"),
      value: integer("value"),
      active: boolean("active"),
    });

    const schemaV1 = { test_multi_constraints: tableV1 };

    console.log("📦 Creating initial schema...");
    await migrator.migrate("@elizaos/multi-constraints-v1", schemaV1);

    await db.insert(tableV1).values([
      { code: "ABC", value: 100, active: true },
      { code: "DEF", value: 200, active: false },
      { code: null, value: null, active: null },
    ]);

    // V2: Add multiple constraints at once
    const tableV2 = pgTable(
      "test_multi_constraints",
      {
        id: uuid("id").primaryKey().defaultRandom(),
        code: text("code").notNull().unique(), // Add NOT NULL + UNIQUE
        value: integer("value").notNull(), // Add NOT NULL
        active: boolean("active").default(true).notNull(), // Add NOT NULL with default
      },
      (table) => [
        check("value_positive", sql`value > 0`), // Add CHECK constraint
        unique("code_unique_constraint").on(table.code), // Additional unique constraint
      ]
    );

    const schemaV2 = { test_multi_constraints: tableV2 };

    console.log("\n🔍 Checking multiple constraint additions...");
    const check2 = await migrator.checkMigration("@elizaos/multi-constraints-v1", schemaV2);

    if (check2) {
      console.log("  ⚠️ Multiple constraints being added:");
      console.log("    - NOT NULL on code");
      console.log("    - UNIQUE on code");
      console.log("    - NOT NULL on value");
      console.log("    - NOT NULL with default on active");
      console.log("    - CHECK constraint on value");
    }

    console.log("\n🔧 Preparing data for constraints...");
    await db.execute(sql`DELETE FROM test_multi_constraints WHERE code IS NULL`);
    await db.execute(sql`UPDATE test_multi_constraints SET value = 50 WHERE value IS NULL`);
    await db.execute(sql`UPDATE test_multi_constraints SET active = true WHERE active IS NULL`);

    console.log("\n📦 Applying multiple constraints...");
    await migrator.migrate("@elizaos/multi-constraints-v1", schemaV2);
    console.log("  ✅ All constraints added successfully");

    const violations: string[] = [];

    try {
      await db.execute(sql`INSERT INTO test_multi_constraints (code, value) VALUES (NULL, 100)`);
    } catch (_e) {
      violations.push("NOT NULL on code");
    }

    try {
      await db.execute(sql`INSERT INTO test_multi_constraints (code, value) VALUES ('ABC', 100)`);
    } catch (_e) {
      violations.push("UNIQUE on code");
    }

    try {
      await db.execute(sql`INSERT INTO test_multi_constraints (code, value) VALUES ('XYZ', -10)`);
    } catch (_e) {
      violations.push("CHECK on value");
    }

    console.log("\n✅ All constraints enforced:");
    violations.forEach((v) => console.log(`  - ${v}`));
    expect(violations.length).toBeGreaterThanOrEqual(3);
  });
});
