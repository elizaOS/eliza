/**
 * Real-DB coverage for the plain crypto top-up credit grant in
 * `CryptoPaymentsService.confirmPayment` (the no-double-credit invariant).
 *
 * The bug: the plain top-up granted credits via `creditsService.addCredits`
 * WITHOUT `db: tx` (so the credit committed on the global connection, not
 * atomically with the status="confirmed" flip) and WITHOUT a
 * `stripePaymentIntentId` idempotency key. A partial failure after the credit
 * (e.g. the invoice insert throwing) rolled the status back to "pending" while
 * the credit stayed committed; a reprocess (the user-pollable status endpoint,
 * a redelivered event) then credited the org AGAIN — free money. The adjacent
 * app-purchase path in the same method was already protected via
 * `stripePaymentIntentId: crypto:${payment.id}`; this closes the plain-path gap.
 *
 * These run the REAL confirmPayment against in-process PGlite (real SQL: the
 * SELECT … FOR UPDATE, the status transition, the WITH-CTE credit insert +
 * balance update). Only the invoice + discord side-effects are stubbed — the
 * invoice stub is armed to throw to exercise the atomic rollback. Fails loudly
 * (via the `pgliteReady` guard) if PGlite ever fails to initialize — never a
 * silent skip.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";

const ORG_ID = "00000000-0000-4000-8000-0000000000c1";
const PAYMENT_ID = "00000000-0000-4000-8000-0000000000d1";
const PGLITE_TIMEOUT = 60000;

// Controllable invoice stub: succeeds by default; throws when armed so we can
// exercise a post-credit failure inside the confirmation transaction.
let invoiceCreateShouldThrow = false;
mock.module("../invoices", () => ({
  invoicesService: {
    async getByStripeInvoiceId() {
      return undefined;
    },
    async create() {
      if (invoiceCreateShouldThrow) throw new Error("simulated invoice insert conflict");
      return { id: "invoice-stub" };
    },
  },
}));
// Discord logging is fire-and-forget; stub to avoid any network.
mock.module("../discord", () => ({
  discordService: {
    async logPaymentReceived() {},
    async logPayment() {},
  },
}));
mock.module("../oxapay", () => ({
  isOxaPayConfigured: () => true,
  oxaPayService: {
    async getPaymentStatus() {
      return {
        status: "confirmed",
        transactions: [
          {
            txHash: "0xhashManual",
            amount: "10",
            currency: "USDT",
            nativeAmount: "10",
            usdAmount: "10",
          },
        ],
      };
    },
    isPaymentConfirmed(status: string) {
      return status === "confirmed";
    },
  },
}));

let dbWrite: typeof import("../../../db/client").dbWrite;
let closeDb: typeof import("../../../db/client").closeDatabaseConnectionsForTests | undefined;
let cryptoPaymentsService: typeof import("../crypto-payments").cryptoPaymentsService;
let pgliteReady = true;

async function seedPendingPayment(): Promise<void> {
  await dbWrite.execute(
    `INSERT INTO crypto_payments
       (id, organization_id, user_id, payment_address, token, network,
        expected_amount, credits_to_add, status, expires_at, metadata)
     VALUES
       ('${PAYMENT_ID}', '${ORG_ID}', NULL, '0xpay', 'USDT', 'bsc',
        '10', '10', 'pending', now() + interval '1 hour',
        '{"oxapay_track_id":"track-123"}'::jsonb);`,
  );
}
async function orgBalance(): Promise<number> {
  const r = await dbWrite.execute(`SELECT credit_balance FROM organizations WHERE id='${ORG_ID}';`);
  return Number((r.rows[0] as { credit_balance: string }).credit_balance);
}
async function creditRowCount(): Promise<number> {
  const r = await dbWrite.execute(
    `SELECT count(*)::int AS n FROM credit_transactions WHERE organization_id='${ORG_ID}';`,
  );
  return (r.rows[0] as { n: number }).n;
}
async function paymentStatus(): Promise<string> {
  const r = await dbWrite.execute(`SELECT status FROM crypto_payments WHERE id='${PAYMENT_ID}';`);
  return (r.rows[0] as { status: string }).status;
}

beforeAll(async () => {
  try {
    ({ closeDatabaseConnectionsForTests: closeDb, dbWrite } = await import("../../../db/client"));
    ({ cryptoPaymentsService } = await import("../crypto-payments"));
    const ddl = [
      // Full org columns — organizationsRepository.findById selects them all.
      `CREATE TABLE IF NOT EXISTS organizations (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name text NOT NULL DEFAULT 'test-org',
        slug text NOT NULL DEFAULT 'test-org',
        credit_balance numeric(12,6) NOT NULL DEFAULT '0',
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
      // The idempotency dedupe (applyCreditIncrease's ON CONFLICT) targets this
      // unique index; multiple NULLs are allowed, one row per non-null key.
      `CREATE UNIQUE INDEX IF NOT EXISTS credit_transactions_stripe_payment_intent_idx
         ON credit_transactions (stripe_payment_intent_id)`,
      `CREATE TABLE IF NOT EXISTS crypto_payments (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid NOT NULL,
        user_id uuid,
        payment_address text NOT NULL,
        token_address text,
        token text NOT NULL,
        network text NOT NULL,
        expected_amount text NOT NULL,
        received_amount text,
        credits_to_add text NOT NULL,
        transaction_hash text,
        block_number text,
        status text NOT NULL,
        created_at timestamp NOT NULL DEFAULT now(),
        updated_at timestamp NOT NULL DEFAULT now(),
        confirmed_at timestamp,
        expires_at timestamp NOT NULL,
        metadata jsonb DEFAULT '{}'::jsonb
      )`,
    ];
    for (const stmt of ddl) await dbWrite.execute(stmt);
  } catch (error) {
    pgliteReady = false;
    console.warn("[crypto-payments-topup-idempotency] PGlite unavailable, skipping:", error);
  }
}, PGLITE_TIMEOUT);

afterAll(async () => {
  if (closeDb) await closeDb();
});

beforeEach(async () => {
  if (!pgliteReady) return;
  await dbWrite.execute(`DELETE FROM credit_transactions;`);
  await dbWrite.execute(`DELETE FROM crypto_payments;`);
  await dbWrite.execute(`DELETE FROM organizations;`);
  await dbWrite.execute(
    `INSERT INTO organizations (id, credit_balance) VALUES ('${ORG_ID}', '0');`,
  );
  invoiceCreateShouldThrow = false;
});

describe("crypto top-up — no double-credit (idempotent + atomic)", () => {
  test(
    "credits exactly once, and a reprocess of the same payment does NOT double-credit",
    async () => {
      if (!pgliteReady) return;
      await seedPendingPayment();

      await cryptoPaymentsService.confirmPayment(PAYMENT_ID, "0xhashA", "10");
      expect(await orgBalance()).toBeCloseTo(10, 6);
      expect(await creditRowCount()).toBe(1);

      // Simulate a reprocess: force the row back to 'pending' (as a partial
      // post-credit failure + status revert would) and re-run confirmPayment
      // with the same payment. The stripePaymentIntentId=crypto:<id> dedupe must
      // make the second credit a no-op. (Pre-fix, this double-credited.)
      await dbWrite.execute(
        `UPDATE crypto_payments SET status='pending' WHERE id='${PAYMENT_ID}';`,
      );
      await cryptoPaymentsService.confirmPayment(PAYMENT_ID, "0xhashA", "10");

      expect(await creditRowCount()).toBe(1);
      expect(await orgBalance()).toBeCloseTo(10, 6);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "a post-credit failure inside the tx rolls the credit back (atomic) — no orphaned credit",
    async () => {
      if (!pgliteReady) return;
      await seedPendingPayment();

      // Arm the invoice insert (which runs after the credit) to throw.
      invoiceCreateShouldThrow = true;
      await expect(
        cryptoPaymentsService.confirmPayment(PAYMENT_ID, "0xhashB", "10"),
      ).rejects.toThrow();

      // Because the credit is granted with db: tx, the invoice failure rolled it
      // back together with the status flip. (Pre-fix, the credit committed on the
      // global connection and survived → orphaned credit + a reprocess double.)
      expect(await creditRowCount()).toBe(0);
      expect(await orgBalance()).toBeCloseTo(0, 6);
      expect(await paymentStatus()).toBe("pending");

      // A clean reprocess now succeeds and credits exactly once.
      invoiceCreateShouldThrow = false;
      await cryptoPaymentsService.confirmPayment(PAYMENT_ID, "0xhashB", "10");
      expect(await creditRowCount()).toBe(1);
      expect(await orgBalance()).toBeCloseTo(10, 6);
      expect(await paymentStatus()).toBe("confirmed");
    },
    PGLITE_TIMEOUT,
  );

  test(
    "manual tx-hash confirmation is also atomic and idempotent for plain top-ups",
    async () => {
      if (!pgliteReady) return;
      await seedPendingPayment();

      invoiceCreateShouldThrow = true;
      const failed = await cryptoPaymentsService.verifyAndConfirmByTxHash(
        PAYMENT_ID,
        "0xhashManual",
      );
      expect(failed.success).toBe(false);
      expect(failed.message).toBe("simulated invoice insert conflict");
      expect(await creditRowCount()).toBe(0);
      expect(await orgBalance()).toBeCloseTo(0, 6);
      expect(await paymentStatus()).toBe("pending");

      invoiceCreateShouldThrow = false;
      const confirmed = await cryptoPaymentsService.verifyAndConfirmByTxHash(
        PAYMENT_ID,
        "0xhashManual",
      );
      expect(confirmed.success).toBe(true);
      expect(await creditRowCount()).toBe(1);
      expect(await orgBalance()).toBeCloseTo(10, 6);

      await dbWrite.execute(
        `UPDATE crypto_payments SET status='pending' WHERE id='${PAYMENT_ID}';`,
      );
      const replayed = await cryptoPaymentsService.verifyAndConfirmByTxHash(
        PAYMENT_ID,
        "0xhashManual",
      );
      expect(replayed.success).toBe(true);
      expect(await creditRowCount()).toBe(1);
      expect(await orgBalance()).toBeCloseTo(10, 6);
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
