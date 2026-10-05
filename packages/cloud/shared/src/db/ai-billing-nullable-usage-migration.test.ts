/** Runs the historical ledger DDL and actual nullable-link upgrade on PostgreSQL engines. */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { ElizaError } from "@elizaos/core";
import { Client } from "pg";
import { acquireEphemeralPostgres } from "../lib/services/tenant-db/__tests__/ephemeral-postgres";

const original = readFileSync(
  new URL("./migrations/0118_add_ai_billing_and_alert_events.sql", import.meta.url),
  "utf8",
);
const upgrade = readFileSync(
  new URL("./migrations/0473_ai_billing_records_nullable_usage_record.sql", import.meta.url),
  "utf8",
);
const org = "00000000-0000-4000-8000-000000000001";
const usage = "00000000-0000-4000-8000-000000000002";

async function verifyUpgrade(query: (sql: string) => Promise<{ rows: unknown[] }>) {
  await query(`CREATE TABLE organizations(id uuid PRIMARY KEY); CREATE TABLE users(id uuid PRIMARY KEY);
    CREATE TABLE usage_records(id uuid PRIMARY KEY); CREATE TABLE credit_transactions(id uuid PRIMARY KEY);`);
  await query(original);
  await query(
    `INSERT INTO organizations VALUES ('${org}'); INSERT INTO usage_records VALUES ('${usage}');`,
  );
  const insert = (key: string, link: string) => `INSERT INTO ai_billing_records
    (organization_id, usage_record_id, idempotency_key, provider, model, usage_total_cost, ledger_total)
    VALUES ('${org}', ${link}, '${key}', 'actual-provider', 'custom-model', 0.003, 0.005)`;
  await query(insert("historical", `'${usage}'`));
  await expect(query(insert("unavailable", "NULL"))).rejects.toThrow();
  await query(upgrade);
  await query(upgrade); // Reapplying the narrow DDL must preserve history.
  await query(insert("unavailable", "NULL"));
  await query(insert("another-null", "NULL"));
  await expect(query(insert("unavailable", "NULL"))).rejects.toThrow();
  await expect(query(insert("duplicate-link", `'${usage}'`))).rejects.toThrow();
  await expect(
    query(insert("unknown-link", "'00000000-0000-4000-8000-000000000099'")),
  ).rejects.toThrow();
  const result =
    await query(`SELECT usage_record_id::text, usage_total_cost::text, ledger_total::text
    FROM ai_billing_records WHERE idempotency_key='historical'`);
  expect(result.rows).toEqual([
    { usage_record_id: usage, usage_total_cost: "0.003000", ledger_total: "0.005000" },
  ]);
  expect((await query("SELECT id FROM ai_billing_records")).rows).toHaveLength(3);
}

test("upgrades the real historical ledger DDL on PGlite", async () => {
  const db = new PGlite();
  try {
    await verifyUpgrade(async (sql) => (await db.exec(sql)).at(-1) ?? { rows: [] });
  } finally {
    await db.close();
  }
}, 120_000);

const enabled =
  process.env.APPS_TENANT_DB_EPHEMERAL === "1" || process.env.TEST_LANE === "post-merge";
(enabled ? test : test.skip)(
  "upgrades the real historical ledger DDL on PostgreSQL",
  async () => {
    const postgres = await acquireEphemeralPostgres();
    if (!postgres)
      throw new ElizaError("Requested ledger migration PostgreSQL unavailable", {
        code: "LEDGER_TEST_POSTGRES_UNAVAILABLE",
      });
    const client = new Client({ connectionString: postgres.dsn });
    let connected = false;
    try {
      await client.connect();
      connected = true;
      await client.query(
        "CREATE SCHEMA ledger_nullable_upgrade; SET search_path TO ledger_nullable_upgrade, public",
      );
      await verifyUpgrade(async (sql) => {
        const result = await client.query(sql);
        return Array.isArray(result) ? (result.at(-1) ?? { rows: [] }) : result;
      });
    } finally {
      try {
        if (connected) await client.query("DROP SCHEMA IF EXISTS ledger_nullable_upgrade CASCADE");
      } finally {
        await client.end().finally(() => postgres.stop());
      }
    }
  },
  120_000,
);
