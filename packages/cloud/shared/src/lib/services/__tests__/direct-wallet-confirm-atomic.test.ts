/**
 * Real-DB proof that the direct-wallet credit grant is ATOMIC with the
 * status="confirmed" flip in `DirectWalletPaymentsService.confirmPayment`.
 *
 * The bug (F1): the confirmation transaction flipped the row to
 * status="confirmed" and COMMITTED, and only then granted the credits via
 * `creditsService.addCredits` on the global connection. If addCredits threw,
 * the row was durably `confirmed` with zero credits — and the recovery cron
 * (`processBroadcastBatch`) only re-selects `status='broadcast'` rows, so a
 * paid on-chain deposit sat uncredited forever. The fix moves the grant
 * INSIDE the transaction (`db: tx`), so grant + status flip commit or roll
 * back together (same pattern the plain crypto top-up path already uses).
 *
 * These run the REAL confirmPayment against in-process PGlite (real SQL: the
 * SELECT … FOR UPDATE, the status transition, the WITH-CTE credit insert +
 * balance update). Only the on-chain verify layer (viem) and the post-tx
 * invoice side-effect are stubbed — the payment row is created by the real
 * createPayment (real HMAC quote signature) and the credits land through the
 * real addCredits unless a test arms a one-shot failure to exercise the
 * rollback. Fails loudly (via the `pgliteReady` guard) if PGlite ever fails
 * to initialize — never a silent skip.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import * as actualViem from "viem";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.CRYPTO_DIRECT_BSC_RECEIVE_ADDRESS = "0x0000000000000000000000000000000000000b5c";
process.env.CRYPTO_DIRECT_BSC_RPC_URL = "http://mocked-bsc";
process.env.CRYPTO_DIRECT_QUOTE_SIGNING_KEY = "test-signing-key-deadbeef";

const ORG_ID = "00000000-0000-4000-8000-0000000000e1";
const USER_ID = "00000000-0000-4000-8000-0000000000e2";
const PAYER_EVM = "0x1111111111111111111111111111111111111111";
const PGLITE_TIMEOUT = 60000;

// Chain stub (adapted from direct-wallet-payments.integration.test.ts, whose
// vi.mock plumbing is vitest-only): register one synthetic USDT Transfer per
// tx hash; the mocked public client + parseEventLogs replay it so the on-chain
// verify inside confirmPayment deterministically reaches the credit grant.
interface FakeTransfer {
  tokenAddress: string;
  from: string;
  to: string;
  value: bigint;
}
const chainTxs = new Map<string, FakeTransfer>();

mock.module("viem", () => ({
  ...actualViem,
  createPublicClient: () => ({
    async getTransactionReceipt({ hash }: { hash: string }) {
      const transfer = chainTxs.get(hash);
      if (!transfer) {
        const err = new Error("Transaction receipt not found");
        err.name = "TransactionReceiptNotFoundError";
        throw err;
      }
      return {
        status: "success",
        blockNumber: 12345n,
        logs: [{ address: transfer.tokenAddress }],
      };
    },
  }),
  parseEventLogs: ({ logs }: { logs: Array<{ address: string }> }) =>
    logs.flatMap((log) => {
      for (const transfer of chainTxs.values()) {
        if (transfer.tokenAddress.toLowerCase() === log.address.toLowerCase()) {
          return [
            {
              address: transfer.tokenAddress,
              args: { from: transfer.from, to: transfer.to, value: transfer.value },
            },
          ];
        }
      }
      return [];
    }),
}));

// Invoice creation runs after the confirmation tx and is not under test here
// (it has its own idempotency); stub it to avoid unrelated table DDL.
mock.module("../invoices", () => ({
  invoicesService: {
    async getByStripeInvoiceId() {
      return undefined;
    },
    async create() {
      return { id: "invoice-stub" };
    },
  },
}));

let dbWrite: typeof import("../../../db/client").dbWrite;
let closeDb: typeof import("../../../db/client").closeDatabaseConnectionsForTests | undefined;
let service: typeof import("../direct-wallet-payments").directWalletPaymentsService;
let creditsService: typeof import("../credits").creditsService;
let pgliteReady = true;

// One-shot failure injection for the atomicity proof: the REAL addCredits runs
// unless armed, in which case the next call throws — simulating a credit-grant
// infra failure inside the confirmation transaction. confirmPayment itself is
// never mocked.
let addCreditsFailuresToInject = 0;

const env = process.env as Record<string, string>;

async function orgBalance(): Promise<number> {
  const r = await dbWrite.execute(`SELECT credit_balance FROM organizations WHERE id='${ORG_ID}';`);
  return Number((r.rows[0] as { credit_balance: string }).credit_balance);
}
async function creditRowCount(paymentId: string): Promise<number> {
  const r = await dbWrite.execute(
    `SELECT count(*)::int AS n FROM credit_transactions
     WHERE stripe_payment_intent_id='wallet_native:${paymentId}';`,
  );
  return (r.rows[0] as { n: number }).n;
}
async function paymentStatus(paymentId: string): Promise<string> {
  const r = await dbWrite.execute(`SELECT status FROM crypto_payments WHERE id='${paymentId}';`);
  return (r.rows[0] as { status: string }).status;
}

// Creates a real BSC-USDT payment via the service (real quote signature),
// stamps the server-written "already verified" payer-proof metadata (same
// shortcut as the integration test — we drive the money path, not the proof),
// and registers a matching on-chain Transfer for `txHash`.
async function createConfirmablePayment(txHash: string) {
  const { payment } = await service.createPayment(env, {
    organizationId: ORG_ID,
    userId: USER_ID,
    accountWalletAddress: null,
    payerAddress: PAYER_EVM,
    amountUsd: 10,
    network: "bsc",
    tokenSymbol: "USDT",
  });
  const patch = JSON.stringify({
    payer_proof_verified_at: "2026-07-01T20:00:00.000Z",
    payer_proof_address: PAYER_EVM.toLowerCase(),
    payer_proof_scheme: "evm-eip712",
  });
  await dbWrite.execute(
    `UPDATE crypto_payments
     SET metadata = COALESCE(metadata, '{}'::jsonb) || '${patch}'::jsonb
     WHERE id = '${payment.id}';`,
  );
  const meta = payment.metadata as Record<string, unknown>;
  chainTxs.set(txHash, {
    tokenAddress: meta.token_address as string,
    from: PAYER_EVM,
    to: env.CRYPTO_DIRECT_BSC_RECEIVE_ADDRESS,
    value: BigInt(meta.expected_token_units as string),
  });
  return payment;
}

beforeAll(async () => {
  try {
    ({ closeDatabaseConnectionsForTests: closeDb, dbWrite } = await import("../../../db/client"));
    ({ directWalletPaymentsService: service } = await import("../direct-wallet-payments"));
    ({ creditsService } = await import("../credits"));

    const realAddCredits = creditsService.addCredits.bind(creditsService);
    creditsService.addCredits = async (params) => {
      if (addCreditsFailuresToInject > 0) {
        addCreditsFailuresToInject -= 1;
        throw new Error("simulated addCredits failure");
      }
      return realAddCredits(params);
    };

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
    console.warn("[direct-wallet-confirm-atomic] PGlite unavailable, skipping:", error);
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
  chainTxs.clear();
  addCreditsFailuresToInject = 0;
});

describe("direct-wallet confirmPayment — credit grant is atomic with the status flip", () => {
  test(
    "a failed in-tx credit grant rolls the WHOLE confirmation back — never confirmed-without-credits",
    async () => {
      if (!pgliteReady) return;
      const hash = `0x${"a".repeat(64)}`;
      const payment = await createConfirmablePayment(hash);

      addCreditsFailuresToInject = 1;
      await expect(
        service.confirmPayment(env, { paymentId: payment.id, txHash: hash, userId: USER_ID }),
      ).rejects.toThrow(/simulated addCredits failure/);

      // The regression: pre-fix, the transaction had already committed
      // status='confirmed' before addCredits ran, so the failure stranded a
      // durably confirmed row with ZERO credits — invisible to the recovery
      // cron, which only re-selects 'broadcast' rows. Post-fix, grant and
      // status flip roll back together.
      expect(await paymentStatus(payment.id)).toBe("pending");
      expect(await creditRowCount(payment.id)).toBe(0);
      expect(await orgBalance()).toBeCloseTo(0, 6);

      // The deposit stays recoverable: a clean retry confirms and credits.
      await service.confirmPayment(env, { paymentId: payment.id, txHash: hash, userId: USER_ID });
      expect(await paymentStatus(payment.id)).toBe("confirmed");
      expect(await creditRowCount(payment.id)).toBe(1);
      expect(await orgBalance()).toBeCloseTo(10, 6);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "happy path: confirm flips status and grants exactly one credit row with the right amount",
    async () => {
      if (!pgliteReady) return;
      const hash = `0x${"b".repeat(64)}`;
      const payment = await createConfirmablePayment(hash);

      const result = await service.confirmPayment(env, {
        paymentId: payment.id,
        txHash: hash,
        userId: USER_ID,
      });
      expect(result.alreadyConfirmed).toBe(false);
      expect(await paymentStatus(payment.id)).toBe("confirmed");
      expect(await creditRowCount(payment.id)).toBe(1);
      const r = await dbWrite.execute(
        `SELECT amount, type FROM credit_transactions
         WHERE stripe_payment_intent_id='wallet_native:${payment.id}';`,
      );
      const row = r.rows[0] as { amount: string; type: string };
      expect(Number(row.amount)).toBeCloseTo(10, 6);
      expect(row.type).toBe("credit");
      expect(await orgBalance()).toBeCloseTo(10, 6);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "re-confirm does not double-credit — neither via alreadyConfirmed nor via a forced re-run",
    async () => {
      if (!pgliteReady) return;
      const hash = `0x${"c".repeat(64)}`;
      const payment = await createConfirmablePayment(hash);

      await service.confirmPayment(env, { paymentId: payment.id, txHash: hash, userId: USER_ID });
      const second = await service.confirmPayment(env, {
        paymentId: payment.id,
        txHash: hash,
        userId: USER_ID,
      });
      expect(second.alreadyConfirmed).toBe(true);
      expect(await creditRowCount(payment.id)).toBe(1);
      expect(await orgBalance()).toBeCloseTo(10, 6);

      // Even if the row is forced back into a re-processable state (ops edit,
      // partial revert), the wallet_native:<id> SQL dedupe inside addCredits
      // keeps the re-run grant a no-op.
      await dbWrite.execute(
        `UPDATE crypto_payments SET status='broadcast' WHERE id='${payment.id}';`,
      );
      await service.confirmPayment(env, { paymentId: payment.id, txHash: hash, userId: USER_ID });
      expect(await paymentStatus(payment.id)).toBe("confirmed");
      expect(await creditRowCount(payment.id)).toBe(1);
      expect(await orgBalance()).toBeCloseTo(10, 6);
    },
    PGLITE_TIMEOUT,
  );
});

// Loud guard: PGlite is in-process (no network), so `pgliteReady` must be true.
// If PGlite/DDL ever fails to init, the DB-dependent tests above early-return;
// this turns that silent no-op into a hard CI failure so a money-path proof can
// never masquerade as a vacuous green.
test("pglite schema applied — never a silent skip", () => {
  expect(pgliteReady).toBe(true);
});
