/**
 * Money-path regression for the admin-gated Stripe Connect fiat payout route
 * (#10279 / #10327).
 *
 * The transfer is a compensating saga: debit the redeemable ledger, then push a
 * Stripe transfer, then compensate on failure. Two correctness invariants the
 * fix introduced were previously untested on a live money path:
 *
 *   1. The debit is IDEMPOTENT on `idempotency_key` — the route MUST pass
 *      `dedupeBySourceId: true` with `sourceId === idempotency_key`, so a
 *      same-key retry reuses the prior adjustment while Stripe replays the single
 *      transfer (debited 1×, paid 1×).
 *   2. Compensation is OUTCOME-AWARE. Only a DEFINITIVE Stripe rejection (no
 *      transfer created: invalid-request / auth / permission / rate-limit)
 *      re-credits the balance. An AMBIGUOUS failure (network timeout, Stripe 5xx
 *      — the transfer may have settled) HOLDS the debit and surfaces
 *      `needsReconciliation` rather than minting balance back and double-paying.
 *
 * `handleTransfer` is module-private, so we drive it through the exported Hono
 * router (mirrors agent-a2a-billing.test.ts).
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
// `mock.module` is process-global: spread the real auth module so this file's
// partial mock (only `requireAdmin`) does not drop its other exports for later
// test files in the same run.
import * as workersHonoAuthActual from "@/lib/auth/workers-hono-auth";

const USER_ID = "00000000-0000-4000-8000-0000000000aa";
const IDEMPOTENCY_KEY = "idem_key_0123456789abcdef"; // ≥16 chars (schema min)

const findByUserId = mock();
mock.module(
  "@elizaos/cloud-shared/db/repositories/stripe-connect-accounts",
  () => ({
    stripeConnectAccountsRepository: { findByUserId },
  }),
);

const transferToConnectAccount = mock();
mock.module("@elizaos/cloud-shared/lib/services/stripe-connect-payout", () => ({
  transferToConnectAccount,
}));

const requireAdmin = mock();
mock.module("@/lib/auth/workers-hono-auth", () => ({
  ...workersHonoAuthActual,
  requireAdmin,
}));

mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: { CRITICAL: {} },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

const getBalance = mock();
const reduceEarnings = mock();
const addEarnings = mock();
const hasEarningForSourceId = mock();
mock.module("@/lib/services/redeemable-earnings", () => ({
  redeemableEarningsService: {
    getBalance,
    reduceEarnings,
    addEarnings,
    hasEarningForSourceId,
  },
}));

mock.module("@/lib/stripe", () => ({
  requireStripe: () => ({}),
}));

mock.module("@/lib/utils/logger", () => ({
  logger: { error: mock(), info: mock(), warn: mock() },
}));

const { default: transferRoute } = await import(
  "../v1/earnings/payout/stripe-connect/transfer/route"
);

const app = new Hono();
app.route("/transfer", transferRoute);

function callTransfer(amount = 10) {
  return app.request("/transfer", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      user_id: USER_ID,
      amount,
      idempotency_key: IDEMPOTENCY_KEY,
    }),
  });
}

/** A Stripe-SDK-shaped error: the route narrows on the `type` field. */
function stripeError(type: string): Error & { type: string } {
  return Object.assign(new Error(`stub ${type}`), { type });
}

beforeEach(() => {
  findByUserId.mockReset();
  transferToConnectAccount.mockReset();
  requireAdmin.mockReset();
  getBalance.mockReset();
  reduceEarnings.mockReset();
  addEarnings.mockReset();
  hasEarningForSourceId.mockReset();

  requireAdmin.mockResolvedValue({ userId: "admin-1" });
  findByUserId.mockResolvedValue({
    stripe_connect_account_id: "acct_123",
    status: "active",
    payouts_enabled: true,
  });
  getBalance.mockResolvedValue({
    availableBalance: 100,
    totalEarned: 100,
    totalRedeemed: 0,
    totalPending: 0,
    breakdown: { miniapps: 0, agents: 0, mcps: 0 },
  });
  reduceEarnings.mockResolvedValue({
    success: true,
    newBalance: 90,
    ledgerEntryId: "led_1",
  });
  addEarnings.mockResolvedValue({ success: true, newBalance: 100 });
  hasEarningForSourceId.mockResolvedValue(false);
});

