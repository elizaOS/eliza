/**
 * Real PGlite coverage for carve-out projection certification across partially
 * populated targets, same-key collisions, and incomplete copies.
 */

import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertCarveOutProjectionComplete,
  type CarveOutDatabase,
  type CarveOutSqlExecutor,
  runCarveOutMigration,
} from "./carve-out-migration.js";

let database: PGlite | undefined;

afterEach(async () => {
  await database?.close();
  database = undefined;
});

async function fixture(): Promise<CarveOutSqlExecutor> {
  database = new PGlite();
  await database.exec(`
    CREATE SCHEMA legacy_domain;
    CREATE SCHEMA canonical_domain;
    CREATE TABLE legacy_domain.items (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
    CREATE TABLE canonical_domain.items (
      id TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      canonical_note TEXT
    );
    INSERT INTO legacy_domain.items VALUES ('shared', 'same'), ('source-only', 'copy-me');
    INSERT INTO canonical_domain.items VALUES
      ('shared', 'same', 'enriched'), ('target-only', 'owned', 'keep');
  `);
  return async (statement) => {
    const result = await database!.query<Record<string, unknown>>(statement);
    return result.rows;
  };
}

function transactionalDatabase(exec: CarveOutSqlExecutor): CarveOutDatabase {
  return {
    execute: exec,
    transaction: (operation) =>
      database!.transaction((transaction) =>
        operation(async (statement) => {
          const result = await transaction.query<Record<string, unknown>>(statement);
          return result.rows;
        })
      ),
  };
}

const projection = {
  migrationKey: "test/items/v1",
  source: { schema: "legacy_domain", table: "items" },
  target: { schema: "canonical_domain", table: "items" },
  keyColumns: ["id"],
} as const;

describe("assertCarveOutProjectionComplete", () => {
  it("certifies a partially populated target only after source-only rows are copied", async () => {
    const exec = await fixture();
    await exec(`
      INSERT INTO canonical_domain.items (id, payload)
      SELECT s.id, s.payload FROM legacy_domain.items AS s
      WHERE NOT EXISTS (
        SELECT 1 FROM canonical_domain.items AS t WHERE t.id = s.id
      )
      ON CONFLICT (id) DO NOTHING
    `);

    await expect(assertCarveOutProjectionComplete(exec, projection)).resolves.toBeUndefined();
    const rows = await exec(
      "SELECT id, payload, canonical_note FROM canonical_domain.items ORDER BY id"
    );
    expect(rows).toEqual([
      { id: "shared", payload: "same", canonical_note: "enriched" },
      { id: "source-only", payload: "copy-me", canonical_note: null },
      { id: "target-only", payload: "owned", canonical_note: "keep" },
    ]);
  }, 120_000);

  it("fails closed on same-key semantic drift", async () => {
    const exec = await fixture();
    await exec("UPDATE canonical_domain.items SET payload = 'different' WHERE id = 'shared'");
    await expect(assertCarveOutProjectionComplete(exec, projection)).rejects.toMatchObject({
      code: "CARVE_OUT_MIGRATION_COLLISION",
    });
  }, 120_000);

  it("fails closed while any source-only row remains", async () => {
    const exec = await fixture();
    await expect(assertCarveOutProjectionComplete(exec, projection)).rejects.toMatchObject({
      code: "CARVE_OUT_MIGRATION_INCOMPLETE",
    });
  }, 120_000);

  it("rejects nullable or duplicate declared keys instead of producing ambiguous matches", async () => {
    const exec = await fixture();
    await exec("CREATE TABLE legacy_domain.ambiguous_items (id TEXT, payload TEXT NOT NULL)");
    await exec("CREATE TABLE canonical_domain.ambiguous_items (id TEXT, payload TEXT NOT NULL)");
    await exec(`INSERT INTO legacy_domain.ambiguous_items VALUES
      (NULL, 'null-key'), ('duplicate', 'one'), ('duplicate', 'two')`);

    await expect(
      assertCarveOutProjectionComplete(exec, {
        migrationKey: "test/ambiguous-items/v1",
        source: { schema: "legacy_domain", table: "ambiguous_items" },
        target: { schema: "canonical_domain", table: "ambiguous_items" },
        keyColumns: ["id"],
      })
    ).rejects.toMatchObject({ code: "CARVE_OUT_MIGRATION_KEY_INVALID" });
  }, 120_000);
});

describe("runCarveOutMigration transaction", () => {
  it("rolls back a copied row and its receipt when verification fails after the source lock", async () => {
    const exec = await fixture();
    const db = transactionalDatabase(exec);

    await expect(
      runCarveOutMigration(db, {
        key: "test/transaction-rollback/v1",
        sourceTables: [{ schema: "legacy_domain", table: "items" }],
        run: async (transactionExec) => {
          await transactionExec(
            "INSERT INTO canonical_domain.items VALUES ('transient', 'copied', NULL)"
          );
          throw new Error("verification failed after copy");
        },
        outcome: String,
      })
    ).rejects.toThrow("verification failed after copy");

    const copied = await exec("SELECT id FROM canonical_domain.items WHERE id = 'transient'");
    const receipts = await exec(`
      SELECT migration_key FROM app_eliza_migrations.carve_out_receipts
       WHERE migration_key = 'test/transaction-rollback/v1'
    `);
    expect(copied).toEqual([]);
    expect(receipts).toEqual([]);
  }, 120_000);
});
