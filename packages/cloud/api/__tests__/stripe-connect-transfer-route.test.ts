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
const hasEarningBySourceId = mock();
mock.module("@/lib/services/redeemable-earnings", () => ({
  redeemableEarningsService: {
    getBalance,
    reduceEarnings,
    addEarnings,
    hasEarningBySourceId,
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
  hasEarningBySourceId.mockReset();
  // Default: no prior compensating refund exists (the common case).
  hasEarningBySourceId.mockResolvedValue(false);

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

  // #11022: a DEDUPLICATED debit whose key was already rejected + refunded must
  // NOT fire a fresh transfer (that double-pays: fiat out + balance kept).
  test("refuses a same-key retry after a rejected+refunded attempt (deduplicated debit + existing :refund → 409, no transfer)", async () => {
    reduceEarnings.mockResolvedValue({
      success: true,
      newBalance: 100, // balance unchanged: the dedup reused the prior (rolled-back) adjustment
      ledgerEntryId: "led_1",
      deduplicated: true,
    });
    // A compensating `${key}:refund` earning from the definitively-rejected first
    // attempt exists → the debit no longer holds funds.
    hasEarningBySourceId.mockResolvedValue(true);

    const res = await callTransfer(10);
    const body = (await res.json()) as { success: boolean; error: string };

    expect(res.status).toBe(409);
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/fresh idempotency_key/i);
    // The critical invariant: NO fresh transfer, so no double-pay.
    expect(transferToConnectAccount).not.toHaveBeenCalled();
    expect(addEarnings).not.toHaveBeenCalled();
    // It checked the refund marker keyed on `${key}:refund`.
    const checkArg = hasEarningBySourceId.mock.calls[0]?.[0] as {
      sourceId: string;
      source: string;
    };
    expect(checkArg.sourceId).toBe(`${IDEMPOTENCY_KEY}:refund`);
    expect(checkArg.source).toBe("creator_revenue_share");
  });

  // The legitimate ambiguous-retry path must still work: a deduplicated debit
  // with NO prior refund is Stripe's own transfer-idempotency replaying the
  // single transfer — it must proceed (debited 1×, paid 1×), not be blocked.
  test("still proceeds on a deduplicated debit when no refund exists (ambiguous-timeout retry, Stripe replays)", async () => {
    reduceEarnings.mockResolvedValue({
      success: true,
      newBalance: 90,
      ledgerEntryId: "led_1",
      deduplicated: true,
    });
    hasEarningBySourceId.mockResolvedValue(false); // no compensating refund
    transferToConnectAccount.mockResolvedValue({
      transferId: "tr_replay",
      amountCents: 1000,
    });

    const res = await callTransfer(10);
    const body = (await res.json()) as {
      success: boolean;
      transferId?: string;
    };

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.transferId).toBe("tr_replay");
    expect(transferToConnectAccount).toHaveBeenCalledTimes(1);
  });
});
