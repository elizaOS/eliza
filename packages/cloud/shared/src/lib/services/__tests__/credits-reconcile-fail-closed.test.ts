/**
 * CreditsService.reconcile() fail-closed settlement contract (#13415 slice).
 *
 * Real PGlite-backed coverage for two former fail-open paths:
 *
 *  1. A reconcile call naming a `reservation_transaction_id` that matches no
 *     reservation row used to fall through to the legacy lane and mint a
 *     refund keyed only on the caller-supplied `reservedAmount` — credit with
 *     no corresponding debit. It must now throw ReservationNotFoundError and
 *     write nothing.
 *  2. The legacy (no-reservation-id) lane's retry loop used to swallow a
 *     persistent settlement failure and return a success-shaped result
 *     (`adjustmentType: "none"`), making a lost refund indistinguishable from
 *     a clean settle. It must now surface the failure.
 *
 * The harness is real: the actual reconcile/refund/deduct SQL runs against an
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
const MISSING_ORG_ID = "00000000-0000-0000-0000-0000000000f7";
const USER_ID = "00000000-0000-0000-0000-0000000000f8";
const MISSING_RESERVATION_ID = "00000000-0000-0000-0000-0000000000f9";

let dbWrite: typeof import("../../../db/client").dbWrite;
let closeDb: typeof import("../../../db/client").closeDatabaseConnectionsForTests | undefined;
let creditsService: typeof import("../credits").creditsService;
let ReservationNotFoundError: typeof import("../credits").ReservationNotFoundError;
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
  await dbWrite.execute(`DELETE FROM credit_transactions WHERE organization_id = '${ORG_ID}';`);
  await dbWrite.execute(`DELETE FROM organizations WHERE id = '${ORG_ID}';`);
  await dbWrite.execute(
    `INSERT INTO organizations (id, credit_balance) VALUES ('${ORG_ID}', '${balance}');`,
  );
}

beforeAll(async () => {
  try {
    ({ closeDatabaseConnectionsForTests: closeDb, dbWrite } = await import("../../../db/client"));
    const credits = await import("../credits");
    creditsService = credits.creditsService;
    ReservationNotFoundError = credits.ReservationNotFoundError;

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
    "does not retry the not-found settlement (single decisive failure)",
    async () => {
      const started = Date.now();
      await expect(
        creditsService.reconcile({
          organizationId: ORG_ID,
          reservedAmount: 10,
          actualCost: 2,
          description: "bogus reservation settle",
          metadata: { reservation_transaction_id: MISSING_RESERVATION_ID },
        }),
      ).rejects.toBeInstanceOf(ReservationNotFoundError);
      // The transient-retry ladder sleeps 100ms+200ms between attempts; a
      // decisive not-found must not enter it.
      expect(Date.now() - started).toBeLessThan(100);
    },
    PGLITE_TIMEOUT,
  );
});

describe("legacy-lane persistent settlement failure", () => {
  test(
    "surfaces the failure instead of returning a success-shaped result",
    async () => {
      // No reservation_transaction_id → legacy lane. The org row does not
      // exist, so refundCredits fails on every retry. The old catch returned
      // `adjustmentType: "none"` here — a fabricated clean settle.
      await expect(
        creditsService.reconcile({
          organizationId: MISSING_ORG_ID,
          reservedAmount: 25,
          actualCost: 5,
          description: "legacy settle against missing org",
        }),
      ).rejects.toThrow();
      expect(await countTransactions(MISSING_ORG_ID)).toBe(0);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "still settles a healthy legacy refund (regression guard)",
    async () => {
      const result = await creditsService.reconcile({
        organizationId: ORG_ID,
        reservedAmount: 10,
        actualCost: 4,
        description: "legacy refund settle",
      });
      expect(result.adjustmentType).toBe("refund");
      expect(await getBalance()).toBe(106);
    },
    PGLITE_TIMEOUT,
  );
});
