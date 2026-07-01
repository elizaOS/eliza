/**
 * CreditsService.reconcile() — real PGlite-backed settlement coverage.
 *
 * `reconcile()` is the money-settlement seam that runs after every metered
 * request: it compares the reserved estimate against the actual cost and either
 * refunds the excess, charges the overage, reports an uncollected overage, or
 * no-ops within EPSILON. These cases run the REAL method against an in-process
 * PGlite DB so the real refundCredits / deductCredits SQL (the FOR UPDATE
 * row-lock, the atomic credit_balance movement, and the credit_transactions
 * insert) actually executes; balances are read back from the DB and asserted to
 * the cent. They self-skip if PGlite is unavailable.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";

const PGLITE_TIMEOUT = 60000;

const ORG_ID = "00000000-0000-0000-0000-0000000000d4";
const USER_ID = "00000000-0000-0000-0000-0000000000e5";

let dbWrite: typeof import("../../../db/client").dbWrite;
let closeDb: typeof import("../../../db/client").closeDatabaseConnectionsForTests | undefined;
let creditsService: typeof import("../credits").creditsService;
let pgliteReady = true;

async function getBalance(): Promise<number> {
  const res = await dbWrite.execute(
    `SELECT credit_balance FROM organizations WHERE id = '${ORG_ID}';`,
  );
  return Number((res.rows[0] as { credit_balance: string }).credit_balance);
}

async function seedOrg(balance: string): Promise<void> {
  await dbWrite.execute(`DELETE FROM credit_transactions WHERE organization_id = '${ORG_ID}';`);
  await dbWrite.execute(`DELETE FROM organizations WHERE id = '${ORG_ID}';`);
  await dbWrite.execute(
    `INSERT INTO organizations (id, credit_balance) VALUES ('${ORG_ID}', '${balance}');`,
  );
}

async function countTransactions(): Promise<number> {
  const res = await dbWrite.execute(
    `SELECT count(*)::int AS n FROM credit_transactions WHERE organization_id = '${ORG_ID}';`,
  );
  return (res.rows[0] as { n: number }).n;
}

async function countByType(type: string): Promise<number> {
  const res = await dbWrite.execute(
    `SELECT count(*)::int AS n FROM credit_transactions WHERE organization_id = '${ORG_ID}' AND type = '${type}';`,
  );
  return (res.rows[0] as { n: number }).n;
}

beforeAll(async () => {
  try {
    ({ closeDatabaseConnectionsForTests: closeDb, dbWrite } = await import("../../../db/client"));
    ({ creditsService } = await import("../credits"));

    // organizations carries the full column set that the real reconcile path
    // reads: the core debit/refund SQL only touches credit_balance, but the
    // fire-and-forget hooks (invalidateOrganizationCache, checkAndTriggerAutoTopUp,
    // queueLowCreditsEmail) run `organizationsRepository.findById`, which SELECTs
    // every column. A minimal 3-column table makes those background queries throw
    // `column "name" does not exist`, which the real code surfaces. So we mirror
    // the columns findById needs (with defaults, so seeds still set only id +
    // credit_balance). credit_transactions DDL is verbatim from
    // container-billing-idempotency.test.ts.
    const ddl = [
      `CREATE TABLE IF NOT EXISTS organizations (
        id uuid PRIMARY KEY,
        name text NOT NULL DEFAULT 'test-org',
        slug text NOT NULL DEFAULT 'test-org',
        credit_balance numeric(20,6) NOT NULL DEFAULT '0',
        settings jsonb DEFAULT '{}',
        stripe_customer_id text,
        billing_email text,
        stripe_payment_method_id text,
        stripe_default_payment_method text,
        auto_top_up_enabled boolean DEFAULT false,
        auto_top_up_threshold numeric(12,6),
        auto_top_up_amount numeric(12,6),
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
        created_at timestamp NOT NULL DEFAULT now()
      )`,
      // applyCreditIncrease (the refund path) uses
      // `ON CONFLICT (stripe_payment_intent_id) DO NOTHING`, which requires this
      // unique index to exist (migration 0000). Multiple NULLs are distinct in a
      // standard unique index, so non-stripe refund/reservation rows don't collide.
      `CREATE UNIQUE INDEX IF NOT EXISTS credit_transactions_stripe_payment_intent_idx
        ON credit_transactions (stripe_payment_intent_id)`,
    ];
    for (const stmt of ddl) {
      await dbWrite.execute(stmt);
    }
  } catch (error) {
    pgliteReady = false;
    console.warn("[credits-reconcile] PGlite unavailable, skipping DB cases:", error);
  }
}, PGLITE_TIMEOUT);

afterAll(async () => {
  if (closeDb) await closeDb();
});

describe("CreditsService.reconcile", () => {
  beforeEach(async () => {
    if (!pgliteReady) return;
    // Fresh org per test so balances/transactions never bleed across cases.
    await seedOrg("10");
  });

  test(
    "refund branch: reserved > actual increases balance by the difference",
    async () => {
      if (!pgliteReady) return;

      const result = await creditsService.reconcile({
        organizationId: ORG_ID,
        reservedAmount: 1.0,
        actualCost: 0.4,
        description: "reconcile refund case",
        metadata: { user_id: USER_ID },
      });

      expect(result.adjustmentType).toBe("refund");
      expect(result.settlementTransactionIds.length).toBe(1);

      // 10.0 + (1.0 - 0.4) = 10.60, read back from the DB.
      expect(await getBalance()).toBeCloseTo(10.6, 6);

      // Exactly one refund row, whose id is the returned settlement id.
      expect(await countByType("refund")).toBe(1);
      expect(await countTransactions()).toBe(1);
      const refundRow = await dbWrite.execute(
        `SELECT id, amount FROM credit_transactions WHERE organization_id = '${ORG_ID}' AND type = 'refund';`,
      );
      expect(Number((refundRow.rows[0] as { amount: string }).amount)).toBeCloseTo(0.6, 6);
      expect((refundRow.rows[0] as { id: string }).id).toBe(result.settlementTransactionIds[0]);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "overage branch (collectable): actual > reserved decreases balance by the overage",
    async () => {
      if (!pgliteReady) return;

      const result = await creditsService.reconcile({
        organizationId: ORG_ID,
        reservedAmount: 0.4,
        actualCost: 1.0,
        description: "reconcile overage case",
        metadata: { user_id: USER_ID },
      });

      expect(result.adjustmentType).toBe("overage");
      expect(result.settlementTransactionIds.length).toBe(1);

      // 10.0 - (1.0 - 0.4) = 9.40, read back from the DB.
      expect(await getBalance()).toBeCloseTo(9.4, 6);

      // A debit row of -0.6 was written; its id is the returned settlement id.
      expect(await countByType("debit")).toBe(1);
      expect(await countTransactions()).toBe(1);
      const debitRow = await dbWrite.execute(
        `SELECT id, amount FROM credit_transactions WHERE organization_id = '${ORG_ID}' AND type = 'debit';`,
      );
      expect(Number((debitRow.rows[0] as { amount: string }).amount)).toBeCloseTo(-0.6, 6);
      expect((debitRow.rows[0] as { id: string }).id).toBe(result.settlementTransactionIds[0]);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "epsilon/none branch: exact match is a no-op",
    async () => {
      if (!pgliteReady) return;

      const before = await getBalance();
      const result = await creditsService.reconcile({
        organizationId: ORG_ID,
        reservedAmount: 1.0,
        actualCost: 1.0,
        description: "reconcile none case",
        metadata: { user_id: USER_ID },
      });

      expect(result.adjustmentType).toBe("none");
      expect(result.settlementTransactionIds).toEqual([]);

      // No DB change at all: balance unchanged and no transaction written.
      expect(await getBalance()).toBeCloseTo(before, 6);
      expect(await countTransactions()).toBe(0);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "epsilon/none branch: a nonzero sub-EPSILON difference is a no-op (PINS the EPSILON tolerance band)",
    async () => {
      if (!pgliteReady) return;

      // A real (tiny) difference that is below EPSILON (1e-7): diff = -5e-8.
      // This is the discriminating case for the EPSILON guard — with the guard
      // intact it returns "none" and writes nothing. If the EPSILON check is
      // broken so this difference is NOT absorbed, reconcile instead falls to the
      // overage branch and (because the overage is a positive amount the org can
      // pay) actually charges a debit — flipping adjustmentType to "overage" and
      // writing a transaction. So this case GOES RED if the EPSILON band is broken,
      // unlike the exact-match case above (which the retry-fallback masks).
      const before = await getBalance();
      const result = await creditsService.reconcile({
        organizationId: ORG_ID,
        reservedAmount: 1.0,
        actualCost: 1.00000005,
        description: "reconcile sub-epsilon case",
        metadata: { user_id: USER_ID },
      });

      expect(result.adjustmentType).toBe("none");
      expect(result.settlementTransactionIds).toEqual([]);
      expect(await getBalance()).toBeCloseTo(before, 6);
      expect(await countTransactions()).toBe(0);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "overage uncollectable: balance below overage is reported explicitly and not charged",
    async () => {
      if (!pgliteReady) return;

      // Balance ($0.10) is BELOW the overage ($1.00). The atomic deduct refuses
      // to drive the balance negative and returns success:false WITHOUT throwing.
      await seedOrg("0.10");

      const result = await creditsService.reconcile({
        organizationId: ORG_ID,
        reservedAmount: 0.0,
        actualCost: 1.0,
        description: "reconcile uncollectable overage case",
        metadata: { user_id: USER_ID },
      });

      // Reconcile must not report a charged overage unless a debit transaction
      // was actually written.
      expect(result.adjustmentType).toBe("uncollected_overage");
      expect(result.settlementTransactionIds).toEqual([]);

      // The balance is NOT driven negative; no debit row was written.
      const balance = await getBalance();
      expect(balance).toBeGreaterThanOrEqual(0);
      expect(balance).toBeCloseTo(0.1, 6);
      expect(await countByType("debit")).toBe(0);
      expect(await countTransactions()).toBe(0);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "refund branch: actualCost 0 refunds the ENTIRE reservation (request-failure path)",
    async () => {
      if (!pgliteReady) return;

      // The live request-failure path settles a reservation against actualCost 0
      // (reservation.reconcile(0)): the request was reserved but produced no
      // billable cost, so the FULL reserved amount must come back. difference =
      // reservedAmount - 0 = reservedAmount, which is positive and well above
      // EPSILON, so this drives the difference > 0 refund branch with the maximum
      // possible refund. The existing refund test only exercises a partial refund
      // (actualCost 0.4), so this pins the full-refund edge the failure path hits.
      const result = await creditsService.reconcile({
        organizationId: ORG_ID,
        reservedAmount: 1.0,
        actualCost: 0,
        description: "reconcile full-refund case",
        metadata: { user_id: USER_ID },
      });

      expect(result.adjustmentType).toBe("refund");
      expect(result.settlementTransactionIds.length).toBe(1);

      // The entire reservation comes back: 10.0 + (1.0 - 0) = 11.00.
      expect(await getBalance()).toBeCloseTo(11.0, 6);

      // Exactly one refund row, for the FULL reserved amount, and its id is the
      // returned settlement id.
      expect(await countByType("refund")).toBe(1);
      expect(await countTransactions()).toBe(1);
      const refundRow = await dbWrite.execute(
        `SELECT id, amount FROM credit_transactions WHERE organization_id = '${ORG_ID}' AND type = 'refund';`,
      );
      expect(Number((refundRow.rows[0] as { amount: string }).amount)).toBeCloseTo(1.0, 6);
      expect((refundRow.rows[0] as { id: string }).id).toBe(result.settlementTransactionIds[0]);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "overage retry/catch fallback: deductCredits that always THROWS exhausts all retries and reports an uncollected overage without a debit",
    async () => {
      if (!pgliteReady) return;

      // Distinct from the uncollectable case above: there, deductCredits returns
      // success:false (a clean refusal). Here we force the THROW path — every
      // deductCredits attempt raises — so reconcile exhausts all 3 retries and
      // hits the terminal catch fallback. For an overage (difference < 0) that
      // fallback must report "uncollected_overage" and, critically, write NO
      // debit row (no money silently lost or double-charged). This is the only
      // case that drives reconcile()'s catch arm; no existing test forces
      // deductCredits to throw.
      const original = creditsService.deductCredits;
      let attempts = 0;
      creditsService.deductCredits = async () => {
        attempts += 1;
        throw new Error("simulated transient deduct failure");
      };

      try {
        const result = await creditsService.reconcile({
          organizationId: ORG_ID,
          reservedAmount: 0.4,
          actualCost: 1.0,
          description: "reconcile throwing-overage case",
          metadata: { user_id: USER_ID },
        });

        // All 3 attempts ran (MAX_RETRIES) and then the terminal fallback fired.
        expect(attempts).toBe(3);
        expect(result.adjustmentType).toBe("uncollected_overage");
        expect(result.settlementTransactionIds).toEqual([]);
      } finally {
        // Restore so the throwing override never bleeds into other tests.
        creditsService.deductCredits = original;
      }

      // The fallback wrote nothing: balance untouched at the seeded 10.0 and no
      // debit row exists.
      expect(await getBalance()).toBeCloseTo(10.0, 6);
      expect(await countByType("debit")).toBe(0);
      expect(await countTransactions()).toBe(0);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "NON-IDEMPOTENT double-settle hazard: settling then a second reconcile(0) refunds AGAIN (the free-generation bug #10278's chargeSettled guard prevents)",
    async () => {
      if (!pgliteReady) return;

      // reconcile() is a pure function of (reservedAmount - actualCost); it has NO
      // settled-guard of its own. The metered media routes (generate-video /
      // generate-music / generate-image) reserve the full amount up front, then on
      // success call reconcile(actualCost) to settle. If a *post-settle*, non-critical
      // step then throws (e.g. generationsService.create), the route's catch arm used
      // to call reconcile(0) — refunding the FULL reservation a SECOND time and handing
      // the user a free generation. This test pins that hazard at the money layer so the
      // route-level `if (reservation && !chargeSettled)` guard can never be silently
      // removed without a red test.

      // 1) Settle: reserved 1.0, actual 0.4 -> refund the 0.6 over-reservation.
      const settle = await creditsService.reconcile({
        organizationId: ORG_ID,
        reservedAmount: 1.0,
        actualCost: 0.4,
        description: "media settle (charge committed)",
        metadata: { user_id: USER_ID },
      });
      expect(settle.adjustmentType).toBe("refund");
      expect(await getBalance()).toBeCloseTo(10.6, 6);

      // 2) The OLD post-settle catch path: reconcile(0) on the same reservation.
      //    Because reconcile is non-idempotent, this refunds the ENTIRE 1.0 again.
      const doubleRefund = await creditsService.reconcile({
        organizationId: ORG_ID,
        reservedAmount: 1.0,
        actualCost: 0,
        description: "media post-settle error -> erroneous second refund",
        metadata: { user_id: USER_ID },
      });
      expect(doubleRefund.adjustmentType).toBe("refund");

      // The damage: balance is 10.0 + 0.6 + 1.0 = 11.60 (1.0 of free credit on a
      // request that only over-reserved by 0.6), and TWO refund rows exist. This is
      // exactly what skipping reconcile(0) once chargeSettled is true prevents.
      expect(await getBalance()).toBeCloseTo(11.6, 6);
      expect(await countByType("refund")).toBe(2);
    },
    PGLITE_TIMEOUT,
  );
});

/**
 * #10846 finding 2: the reconcile retry loop double-applied the refund/overage
 * on a commit-then-ack-loss because neither branch carried a dedupe key. The fix
 * derives a stable `recon:<reservation_transaction_id>:<phase>` key and threads
 * it into refundCredits / deductCredits, so a re-run of an already-settled
 * reconcile is a no-op. Re-invoking reconcile with the same reservation id is the
 * observable equivalent of the retry (the key is what protects the retry).
 */
