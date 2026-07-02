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
 * the cent. They fail loudly (via the `pgliteReady` guard) if PGlite/pushSchema ever fails to initialize — never a silent skip.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.CREDIT_COST_BUFFER = "1.5";

const PGLITE_TIMEOUT = 60000;
const RESERVATION_SETTLEMENT_MARKER = "credit_reservation_v1";
const APP_CHAT_RESERVATION_SETTLEMENT_MARKER = "app_chat_reservation_v1";

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

async function insertReservation(
  amount: number,
  ageMs = 0,
  markerAware = true,
  metadataOverrides: Record<string, unknown> = {},
): Promise<string> {
  const createdAt = new Date(Date.now() - ageMs).toISOString();
  const metadata = {
    user_id: USER_ID,
    type: "reservation",
    model: "test-model",
    ...(markerAware && { settlement_marker: RESERVATION_SETTLEMENT_MARKER }),
    ...metadataOverrides,
  };
  const res = await dbWrite.execute(
    `INSERT INTO credit_transactions (
      organization_id,
      user_id,
      amount,
      type,
      description,
      metadata,
      created_at
    ) VALUES (
      '${ORG_ID}',
      '${USER_ID}',
      '${String(-amount)}',
      'debit',
      'Chat completion: test-model (reserved)',
      '${JSON.stringify(metadata)}'::jsonb,
      '${createdAt}'::timestamp
    ) RETURNING id;`,
  );
  return (res.rows[0] as { id: string }).id;
}

async function insertAppChatReservation(
  amount: number,
  ageMs = 0,
  metadataOverrides: Record<string, unknown> = {},
): Promise<string> {
  const createdAt = new Date(Date.now() - ageMs).toISOString();
  const metadata = {
    appId: "app-chat-test",
    userId: USER_ID,
    type: "app_chat_reservation",
    settlement_marker: APP_CHAT_RESERVATION_SETTLEMENT_MARKER,
    model: "test-model",
    provider: "test-provider",
    billingSource: "test",
    safetyMultiplier: 1.5,
    estimated_cost: amount / 1.5,
    reserved_amount: amount,
    totalCost: amount,
    ...metadataOverrides,
  };
  const res = await dbWrite.execute(
    `INSERT INTO credit_transactions (
      organization_id,
      user_id,
      amount,
      type,
      description,
      metadata,
      created_at
    ) VALUES (
      '${ORG_ID}',
      '${USER_ID}',
      '${String(-amount)}',
      'debit',
      'Chat: test-model',
      '${JSON.stringify(metadata)}'::jsonb,
      '${createdAt}'::timestamp
    ) RETURNING id;`,
  );
  return (res.rows[0] as { id: string }).id;
}

async function getReservationSettledAt(id: string): Promise<string | null> {
  const res = await dbWrite.execute(
    `SELECT settled_at FROM credit_transactions WHERE id = '${id}';`,
  );
  return (res.rows[0] as { settled_at: string | null }).settled_at;
}

async function settlementRowsForReservation(
  id: string,
): Promise<Array<{ amount: string; type: string; stripe_payment_intent_id: string | null }>> {
  const res = await dbWrite.execute(
    `SELECT amount, type, stripe_payment_intent_id
     FROM credit_transactions
     WHERE metadata->>'reservation_transaction_id' = '${id}'
     ORDER BY created_at ASC;`,
  );
  return res.rows as Array<{
    amount: string;
    type: string;
    stripe_payment_intent_id: string | null;
  }>;
}

