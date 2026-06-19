/**
 * Container-billing idempotency hardening (deeper-4b).
 *
 * Pins the defense-in-depth that keeps a cron re-run from double-debiting:
 *  1. `computeContainerBillingPeriod` is deterministic per UTC day (pure).
 *  2. `convertToCredits` is idempotent per `idempotencyKey` — a re-run returns
 *     the original ledger entry and does NOT debit earnings again.
 *  3. `listBillableContainers` gates on `next_billing_at` (already-paid periods
 *     are skipped) and `recordSuccessfulDailyBilling`:
 *       - row-locks the container and no-ops if the period is already billed,
 *       - records the credit_transaction as `-fromCredits` (not `-dailyCost`)
 *         so credit_balance reconciles with sum(credit_transactions).
 *
 * The DB-backed cases run against in-process PGlite so the real SQL (FOR UPDATE,
 * the JSONB-keyed lookup, and the partial unique indexes from migration 0139)
 * executes. They self-skip if PGlite is unavailable.
 */

import { beforeAll, describe, expect, test } from "bun:test";

process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";

import { computeContainerBillingPeriod } from "../container-billing-policy";

const PGLITE_TIMEOUT = 60000;

const ORG_ID = "00000000-0000-0000-0000-0000000000a1";
const USER_ID = "00000000-0000-0000-0000-0000000000b2";
const CONTAINER_ID = "00000000-0000-0000-0000-0000000000c3";

let dbWrite: typeof import("../../../db/client").dbWrite;
let redeemableEarningsService: typeof import("../redeemable-earnings").redeemableEarningsService;
let containerBillingRepository: typeof import("../../../db/repositories/container-billing").containerBillingRepository;
let pgliteReady = true;

beforeAll(async () => {
  try {
    ({ dbWrite } = await import("../../../db/client"));
    ({ redeemableEarningsService } = await import("../redeemable-earnings"));
    ({ containerBillingRepository } = await import("../../../db/repositories/container-billing"));

    // Minimal schema: the columns these code paths touch + the unique indexes
    // from migration 0139. FKs are omitted (single-table seams under test).
    // drizzle's execute() uses the extended protocol — one statement per call.
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
        updated_at timestamp NOT NULL DEFAULT now()
      )`,
      `CREATE TABLE IF NOT EXISTS credit_transactions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid NOT NULL,
        user_id uuid,
        amount numeric(12,6) NOT NULL,
        type text NOT NULL,
        description text,
        metadata jsonb NOT NULL DEFAULT '{}',
        stripe_payment_intent_id text,
        created_at timestamp NOT NULL DEFAULT now()
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
        total_billed numeric(12,2) NOT NULL DEFAULT '0',
        last_billed_at timestamp,
        next_billing_at timestamp,
        updated_at timestamp NOT NULL DEFAULT now()
      )`,
      `CREATE TABLE IF NOT EXISTS container_billing_records (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        container_id uuid NOT NULL,
        organization_id uuid NOT NULL,
        amount numeric(10,2) NOT NULL,
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
    ];
    for (const stmt of ddl) {
      await dbWrite.execute(stmt);
    }
  } catch (error) {
    pgliteReady = false;
    console.warn("[container-billing-idempotency] PGlite unavailable, skipping DB cases:", error);
  }
}, PGLITE_TIMEOUT);

describe("computeContainerBillingPeriod", () => {
  test("normalizes to the UTC day regardless of time of day", () => {
    const { periodStart, periodEnd } = computeContainerBillingPeriod(
      new Date("2026-06-05T14:30:45.123Z"),
    );
    expect(periodStart.toISOString()).toBe("2026-06-05T00:00:00.000Z");
    expect(periodEnd.toISOString()).toBe("2026-06-06T00:00:00.000Z");
  });

  test("is stable across two timestamps on the same UTC day", () => {
    const a = computeContainerBillingPeriod(new Date("2026-06-05T00:00:01.000Z"));
    const b = computeContainerBillingPeriod(new Date("2026-06-05T23:59:59.000Z"));
    expect(a.periodStart.getTime()).toBe(b.periodStart.getTime());
  });

  test("rolls to a new period across the UTC midnight boundary", () => {
    const a = computeContainerBillingPeriod(new Date("2026-06-05T23:59:59.000Z"));
    const b = computeContainerBillingPeriod(new Date("2026-06-06T00:00:01.000Z"));
    expect(a.periodStart.getTime()).not.toBe(b.periodStart.getTime());
  });
});

