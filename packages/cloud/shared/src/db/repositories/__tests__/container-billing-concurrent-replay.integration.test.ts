/**
 * Concurrent container-billing replay (#22951 earnings-first settlement).
 *
 * Proves the already-billed fence under GENUINELY overlapping settlement
 * transactions: two `recordSuccessfulDailyBilling` calls released together on
 * independent pool sessions, both parked behind an external holder session that
 * owns the container row lock — so both are provably inside their open
 * transactions at the same instant (asserted via `pg_stat_activity`) before
 * either can enter the critical section. Exactly one settles earnings-first;
 * the loser converges on the already-billed receipt instead of surfacing a
 * unique-constraint or transaction error. PGlite cannot prove this: it is a
 * single session, so two drizzle transactions cannot contend for the row lock
 * (same constraint as compute-stop-concurrency.integration.test.ts).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { Client } from "pg";
import {
  acquireEphemeralPostgres,
  type EphemeralPostgres,
} from "../../../lib/services/tenant-db/__tests__/ephemeral-postgres";

const SKIP_REASON =
  "[container billing concurrent replay] SKIPPED - no real PostgreSQL available. " +
  "Set APPS_TENANT_DB_EPHEMERAL=1 with Docker, or provide APPS_TENANT_DB_TEST_DSN.";
const ORIGINAL_ENV = {
  DATABASE_URL: process.env.DATABASE_URL,
  TEST_DATABASE_URL: process.env.TEST_DATABASE_URL,
};

let postgres: EphemeralPostgres | null = await acquireEphemeralPostgres();
let databaseName: string | null = null;
let isolatedDsn: string | null = null;
let closeDatabaseConnectionsForTests:
  | typeof import("../../client").closeDatabaseConnectionsForTests
  | undefined;
let dbWrite: typeof import("../../client").dbWrite | undefined;
let containerBillingRepository:
  | typeof import("../container-billing").containerBillingRepository
  | undefined;

function restoreEnv(name: keyof typeof ORIGINAL_ENV, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function createIsolatedDatabase(baseDsn: string): Promise<string> {
  databaseName = `eliza_billing_replay_${randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString: baseDsn });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await admin.end();
  }
  const url = new URL(baseDsn);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

/**
 * Block until at least `minWaiters` OTHER sessions in this database are parked
 * on a lock (cardinality(pg_blocking_pids) > 0). For this suite that means both
 * settlement transactions are open and contending for the holder's container
 * row lock — the proof that the two calls genuinely overlap in flight.
 */
