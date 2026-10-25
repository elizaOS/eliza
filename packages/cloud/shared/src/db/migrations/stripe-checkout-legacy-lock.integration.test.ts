/**
 * Proves legacy Stripe quarantine tenant binding against two real PostgreSQL sessions.
 * PGlite cannot establish cross-session row-lock blocking, so this suite uses the opt-in ephemeral harness.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import {
  acquireEphemeralPostgres,
  type EphemeralPostgres,
} from "../../lib/services/tenant-db/__tests__/ephemeral-postgres";

const ORG_A = "10000000-0000-4000-8000-000000000001";
const ORG_B = "10000000-0000-4000-8000-000000000002";
const USER_A = "20000000-0000-4000-8000-000000000001";
const migration = await readFile(
  new URL("./0261_stripe_checkout_orders.sql", import.meta.url),
  "utf8",
);
const SKIP_REASON =
  "[Stripe legacy tenant lock] SKIPPED - no real PostgreSQL available. " +
  "Set APPS_TENANT_DB_EPHEMERAL=1 with Docker, or provide APPS_TENANT_DB_TEST_DSN.";

let postgres: EphemeralPostgres | null = await acquireEphemeralPostgres();
const schemaName = `stripe_lock_${randomUUID().replaceAll("-", "")}`;

if (!postgres) console.warn(SKIP_REASON);

async function client(): Promise<Client> {
  if (!postgres) throw new Error("real PostgreSQL harness was not initialized");
  const connection = new Client({ connectionString: postgres.dsn });
  await connection.connect();
  await connection.query(`SET search_path TO "${schemaName}"`);
  return connection;
}

async function waitUntilBlocked(observer: Client, blockedPid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await observer.query<{ blocked: boolean }>(
      "SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked",
      [blockedPid],
    );
    if (result.rows[0]?.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for PostgreSQL session ${blockedPid} to block`);
}

beforeAll(async () => {
  if (!postgres) return;
  const admin = new Client({ connectionString: postgres.dsn });
  await admin.connect();
  try {
    await admin.query(`CREATE SCHEMA "${schemaName}"`);
    await admin.query(`SET search_path TO "${schemaName}"`);
    await admin.query(`
      CREATE TABLE organizations (id uuid PRIMARY KEY);
      CREATE TABLE users (
        id uuid PRIMARY KEY,
        organization_id uuid REFERENCES organizations(id)
      );
      CREATE TABLE credit_packs (id uuid PRIMARY KEY);
      CREATE TABLE credit_transactions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid NOT NULL REFERENCES organizations(id),
        amount numeric(12,6) NOT NULL,
        type text NOT NULL,
        metadata jsonb NOT NULL DEFAULT '{}',
        stripe_payment_intent_id text
      );
      INSERT INTO organizations(id) VALUES ('${ORG_A}'), ('${ORG_B}');
      INSERT INTO users(id, organization_id) VALUES ('${USER_A}', '${ORG_A}');
    `);
    await admin.query(migration.replaceAll("--> statement-breakpoint", ""));
  } finally {
    await admin.end();
  }
}, 30_000);

afterAll(async () => {
  if (postgres) {
    const admin = new Client({ connectionString: postgres.dsn });
    await admin.connect();
    try {
      await admin.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    } finally {
      await admin.end();
    }
  }
  await postgres?.stop();
  postgres = null;
}, 30_000);

const realPostgres = postgres ? describe : describe.skip;

realPostgres("0261 legacy Stripe quarantine tenant lock", () => {
  test("serializes quarantine insertion with user organization reassignment in both orders", async () => {
    const holder = await client();
    const contender = await client();
    const observer = await client();
    try {
      const contenderPidResult = await contender.query<{ pid: number }>(
        "SELECT pg_backend_pid() AS pid",
      );
      const contenderPid = contenderPidResult.rows[0]?.pid;
      if (!contenderPid) throw new Error("PostgreSQL contender PID was unavailable");
      await holder.query("BEGIN");
      await holder.query(`INSERT INTO stripe_checkout_legacy_quarantine (
        checkout_session_id, stripe_payment_intent_id, organization_id,
        initiated_by_user_id, stripe_customer_id, charge_amount_cents,
        currency, reason, provider_receipt
      ) VALUES (
        'cs_holder', 'pi_holder', '${ORG_A}', '${USER_A}', 'cus_a', 500,
        'usd', 'test', '{}'
      )`);

      await contender.query("BEGIN");
      const reassign = contender.query("UPDATE users SET organization_id = $1 WHERE id = $2", [
        ORG_B,
        USER_A,
      ]);
      await waitUntilBlocked(observer, contenderPid);
      await holder.query("COMMIT");
      await reassign;
      await contender.query("COMMIT");

      const historical = await observer.query<{
        organization_id: string;
        initiated_by_user_id: string;
      }>(`SELECT organization_id::text, initiated_by_user_id::text
          FROM stripe_checkout_legacy_quarantine
          WHERE checkout_session_id = 'cs_holder'`);
      expect(historical.rows).toEqual([{ organization_id: ORG_A, initiated_by_user_id: USER_A }]);

      await holder.query("BEGIN");
      await holder.query("UPDATE users SET organization_id = $1 WHERE id = $2", [ORG_A, USER_A]);
      await contender.query("BEGIN");
      const staleInsert = contender.query(`INSERT INTO stripe_checkout_legacy_quarantine (
        checkout_session_id, stripe_payment_intent_id, organization_id,
        initiated_by_user_id, stripe_customer_id, charge_amount_cents,
        currency, reason, provider_receipt
      ) VALUES (
        'cs_stale', 'pi_stale', '${ORG_B}', '${USER_A}', 'cus_b', 500,
        'usd', 'test', '{}'
      )`);
      await waitUntilBlocked(observer, contenderPid);
      await holder.query("COMMIT");
      await expect(staleInsert).rejects.toThrow(/user organization mismatch/i);
      await contender.query("ROLLBACK");
      const staleRows = await observer.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM stripe_checkout_legacy_quarantine " +
          "WHERE checkout_session_id = 'cs_stale'",
      );
      expect(staleRows.rows).toEqual([{ count: "0" }]);
    } finally {
      await Promise.allSettled([holder.query("ROLLBACK"), contender.query("ROLLBACK")]);
      await Promise.allSettled([holder.end(), contender.end(), observer.end()]);
    }
  }, 30_000);
});
