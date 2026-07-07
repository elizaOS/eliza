/**
 * Real-DB coverage for the atomic credit-deduct + insufficient-credits guard.
 *
 * The credit-deduction SQL in `credits.ts` is the gate that protects real money:
 * `reserveAndDeductCredits` is the single atomic `FOR UPDATE` mutation that every
 * inference/reservation/overage charge funnels through, and its WHERE clause
 * (`current_balance >= amount`) is the insufficient-credits guard. Until now that
 * SQL ran in ZERO tests — every billing suite mocked the mutation seam, so a
 * regression (a flipped comparison, a dropped guard, a wrong sign on the debit
 * row) would have shipped green.
 *
 * This suite runs the REAL `CreditsService` SQL against in-process PGlite, the
 * same honest pattern as `container-billing-idempotency.test.ts`. It seeds a real
 * `organizations` row + `credit_transactions` table and asserts the observable
 * effects on the DB, so each test FAILS if the real logic regresses. The only
 * things stubbed are the fire-and-forget, non-billing side-effects on the success
 * path (email/webhook/auto-top-up) — never the deduct/guard arithmetic itself.
 *
 * Fails loudly (via the `pgliteReady` guard) if PGlite/pushSchema ever fails to initialize — never a silent skip.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
// Force the cache client onto its in-memory backend so the awaited
// `CacheInvalidation.onCreditMutation` on the success path never reaches a real
// Redis (deterministic + offline).
process.env.MOCK_REDIS ||= "1";

// Stub the non-billing fire-and-forget side-effects the success path kicks off.
// These are NOT the code under test — they are downstream notifications. Leaving
// them real would make the test depend on email/webhook/auto-top-up infra. The
// deduct + guard SQL in credits.ts runs entirely real against PGlite below.
mock.module("../email", () => ({
  emailService: {
    sendLowCreditsEmail: mock(async () => false),
  },
}));
mock.module("../waifu-webhook", () => ({
  resolveWaifuWebhookTarget: mock(() => null),
  classifyCreditBalance: mock(() => null),
  emitWaifuCreditWebhook: mock(async () => undefined),
}));
mock.module("../auto-top-up", () => ({
  autoTopUpService: {
    executeAutoTopUp: mock(async () => undefined),
  },
}));

const PGLITE_TIMEOUT = 60000;

const ORG_ID = "00000000-0000-0000-0000-0000000000d1";
const USER_ID = "00000000-0000-0000-0000-0000000000d2";

let dbWrite: typeof import("../../../db/client").dbWrite;
let closeDb: typeof import("../../../db/client").closeDatabaseConnectionsForTests | undefined;
let creditsService: typeof import("../credits").creditsService;
let InsufficientCreditsError: typeof import("../credits").InsufficientCreditsError;
let pgliteReady = true;

async function seedOrg(balance: string): Promise<void> {
  await dbWrite.execute(`DELETE FROM credit_transactions;`);
  await dbWrite.execute(`DELETE FROM organizations;`);
  await dbWrite.execute(
    `INSERT INTO organizations (id, name, slug, credit_balance, pay_as_you_go_from_earnings, is_active)
     VALUES ('${ORG_ID}', 'Acme', 'acme-${ORG_ID}', '${balance}', true, true);`,
  );
}

async function readBalance(): Promise<number> {
  const rows = await dbWrite.execute(
    `SELECT credit_balance FROM organizations WHERE id = '${ORG_ID}';`,
  );
  return Number((rows.rows[0] as { credit_balance: string }).credit_balance);
}

async function listDebits(): Promise<{ amount: number; type: string }[]> {
  const rows = await dbWrite.execute(
    `SELECT amount, type FROM credit_transactions WHERE organization_id = '${ORG_ID}' ORDER BY created_at ASC;`,
  );
  return (rows.rows as { amount: string; type: string }[]).map((r) => ({
    amount: Number(r.amount),
    type: r.type,
  }));
}

beforeAll(async () => {
  try {
    ({ closeDatabaseConnectionsForTests: closeDb, dbWrite } = await import("../../../db/client"));
    ({ creditsService, InsufficientCreditsError } = await import("../credits"));

    // The columns the real credit-deduct SQL + the auto-top-up findById
    // relational read touch. Full organizations shape so the success-path
    // `organizationsRepository.findById` (auto-top-up check) returns cleanly.
    const ddl = [
      `CREATE TABLE IF NOT EXISTS organizations (
        id uuid PRIMARY KEY,
        name text NOT NULL,
        slug text NOT NULL,
        credit_balance numeric(12,6) NOT NULL DEFAULT '0',
        settings jsonb DEFAULT '{}',
        stripe_customer_id text,
        billing_email text,
        stripe_payment_method_id text,
        stripe_default_payment_method text,
        auto_top_up_enabled boolean DEFAULT false,
        auto_top_up_threshold numeric(10,2),
        auto_top_up_amount numeric(10,2),
        pay_as_you_go_from_earnings boolean NOT NULL DEFAULT true,
        steward_tenant_id text,
        steward_tenant_api_key text,
        is_active boolean NOT NULL DEFAULT true,
        created_at timestamp NOT NULL DEFAULT now(),
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
        created_at timestamp NOT NULL DEFAULT now(),
        settled_at timestamp
      )`,
      // The refund/credit path's `applyCreditIncrease` uses
      // `ON CONFLICT (stripe_payment_intent_id) DO NOTHING`, which requires this
      // unique index to exist (mirrors the real schema's
      // `credit_transactions_stripe_payment_intent_idx`). Multiple NULLs are
      // allowed by a standard UNIQUE index, so debit rows are unaffected.
      `CREATE UNIQUE INDEX IF NOT EXISTS credit_transactions_stripe_payment_intent_idx
        ON credit_transactions (stripe_payment_intent_id)`,
    ];
    for (const stmt of ddl) {
      await dbWrite.execute(stmt);
    }
  } catch (error) {
    pgliteReady = false;
    console.warn("[credits-deduct-guard] PGlite unavailable, skipping DB cases:", error);
  }
}, PGLITE_TIMEOUT);

afterAll(async () => {
  if (closeDb) await closeDb();
});

describe("reserveAndDeductCredits — atomic debit", () => {
  beforeEach(async () => {
    if (!pgliteReady) return;
    await seedOrg("10.000000");
  });

  test(
    "(a) a sufficient debit moves the balance by exactly -amount and writes ONE matching debit row",
    async () => {
      if (!pgliteReady) return;

      const result = await creditsService.reserveAndDeductCredits({
        organizationId: ORG_ID,
        amount: 3.25,
        description: "inference charge",
        metadata: { user_id: USER_ID },
      });

      expect(result.success).toBe(true);
      expect(result.reason).toBeUndefined();
      // Balance moved by exactly -amount.
      expect(result.newBalance).toBeCloseTo(6.75, 6);
      expect(await readBalance()).toBeCloseTo(6.75, 6);

      // Exactly one debit row, recorded as -amount (negative), typed "debit".
      const debits = await listDebits();
      expect(debits).toHaveLength(1);
      expect(debits[0].type).toBe("debit");
      expect(debits[0].amount).toBeCloseTo(-3.25, 6);

      // The returned transaction mirrors the persisted row.
      expect(result.transaction).not.toBeNull();
      expect(Number(result.transaction?.amount)).toBeCloseTo(-3.25, 6);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "(b) amount > balance fails CLOSED: success:false, reason:insufficient_balance, balance + ledger untouched",
    async () => {
      if (!pgliteReady) return;

      const result = await creditsService.reserveAndDeductCredits({
        organizationId: ORG_ID,
        amount: 10.000001, // one micro-dollar over the $10 balance
        description: "over-budget charge",
        metadata: { user_id: USER_ID },
      });

      expect(result.success).toBe(false);
      expect(result.reason).toBe("insufficient_balance");
      expect(result.transaction).toBeNull();
      // The guard returns the live (unchanged) balance.
      expect(result.newBalance).toBeCloseTo(10, 6);

      // The guard fails CLOSED — no money moved, no debit row written.
      expect(await readBalance()).toBeCloseTo(10, 6);
      expect(await listDebits()).toHaveLength(0);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "(b2) a debit for exactly the full balance succeeds and lands at zero (boundary of the >= guard)",
    async () => {
      if (!pgliteReady) return;

      const result = await creditsService.reserveAndDeductCredits({
        organizationId: ORG_ID,
        amount: 10,
        description: "drain to zero",
        metadata: { user_id: USER_ID },
      });

      expect(result.success).toBe(true);
      expect(result.newBalance).toBeCloseTo(0, 6);
      expect(await readBalance()).toBeCloseTo(0, 6);
      const debits = await listDebits();
      expect(debits).toHaveLength(1);
      expect(debits[0].amount).toBeCloseTo(-10, 6);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "an unknown organization fails with reason:org_not_found and writes nothing",
    async () => {
      if (!pgliteReady) return;

      const result = await creditsService.reserveAndDeductCredits({
        organizationId: "00000000-0000-0000-0000-0000deadbeef",
        amount: 1,
        description: "ghost org",
      });

      expect(result.success).toBe(false);
      expect(result.reason).toBe("org_not_found");
      // The seeded org is untouched.
      expect(await readBalance()).toBeCloseTo(10, 6);
      expect(await listDebits()).toHaveLength(0);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "(concurrency #10857) N concurrent debits on a limited balance NEVER overspend — only affordable ones win, balance never goes negative",
    async () => {
      if (!pgliteReady) return;
      // $1.00 balance, 8 concurrent $0.30 charges — only 3 can fit ($0.90).
      // This is the exact race the monetized-app /v1/messages path hit with the
      // old read-only checkBalance: all 8 passed the read → served → overspend,
      // platform absorbing the loss (#10857). The atomic reserveAndDeductCredits
      // it now uses (via reserveInferenceCredits) must serialize on the row and
      // reject the surplus.
      await seedOrg("1.000000");
      const AMOUNT = 0.3;
      const N = 8;

      const results = await Promise.all(
        Array.from({ length: N }, (_, i) =>
          creditsService.reserveAndDeductCredits({
            organizationId: ORG_ID,
            amount: AMOUNT,
            description: `concurrent charge ${i}`,
            metadata: { user_id: USER_ID },
          }),
        ),
      );

      const succeeded = results.filter((r) => r.success);
      const failed = results.filter((r) => !r.success);

      // Exactly floor(1.00 / 0.30) = 3 win; the surplus fail CLOSED.
      expect(succeeded).toHaveLength(3);
      expect(failed).toHaveLength(N - 3);
      for (const f of failed) {
        expect(f.reason).toBe("insufficient_balance");
      }

      // The load-bearing invariant: balance NEVER went negative, and it equals
      // exactly the 3 affordable debits — no overspend, no platform-absorbed loss.
      const finalBalance = await readBalance();
      expect(finalBalance).toBeGreaterThanOrEqual(0);
      expect(finalBalance).toBeCloseTo(1.0 - 3 * AMOUNT, 6);

      // One debit row per successful charge — no phantom or duplicate debits.
      expect(await listDebits()).toHaveLength(3);
    },
    PGLITE_TIMEOUT,
  );
});

describe("reserve() — high-level reservation gate", () => {
  beforeEach(async () => {
    if (!pgliteReady) return;
    await seedOrg("2.000000");
  });

  test(
    "(c) reserve() throws InsufficientCreditsError when the reservation exceeds the balance (no debit)",
    async () => {
      if (!pgliteReady) return;

      let thrown: unknown;
      try {
        await creditsService.reserve({
          organizationId: ORG_ID,
          userId: USER_ID,
          description: "expensive job",
          amount: 5, // > $2 balance
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(InsufficientCreditsError);
      const err = thrown as InstanceType<typeof InsufficientCreditsError>;
      expect(err.required).toBeCloseTo(5, 6);
      expect(err.available).toBeCloseTo(2, 6);
      expect(err.reason).toBe("insufficient_balance");

      // Nothing was reserved/debited — the balance is intact.
      expect(await readBalance()).toBeCloseTo(2, 6);
      expect(await listDebits()).toHaveLength(0);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "reserve() succeeds within budget, debiting the reserved amount once",
    async () => {
      if (!pgliteReady) return;

      const reservation = await creditsService.reserve({
        organizationId: ORG_ID,
        userId: USER_ID,
        description: "in-budget job",
        amount: 1.5,
      });

      expect(reservation.reservedAmount).toBeCloseTo(1.5, 6);
      expect(reservation.reservationTransactionId).toBeTruthy();
      expect(await readBalance()).toBeCloseTo(0.5, 6);

      const debits = await listDebits();
      expect(debits).toHaveLength(1);
      expect(debits[0].amount).toBeCloseTo(-1.5, 6);
    },
    PGLITE_TIMEOUT,
  );
});

describe("reconcile() — settle reserved vs actual", () => {
  beforeEach(async () => {
    if (!pgliteReady) return;
    await seedOrg("20.000000");
  });

  test(
    "(d) actual < reserved → refunds the difference (credit_balance goes UP by the refund)",
    async () => {
      if (!pgliteReady) return;

      // Reserve $5 (balance 20 -> 15).
      const reservation = await creditsService.reserve({
        organizationId: ORG_ID,
        userId: USER_ID,
        description: "job",
        amount: 5,
      });
      expect(await readBalance()).toBeCloseTo(15, 6);

      // Actual cost was only $2 → refund $3 (balance 15 -> 18).
      const result = await reservation.reconcile(2);

      expect(result.adjustmentType).toBe("refund");
      expect(result.reservedAmount).toBeCloseTo(5, 6);
      expect(result.actualCost).toBeCloseTo(2, 6);
      expect(result.settlementTransactionIds).toHaveLength(1);
      expect(await readBalance()).toBeCloseTo(18, 6);

      // A refund (+3) ledger row exists alongside the original reservation debit.
      const txns = await listDebits();
      const refundRow = txns.find((t) => t.type === "refund");
      expect(refundRow).toBeDefined();
      expect(refundRow?.amount).toBeCloseTo(3, 6);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "(d) actual > reserved → charges the overage (credit_balance goes DOWN by the overage)",
    async () => {
      if (!pgliteReady) return;

      // Reserve $5 (balance 20 -> 15).
      const reservation = await creditsService.reserve({
        organizationId: ORG_ID,
        userId: USER_ID,
        description: "job",
        amount: 5,
      });
      expect(await readBalance()).toBeCloseTo(15, 6);

      // Actual cost was $8 → charge $3 overage (balance 15 -> 12).
      const result = await reservation.reconcile(8);

      expect(result.adjustmentType).toBe("overage");
      expect(result.reservedAmount).toBeCloseTo(5, 6);
      expect(result.actualCost).toBeCloseTo(8, 6);
      expect(result.settlementTransactionIds).toHaveLength(1);
      expect(await readBalance()).toBeCloseTo(12, 6);

      // Two debit rows now: the $5 reservation + the $3 overage.
      const debits = (await listDebits()).filter((t) => t.type === "debit");
      expect(debits).toHaveLength(2);
      expect(debits.some((d) => Math.abs(d.amount - -3) < 1e-6)).toBe(true);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "actual == reserved (within epsilon) → no-op, balance unchanged, no settlement rows",
    async () => {
      if (!pgliteReady) return;

      const reservation = await creditsService.reserve({
        organizationId: ORG_ID,
        userId: USER_ID,
        description: "job",
        amount: 4,
      });
      expect(await readBalance()).toBeCloseTo(16, 6);

      const result = await reservation.reconcile(4);

      expect(result.adjustmentType).toBe("none");
      expect(result.settlementTransactionIds).toHaveLength(0);
      // Only the original reservation debit moved the balance.
      expect(await readBalance()).toBeCloseTo(16, 6);
      expect(await listDebits()).toHaveLength(1);
    },
    PGLITE_TIMEOUT,
  );
});

// Loud guard: PGlite is in-process (no network), so `pgliteReady` must be true.
// If pushSchema/PGlite ever fails to init, the DB-dependent tests above
// early-return; this turns that silent no-op into a hard CI failure so a
// money-path proof can never masquerade as a vacuous green.
test("pglite schema applied — never a silent skip", () => {
  expect(pgliteReady).toBe(true);
});