describe("CreditsService.reconcile idempotency (#10846)", () => {
  const RES_ID = "00000000-0000-0000-0000-0000000000f6";

  test(
    "a re-run refund with the same reservation id does NOT double-credit",
    async () => {
      if (!pgliteReady) return;
      await seedOrg("10");
      const args = {
        organizationId: ORG_ID,
        reservedAmount: 1.0,
        actualCost: 0.4,
        description: "reconcile refund idempotent",
        metadata: { user_id: USER_ID, reservation_transaction_id: RES_ID },
      };

      const first = await creditsService.reconcile(args);
      const second = await creditsService.reconcile(args);

      // Refund applied exactly once: balance = 10 + 0.6, one refund row.
      expect(await getBalance()).toBeCloseTo(10.6, 6);
      expect(await countByType("refund")).toBe(1);
      expect(await countTransactions()).toBe(1);
      // Both invocations report the SAME settlement transaction.
      expect(second.settlementTransactionIds).toEqual(first.settlementTransactionIds);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "a re-run overage with the same reservation id does NOT double-charge",
    async () => {
      if (!pgliteReady) return;
      await seedOrg("20");
      const args = {
        organizationId: ORG_ID,
        reservedAmount: 0.4,
        actualCost: 1.0,
        description: "reconcile overage idempotent",
        metadata: { user_id: USER_ID, reservation_transaction_id: RES_ID },
      };

      const first = await creditsService.reconcile(args);
      const second = await creditsService.reconcile(args);

      // Overage charged exactly once: balance = 20 - 0.6, one debit row.
      expect(await getBalance()).toBeCloseTo(19.4, 6);
      expect(await countByType("debit")).toBe(1);
      expect(await countTransactions()).toBe(1);
      expect(second.settlementTransactionIds).toEqual(first.settlementTransactionIds);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "without a reservation id the fix is opt-in — behavior is unchanged (still double-applies)",
    async () => {
      if (!pgliteReady) return;
      await seedOrg("10");
      // No reservation_transaction_id ⇒ no dedupe key ⇒ prior non-idempotent
      // behavior is preserved (this documents that the fix does NOT silently
      // change any existing caller that lacks a reservation id).
      const args = {
        organizationId: ORG_ID,
        reservedAmount: 1.0,
        actualCost: 0.4,
        description: "reconcile refund no-key",
        metadata: { user_id: USER_ID },
      };

      await creditsService.reconcile(args);
      await creditsService.reconcile(args);

      expect(await getBalance()).toBeCloseTo(11.2, 6);
      expect(await countByType("refund")).toBe(2);
    },
    PGLITE_TIMEOUT,
  );
});
