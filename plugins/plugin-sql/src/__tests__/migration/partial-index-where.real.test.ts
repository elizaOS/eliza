/**
 * Proves the runtime migrator preserves partial-index WHERE clauses. The
 * schema declares three partial unique indexes (approval_requests idempotency,
 * connector_accounts soft-delete pair); dropping the predicate would silently
 * turn them into full unique indexes and diverge from the committed SQL
 * migrations. Covers the whole pipeline: snapshot capture, SQL generation
 * (including NULLS ordering), and a real-database check that RuntimeMigrator
 * and the committed drizzle/migrations/0004 file produce byte-identical
 * pg_get_indexdef output for the same declared index.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { index, pgTable, text } from "drizzle-orm/pg-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateSnapshot } from "../../runtime-migrator/drizzle-adapters/snapshot-generator";
import { generateMigrationSQL } from "../../runtime-migrator/drizzle-adapters/sql-generator";
import { RuntimeMigrator } from "../../runtime-migrator/runtime-migrator";
import type { DrizzleDB } from "../../runtime-migrator/types";
import { agentTable } from "../../schema/agent";
import { approvalRequestTable } from "../../schema/approvalRequests";
import { connectorAccountsTable } from "../../schema/connectorAccounts";
import { createIsolatedTestDatabaseForMigration } from "../test-helpers";

const INDEX_NAME = "approval_requests_agent_idempotency_uidx";

const MIGRATION_0004_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../drizzle/migrations/0004_approval_request_idempotency.sql"
);

async function getIndexDef(db: DrizzleDB, indexName: string): Promise<string> {
  const result = await db.execute(
    sql`SELECT pg_get_indexdef(c.oid) AS def
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relname = ${indexName} AND n.nspname = 'public'`
  );
  const row = result.rows[0] as { def?: string } | undefined;
  if (!row?.def) {
    throw new Error(`Index ${indexName} not found in database`);
  }
  return row.def;
}

describe("Partial index WHERE clause preservation", () => {
  describe("snapshot and SQL generation", () => {
    it("captures partial-index WHERE clauses from the Drizzle schema", async () => {
      const snapshot = await generateSnapshot({
        agents: agentTable,
        approval_requests: approvalRequestTable,
        connector_accounts: connectorAccountsTable,
      });

      const approvalIndex = snapshot.tables["public.approval_requests"].indexes[INDEX_NAME];
      expect(approvalIndex).toBeDefined();
      expect(approvalIndex.isUnique).toBe(true);
      expect(approvalIndex.where).toBe(`"idempotency_key" IS NOT NULL`);

      const connectorIndexes = snapshot.tables["public.connector_accounts"].indexes;
      expect(connectorIndexes.connector_accounts_agent_provider_account_key_uniq.where).toBe(
        `"deleted_at" IS NULL`
      );
      expect(connectorIndexes.connector_accounts_agent_provider_external_role_uniq.where).toBe(
        `"deleted_at" IS NULL`
      );

      // Full (non-partial) indexes must not grow a predicate.
      expect(connectorIndexes.connector_accounts_status_idx.where).toBeUndefined();
    });

    it("emits the WHERE clause in generated CREATE INDEX statements", async () => {
      const snapshot = await generateSnapshot({
        agents: agentTable,
        approval_requests: approvalRequestTable,
      });

      const statements = await generateMigrationSQL(null, snapshot);
      const createIndex = statements.find((stmt) => stmt.includes(INDEX_NAME));

      expect(createIndex).toBe(
        `CREATE UNIQUE INDEX IF NOT EXISTS "${INDEX_NAME}" ` +
          `ON "public"."approval_requests" USING btree ("agent_id", "idempotency_key") ` +
          `WHERE "idempotency_key" IS NOT NULL;`
      );
    });

    it("emits per-column NULLS ordering the way drizzle-kit does", async () => {
      const orderingTable = pgTable(
        "nulls_ordering",
        {
          a: text("a"),
          b: text("b"),
          c: text("c"),
        },
        (table) => [
          index("nulls_ordering_desc_idx").on(table.a.desc()),
          index("nulls_ordering_first_idx").on(table.b.nullsFirst()),
          index("nulls_ordering_default_idx").on(table.c),
        ]
      );

      const snapshot = await generateSnapshot({ nulls_ordering: orderingTable });
      const statements = await generateMigrationSQL(null, snapshot);
      const forIndex = (name: string) => statements.find((stmt) => stmt.includes(`"${name}"`));

      // DESC flips PostgreSQL's null placement to NULLS FIRST, so Drizzle's
      // "last" default must be spelled out to stay faithful to the schema.
      expect(forIndex("nulls_ordering_desc_idx")).toContain(`("a" DESC NULLS LAST)`);
      expect(forIndex("nulls_ordering_first_idx")).toContain(`("b" NULLS FIRST)`);
      // ASC + NULLS LAST is the PostgreSQL default and stays implicit.
      expect(forIndex("nulls_ordering_default_idx")).toContain(`("c")`);
    });
  });

  describe("DDL equivalence with the committed SQL migration", () => {
    let db: DrizzleDB;
    let cleanup: () => Promise<void>;

    beforeEach(async () => {
      const testSetup = await createIsolatedTestDatabaseForMigration("partial_index_where_test");
      db = testSetup.db;
      cleanup = testSetup.cleanup;
    });

    afterEach(async () => {
      if (cleanup) {
        await cleanup();
      }
    });

    it("RuntimeMigrator and drizzle/migrations/0004 produce identical index DDL", async () => {
      // Path A: the committed SQL migration, applied verbatim from disk
      // against a minimal pre-existing approval_requests table (0004 is an
      // ALTER + CREATE INDEX on an already-provisioned database).
      await db.execute(
        sql.raw(
          `CREATE TABLE "approval_requests" ("id" uuid PRIMARY KEY, "agent_id" uuid NOT NULL)`
        )
      );

      const migrationSql = fs.readFileSync(MIGRATION_0004_PATH, "utf8");
      for (const statement of migrationSql.split(/-->\s*statement-breakpoint/)) {
        const trimmed = statement.trim();
        if (trimmed.length > 0) {
          await db.execute(sql.raw(trimmed));
        }
      }

      const sqlMigrationDef = await getIndexDef(db, INDEX_NAME);
      expect(sqlMigrationDef).toContain("WHERE");

      await db.execute(sql.raw(`DROP TABLE "approval_requests" CASCADE`));

      // Path B: the runtime migrator, driven by the real Drizzle schema.
      const migrator = new RuntimeMigrator(db);
      await migrator.initialize();
      await migrator.migrate("@elizaos/partial-index-equivalence-test", {
        agents: agentTable,
        approval_requests: approvalRequestTable,
      });

      const runtimeMigratorDef = await getIndexDef(db, INDEX_NAME);

      // pg_get_indexdef returns the server-normalized definition, so equal
      // strings prove the two migration paths created semantically identical
      // indexes — including the partial-index predicate.
      expect(runtimeMigratorDef).toBe(sqlMigrationDef);
      expect(runtimeMigratorDef).toMatch(/WHERE \(?idempotency_key IS NOT NULL\)?/);
      expect(runtimeMigratorDef).toContain("UNIQUE");
    });
  });
});
