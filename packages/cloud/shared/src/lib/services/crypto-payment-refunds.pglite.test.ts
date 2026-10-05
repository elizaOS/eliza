/**
 * Crypto and x402 payments are refundable only as Cloud credits (#22968).
 * Exercises the real refund service and credit ledger on PGlite.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";

const ORG = "71000000-0000-4000-8000-000000022968";
const OTHER_ORG = "71000000-0000-4000-8000-000000022969";
const WALLET_PAYMENT = "72000000-0000-4000-8000-000000000001";
const X402_PAYMENT = "72000000-0000-4000-8000-000000000002";

let database: typeof import("../../db/client");
let service: typeof import("./crypto-payment-refunds").cryptoPaymentRefundsService;
let CryptoRefundError: typeof import("./crypto-payment-refunds").CryptoRefundError;

async function exec(query: string): Promise<void> {
  await database.getPgliteClientForTests().exec(query);
}

async function query<T>(text: string): Promise<T[]> {
  return (await database.getPgliteClientForTests().query<T>(text)).rows;
}

const refund = (overrides: Record<string, unknown> = {}) =>
  service.refundAsCloudCredits({
    paymentId: WALLET_PAYMENT,
    organizationId: ORG,
    amountUsd: "4",
    refundKey: "support-ticket-1",
    reason: "Gross overpayment rejected by verification",
    operatorUserId: "operator",
    destination: "cloud_credits",
    ...overrides,
  } as Parameters<typeof service.refundAsCloudCredits>[0]);

beforeAll(async () => {
  database = await import("../../db/client");
  await exec(`
    CREATE TABLE organizations (
      id uuid PRIMARY KEY,
      credit_balance numeric(16,6) NOT NULL DEFAULT 0,
      settings jsonb DEFAULT '{}'::jsonb,
      updated_at timestamp DEFAULT now()
    );
    CREATE TABLE credit_transactions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL REFERENCES organizations(id),
      user_id uuid,
      amount numeric(16,6) NOT NULL,
      type text NOT NULL,
      description text,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      stripe_payment_intent_id text UNIQUE,
      created_at timestamp NOT NULL DEFAULT now(),
      settled_at timestamp
    );
    CREATE TABLE crypto_payments (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL REFERENCES organizations(id),
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
      expires_at timestamp NOT NULL DEFAULT now(),
      metadata jsonb DEFAULT '{}'::jsonb
    );
  `);
  ({ cryptoPaymentRefundsService: service, CryptoRefundError } = await import(
    "./crypto-payment-refunds"
  ));
}, 120_000);

beforeEach(async () => {
  await exec(`
    DELETE FROM credit_transactions;
    DELETE FROM crypto_payments;
    DELETE FROM organizations;
    INSERT INTO organizations (id) VALUES ('${ORG}'), ('${OTHER_ORG}');
    INSERT INTO crypto_payments (id, organization_id, payment_address, token, network, expected_amount, credits_to_add, status, metadata)
    VALUES
      ('${WALLET_PAYMENT}', '${ORG}', '0xreceive', 'BNB', 'bsc', '10', '15.00', 'confirmed',
        '{"provider":"wallet_native","paid_amount_usd":"10.00","bonus_credits":5}'),
      ('${X402_PAYMENT}', '${ORG}', '0xpayto', 'USDC', 'eip155:8453', '2000000', '2.0000', 'confirmed',
        '{"kind":"x402_payment_request","totalChargedUsd":2}');
    UPDATE crypto_payments SET confirmed_at = now();
  `);
});

afterAll(async () => {
  if (database) await database.closeDatabaseConnectionsForTests();
});

describe("crypto and x402 refunds (#22968)", () => {
  test("on-chain and fiat refunds are refused before any ledger write", async () => {
    for (const destination of ["on_chain", "fiat", "original_payment_method"]) {
      for (const paymentId of [WALLET_PAYMENT, X402_PAYMENT]) {
        const error = await refund({ destination, paymentId }).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(CryptoRefundError);
        expect(error).toMatchObject({ code: "CRYPTO_REFUND_DESTINATION_NOT_ALLOWED" });
      }
    }
    expect(await query("SELECT id FROM credit_transactions")).toEqual([]);
  });

  test("quoted but unsettled payments cannot mint refund credits", async () => {
    for (const status of ["pending", "broadcast", "failed", "expired"]) {
      await exec(`UPDATE crypto_payments SET status = '${status}' WHERE id = '${WALLET_PAYMENT}'`);
      await expect(refund()).rejects.toMatchObject({ code: "CRYPTO_REFUND_PAYMENT_NOT_CONFIRMED" });
    }
    await exec(
      `UPDATE crypto_payments SET status = 'confirmed', confirmed_at = NULL WHERE id = '${WALLET_PAYMENT}'`,
    );
    await expect(refund()).rejects.toMatchObject({ code: "CRYPTO_REFUND_PAYMENT_NOT_CONFIRMED" });
    expect(await query("SELECT id FROM credit_transactions")).toEqual([]);
  });

  test("refunds are Cloud credits, capped at the paid USD and never the promo bonus", async () => {
    const first = await refund();
    expect(first).toMatchObject({
      amountUsd: "4.000000",
      refundedTotalUsd: "4.000000",
      refundableUsd: "10.000000",
      replayed: false,
    });
    const replay = await refund();
    expect(replay).toMatchObject({ transactionId: first.transactionId, replayed: true });

    await expect(
      refund({ refundKey: "support-ticket-2", amountUsd: "6.01" }),
    ).rejects.toMatchObject({ code: "CRYPTO_REFUND_EXCEEDS_PAYMENT" });
    await refund({ refundKey: "support-ticket-2", amountUsd: "6" });

    const rows = await query<{ type: string; amount: string; metadata: Record<string, unknown> }>(
      "SELECT type, amount::text AS amount, metadata FROM credit_transactions ORDER BY created_at",
    );
    expect(rows.map((row) => [row.type, row.amount])).toEqual([
      ["refund", "4.000000"],
      ["refund", "6.000000"],
    ]);
    expect(rows[0]?.metadata).toMatchObject({
      type: "crypto_payment_refund",
      payment_rail: "crypto",
      refund_destination: "cloud_credits",
      refunded_crypto_payment_id: WALLET_PAYMENT,
    });
    const [balance] = await query<{ credit_balance: string }>(
      `SELECT credit_balance::text AS credit_balance FROM organizations WHERE id = '${ORG}'`,
    );
    expect(balance?.credit_balance).toBe("10.000000");
  });

  test("a malformed or reused refund key is reported as a key problem, not an amount problem", async () => {
    await expect(refund({ refundKey: "k" })).rejects.toMatchObject({
      code: "CRYPTO_REFUND_INVALID_KEY",
      message: "Refund key is invalid",
    });
    await expect(refund({ refundKey: "bad key with spaces" })).rejects.toMatchObject({
      code: "CRYPTO_REFUND_INVALID_KEY",
    });
    expect(await query("SELECT id FROM credit_transactions")).toEqual([]);

    await refund({ refundKey: "support-ticket-3", amountUsd: "2" });
    await expect(refund({ refundKey: "support-ticket-3", amountUsd: "3" })).rejects.toMatchObject({
      code: "CRYPTO_REFUND_KEY_AMOUNT_MISMATCH",
      message: "Refund key was already used for a different amount",
      context: { paymentId: WALLET_PAYMENT },
    });
    await expect(refund({ amountUsd: "0" })).rejects.toMatchObject({
      code: "CRYPTO_REFUND_INVALID_AMOUNT",
    });
    const rows = await query<{ amount: string }>(
      "SELECT amount::text AS amount FROM credit_transactions",
    );
    expect(rows).toEqual([{ amount: "2.000000" }]);
  });

  test("x402 payment requests are refused: the record belongs to the payee, not the payer", async () => {
    // The seeded x402 row is owned by ORG, the organization that created the
    // payment request and was paid for it; the payer is an external wallet.
    for (const organizationId of [ORG, OTHER_ORG]) {
      await expect(
        refund({
          paymentId: X402_PAYMENT,
          organizationId,
          amountUsd: "2",
          refundKey: "x402-ticket-1",
        }),
      ).rejects.toMatchObject({ code: "CRYPTO_REFUND_X402_PAYER_UNBOUND" });
    }
    expect(await query("SELECT id FROM credit_transactions")).toEqual([]);
    const [payee] = await query<{ credit_balance: string }>(
      `SELECT credit_balance::text AS credit_balance FROM organizations WHERE id = '${ORG}'`,
    );
    expect(Number(payee?.credit_balance ?? 0)).toBe(0);
  });
});
