/** Exercises the financial append-only migration on PostgreSQL, including the former deletion setting. Minimal journal tables isolate preservation of recorded economic payloads. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";

const url = process.env.APP_BILLING_TEST_POSTGRES_URL;
const schema = `financial_retention_${randomUUID().replaceAll("-", "_")}`;
let db: Client;
const tables = [
  "billing_subscription_revisions",
  "subscription_allowance_transactions",
  "app_billing_membership_operations",
];

describe.skipIf(!url)("financial history retention during erasure", () => {
  beforeAll(async () => {
    db = new Client({ connectionString: url });
    await db.connect();
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`SET search_path TO ${schema},public`);
    const previous = await readFile(
      new URL(
        "../migrations/0374_subscription_funding_transaction_uniqueness.sql",
        import.meta.url,
      ),
      "utf8",
    );
    await db.query(previous.slice(previous.indexOf("CREATE OR REPLACE FUNCTION")));
    for (const table of tables) {
      await db.query(`CREATE TABLE ${table}(id integer PRIMARY KEY,payload jsonb NOT NULL)`);
      await db.query(
        `CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE OR TRUNCATE ON ${table} FOR EACH STATEMENT EXECUTE FUNCTION reject_subscription_append_only_mutation()`,
      );
      await db.query(`INSERT INTO ${table} VALUES(1,$1)`, [
        { amount: "17.125000", source: "original-provider-evidence" },
      ]);
    }
    await db.query("SELECT set_config('eliza.subscription_account_deletion_authority','on',false)");
    await db.query("DELETE FROM billing_subscription_revisions WHERE id=1");
    await db.query("INSERT INTO billing_subscription_revisions VALUES(1,$1)", [
      { amount: "17.125000", source: "original-provider-evidence" },
    ]);
    await db.query(
      await readFile(
        new URL("../migrations/0437_billing_financial_history_retention.sql", import.meta.url),
        "utf8",
      ),
    );
  });
  afterAll(async () => {
    if (!db) return;
    await db.query(`DROP SCHEMA ${schema} CASCADE`);
    await db.end();
  });
  test("the former erasure bypass cannot mutate, delete, or truncate recorded history", async () => {
    for (const table of tables) {
      await expect(db.query(`DELETE FROM ${table} WHERE id=1`)).rejects.toMatchObject({
        code: "23514",
      });
      await expect(db.query(`UPDATE ${table} SET payload='{}' WHERE id=1`)).rejects.toMatchObject({
        code: "23514",
      });
      await expect(db.query(`TRUNCATE ${table}`)).rejects.toMatchObject({ code: "23514" });
      expect((await db.query(`SELECT payload FROM ${table} WHERE id=1`)).rows).toEqual([
        { payload: { amount: "17.125000", source: "original-provider-evidence" } },
      ]);
    }
  });
});