describe("convertToCredits idempotency", () => {
  test(
    "same idempotencyKey debits earnings exactly once",
    async () => {
      if (!pgliteReady) return;
      await dbWrite.execute(`DELETE FROM redeemable_earnings_ledger;`);
      await dbWrite.execute(`DELETE FROM redeemable_earnings;`);
      await dbWrite.execute(
        `INSERT INTO redeemable_earnings (user_id, total_earned, available_balance)
         VALUES ('${USER_ID}', '100', '100');`,
      );

      const key = "container:c3:2026-06-05T00:00:00.000Z";
      const first = await redeemableEarningsService.convertToCredits({
        userId: USER_ID,
        amount: 0.67,
        organizationId: ORG_ID,
        description: "Container hosting: test",
        idempotencyKey: key,
      });
      const second = await redeemableEarningsService.convertToCredits({
        userId: USER_ID,
        amount: 0.67,
        organizationId: ORG_ID,
        description: "Container hosting: test",
        idempotencyKey: key,
      });

      expect(first.success).toBe(true);
      expect(second.success).toBe(true);
      // Idempotent: same ledger entry, balance debited only once.
      expect(second.ledgerEntryId).toBe(first.ledgerEntryId);
      expect(Number(first.newBalance)).toBeCloseTo(99.33, 4);
      expect(Number(second.newBalance)).toBeCloseTo(99.33, 4);

      const ledger = await dbWrite.execute(
        `SELECT count(*)::int AS n FROM redeemable_earnings_ledger WHERE entry_type = 'credit_conversion';`,
      );
      const earnings = await dbWrite.execute(
        `SELECT available_balance FROM redeemable_earnings WHERE user_id = '${USER_ID}';`,
      );
      expect((ledger.rows[0] as { n: number }).n).toBe(1);
      expect(
        Number((earnings.rows[0] as { available_balance: string }).available_balance),
      ).toBeCloseTo(99.33, 4);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "a different key (next period) debits again",
    async () => {
      if (!pgliteReady) return;
      const next = await redeemableEarningsService.convertToCredits({
        userId: USER_ID,
        amount: 0.67,
        organizationId: ORG_ID,
        description: "Container hosting: test",
        idempotencyKey: "container:c3:2026-06-06T00:00:00.000Z",
      });
      expect(next.success).toBe(true);
      expect(Number(next.newBalance)).toBeCloseTo(98.66, 4);

      const ledger = await dbWrite.execute(
        `SELECT count(*)::int AS n FROM redeemable_earnings_ledger WHERE entry_type = 'credit_conversion';`,
      );
      expect((ledger.rows[0] as { n: number }).n).toBe(2);
    },
    PGLITE_TIMEOUT,
  );
});

describe("container billing gate + row-lock guard", () => {
  test(
    "gates by next_billing_at, records -fromCredits, and is idempotent on re-run",
    async () => {
      if (!pgliteReady) return;
      await dbWrite.execute(`DELETE FROM container_billing_records;`);
      await dbWrite.execute(`DELETE FROM credit_transactions;`);
      await dbWrite.execute(`DELETE FROM containers;`);
      await dbWrite.execute(`DELETE FROM organizations;`);
      await dbWrite.execute(
        `INSERT INTO organizations (id, credit_balance) VALUES ('${ORG_ID}', '50');`,
      );
      await dbWrite.execute(
        `INSERT INTO containers (id, name, project_name, organization_id, user_id, status, billing_status, total_billed)
         VALUES ('${CONTAINER_ID}', 'web', 'proj', '${ORG_ID}', '${USER_ID}', 'running', 'active', '0');`,
      );

      const now = new Date("2026-06-05T14:30:00.000Z");
      const { periodStart, periodEnd } = computeContainerBillingPeriod(now);

      // Never billed (next_billing_at null) → due.
      const dueBefore = await containerBillingRepository.listBillableContainers(now);
      expect(dueBefore.map((c) => c.id)).toContain(CONTAINER_ID);

      const billInput = {
        containerId: CONTAINER_ID,
        organizationId: ORG_ID,
        userId: USER_ID,
        containerName: "web",
        currentTotalBilled: "0",
        dailyCost: 0.67,
        newBalance: 49.33,
        fromEarnings: 0,
        fromCredits: 0.67,
        now,
        billingPeriodStart: periodStart,
        billingPeriodEnd: periodEnd,
      };

      const firstBill = await containerBillingRepository.recordSuccessfulDailyBilling(billInput);
      expect(firstBill.alreadyBilled).toBe(false);

      // credit_transaction is the credit-balance movement only (-fromCredits).
      const tx = await dbWrite.execute(
        `SELECT amount FROM credit_transactions WHERE organization_id = '${ORG_ID}';`,
      );
      expect(tx.rows.length).toBe(1);
      expect(Number((tx.rows[0] as { amount: string }).amount)).toBeCloseTo(-0.67, 6);

      // Now gated out — next_billing_at advanced to the period end.
      const dueAfter = await containerBillingRepository.listBillableContainers(now);
      expect(dueAfter.map((c) => c.id)).not.toContain(CONTAINER_ID);

      // Re-run for the same period: row-lock guard no-ops, no second debit.
      const secondBill = await containerBillingRepository.recordSuccessfulDailyBilling(billInput);
      expect(secondBill.alreadyBilled).toBe(true);
      expect(secondBill.transactionId).toBeNull();

      const txAfter = await dbWrite.execute(
        `SELECT count(*)::int AS n FROM credit_transactions WHERE organization_id = '${ORG_ID}';`,
      );
      const recAfter = await dbWrite.execute(
        `SELECT count(*)::int AS n FROM container_billing_records WHERE container_id = '${CONTAINER_ID}' AND status = 'success';`,
      );
      expect((txAfter.rows[0] as { n: number }).n).toBe(1);
      expect((recAfter.rows[0] as { n: number }).n).toBe(1);
    },
    PGLITE_TIMEOUT,
  );
});