async function waitUntilBlockedWaiters(observer: Client, minWaiters: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await observer.query<{ waiters: number }>(`
      SELECT count(*)::int AS waiters
      FROM pg_stat_activity activity
      WHERE activity.datname = current_database()
        AND activity.pid <> pg_backend_pid()
        AND cardinality(pg_blocking_pids(activity.pid)) > 0
    `);
    if ((result.rows[0]?.waiters ?? 0) >= minWaiters) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${minWaiters} blocked settlement waiters`);
}

if (!postgres) {
  console.warn(SKIP_REASON);
} else {
  isolatedDsn = await createIsolatedDatabase(postgres.dsn);
  process.env.DATABASE_URL = isolatedDsn;
  process.env.TEST_DATABASE_URL = isolatedDsn;
  const [clientModule, repositoryModule] = await Promise.all([
    import("../../client"),
    import("../container-billing"),
  ]);
  closeDatabaseConnectionsForTests = clientModule.closeDatabaseConnectionsForTests;
  dbWrite = clientModule.dbWrite;
  containerBillingRepository = repositoryModule.containerBillingRepository;
}

beforeAll(async () => {
  if (!dbWrite) return;
  // Minimal schema for recordSuccessfulDailyBilling (same column set as the
  // PGlite idempotency suite, including the 0139 partial unique indexes the
  // fence must not violate).
  const ddl = [
    `CREATE TABLE IF NOT EXISTS redeemable_earnings (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL,
      total_earned numeric(18,4) NOT NULL DEFAULT '0',
      total_redeemed numeric(18,4) NOT NULL DEFAULT '0',
      total_pending numeric(18,4) NOT NULL DEFAULT '0',
      available_balance numeric(18,4) NOT NULL DEFAULT '0',
      earned_from_miniapps numeric(18,4) NOT NULL DEFAULT '0',
      earned_from_agents numeric(18,4) NOT NULL DEFAULT '0',
      earned_from_mcps numeric(18,4) NOT NULL DEFAULT '0',
      earned_from_affiliates numeric(18,4) NOT NULL DEFAULT '0',
      earned_from_app_owner_shares numeric(18,4) NOT NULL DEFAULT '0',
      earned_from_creator_shares numeric(18,4) NOT NULL DEFAULT '0',
      total_converted_to_credits numeric(18,4) NOT NULL DEFAULT '0',
      last_earning_at timestamp,
      last_redemption_at timestamp,
      version numeric(10,0) NOT NULL DEFAULT '0',
      created_at timestamp NOT NULL DEFAULT now(),
      updated_at timestamp NOT NULL DEFAULT now()
    )`,
    `CREATE TABLE IF NOT EXISTS redeemable_earnings_ledger (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL,
      entry_type text NOT NULL,
      amount numeric(18,4) NOT NULL,
      balance_after numeric(18,4) NOT NULL,
      earnings_source text,
      source_id uuid,
      redemption_id uuid,
      description text NOT NULL,
      metadata jsonb NOT NULL DEFAULT '{}',
      created_at timestamp NOT NULL DEFAULT now()
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS redeemable_earnings_ledger_conversion_idempotency_idx
      ON redeemable_earnings_ledger ((metadata ->> 'idempotency_key'))
      WHERE entry_type = 'credit_conversion' AND (metadata ->> 'idempotency_key') IS NOT NULL`,
    `CREATE TABLE IF NOT EXISTS organizations (
      id uuid PRIMARY KEY,
      credit_balance numeric(20,6) NOT NULL DEFAULT '0',
      balance_revision bigint NOT NULL DEFAULT 0,
      updated_at timestamp NOT NULL DEFAULT now()
    )`,
    `CREATE TABLE IF NOT EXISTS users (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS credit_transactions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL,
      user_id uuid,
      amount numeric(16,6) NOT NULL,
      type text NOT NULL,
      description text,
      metadata jsonb NOT NULL DEFAULT '{}',
      stripe_payment_intent_id text,
      created_at timestamp NOT NULL DEFAULT now(),
      settled_at timestamp
    )`,
    `CREATE TABLE IF NOT EXISTS containers (
      id uuid PRIMARY KEY,
      name text NOT NULL,
      project_name text NOT NULL,
      organization_id uuid NOT NULL,
      user_id uuid NOT NULL,
      status text NOT NULL,
      billing_status text NOT NULL,
      desired_count integer NOT NULL DEFAULT 1,
      cpu integer NOT NULL DEFAULT 1,
      memory integer NOT NULL DEFAULT 1024,
      shutdown_warning_sent_at timestamp,
      scheduled_shutdown_at timestamp,
      lifecycle_revision bigint NOT NULL DEFAULT 0,
      total_billed numeric(18,6) NOT NULL DEFAULT '0',
      last_billed_at timestamp,
      next_billing_at timestamp,
      created_at timestamp NOT NULL DEFAULT now(),
      updated_at timestamp NOT NULL DEFAULT now()
    )`,
    `CREATE TABLE IF NOT EXISTS container_billing_records (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      container_id uuid NOT NULL,
      organization_id uuid NOT NULL,
      amount numeric(16,6) NOT NULL,
      rate_segments jsonb NOT NULL DEFAULT '[]',
      billing_period_start timestamp NOT NULL,
      billing_period_end timestamp NOT NULL,
      status text NOT NULL DEFAULT 'success',
      credit_transaction_id uuid,
      error_message text,
      created_at timestamp NOT NULL DEFAULT now()
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS container_billing_records_period_unique
      ON container_billing_records (container_id, billing_period_start)
      WHERE status = 'success'`,
    `CREATE TABLE IF NOT EXISTS compute_billing_rate_segments (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL,
      workload_kind text NOT NULL,
      workload_id uuid NOT NULL,
      lifecycle_revision bigint NOT NULL,
      billing_state text NOT NULL,
      rate_per_hour numeric(16,6) NOT NULL,
      effective_at timestamp NOT NULL,
      created_at timestamp NOT NULL DEFAULT now()
    )`,
  ];
  for (const stmt of ddl) {
    await dbWrite.execute(stmt);
  }
}, 30_000);

afterAll(async () => {
  await closeDatabaseConnectionsForTests?.();
  if (postgres && databaseName) {
    const admin = new Client({ connectionString: postgres.dsn });
    await admin.connect();
    try {
      await admin.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
        [databaseName],
      );
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    } finally {
      await admin.end();
    }
  }
  await postgres?.stop();
  postgres = null;
  for (const [name, value] of Object.entries(ORIGINAL_ENV)) {
    restoreEnv(name as keyof typeof ORIGINAL_ENV, value);
  }
}, 30_000);

const realPostgres = postgres ? describe : describe.skip;

realPostgres("concurrent settlement replay (earnings-first)", () => {
  test("two overlapping settlements contend on the row lock: one settles, the loser converges on the already-billed fence", async () => {
    if (!isolatedDsn || !dbWrite || !containerBillingRepository) {
      throw new Error("harness unavailable");
    }
    const organizationId = randomUUID();
    const userId = randomUUID();
    const containerId = randomUUID();
    // Mixed pools (credits 50, earnings 0.3) with a 0.027917/hr rate over
    // exactly 24h → a 0.670008 charge split earnings-first: 0.3 from
    // earnings, 0.370008 from credits — same economics as the sequential
    // PGlite cases, now under genuine transaction overlap.
    const periodStart = new Date("2026-08-18T05:00:00Z");
    const now = new Date("2026-08-19T05:00:00Z");
    const charge = 0.670008;

    await dbWrite.execute(
      sql`INSERT INTO organizations (id, credit_balance) VALUES (${organizationId}, '50')`,
    );
    await dbWrite.execute(
      sql`INSERT INTO users (id, organization_id) VALUES (${userId}, ${organizationId})`,
    );
    await dbWrite.execute(
      sql`INSERT INTO redeemable_earnings
          (user_id, total_earned, available_balance, earned_from_creator_shares)
         VALUES (${userId}, '0.3', '0.3', '0.3')`,
    );
    await dbWrite.execute(
      sql`INSERT INTO containers
          (id, name, project_name, organization_id, user_id, status, billing_status, total_billed, created_at)
         VALUES (${containerId}, 'web', 'proj', ${organizationId}, ${userId}, 'running', 'active', '0', ${periodStart})`,
    );
    await dbWrite.execute(
      sql`INSERT INTO compute_billing_rate_segments
          (organization_id, workload_kind, workload_id, lifecycle_revision, billing_state, rate_per_hour, effective_at)
         VALUES (${organizationId}, 'container', ${containerId}, 0, 'running', '0.027917', ${periodStart})`,
    );

    const input = {
      containerId,
      organizationId,
      userId,
      containerName: "web",
      dailyRate: 0.67,
      earningsSourceUserId: userId,
      payAsYouGoFromEarnings: true,
      newBalance: 0,
      now,
    };

    const holder = new Client({ connectionString: isolatedDsn });
    const observer = new Client({ connectionString: isolatedDsn });
    await Promise.all([holder.connect(), observer.connect()]);
    try {
      // Barrier: an external session owns the container row lock so NEITHER
      // settlement can enter its critical section until both are open and
      // contending — guaranteeing real overlap rather than accidental
      // serialization by scheduling order.
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM containers WHERE id = $1 FOR UPDATE", [containerId]);

      // Released together; each call opens its own pool session/transaction
      // and parks on the container row lock behind the holder.
      const inFlight = [
        containerBillingRepository.recordSuccessfulDailyBilling(input),
        containerBillingRepository.recordSuccessfulDailyBilling(input),
      ];
      // Prove both transactions are open and blocked at the same instant.
      await waitUntilBlockedWaiters(observer, 2);
      await holder.query("COMMIT");

      const results = await Promise.allSettled(inFlight);
      // The loser must converge on the fence — never a unique-constraint or
      // transaction error — so both calls fulfill.
      expect(results.every((r) => r.status === "fulfilled")).toBe(true);
      const values = results.map(
        (r) =>
          (
            r as PromiseFulfilledResult<{
              alreadyBilled: boolean;
              transactionId: string | null;
              insufficient: boolean;
              fromEarnings: number;
            }>
          ).value,
      );

      const settled = values.filter((v) => !v.alreadyBilled && v.transactionId !== null);
      const fenced = values.filter((v) => v.alreadyBilled);
      expect(settled).toHaveLength(1);
      expect(fenced).toHaveLength(1);
      expect(fenced[0]!.transactionId).toBeNull();
      expect(fenced[0]!.insufficient).toBe(false);
      // The winner's split is still earnings-first under contention.
      expect(settled[0]!.fromEarnings).toBeCloseTo(0.3, 6);

      // Final committed state (read from an independent session): exactly
      // one success receipt, one earnings conversion, one debit.
      const receipts = await observer.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM container_billing_records WHERE container_id = $1 AND status = 'success'",
        [containerId],
      );
      expect(receipts.rows[0]!.n).toBe(1);

      const conversions = await observer.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM redeemable_earnings_ledger WHERE user_id = $1 AND entry_type = 'credit_conversion'",
        [userId],
      );
      expect(conversions.rows[0]!.n).toBe(1);

      const debit = await observer.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM credit_transactions WHERE organization_id = $1 AND type = 'debit'",
        [organizationId],
      );
      expect(debit.rows[0]!.n).toBe(1);

      const conversionCredit = await observer.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM credit_transactions WHERE organization_id = $1 AND type = 'credit'",
        [organizationId],
      );
      expect(conversionCredit.rows[0]!.n).toBe(1);

      const earnings = await observer.query<{ available_balance: string }>(
        "SELECT available_balance FROM redeemable_earnings WHERE user_id = $1",
        [userId],
      );
      expect(Number(earnings.rows[0]!.available_balance)).toBeCloseTo(0, 4);

      const org = await observer.query<{ credit_balance: string }>(
        "SELECT credit_balance FROM organizations WHERE id = $1",
        [organizationId],
      );
      expect(Number(org.rows[0]!.credit_balance)).toBeCloseTo(50 + 0.3 - charge, 6);
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      await Promise.all([holder.end(), observer.end()]);
    }
  }, 30_000);
});
