/**
 * End-to-end `RuntimeMigrator` coverage against a real Postgres/PGlite
 * database (via `createIsolatedTestDatabaseForMigration`): a purpose-built
 * schema exercising every constraint kind the migrator must diff and apply —
 * dependency-ordered table creation, `vector` columns, foreign keys, unique
 * and check constraints, actual constraint enforcement on insert, idempotent
 * re-migration, empty schemas, and non-table schema exports that must be
 * ignored rather than migrated.
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  vector,
} from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

interface VectorColumnRow {
  data_type: string;
  column_name: string;
  [key: string]: unknown;
}

interface ForeignKeyRow {
  constraint_name: string;
  table_name: string;
  [key: string]: unknown;
}

interface UniqueConstraintRow {
  constraint_name: string;
  table_name: string;
  [key: string]: unknown;
}

interface CheckConstraintRow {
  constraint_name: string;
  table_name: string;
  [key: string]: unknown;
}

interface AgentRow {
  name: string;
  [key: string]: unknown;
}

import { RuntimeMigrator } from "../../runtime-migrator";
import type { DrizzleDatabase } from "../../types";
import { createIsolatedTestDatabaseForMigration } from "../test-helpers";

const testBaseTable = pgTable(
  "base_entities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).default(sql`now()`).notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).default(sql`now()`).notNull(),
    active: boolean("active").default(true).notNull(),
    metadata: jsonb("metadata").default({}).notNull(),
  },
  (table) => [
    unique("base_entities_name_unique").on(table.name),
    index("idx_base_entities_active").on(table.active),
  ]
);

const testDependentTable = pgTable(
  "dependent_entities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    base_id: uuid("base_id")
      .notNull()
      .references(() => testBaseTable.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    value: integer("value").default(0),
    settings: jsonb("settings").default({}).notNull(),
  },
  (table) => [
    unique("dependent_entities_base_type_unique").on(table.base_id, table.type),
    index("idx_dependent_entities_type").on(table.type),
    check("value_positive", sql`value >= 0`),
  ]
);

const testVectorTable = pgTable(
  "vector_embeddings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    entity_id: uuid("entity_id")
      .notNull()
      .references(() => testBaseTable.id, { onDelete: "cascade" }),
    dim_384: vector("dim_384", { dimensions: 384 }),
    dim_512: vector("dim_512", { dimensions: 512 }),
    dim_1024: vector("dim_1024", { dimensions: 1024 }),
    created_at: timestamp("created_at", { withTimezone: true }).default(sql`now()`).notNull(),
  },
  (table) => [
    index("idx_vector_embeddings_entity").on(table.entity_id),
    foreignKey({
      name: "fk_vector_embeddings_entity",
      columns: [table.entity_id],
      foreignColumns: [testBaseTable.id],
    }).onDelete("cascade"),
  ]
);

const testComplexDependencyTable = pgTable(
  "complex_relations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    base_id: uuid("base_id")
      .notNull()
      .references(() => testBaseTable.id),
    dependent_id: uuid("dependent_id")
      .notNull()
      .references(() => testDependentTable.id),
    vector_id: uuid("vector_id").references(() => testVectorTable.id),
    relation_type: text("relation_type").notNull(),
    strength: integer("strength").default(1),
  },
  (table) => [
    unique("complex_relations_base_dependent_unique").on(table.base_id, table.dependent_id),
    check("strength_range", sql`strength >= 1 AND strength <= 10`),
    index("idx_complex_relations_type").on(table.relation_type),
  ]
);

const testSchema = {
  testBaseTable,
  testDependentTable,
  testVectorTable,
  testComplexDependencyTable,
};

describe("Comprehensive Dynamic Migration Tests", () => {
  let db: DrizzleDatabase;
  let migrator: RuntimeMigrator;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const testSetup = await createIsolatedTestDatabaseForMigration("comprehensive_migration_tests");
    db = testSetup.db;
    cleanup = testSetup.cleanup;

    // The vector extension is already installed by adapter.init().
  });

  afterAll(async () => {
    if (cleanup) {
      await cleanup();
    }
  });

  describe("Migration Execution", () => {
    beforeAll(async () => {
      try {
        await db.execute(sql`DROP SCHEMA IF EXISTS migrations CASCADE`);
        await db.execute(sql`DROP SCHEMA IF EXISTS public CASCADE`);
        await db.execute(sql`CREATE SCHEMA public`);
        console.log("[TEST CLEANUP] Reset schemas for migration tests");
      } catch (error) {
        console.log("[TEST CLEANUP] Schema cleanup failed:", error);
      }

      migrator = new RuntimeMigrator(db);
      await migrator.initialize();
    });

    it("should create all tables in correct dependency order", async () => {
      await migrator.migrate("test-plugin", testSchema, { verbose: true });

      const result = await db.execute(
        sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`
      );

      const tableNames = result.rows.map((row) => (row as { table_name: string }).table_name);
      expect(tableNames).toContain("base_entities");
      expect(tableNames).toContain("dependent_entities");
      expect(tableNames).toContain("vector_embeddings");
      expect(tableNames).toContain("complex_relations");
    });

    it("should create vector columns with correct types", async () => {
      const result = await db.execute(
        sql`SELECT column_name, data_type 
            FROM information_schema.columns 
            WHERE table_schema = 'public' 
            AND table_name = 'vector_embeddings' 
            AND column_name LIKE 'dim_%'
            ORDER BY column_name`
      );

      const vectorColumns = result.rows as VectorColumnRow[];
      expect(vectorColumns).toHaveLength(3);

      // The pgvector extension reports its column type as USER-DEFINED.
      vectorColumns.forEach((col) => {
        expect(col.data_type).toBe("USER-DEFINED");
      });
    });

    it("should create foreign key constraints properly", async () => {
      const result = await db.execute(
        sql`SELECT tc.constraint_name, tc.table_name, kcu.column_name, ccu.table_name AS referenced_table
            FROM information_schema.table_constraints AS tc
            JOIN information_schema.key_column_usage AS kcu
              ON tc.constraint_name = kcu.constraint_name
            JOIN information_schema.constraint_column_usage AS ccu
              ON ccu.constraint_name = tc.constraint_name
            WHERE tc.constraint_type = 'FOREIGN KEY' 
            AND tc.table_schema = 'public'
            ORDER BY tc.table_name, tc.constraint_name`
      );

      const foreignKeys = result.rows as ForeignKeyRow[];
      expect(foreignKeys.length).toBeGreaterThan(0);

      const dependentFk = foreignKeys.find(
        (fk) =>
          fk.table_name === "dependent_entities" &&
          (fk as { column_name: string }).column_name === "base_id"
      );
      expect(dependentFk).toBeDefined();
      expect((dependentFk as { referenced_table: string }).referenced_table).toBe("base_entities");
    });

    it("should create unique constraints properly", async () => {
      const result = await db.execute(
        sql`SELECT tc.constraint_name, tc.table_name
            FROM information_schema.table_constraints AS tc
            WHERE tc.constraint_type = 'UNIQUE' 
            AND tc.table_schema = 'public'
            ORDER BY tc.table_name, tc.constraint_name`
      );

      const uniqueConstraints = result.rows as UniqueConstraintRow[];
      expect(uniqueConstraints.length).toBeGreaterThan(0);

      const baseNameUnique = uniqueConstraints.find(
        (uc) =>
          uc.table_name === "base_entities" && uc.constraint_name === "base_entities_name_unique"
      );
      expect(baseNameUnique).toBeDefined();
    });

    it("should create check constraints properly", async () => {
      const result = await db.execute(
        sql`SELECT tc.constraint_name, tc.table_name
            FROM information_schema.table_constraints AS tc
            WHERE tc.constraint_type = 'CHECK' 
            AND tc.table_schema = 'public'
            ORDER BY tc.table_name, tc.constraint_name`
      );

      const checkConstraints = result.rows as CheckConstraintRow[];
      expect(checkConstraints.length).toBeGreaterThan(0);

      const valuePositive = checkConstraints.find(
        (cc) => cc.table_name === "dependent_entities" && cc.constraint_name === "value_positive"
      );
      expect(valuePositive).toBeDefined();
    });

    it("should support vector similarity operations", async () => {
      await db.execute(
        sql`INSERT INTO public.base_entities (id, name) VALUES 
            ('550e8400-e29b-41d4-a716-446655440000', 'test-entity')`
      );

      const testVector = Array(384)
        .fill(0)
        .map(() => Math.random())
        .join(",");
      await db.execute(
        sql`INSERT INTO public.vector_embeddings (entity_id, dim_384) VALUES 
            ('550e8400-e29b-41d4-a716-446655440000', '[${sql.raw(testVector)}]')`
      );

      const result = await db.execute(
        sql`SELECT entity_id, dim_384 <=> '[${sql.raw(testVector)}]' as distance 
            FROM public.vector_embeddings 
            WHERE dim_384 IS NOT NULL 
            ORDER BY distance 
            LIMIT 1`
      );

      expect(result.rows).toHaveLength(1);
      const row = result.rows[0] as AgentRow;
      expect(row.entity_id).toBe("550e8400-e29b-41d4-a716-446655440000");
      expect(row.distance).toBe(0); // Same vector should have distance 0
    });
  });

  describe("Data Integrity", () => {
    it("should enforce foreign key constraints", async () => {
      // Inserting a dependent row against a non-existent base_id must fail.
      let errorThrown = false;
      try {
        await db.execute(
          sql`INSERT INTO public.dependent_entities (base_id, type) VALUES 
              ('99999999-9999-9999-9999-999999999999', 'test')`
        );
      } catch (_error) {
        errorThrown = true;
      }
      expect(errorThrown).toBe(true);
    });

    it("should enforce unique constraints", async () => {
      await db.execute(
        sql`INSERT INTO public.base_entities (id, name) VALUES 
            ('550e8400-e29b-41d4-a716-446655440001', 'unique-test')`
      );

      // A second row with the same name must violate the unique constraint.
      let errorThrown = false;
      try {
        await db.execute(
          sql`INSERT INTO public.base_entities (id, name) VALUES 
              ('550e8400-e29b-41d4-a716-446655440002', 'unique-test')`
        );
      } catch (_error) {
        errorThrown = true;
      }
      expect(errorThrown).toBe(true);
    });

    it("should enforce check constraints", async () => {
      await db.execute(
        sql`INSERT INTO public.base_entities (id, name) VALUES 
            ('550e8400-e29b-41d4-a716-446655440003', 'check-test')`
      );

      // A negative value must violate the "value_positive" check constraint.
      let errorThrown = false;
      try {
        await db.execute(
          sql`INSERT INTO public.dependent_entities (base_id, type, value) VALUES 
              ('550e8400-e29b-41d4-a716-446655440003', 'test', -1)`
        );
      } catch (_error) {
        errorThrown = true;
      }
      expect(errorThrown).toBe(true);
    });
  });

  describe("Edge Cases", () => {
    it("should handle idempotent migrations (running same migration twice)", async () => {
      let errorThrown = false;
      let _errorDetails: unknown = null;
      try {
        await migrator.migrate("test-plugin", testSchema, { verbose: true });
      } catch (error) {
        errorThrown = true;
        _errorDetails = error;
        console.error("[TEST] Idempotent migration failed:", error);
      }
      expect(errorThrown).toBe(false);

      const result = await db.execute(
        sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`
      );
      expect(result.rows.length).toBeGreaterThanOrEqual(4);
    });

    it("should handle empty schema gracefully", async () => {
      let errorThrown = false;
      let _errorDetails: unknown = null;
      try {
        await migrator.migrate("empty-plugin", {}, { verbose: true });
      } catch (error) {
        errorThrown = true;
        _errorDetails = error;
        console.error("[TEST] Empty schema migration failed:", error);
      }
      expect(errorThrown).toBe(false);
    });

    it("should handle schema with non-table exports", async () => {
      // A dedicated table avoids name conflicts with tables from other tests.
      const testMixedTable = pgTable("mixed_test_table", {
        id: uuid("id").primaryKey().defaultRandom(),
        name: text("name").notNull(),
        created_at: timestamp("created_at", { withTimezone: true }).default(sql`now()`).notNull(),
      });

      const mixedSchema = {
        testMixedTable,
        someConstant: "not-a-table",
        someFunction: () => "also-not-a-table",
        someObject: { notATable: true },
      };

      let errorThrown = false;
      let _errorDetails: unknown = null;
      try {
        await migrator.migrate("mixed-plugin", mixedSchema, { verbose: true });
      } catch (error) {
        errorThrown = true;
        _errorDetails = error;
        console.error("[TEST] Mixed schema migration failed:", error);
      }
      expect(errorThrown).toBe(false);

      // Only the real table should be created; non-table exports are ignored.
      const result = await db.execute(
        sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`
      );
      const mixedTableExists = result.rows.some(
        (row) => (row as { table_name: string }).table_name === "mixed_test_table"
      );
      expect(mixedTableExists).toBe(true);
    });
  });
});
