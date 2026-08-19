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
const OTHER_ORG_ID = "00000000-0000-4000-8000-0000000000c2";
const PAYMENT_ID = "00000000-0000-4000-8000-0000000000d1";
const OTHER_PAYMENT_ID = "00000000-0000-4000-8000-0000000000d2";
const USER_ID = "00000000-0000-4000-8000-0000000000e1";
const APP_ID = "00000000-0000-4000-8000-0000000000f1";
const CHARGE_REQUEST_ID = "00000000-0000-4000-8000-0000000000f2";
const PGLITE_TIMEOUT = 60000;

// Controllable invoice stub: succeeds by default; throws when armed so we can
// exercise a post-credit failure inside the confirmation transaction.
let invoiceCreateShouldThrow = false;
let invoiceCreateSawTransaction = false;
let invoiceCreateCount = 0;
let lastInvoiceAmountPaid: string | null = null;
mock.module("../invoices", () => ({
  invoicesService: {
    async getByStripeInvoiceId() {
      return undefined;
    },
    async create(data: { amount_paid: string }, transaction?: unknown) {
      invoiceCreateCount += 1;
      invoiceCreateSawTransaction = transaction !== undefined;
      lastInvoiceAmountPaid = data.amount_paid;
      if (invoiceCreateShouldThrow) throw new Error("simulated invoice insert conflict");
      return { id: "invoice-stub" };
    },
  },
}));
let appPurchaseSawTransaction = false;
mock.module("../app-credits", () => ({
  appCreditsService: {
    async processPurchase(params: {
      stripePaymentIntentId: string;
      transaction?: { execute(query: string): Promise<unknown> };
    }) {
      appPurchaseSawTransaction = params.transaction !== undefined;
      await params.transaction?.execute(
        `INSERT INTO credit_transactions
          (organization_id, amount, type, description, metadata, stripe_payment_intent_id)
         VALUES ('${ORG_ID}', '1', 'credit', 'app purchase sentinel', '{}', '${params.stripePaymentIntentId}')`,
      );
      return {
        success: true,
        creditsAdded: 10,
        platformOffset: 0,
        creatorEarnings: 0,
        newBalance: 0,
      };
    },
  },
}));
mock.module("../referrals", () => ({
  referralsService: {
    async calculateRevenueSplitsExact() {
      return {
        elizaCloudAmount: "9.000000",
        splits: [{ userId: USER_ID, role: "creator", amount: "1.000000" }],
      };
    },
  },
}));
let referralShouldThrowAfterWrite = false;
let referralSawTransaction = false;
mock.module("../redeemable-earnings", () => ({
  redeemableEarningsService: {
    async addEarnings(params: { transaction?: { execute(query: string): Promise<unknown> } }) {
      referralSawTransaction = params.transaction !== undefined;
      await params.transaction?.execute(
        `INSERT INTO credit_transactions
          (organization_id, amount, type, description, metadata, stripe_payment_intent_id)
         VALUES ('${ORG_ID}', '1', 'credit', 'referral sentinel', '{}', 'referral-sentinel')`,
      );
      if (referralShouldThrowAfterWrite) throw new Error("simulated referral failure");
      return { success: true, newBalance: 1, ledgerEntryId: "referral-ledger" };
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
        trackId: "track-123",
        status: "confirmed",
        amount: "10",
        currency: "USD",
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
let cryptoPaymentsRepository: typeof import("../../../db/repositories/crypto-payments").cryptoPaymentsRepository;
let cryptoPaymentsService: typeof import("../crypto-payments").cryptoPaymentsService;
let pgliteReady = true;

function settlementEvidence(
  invoiceAmount = "10",
  payCurrency = "USDT",
  trackId = "track-123",
  invoiceCurrency = "USD",
) {
  return { trackId, invoiceAmount, invoiceCurrency, payCurrency };
}

async function seedPendingPayment(): Promise<void> {
  await dbWrite.execute(
    `INSERT INTO crypto_payments
       (id, organization_id, user_id, payment_address, token, network,
        expected_amount, credits_to_add, status, expires_at, metadata)
     VALUES
       ('${PAYMENT_ID}', '${ORG_ID}', NULL, '0xpay', 'USDT', 'bsc',
        '10', '10', 'pending', now() + interval '1 hour',
        '{"oxapay_track_id":"track-123","fiat_amount":"10","fiat_currency":"USD"}'::jsonb);`,
  );
}
async function seedAppPurchasePayment(): Promise<void> {
  await dbWrite.execute(
    `INSERT INTO crypto_payments
       (id, organization_id, user_id, payment_address, token, network,
        expected_amount, credits_to_add, status, expires_at, metadata)
     VALUES
       ('${PAYMENT_ID}', '${ORG_ID}', '${USER_ID}', '0xpay', 'USDT', 'bsc',
        '10', '10', 'pending', now() + interval '1 hour',
        '{"oxapay_track_id":"track-123","fiat_amount":"10","fiat_currency":"USD","kind":"app_credit_purchase","app_id":"${APP_ID}"}'::jsonb);`,
  );
}
async function seedReferralPayment(): Promise<void> {
  await dbWrite.execute(
    `INSERT INTO crypto_payments
       (id, organization_id, user_id, payment_address, token, network,
        expected_amount, credits_to_add, status, expires_at, metadata)
     VALUES
       ('${PAYMENT_ID}', '${ORG_ID}', '${USER_ID}', '0xpay', 'USDT', 'bsc',
        '10', '10', 'pending', now() + interval '1 hour',
        '{"oxapay_track_id":"track-123","fiat_amount":"10","fiat_currency":"USD"}'::jsonb);`,
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
async function paymentReceivedAmount(): Promise<string | null> {
  const r = await dbWrite.execute(
    `SELECT received_amount FROM crypto_payments WHERE id='${PAYMENT_ID}';`,
  );
  return (r.rows[0] as { received_amount: string | null }).received_amount;
}

beforeAll(async () => {
  try {
    ({ closeDatabaseConnectionsForTests: closeDb, dbWrite } = await import("../../../db/client"));
    ({ cryptoPaymentsRepository } = await import("../../../db/repositories/crypto-payments"));
    ({ cryptoPaymentsService } = await import("../crypto-payments"));
    const ddl = [
      // Full org columns — organizationsRepository.findById selects them all.
      `CREATE TABLE IF NOT EXISTS organizations (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name text NOT NULL DEFAULT 'test-org',
        slug text NOT NULL DEFAULT 'test-org',
        credit_balance numeric(12,6) NOT NULL DEFAULT '0',
        balance_revision bigint NOT NULL DEFAULT 0,
        balance_decrease_revision bigint NOT NULL DEFAULT 0,
        auto_top_up_covered_balance_decrease_revision bigint,
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
      `CREATE UNIQUE INDEX IF NOT EXISTS crypto_payments_active_tx_hash_unique_idx
         ON crypto_payments (transaction_hash)
         WHERE transaction_hash IS NOT NULL
           AND status IN ('pending', 'broadcast', 'confirmed')`,
      `CREATE TABLE IF NOT EXISTS app_charge_callback_outbox (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        delivery_key text NOT NULL UNIQUE,
        charge_request_id uuid NOT NULL,
        payload jsonb NOT NULL,
        payload_digest text NOT NULL,
        state text NOT NULL DEFAULT 'pending',
        attempts integer NOT NULL DEFAULT 0,
        next_attempt_at timestamptz NOT NULL DEFAULT now(),
        claim_token uuid,
        lease_expires_at timestamptz,
        last_error text,
        room_delivered_at timestamptz,
        http_delivered_at timestamptz,
        delivered_at timestamptz,
        terminal_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
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
  await dbWrite.execute(`DELETE FROM app_charge_callback_outbox;`);
  await dbWrite.execute(`DELETE FROM credit_transactions;`);
  await dbWrite.execute(`DELETE FROM crypto_payments;`);
  await dbWrite.execute(`DELETE FROM organizations;`);
  await dbWrite.execute(
    `INSERT INTO organizations (id, credit_balance) VALUES
       ('${ORG_ID}', '0'), ('${OTHER_ORG_ID}', '0');`,
  );
  invoiceCreateShouldThrow = false;
  invoiceCreateSawTransaction = false;
  invoiceCreateCount = 0;
  lastInvoiceAmountPaid = null;
  appPurchaseSawTransaction = false;
  referralShouldThrowAfterWrite = false;
  referralSawTransaction = false;
});

describe("crypto top-up — no double-credit (idempotent + atomic)", () => {
  test(
    "credits exactly once, and a reprocess of the same payment does NOT double-credit",
    async () => {
      if (!pgliteReady) return;
      await seedPendingPayment();

      await cryptoPaymentsService.confirmPayment(PAYMENT_ID, "0xhashA", settlementEvidence());
      expect(await orgBalance()).toBeCloseTo(10, 6);
      expect(await creditRowCount()).toBe(1);

      // Simulate a reprocess: force the row back to 'pending' (as a partial
      // post-credit failure + status revert would) and re-run confirmPayment
      // with the same payment. The stripePaymentIntentId=crypto:<id> dedupe must
      // make the second credit a no-op. (Pre-fix, this double-credited.)
      await dbWrite.execute(
        `UPDATE crypto_payments SET status='pending' WHERE id='${PAYMENT_ID}';`,
      );
      await cryptoPaymentsService.confirmPayment(PAYMENT_ID, "0xhashA", settlementEvidence());

      expect(await creditRowCount()).toBe(1);
      expect(await orgBalance()).toBeCloseTo(10, 6);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "rolls back app-purchase writes when the following invoice leg fails",
    async () => {
      if (!pgliteReady) return;
      await seedAppPurchasePayment();
      invoiceCreateShouldThrow = true;

      await expect(
        cryptoPaymentsService.confirmPayment(PAYMENT_ID, "0xhashApp", settlementEvidence()),
      ).rejects.toThrow("simulated invoice insert conflict");

      expect(appPurchaseSawTransaction).toBe(true);
      expect(await creditRowCount()).toBe(0);
      expect(await orgBalance()).toBeCloseTo(0, 6);
      expect(await paymentStatus()).toBe("pending");
    },
    PGLITE_TIMEOUT,
  );

  test(
    "rolls back payment, org credit, invoice boundary, and referral write on referral failure",
    async () => {
      if (!pgliteReady) return;
      await seedReferralPayment();
      referralShouldThrowAfterWrite = true;

      await expect(
        cryptoPaymentsService.confirmPayment(PAYMENT_ID, "0xhashReferral", settlementEvidence()),
      ).rejects.toThrow("simulated referral failure");

      expect(referralSawTransaction).toBe(true);
      expect(invoiceCreateSawTransaction).toBe(true);
      expect(await creditRowCount()).toBe(0);
      expect(await orgBalance()).toBeCloseTo(0, 6);
      expect(await paymentStatus()).toBe("pending");
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
        cryptoPaymentsService.confirmPayment(PAYMENT_ID, "0xhashB", settlementEvidence()),
      ).rejects.toThrow();

      // Because the credit is granted with db: tx, the invoice failure rolled it
      // back together with the status flip. (Pre-fix, the credit committed on the
      // global connection and survived → orphaned credit + a reprocess double.)
      expect(await creditRowCount()).toBe(0);
      expect(await orgBalance()).toBeCloseTo(0, 6);
      expect(await paymentStatus()).toBe("pending");

      // A clean reprocess now succeeds and credits exactly once.
      invoiceCreateShouldThrow = false;
      await cryptoPaymentsService.confirmPayment(PAYMENT_ID, "0xhashB", settlementEvidence());
      expect(await creditRowCount()).toBe(1);
      expect(await orgBalance()).toBeCloseTo(10, 6);
      expect(await paymentStatus()).toBe("confirmed");
      expect(invoiceCreateSawTransaction).toBe(true);
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

  test(
    "preserves the provider decimal on the payment row and quantizes credits only at ledger precision",
    async () => {
      if (!pgliteReady) return;
      await seedPendingPayment();

      const exactProviderAmount = "10.123456789012345678";
      await dbWrite.execute(
        `UPDATE crypto_payments
         SET expected_amount='${exactProviderAmount}',
             metadata = metadata || '{"fiat_amount":"${exactProviderAmount}"}'::jsonb
         WHERE id='${PAYMENT_ID}'`,
      );
      await cryptoPaymentsService.confirmPayment(
        PAYMENT_ID,
        "0xhashExact",
        settlementEvidence(exactProviderAmount),
      );

      expect(await paymentReceivedAmount()).toBe(exactProviderAmount);
      expect(lastInvoiceAmountPaid).toBe("10.12");
      const rows = await dbWrite.execute(
        `SELECT amount::text AS amount FROM credit_transactions WHERE organization_id='${ORG_ID}';`,
      );
      expect((rows.rows[0] as { amount: string }).amount).toBe("10.123457");
    },
    PGLITE_TIMEOUT,
  );

  test(
    "rejects a confirmed replay whose provider amount or currency differs",
    async () => {
      if (!pgliteReady) return;
      await seedPendingPayment();
      await cryptoPaymentsService.confirmPayment(PAYMENT_ID, "0xhashReplay", settlementEvidence());

      await expect(
        cryptoPaymentsService.confirmPayment(PAYMENT_ID, "0xhashReplay", settlementEvidence("11")),
      ).rejects.toThrow("does not match");
      await expect(
        cryptoPaymentsService.confirmPayment(
          PAYMENT_ID,
          "0xhashReplay",
          settlementEvidence("10", "BTC"),
        ),
      ).rejects.toThrow("does not match");
      expect(await creditRowCount()).toBe(1);
      expect(await orgBalance()).toBeCloseTo(10, 6);
    },
    PGLITE_TIMEOUT,
  );

  test("binds provider track ID, fiat amount, and fiat currency to the stored quote", async () => {
    if (!pgliteReady) return;
    await seedPendingPayment();

    await expect(
      cryptoPaymentsService.confirmPayment(
        PAYMENT_ID,
        "0xquote1",
        settlementEvidence("10", "USDT", "wrong-track"),
      ),
    ).rejects.toThrow("server-stored fiat quote");
    await expect(
      cryptoPaymentsService.confirmPayment(PAYMENT_ID, "0xquote2", settlementEvidence("10.01")),
    ).rejects.toThrow("server-stored fiat quote");
    await expect(
      cryptoPaymentsService.confirmPayment(
        PAYMENT_ID,
        "0xquote3",
        settlementEvidence("10", "USDT", "track-123", "EUR"),
      ),
    ).rejects.toThrow("server-stored fiat quote");
    expect(await paymentStatus()).toBe("pending");
    expect(await creditRowCount()).toBe(0);
  });

  test("confirmed replay re-proves the canonical invoice settlement", async () => {
    if (!pgliteReady) return;
    await seedPendingPayment();
    await cryptoPaymentsService.confirmPayment(PAYMENT_ID, "0xinvoiceReplay", settlementEvidence());
    expect(invoiceCreateCount).toBe(1);

    await cryptoPaymentsService.confirmPayment(PAYMENT_ID, "0xinvoiceReplay", settlementEvidence());
    expect(invoiceCreateCount).toBe(2);
    expect(await creditRowCount()).toBe(1);
  });

  test("confirmed app-purchase replay recovers a missing durable callback intent", async () => {
    if (!pgliteReady) return;
    await dbWrite.execute(
      `INSERT INTO crypto_payments
         (id, organization_id, user_id, payment_address, token, network,
          expected_amount, credits_to_add, status, expires_at, metadata)
       VALUES
         ('${CHARGE_REQUEST_ID}', '${ORG_ID}', '${USER_ID}', 'app-charge', 'USD', 'internal',
          '10', '10', 'pending', now() + interval '1 hour',
          '{"kind":"app_charge_request","app_id":"${APP_ID}","creator_organization_id":"${ORG_ID}"}'::jsonb),
         ('${PAYMENT_ID}', '${ORG_ID}', '${USER_ID}', '0xpay', 'USDT', 'bsc',
          '10', '10', 'pending', now() + interval '1 hour',
          '{"oxapay_track_id":"track-123","fiat_amount":"10","fiat_currency":"USD","kind":"app_credit_purchase","app_id":"${APP_ID}","charge_request_id":"${CHARGE_REQUEST_ID}"}'::jsonb)`,
    );
    await cryptoPaymentsService.confirmPayment(PAYMENT_ID, "0xcallback", settlementEvidence());
    let rows = await dbWrite.execute(`SELECT delivery_key FROM app_charge_callback_outbox`);
    expect(rows.rows).toHaveLength(1);

    await dbWrite.execute(`DELETE FROM app_charge_callback_outbox`);
    await cryptoPaymentsService.confirmPayment(PAYMENT_ID, "0xcallback", settlementEvidence());
    rows = await dbWrite.execute(`SELECT delivery_key FROM app_charge_callback_outbox`);
    expect(rows.rows).toHaveLength(1);
    expect(await creditRowCount()).toBe(1);
  });

  test("one app charge request cannot be purchased by two crypto payments", async () => {
    if (!pgliteReady) return;
    await dbWrite.execute(
      `INSERT INTO crypto_payments
         (id, organization_id, user_id, payment_address, token, network,
          expected_amount, credits_to_add, status, expires_at, metadata)
       VALUES
         ('${CHARGE_REQUEST_ID}', '${ORG_ID}', '${USER_ID}', 'app-charge', 'USD', 'internal',
          '10', '10', 'pending', now() + interval '1 hour',
          '{"kind":"app_charge_request","app_id":"${APP_ID}","creator_organization_id":"${ORG_ID}"}'::jsonb),
         ('${PAYMENT_ID}', '${ORG_ID}', '${USER_ID}', '0xpay-1', 'USDT', 'bsc',
          '10', '10', 'pending', now() + interval '1 hour',
          '{"oxapay_track_id":"track-123","fiat_amount":"10","fiat_currency":"USD","kind":"app_credit_purchase","app_id":"${APP_ID}","charge_request_id":"${CHARGE_REQUEST_ID}"}'::jsonb),
         ('${OTHER_PAYMENT_ID}', '${ORG_ID}', '${USER_ID}', '0xpay-2', 'USDT', 'bsc',
          '10', '10', 'pending', now() + interval '1 hour',
          '{"oxapay_track_id":"track-456","fiat_amount":"10","fiat_currency":"USD","kind":"app_credit_purchase","app_id":"${APP_ID}","charge_request_id":"${CHARGE_REQUEST_ID}"}'::jsonb)`,
    );

    await cryptoPaymentsService.confirmPayment(PAYMENT_ID, "0xappfirst", settlementEvidence());
    await expect(
      cryptoPaymentsService.confirmPayment(
        OTHER_PAYMENT_ID,
        "0xappsecond",
        settlementEvidence("10", "USDT", "track-456"),
      ),
    ).rejects.toThrow("already settled by another payment");

    const second = await dbWrite.execute(
      `SELECT status FROM crypto_payments WHERE id='${OTHER_PAYMENT_ID}'`,
    );
    expect((second.rows[0] as { status: string }).status).toBe("pending");
    expect(await creditRowCount()).toBe(1);
  });

  test(
    "concurrent webhook and manual confirmation converge on one settlement",
    async () => {
      if (!pgliteReady) return;
      await seedPendingPayment();

      const [webhook, manual] = await Promise.all([
        cryptoPaymentsService.handleWebhook({
          track_id: "track-123",
          status: "confirmed",
          txID: "0xhashManual",
        }),
        cryptoPaymentsService.verifyAndConfirmByTxHash(PAYMENT_ID, "0xhashManual"),
      ]);

      expect(webhook.success).toBe(true);
      expect(manual.success).toBe(true);
      expect(await paymentStatus()).toBe("confirmed");
      expect(await creditRowCount()).toBe(1);
      expect(await orgBalance()).toBeCloseTo(10, 6);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "hex transaction-hash casing variants cannot settle two tenants",
    async () => {
      if (!pgliteReady) return;
      await seedPendingPayment();
      await dbWrite.execute(
        `INSERT INTO crypto_payments
           (id, organization_id, user_id, payment_address, token, network,
            expected_amount, credits_to_add, status, expires_at, metadata)
         VALUES
           ('${OTHER_PAYMENT_ID}', '${OTHER_ORG_ID}', NULL, '0xpay2', 'USDT', 'bsc',
            '10', '10', 'pending', now() + interval '1 hour',
            '{"oxapay_track_id":"track-456","fiat_amount":"10","fiat_currency":"USD"}'::jsonb);`,
      );

      const results = await Promise.allSettled([
        cryptoPaymentsService.confirmPayment(PAYMENT_ID, "0xAbCd1234", settlementEvidence()),
        cryptoPaymentsService.confirmPayment(
          OTHER_PAYMENT_ID,
          "0xaBcD1234",
          settlementEvidence("10", "USDT", "track-456"),
        ),
      ]);

      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
      const rows = await dbWrite.execute(
        `SELECT organization_id, transaction_hash FROM crypto_payments WHERE status='confirmed'`,
      );
      expect(rows.rows).toHaveLength(1);
      expect((rows.rows[0] as { transaction_hash: string }).transaction_hash).toBe("0xabcd1234");
      expect(await creditRowCount()).toBe(1);
      const otherBalance = await dbWrite.execute(
        `SELECT credit_balance FROM organizations WHERE id='${OTHER_ORG_ID}'`,
      );
      const balances = [
        await orgBalance(),
        Number((otherBalance.rows[0] as { credit_balance: string }).credit_balance),
      ].sort((left, right) => left - right);
      expect(balances).toEqual([0, 10]);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "repository and settlement service share one canonical EVM transaction identity",
    async () => {
      if (!pgliteReady) return;
      await cryptoPaymentsRepository.create({
        id: OTHER_PAYMENT_ID,
        organization_id: OTHER_ORG_ID,
        payment_address: "0xpay2",
        token: "USDT",
        network: "bsc",
        expected_amount: "10",
        credits_to_add: "10",
        transaction_hash: "0xABCDEF1234",
        status: "broadcast",
        expires_at: new Date(Date.now() + 60_000),
        metadata: {
          oxapay_track_id: "track-456",
          fiat_amount: "10",
          fiat_currency: "USD",
        },
      });
      await seedPendingPayment();

      await expect(
        cryptoPaymentsService.confirmPayment(PAYMENT_ID, "0xabcdef1234", settlementEvidence()),
      ).rejects.toThrow("another payment");
      const existing = await cryptoPaymentsRepository.findById(OTHER_PAYMENT_ID);
      expect(existing?.transaction_hash).toBe("0xabcdef1234");
      expect(await creditRowCount()).toBe(0);
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