async function insertLegacySettlementForReservation(id: string, amount: number): Promise<string> {
  const res = await dbWrite.execute(
    `INSERT INTO credit_transactions (
      organization_id,
      user_id,
      amount,
      type,
      description,
      metadata,
      stripe_payment_intent_id,
      created_at
    ) VALUES (
      '${ORG_ID}',
      '${USER_ID}',
      '${String(amount)}',
      'refund',
      'legacy keyed reconciliation',
      '{"user_id":"${USER_ID}","reservation_transaction_id":"${id}","type":"reconciliation_refund"}'::jsonb,
      'recon:${id}:refund',
      NOW()
    ) RETURNING id;`,
  );
  return (res.rows[0] as { id: string }).id;
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
        credit_balance numeric(20,6) NOT NULL DEFAULT '0' CHECK (credit_balance >= 0),
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
        created_at timestamp NOT NULL DEFAULT now(),
        settled_at timestamp
      )`,
      // applyCreditIncrease (the refund path) uses
      // `ON CONFLICT (stripe_payment_intent_id) DO NOTHING`, which requires this
      // unique index to exist (migration 0000). Multiple NULLs are distinct in a
      // standard unique index, so non-stripe refund/reservation rows don't collide.
      `CREATE UNIQUE INDEX IF NOT EXISTS credit_transactions_stripe_payment_intent_idx
        ON credit_transactions (stripe_payment_intent_id)`,
      `CREATE INDEX IF NOT EXISTS credit_transactions_unsettled_reservations_idx
        ON credit_transactions (created_at)
        WHERE type = 'debit'
          AND (
            (
              metadata->>'type' = 'reservation'
              AND metadata->>'settlement_marker' = '${RESERVATION_SETTLEMENT_MARKER}'
            )
            OR (
              metadata->>'type' = 'app_chat_reservation'
              AND metadata->>'settlement_marker' = '${APP_CHAT_RESERVATION_SETTLEMENT_MARKER}'
            )
          )
          AND settled_at IS NULL`,
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
      // No reservation_transaction_id => no dedupe key => prior non-idempotent
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

describe("CreditsService reservation settlement marker (#11169)", () => {
  test(
    "real reservation rows are claimed and refunded once",
    async () => {
      if (!pgliteReady) return;
      await seedOrg("9");
      const reservationId = await insertReservation(1.0);

      const first = await creditsService.reconcile({
        organizationId: ORG_ID,
        reservedAmount: 1.0,
        actualCost: 0.4,
        description: "chat completion settle",
        metadata: { user_id: USER_ID, reservation_transaction_id: reservationId },
      });
      const second = await creditsService.reconcile({
        organizationId: ORG_ID,
        reservedAmount: 1.0,
        actualCost: 0,
        description: "late duplicate refund attempt",
        metadata: { user_id: USER_ID, reservation_transaction_id: reservationId },
      });

      expect(first.adjustmentType).toBe("refund");
      expect(second.adjustmentType).toBe("none");
      expect(await getBalance()).toBeCloseTo(9.6, 6);
      expect(await getReservationSettledAt(reservationId)).toBeTruthy();
      expect(await countByType("refund")).toBe(1);
      expect(await settlementRowsForReservation(reservationId)).toEqual([
        {
          amount: "0.600000",
          type: "refund",
          stripe_payment_intent_id: `recon:${reservationId}:refund`,
        },
      ]);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "reserve records the fixed settlement estimate on marker-aware reservation rows",
    async () => {
      if (!pgliteReady) return;
      await seedOrg("10");

      const reservation = await creditsService.reserve({
        organizationId: ORG_ID,
        userId: USER_ID,
        description: "fixed image generation",
        amount: 1.25,
      });

      const res = await dbWrite.execute(
        `SELECT amount, metadata FROM credit_transactions WHERE id = '${reservation.reservationTransactionId}';`,
      );
      const row = res.rows[0] as { amount: string; metadata: Record<string, unknown> | string };
      const metadata =
        typeof row.metadata === "string"
          ? (JSON.parse(row.metadata) as Record<string, unknown>)
          : row.metadata;

      expect(Number(row.amount)).toBeCloseTo(-1.25, 6);
      expect(metadata.type).toBe("reservation");
      expect(metadata.settlement_marker).toBe(RESERVATION_SETTLEMENT_MARKER);
      expect(metadata.estimated_cost).toBe(1.25);
      expect(metadata.reserved_amount).toBe(1.25);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "exact-cost settlement marks the reservation settled without a money row",
    async () => {
      if (!pgliteReady) return;
      await seedOrg("9");
      const reservationId = await insertReservation(1.0);

      const result = await creditsService.reconcile({
        organizationId: ORG_ID,
        reservedAmount: 1.0,
        actualCost: 1.0,
        description: "chat completion exact settle",
        metadata: { user_id: USER_ID, reservation_transaction_id: reservationId },
      });

      expect(result.adjustmentType).toBe("none");
      expect(await getBalance()).toBeCloseTo(9, 6);
      expect(await getReservationSettledAt(reservationId)).toBeTruthy();
      expect(await settlementRowsForReservation(reservationId)).toEqual([]);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "real reservation overage is charged once and duplicate settle is ignored",
    async () => {
      if (!pgliteReady) return;
      await seedOrg("19.6");
      const reservationId = await insertReservation(0.4);

      const first = await creditsService.reconcile({
        organizationId: ORG_ID,
        reservedAmount: 0.4,
        actualCost: 1.0,
        description: "chat completion overage settle",
        metadata: { user_id: USER_ID, reservation_transaction_id: reservationId },
      });
      const second = await creditsService.reconcile({
        organizationId: ORG_ID,
        reservedAmount: 0.4,
        actualCost: 1.0,
        description: "duplicate overage settle",
        metadata: { user_id: USER_ID, reservation_transaction_id: reservationId },
      });

      expect(first.adjustmentType).toBe("overage");
      expect(second.adjustmentType).toBe("none");
      expect(await getBalance()).toBeCloseTo(19, 6);
      expect(await countByType("debit")).toBe(2); // reservation + overage
      expect(await settlementRowsForReservation(reservationId)).toEqual([
        {
          amount: "-0.600000",
          type: "debit",
          stripe_payment_intent_id: `recon:${reservationId}:overage`,
        },
      ]);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "sweep ignores ambiguous pre-marker reservations",
    async () => {
      if (!pgliteReady) return;
      await seedOrg("9");
      const reservationId = await insertReservation(1.0, 25 * 60 * 1000, false);

      const stats = await creditsService.sweepStaleReservations({
        graceMs: 20 * 60 * 1000,
        batchSize: 10,
      });

      expect(stats.scanned).toBe(0);
      expect(stats.settled).toBe(0);
      expect(await getBalance()).toBeCloseTo(9, 6);
      expect(await getReservationSettledAt(reservationId)).toBeNull();
      expect(await settlementRowsForReservation(reservationId)).toEqual([]);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "sweep marks legacy-keyed settlements without minting another refund",
    async () => {
      if (!pgliteReady) return;
      await seedOrg("9.6");
      const reservationId = await insertReservation(1.0, 25 * 60 * 1000);
      const legacySettlementId = await insertLegacySettlementForReservation(reservationId, 0.6);

      const stats = await creditsService.sweepStaleReservations({
        graceMs: 20 * 60 * 1000,
        batchSize: 10,
      });

      expect(stats.scanned).toBe(1);
      expect(stats.settled).toBe(1);
      expect(stats.noops).toBe(1);
      expect(stats.refunds).toBe(0);
      expect(await getBalance()).toBeCloseTo(9.6, 6);
      expect(await getReservationSettledAt(reservationId)).toBeTruthy();
      expect(await countByType("refund")).toBe(1);
      expect(await settlementRowsForReservation(reservationId)).toEqual([
        {
          amount: "0.600000",
          type: "refund",
          stripe_payment_intent_id: `recon:${reservationId}:refund`,
        },
      ]);

      const late = await creditsService.reconcile({
        organizationId: ORG_ID,
        reservedAmount: 1.0,
        actualCost: 0.2,
        description: "late waitUntil settle after legacy keyed settle",
        metadata: { user_id: USER_ID, reservation_transaction_id: reservationId },
      });

      expect(late.adjustmentType).toBe("none");
      expect(late.settlementTransactionIds).toEqual([legacySettlementId]);
      expect(await getBalance()).toBeCloseTo(9.6, 6);
      expect(await countByType("refund")).toBe(1);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "sweep settles stale reservations to the estimated cost and blocks late double-settle",
    async () => {
      if (!pgliteReady) return;
      await seedOrg("9");
      const reservationId = await insertReservation(1.0, 25 * 60 * 1000, true, {
        estimated_cost: 0.6666666667,
      });

      const stats = await creditsService.sweepStaleReservations({
        graceMs: 20 * 60 * 1000,
        batchSize: 10,
      });

      expect(stats.scanned).toBe(1);
      expect(stats.settled).toBe(1);
      expect(stats.refunds).toBe(1);
      expect(await getBalance()).toBeCloseTo(9.333333, 6);
      expect(await getReservationSettledAt(reservationId)).toBeTruthy();

      const late = await creditsService.reconcile({
        organizationId: ORG_ID,
        reservedAmount: 1.0,
        actualCost: 0.2,
        description: "late waitUntil settle after sweep",
        metadata: { user_id: USER_ID, reservation_transaction_id: reservationId },
      });

      expect(late.adjustmentType).toBe("none");
      expect(await getBalance()).toBeCloseTo(9.333333, 6);
      expect(await countByType("refund")).toBe(1);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "sweep settles fixed-amount reservations to the stored estimate without applying the model buffer",
    async () => {
      if (!pgliteReady) return;
      await seedOrg("9");
      const reservationId = await insertReservation(1.0, 25 * 60 * 1000, true, {
        estimated_cost: 1.0,
      });

      const stats = await creditsService.sweepStaleReservations({
        graceMs: 20 * 60 * 1000,
        batchSize: 10,
      });

      expect(stats.scanned).toBe(1);
      expect(stats.settled).toBe(1);
      expect(stats.noops).toBe(1);
      expect(stats.refunds).toBe(0);
      expect(await getBalance()).toBeCloseTo(9, 6);
      expect(await getReservationSettledAt(reservationId)).toBeTruthy();
      expect(await settlementRowsForReservation(reservationId)).toEqual([]);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "sweep treats marker rows without an estimate as exact-cost instead of guessing from the current buffer",
    async () => {
      if (!pgliteReady) return;
      await seedOrg("9");
      const reservationId = await insertReservation(1.0, 25 * 60 * 1000);

      const stats = await creditsService.sweepStaleReservations({
        graceMs: 20 * 60 * 1000,
        batchSize: 10,
      });

      expect(stats.scanned).toBe(1);
      expect(stats.settled).toBe(1);
      expect(stats.noops).toBe(1);
      expect(stats.refunds).toBe(0);
      expect(await getBalance()).toBeCloseTo(9, 6);
      expect(await getReservationSettledAt(reservationId)).toBeTruthy();
      expect(await settlementRowsForReservation(reservationId)).toEqual([]);
    },
    PGLITE_TIMEOUT,
  );

  test(
    // #11683: app-chat holds must settle through appCreditsService.reconcileCredits
    // (the lane the route's late settle uses, keyed `reconcile-refund:<holdId>`),
    // NEVER the generic lane below (keyed `recon:<holdId>:refund`) — the disjoint
    // keys let a swept-but-still-in-flight hold be refunded twice, and the
    // generic base-only math over-refunded the markup. This minimal fixture has
    // no users/apps rows for the app-credits lane to resolve, so the sweep must
    // leave the hold untouched (skipped, retried next sweep) rather than settle
    // it generically. The full app-credits-lane sweep proof (markup math,
    // cross-writer dedup with the real settle lane) lives in
    // app-chat-sweep-double-refund.test.ts.
    "sweep never settles app-chat holds through the generic lane",
    async () => {
      if (!pgliteReady) return;
      await seedOrg("8.5");
      const reservationId = await insertAppChatReservation(1.5, 25 * 60 * 1000);

      const stats = await creditsService.sweepStaleReservations({
        graceMs: 20 * 60 * 1000,
        batchSize: 10,
      });

      expect(stats.scanned).toBe(1);
      expect(stats.settled).toBe(0);
      expect(stats.refunds).toBe(0);
      expect(stats.skipped).toBe(1);
      // No generically-keyed money row, no settle claim, balance untouched.
      expect(await getBalance()).toBeCloseTo(8.5, 6);
      expect(await getReservationSettledAt(reservationId)).toBeNull();
      expect(await settlementRowsForReservation(reservationId)).toEqual([]);
      expect(await countByType("refund")).toBe(0);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "sweep does not settle monetized app-chat holds through the generic lane",
    async () => {
      if (!pgliteReady) return;
      // Production monetized shape (#11592): base estimate $1.00, 1.5x buffer
      // -> reserved base $1.50, 20% creator markup -> $1.80 org hold
      // (`computeInferenceCharge`), creator earnings recorded at deduct time;
      // #11683 requires the sweep to use the app-credits settle lane, not the
      // generic `recon:<holdId>:refund` lane. This synthetic fixture does not
      // create the users/apps tables that appCreditsService needs, so the safe
      // behavior is to skip and retry later, leaving the hold open. The real
      // app-credits-lane proof for markup math and late-settle dedup lives in
      // app-chat-sweep-double-refund.test.ts.
      await seedOrg("8.2"); // org had 10, paid the 1.8 hold
      const reservationId = await insertAppChatReservation(1.8, 25 * 60 * 1000, {
        estimated_cost: 1.0,
        reserved_amount: 1.5,
        totalCost: 1.8,
        baseCost: 1.5,
        creatorMarkup: 0.3,
        markupPercentage: 20,
      });

      const stats = await creditsService.sweepStaleReservations({
        graceMs: 20 * 60 * 1000,
        batchSize: 10,
      });

      expect(stats.scanned).toBe(1);
      expect(stats.settled).toBe(0);
      expect(stats.skipped).toBe(1);
      expect(stats.refunds).toBe(0);
      expect(await getBalance()).toBeCloseTo(8.2, 6);
      expect(await getReservationSettledAt(reservationId)).toBeNull();
      expect(await settlementRowsForReservation(reservationId)).toEqual([]);
      expect(await countByType("refund")).toBe(0);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "sweep skips an app-chat hold without a usable base pair instead of guessing",
    async () => {
      if (!pgliteReady) return;
      await seedOrg("8.2");
      const reservationId = await insertAppChatReservation(1.8, 25 * 60 * 1000, {
        estimated_cost: null,
        reserved_amount: null,
      });

      const stats = await creditsService.sweepStaleReservations({
        graceMs: 20 * 60 * 1000,
        batchSize: 10,
      });

      expect(stats.scanned).toBe(1);
      expect(stats.settled).toBe(0);
      expect(stats.skipped).toBe(1);
      expect(stats.noops).toBe(0);
      expect(stats.refunds).toBe(0);
      expect(await getBalance()).toBeCloseTo(8.2, 6);
      expect(await getReservationSettledAt(reservationId)).toBeNull();
      expect(await settlementRowsForReservation(reservationId)).toEqual([]);
    },
    PGLITE_TIMEOUT,
  );
});

/**
 * #10920: a Stripe refund / chargeback must claw back credits the top-up
 * granted, while respecting the live credit_balance >= 0 check constraint.
 */
describe("CreditsService.clawbackCredits (#10920)", () => {
  test(
    "floors the balance at zero and records unrecovered shortfall metadata",
    async () => {
      if (!pgliteReady) return;
      await seedOrg("50"); // org spent a $100 top-up down to $50
      const r = await creditsService.clawbackCredits({
        organizationId: ORG_ID,
        amount: 100,
        description: "refund clawback",
        stripePaymentIntentId: "stripe:refund:ch_1:10000",
        metadata: { payment_intent_id: "pi_1" },
      });

      expect(await getBalance()).toBeCloseTo(0, 6);
      expect(r.newBalance).toBeCloseTo(0, 6);
      expect(r.appliedAmount).toBeCloseTo(50, 6);
      expect(r.shortfallAmount).toBeCloseTo(50, 6);
      expect(r.alreadyProcessed).toBe(false);
      expect(await countByType("clawback")).toBe(1);

      const clawbackRow = await dbWrite.execute(
        `SELECT amount, metadata FROM credit_transactions WHERE organization_id = '${ORG_ID}' AND type = 'clawback';`,
      );
      const row = clawbackRow.rows[0] as {
        amount: string;
        metadata: Record<string, unknown>;
      };
      expect(Number(row.amount)).toBeCloseTo(-50, 6);
      expect(Number(row.metadata.unrecovered_clawback_usd)).toBeCloseTo(50, 6);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "is idempotent on the stripePaymentIntentId key (no double claw on re-delivery)",
    async () => {
      if (!pgliteReady) return;
      await seedOrg("100");
      const key = "stripe:refund:ch_2:5000";

      const first = await creditsService.clawbackCredits({
        organizationId: ORG_ID,
        amount: 50,
        description: "refund clawback",
        stripePaymentIntentId: key,
        metadata: { payment_intent_id: "pi_2" },
      });
      const second = await creditsService.clawbackCredits({
        organizationId: ORG_ID,
        amount: 50,
        description: "refund clawback",
        stripePaymentIntentId: key,
        metadata: { payment_intent_id: "pi_2" },
      });

      expect(await getBalance()).toBeCloseTo(50, 6); // clawed once, not twice
      expect(await countByType("clawback")).toBe(1);
      expect(second.transaction.id).toBe(first.transaction.id);
      expect(second.alreadyProcessed).toBe(true);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "getClawedBackUsdForPaymentIntent sums prior applied clawbacks (for partial-refund deltas)",
    async () => {
      if (!pgliteReady) return;
      await seedOrg("100");
      await creditsService.clawbackCredits({
        organizationId: ORG_ID,
        amount: 30,
        description: "partial 1",
        stripePaymentIntentId: "stripe:refund:ch_3:3000",
        metadata: { payment_intent_id: "pi_3" },
      });
      await creditsService.clawbackCredits({
        organizationId: ORG_ID,
        amount: 20,
        description: "partial 2",
        stripePaymentIntentId: "stripe:refund:ch_3:5000",
        metadata: { payment_intent_id: "pi_3" },
      });

      expect(await creditsService.getClawedBackUsdForPaymentIntent("pi_3")).toBeCloseTo(50, 6);
      expect(await creditsService.getClawedBackUsdForPaymentIntent("pi_none")).toBe(0);
      // Balance clawed the full $50 across the two partials.
      expect(await getBalance()).toBeCloseTo(50, 6);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "getClawedBackUsdForPaymentIntent nets won-dispute reinstatements (#11155)",
    async () => {
      if (!pgliteReady) return;
      await seedOrg("100");

      // Dispute opens: Stripe withdraws the funds → dispute clawback tagged
      // with the payment intent (mirrors handleChargeDisputeFundsWithdrawn).
      await creditsService.clawbackCredits({
        organizationId: ORG_ID,
        amount: 10,
        description: "dispute clawback",
        stripePaymentIntentId: "stripe:dispute:dp_r1",
        metadata: { payment_intent_id: "pi_r1" },
      });
      expect(await creditsService.getClawedBackUsdForPaymentIntent("pi_r1")).toBeCloseTo(10, 6);

      // Platform wins the dispute: funds_reinstated writes a `refund` row
      // (mirrors handleChargeDisputeFundsReinstated in stripe-event.ts).
      await creditsService.refundCredits({
        organizationId: ORG_ID,
        amount: 10,
        description: "Stripe charge.dispute.funds_reinstated reinstatement — dispute dp_r1",
        stripePaymentIntentId: "stripe:dispute:dp_r1:reinstated",
        metadata: {
          payment_intent_id: "pi_r1",
          source: "charge.dispute.funds_reinstated",
        },
      });

      // The tally nets to 0 so a later charge.refunded claws the FULL refund
      // delta instead of under-clawing by the reinstated amount.
      expect(await creditsService.getClawedBackUsdForPaymentIntent("pi_r1")).toBeCloseTo(0, 6);

      // An ordinary (non-reinstatement) refund tagged with the same payment
      // intent must NOT reduce the tally.
      await creditsService.refundCredits({
        organizationId: ORG_ID,
        amount: 5,
        description: "unrelated refund",
        metadata: { payment_intent_id: "pi_r1" },
      });
      expect(await creditsService.getClawedBackUsdForPaymentIntent("pi_r1")).toBeCloseTo(0, 6);

      // Balance: 100 - 10 (clawback) + 10 (reinstatement) + 5 (refund) = 105.
      expect(await getBalance()).toBeCloseTo(105, 6);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "re-delivered funds_reinstated cannot drive the netted tally negative (#11155)",
    async () => {
      if (!pgliteReady) return;
      await seedOrg("100");

      await creditsService.clawbackCredits({
        organizationId: ORG_ID,
        amount: 10,
        description: "dispute clawback",
        stripePaymentIntentId: "stripe:dispute:dp_r2",
        metadata: { payment_intent_id: "pi_r2" },
      });

      const reinstatement = {
        organizationId: ORG_ID,
        amount: 10,
        description: "Stripe charge.dispute.funds_reinstated reinstatement — dispute dp_r2",
        stripePaymentIntentId: "stripe:dispute:dp_r2:reinstated",
        metadata: {
          payment_intent_id: "pi_r2",
          source: "charge.dispute.funds_reinstated",
        },
      };
      const first = await creditsService.refundCredits(reinstatement);
      expect(await creditsService.getClawedBackUsdForPaymentIntent("pi_r2")).toBeCloseTo(0, 6);
      expect(first.newBalance).toBeCloseTo(100, 6);

      // Stripe re-delivers the webhook: the same `:reinstated` idempotency key
      // must dedupe at BOTH the ledger and the balance (applyCreditIncrease
      // gates the balance UPDATE on a fresh insert). A second reinstatement
      // row would make the netted tally NEGATIVE (-10), and a later
      // charge.refunded would then claw MORE than the refund (over-claw).
      const second = await creditsService.refundCredits(reinstatement);
      expect(second.transaction.id).toBe(first.transaction.id);
      expect(second.newBalance).toBeCloseTo(100, 6);
      expect(await creditsService.getClawedBackUsdForPaymentIntent("pi_r2")).toBeCloseTo(0, 6);
      expect(await getBalance()).toBeCloseTo(100, 6);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "partial-dispute reinstatement nets only the reinstated portion (#11155)",
    async () => {
      if (!pgliteReady) return;
      await seedOrg("100");

      // Dispute withdraws the full $10.
      await creditsService.clawbackCredits({
        organizationId: ORG_ID,
        amount: 10,
        description: "dispute clawback",
        stripePaymentIntentId: "stripe:dispute:dp_r3",
        metadata: { payment_intent_id: "pi_r3" },
      });

      // Platform wins PARTIALLY: Stripe reinstates only $4
      // (handleChargeDisputeFundsReinstated caps at min(dispute.amount,
      // applied clawback), so a partial reinstatement writes a $4 row).
      await creditsService.refundCredits({
        organizationId: ORG_ID,
        amount: 4,
        description: "Stripe charge.dispute.funds_reinstated reinstatement — dispute dp_r3",
        stripePaymentIntentId: "stripe:dispute:dp_r3:reinstated",
        metadata: {
          payment_intent_id: "pi_r3",
          source: "charge.dispute.funds_reinstated",
        },
      });
      expect(await creditsService.getClawedBackUsdForPaymentIntent("pi_r3")).toBeCloseTo(6, 6);

      // Later charge.refunded for the full $10: clawbackForReversal computes
      // toClaw = min(10, grant) - 6 = 4 — exactly the reinstated portion.
      // Apply that delta and the tally converges back to the full $10.
      await creditsService.clawbackCredits({
        organizationId: ORG_ID,
        amount: 4,
        description: "refund clawback (delta)",
        stripePaymentIntentId: "stripe:refund:ch_r3:1000",
        metadata: { payment_intent_id: "pi_r3" },
      });
      expect(await creditsService.getClawedBackUsdForPaymentIntent("pi_r3")).toBeCloseTo(10, 6);

      // Balance: 100 - 10 + 4 - 4 = 90 — the org holds exactly what the fiat
      // flows imply (grant refunded in full, only $4 was ever reinstated).
      expect(await getBalance()).toBeCloseTo(90, 6);
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
