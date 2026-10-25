/**
 * Exercises the fail-closed settlement contract of CreditsService.reconcile.
 *
 * Real PGlite-backed coverage verifies two security-sensitive paths:
 *
 *  1. A reconcile call naming a `reservation_transaction_id` that matches no
 *     reservation row used to fall through to the legacy lane and mint a
 *     refund keyed only on the caller-supplied `reservedAmount` — credit with
 *     no corresponding debit. It must now throw ReservationNotFoundError and
 *     write nothing.
 *  2. A positive refund without any reservation id used to trust the caller's
 *     `reservedAmount`, so serial replays and concurrent calls could mint
 *     arbitrary credit. Every attempt must now reject before ledger mutation.
 *  3. Exact/no-op and charge-only legacy reconciliation remain compatible;
 *     the latter can debit credit but must never create it.
 *  4. Negative/non-finite settlement costs must fail before any ledger read or
 *     write, so provider sentinel values cannot become unbacked refunds.
 *
 * The actual reconcile/refund/deduct SQL runs against an
 * in-process PGlite DB and balances/transactions are read back and asserted.
 * The `pgliteReady` guard fails loudly if the DB never initializes.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.CREDIT_COST_BUFFER = "1.5";

const PGLITE_TIMEOUT = 60000;

const ORG_ID = "00000000-0000-0000-0000-0000000000f6";
const OTHER_ORG_ID = "00000000-0000-0000-0000-0000000000f7";
const MISSING_RESERVATION_ID = "00000000-0000-0000-0000-0000000000f9";

let dbWrite: typeof import("../../../db/client").dbWrite;
let closeDb: typeof import("../../../db/client").closeDatabaseConnectionsForTests | undefined;
let creditsService: typeof import("../credits").creditsService;
let EPSILON: typeof import("../credits").EPSILON;
let ReservationNotFoundError: typeof import("../credits").ReservationNotFoundError;
let assertCreditRefundWithinReservation: typeof import("../credits").assertCreditRefundWithinReservation;
let pgliteReady = true;

async function getBalance(): Promise<number> {
  const res = await dbWrite.execute(
    `SELECT credit_balance FROM organizations WHERE id = '${ORG_ID}';`,
  );
  return Number((res.rows[0] as { credit_balance: string }).credit_balance);
}

async function countTransactions(orgId: string): Promise<number> {
  const res = await dbWrite.execute(
    `SELECT count(*)::int AS n FROM credit_transactions WHERE organization_id = '${orgId}';`,
  );
  return (res.rows[0] as { n: number }).n;
}

async function seedOrg(balance: string): Promise<void> {
  await dbWrite.execute(
    `DELETE FROM credit_transactions WHERE organization_id IN ('${ORG_ID}', '${OTHER_ORG_ID}');`,
  );
  await dbWrite.execute(`DELETE FROM organizations WHERE id IN ('${ORG_ID}', '${OTHER_ORG_ID}');`);
  await dbWrite.execute(
    `INSERT INTO organizations (id, credit_balance) VALUES ('${ORG_ID}', '${balance}');`,
  );
}

beforeAll(async () => {
  try {
    ({ closeDatabaseConnectionsForTests: closeDb, dbWrite } = await import("../../../db/client"));
    const credits = await import("../credits");
    creditsService = credits.creditsService;
    EPSILON = credits.EPSILON;
    ReservationNotFoundError = credits.ReservationNotFoundError;
    assertCreditRefundWithinReservation = credits.assertCreditRefundWithinReservation;

    // DDL mirrors credits-reconcile.test.ts: the full organizations column set
    // (background hooks SELECT every column via findById) and the verbatim
    // credit_transactions table + unique stripe intent index the refund path's
    // ON CONFLICT requires.
    const ddl = [
      `CREATE TABLE IF NOT EXISTS organizations (
        id uuid PRIMARY KEY,
        name text NOT NULL DEFAULT 'test-org',
        slug text NOT NULL DEFAULT 'test-org',
        credit_balance numeric(20,6) NOT NULL DEFAULT '0' CHECK (credit_balance >= 0),
        balance_revision bigint NOT NULL DEFAULT 0,
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
      `CREATE UNIQUE INDEX IF NOT EXISTS credit_transactions_stripe_payment_intent_idx
        ON credit_transactions (stripe_payment_intent_id)`,
    ];
    for (const stmt of ddl) {
      await dbWrite.execute(stmt);
    }
  } catch (error) {
    pgliteReady = false;
    throw error;
  }
}, PGLITE_TIMEOUT);

afterAll(async () => {
  await closeDb?.();
});

beforeEach(async () => {
  if (!pgliteReady) throw new Error("PGlite harness failed to initialize");
  await seedOrg("100.00");
});

describe("reconcile with a reservation id that matches no row", () => {
  test(
    "throws ReservationNotFoundError instead of minting a legacy-lane refund",
    async () => {
      await expect(
        creditsService.reconcile({
          organizationId: ORG_ID,
          reservedAmount: 50,
          actualCost: 1,
          description: "bogus reservation settle",
          metadata: { reservation_transaction_id: MISSING_RESERVATION_ID },
        }),
      ).rejects.toBeInstanceOf(ReservationNotFoundError);

      // Nothing minted, balance untouched: the old fall-through refunded
      // reserved - actual = $49 of unverified credit here.
      expect(await getBalance()).toBe(100);
      expect(await countTransactions(ORG_ID)).toBe(0);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "treats another organization's real reservation as unbacked",
    async () => {
      await dbWrite.execute(
        `INSERT INTO organizations (id, credit_balance) VALUES ('${OTHER_ORG_ID}', '50.00');`,
      );
      const inserted = await dbWrite.execute(
        `INSERT INTO credit_transactions (
          organization_id,
          amount,
          type,
          description,
          metadata
        ) VALUES (
          '${OTHER_ORG_ID}',
          '-10.00',
          'debit',
          'other organization reservation',
          '{"type":"reservation"}'::jsonb
        ) RETURNING id;`,
      );
      const reservationTransactionId = (inserted.rows[0] as { id: string }).id;

      await expect(
        creditsService.reconcile({
          organizationId: ORG_ID,
          reservedAmount: 10,
          actualCost: 4,
          description: "cross-organization refund attempt",
          metadata: { reservation_transaction_id: reservationTransactionId },
        }),
      ).rejects.toBeInstanceOf(ReservationNotFoundError);

      expect(await getBalance()).toBe(100);
      expect(await countTransactions(ORG_ID)).toBe(0);
      expect(await countTransactions(OTHER_ORG_ID)).toBe(1);
    },
    PGLITE_TIMEOUT,
  );
});

describe("legacy reconciliation without authoritative reservation backing", () => {
  test("classifies a refund larger than its backing reservation as a fatal invariant failure", () => {
    let thrown: unknown;
    try {
      assertCreditRefundWithinReservation({
        reservedAmount: 0.000001,
        refundAmount: 1618.800001,
        scope: "incident regression",
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      code: "CREDIT_REFUND_EXCEEDS_RESERVATION",
      severity: "fatal",
    });
  });

  test.each([
    { label: "negative", reservedAmount: -1 },
    { label: "non-finite", reservedAmount: Number.NaN },
  ])("rejects a $label backing reservation", ({ reservedAmount }) => {
    expect(() =>
      assertCreditRefundWithinReservation({
        reservedAmount,
        refundAmount: 0,
        scope: "incident regression",
      }),
    ).toThrow();
  });

  test.each([
    { label: "negative actual", reservedAmount: 1, actualCost: -1 },
    { label: "non-finite actual", reservedAmount: 1, actualCost: Number.NaN },
    { label: "negative reservation", reservedAmount: -1, actualCost: 0 },
  ])("rejects $label before minting a refund", async ({ reservedAmount, actualCost }) => {
    await expect(
      creditsService.reconcile({
        organizationId: ORG_ID,
        reservedAmount,
        actualCost,
        description: "invalid legacy settlement",
      }),
    ).rejects.toMatchObject({
      code:
        actualCost < 0 || Number.isNaN(actualCost)
          ? "INVALID_ACTUAL_CREDIT_COST"
          : "INVALID_RESERVED_CREDIT_COST",
    });

    expect(await getBalance()).toBe(100);
    expect(await countTransactions(ORG_ID)).toBe(0);
  });

  test(
    "rejects serial replays and concurrent unbacked refunds without mutation",
    async () => {
      const attempt = () =>
        creditsService.reconcile({
          organizationId: ORG_ID,
          reservedAmount: 10,
          actualCost: 4,
          description: "unbacked legacy refund",
        });

      await expect(attempt()).rejects.toMatchObject({
        code: "CREDIT_REFUND_RESERVATION_REQUIRED",
      });
      await expect(attempt()).rejects.toMatchObject({
        code: "CREDIT_REFUND_RESERVATION_REQUIRED",
      });

      const concurrent = await Promise.allSettled([attempt(), attempt(), attempt(), attempt()]);
      expect(concurrent).toHaveLength(4);
      for (const result of concurrent) {
        expect(result.status).toBe("rejected");
        if (result.status === "rejected") {
          expect(result.reason).toMatchObject({
            code: "CREDIT_REFUND_RESERVATION_REQUIRED",
          });
        }
      }

      expect(await getBalance()).toBe(100);
      expect(await countTransactions(ORG_ID)).toBe(0);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "rejects an unbacked refund exactly at the reconciliation threshold",
    async () => {
      await expect(
        creditsService.reconcile({
          organizationId: ORG_ID,
          reservedAmount: EPSILON,
          actualCost: 0,
          description: "exact-threshold unbacked refund",
        }),
      ).rejects.toMatchObject({ code: "CREDIT_REFUND_RESERVATION_REQUIRED" });

      expect(await getBalance()).toBe(100);
      expect(await countTransactions(ORG_ID)).toBe(0);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "keeps an exact no-op compatible without creating a ledger row",
    async () => {
      const result = await creditsService.reconcile({
        organizationId: ORG_ID,
        reservedAmount: 10,
        actualCost: 10,
        description: "legacy exact settle",
      });

      expect(result.adjustmentType).toBe("none");
      expect(await getBalance()).toBe(100);
      expect(await countTransactions(ORG_ID)).toBe(0);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "keeps charge-only legacy reconciliation compatible without creating credit",
    async () => {
      const result = await creditsService.reconcile({
        organizationId: ORG_ID,
        reservedAmount: 4,
        actualCost: 10,
        description: "legacy overage settle",
      });

      expect(result.adjustmentType).toBe("overage");
      expect(await getBalance()).toBe(94);
      expect(await countTransactions(ORG_ID)).toBe(1);
    },
    PGLITE_TIMEOUT,
  );
});
