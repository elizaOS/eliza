/** Executes the original app_billing removal migration against isolated PGlite databases, proving idempotency and preservation of populated legacy data. */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const migration = readFileSync(
  new URL("./migrations/0149_drop_app_billing.sql", import.meta.url),
  "utf8",
);

async function migrate(database: PGlite): Promise<void> {
  await database.transaction(async (transaction) => {
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) await transaction.exec(statement);
    }
  });
}

test("an absent legacy table is safe to migrate repeatedly", async () => {
  const database = new PGlite();
  try {
    await migrate(database);
    await migrate(database);
    expect(
      (await database.query("SELECT to_regclass('public.app_billing') AS legacy_table")).rows,
    ).toEqual([{ legacy_table: null }]);
  } finally {
    await database.close();
  }
});

test("an empty legacy table and its dependent view are removed idempotently", async () => {
  const database = new PGlite();
  try {
    await database.exec(`
      CREATE TABLE app_billing (id integer PRIMARY KEY, amount numeric(12,6));
      CREATE VIEW legacy_billing_view AS SELECT id, amount FROM app_billing;
    `);
    await migrate(database);
    expect(
      (
        await database.query(
          "SELECT to_regclass('public.app_billing') AS legacy_table, to_regclass('public.legacy_billing_view') AS legacy_view",
        )
      ).rows,
    ).toEqual([{ legacy_table: null, legacy_view: null }]);
    await migrate(database);
  } finally {
    await database.close();
  }
});

test("populated legacy data blocks removal and remains readable after rollback and retry", async () => {
  const database = new PGlite();
  try {
    await database.exec(`
      CREATE TABLE app_billing (id integer PRIMARY KEY, amount numeric(12,6));
      INSERT INTO app_billing VALUES (1, 12.500001), (2, 3.000002);
      CREATE VIEW legacy_billing_view AS SELECT id, amount FROM app_billing;
    `);
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(migrate(database)).rejects.toThrow(
        "app_billing holds 2 row(s); refusing to drop a non-empty table",
      );
      expect(
        (
          await database.query(
            "SELECT id, amount::text AS amount FROM legacy_billing_view ORDER BY id",
          )
        ).rows,
      ).toEqual([
        { id: 1, amount: "12.500001" },
        { id: 2, amount: "3.000002" },
      ]);
    }
  } finally {
    await database.close();
  }
});