describe("Stripe Connect transfer route — money-path invariants (#10279)", () => {
  test("debits idempotently (dedupeBySourceId on idempotency_key) and transfers once on success", async () => {
    transferToConnectAccount.mockResolvedValue({
      transferId: "tr_1",
      amountCents: 1000,
    });

    const res = await callTransfer(10);
    const body = (await res.json()) as {
      success: boolean;
      transferId?: string;
    };

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.transferId).toBe("tr_1");

    // The idempotency contract: debit keyed on idempotency_key, deduped.
    expect(reduceEarnings).toHaveBeenCalledTimes(1);
    const debitArg = reduceEarnings.mock.calls[0]?.[0] as {
      sourceId: string;
      dedupeBySourceId: boolean;
      requireSufficientBalance: boolean;
    };
    expect(debitArg.sourceId).toBe(IDEMPOTENCY_KEY);
    expect(debitArg.dedupeBySourceId).toBe(true);
    expect(debitArg.requireSufficientBalance).toBe(true);
    // Success path never compensates.
    expect(addEarnings).not.toHaveBeenCalled();
  });

  test("DEFINITIVE Stripe rejection re-credits the balance (idempotent refund) and 502s", async () => {
    transferToConnectAccount.mockRejectedValue(
      stripeError("StripeInvalidRequestError"),
    );

    const res = await callTransfer(10);
    const body = (await res.json()) as {
      success: boolean;
      error: string;
      needsReconciliation?: boolean;
    };

    expect(res.status).toBe(502);
    expect(body.success).toBe(false);
    expect(body.error).toBe("Transfer rejected; balance restored");
    expect(body.needsReconciliation).toBeUndefined();

    // Compensation: a single idempotent refund keyed on `${key}:refund`.
    expect(addEarnings).toHaveBeenCalledTimes(1);
    const refundArg = addEarnings.mock.calls[0]?.[0] as {
      sourceId: string;
      dedupeBySourceId: boolean;
      amount: number;
    };
    expect(refundArg.sourceId).toBe(`${IDEMPOTENCY_KEY}:refund`);
    expect(refundArg.dedupeBySourceId).toBe(true);
    expect(refundArg.amount).toBe(10);
  });

  test("refunded same-key retry is blocked before a fresh Stripe transfer", async () => {
    reduceEarnings.mockResolvedValue({
      success: true,
      newBalance: 100,
      ledgerEntryId: "led_original_debit",
      deduplicated: true,
    });
    hasEarningForSourceId.mockResolvedValue(true);

    const res = await callTransfer(10);
    const body = (await res.json()) as {
      success: boolean;
      error: string;
      requiresFreshIdempotencyKey?: boolean;
    };

    expect(res.status).toBe(409);
    expect(body.success).toBe(false);
    expect(body.error).toBe(
      "Prior payout attempt was rejected and refunded; use a fresh idempotency_key",
    );
    expect(body.requiresFreshIdempotencyKey).toBe(true);
    expect(hasEarningForSourceId).toHaveBeenCalledWith({
      userId: USER_ID,
      source: "creator_revenue_share",
      sourceId: `${IDEMPOTENCY_KEY}:refund`,
    });
    expect(transferToConnectAccount).not.toHaveBeenCalled();
    expect(addEarnings).not.toHaveBeenCalled();
  });

  test("deduped same-key retry without refund still reaches Stripe idempotency replay", async () => {
    reduceEarnings.mockResolvedValue({
      success: true,
      newBalance: 90,
      ledgerEntryId: "led_original_debit",
      deduplicated: true,
    });
    hasEarningForSourceId.mockResolvedValue(false);
    transferToConnectAccount.mockResolvedValue({
      transferId: "tr_replayed",
      amountCents: 1000,
    });

    const res = await callTransfer(10);
    const body = (await res.json()) as {
      success: boolean;
      transferId?: string;
      newBalance?: number;
    };

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.transferId).toBe("tr_replayed");
    expect(body.newBalance).toBe(90);
    expect(transferToConnectAccount).toHaveBeenCalledTimes(1);
    expect(addEarnings).not.toHaveBeenCalled();
  });

  test("AMBIGUOUS Stripe failure (5xx) HOLDS the debit — no re-credit, needsReconciliation", async () => {
    transferToConnectAccount.mockRejectedValue(
      stripeError("StripeConnectionError"),
    );

    const res = await callTransfer(10);
    const body = (await res.json()) as {
      success: boolean;
      needsReconciliation?: boolean;
    };

    expect(res.status).toBe(502);
    expect(body.success).toBe(false);
    expect(body.needsReconciliation).toBe(true);
    // Critically: the balance is NOT minted back on an uncertain outcome.
    expect(addEarnings).not.toHaveBeenCalled();
  });

  test("AMBIGUOUS non-Stripe error (no type) also HOLDS the debit", async () => {
    transferToConnectAccount.mockRejectedValue(new Error("network timeout"));

    const res = await callTransfer(10);
    const body = (await res.json()) as { needsReconciliation?: boolean };

    expect(res.status).toBe(502);
    expect(body.needsReconciliation).toBe(true);
    expect(addEarnings).not.toHaveBeenCalled();
  });

  test("a failed debit short-circuits before any transfer (409, no Stripe call)", async () => {
    reduceEarnings.mockResolvedValue({
      success: false,
      newBalance: 100,
      ledgerEntryId: "",
      error: "Insufficient redeemable balance",
    });

    const res = await callTransfer(10);
    expect(res.status).toBe(409);
    expect(transferToConnectAccount).not.toHaveBeenCalled();
    expect(addEarnings).not.toHaveBeenCalled();
  });
});
