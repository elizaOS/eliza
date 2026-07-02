/**
 * #8253 — app purchases and app inference must share ONE ledger: the
 * purchasing user's ORGANIZATION credit balance.
 *
 * Before the fix, `processPurchase` credited the per-app
 * `app_credit_balances` pool while `deductCredits` debited the org balance,
 * so purchased credits were stranded (money paid, credits never spendable).
 * These tests pin the unified-ledger behavior end to end at the service
 * seam: purchase credits the org, dedup reports the org, spend debits the
 * org, and creator revenue-share still records.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

const findTransactionByPaymentIntent = mock();
const createTransaction = mock();
const addPurchaseEarnings = mock();
const addInferenceEarnings = mock();

mock.module("../../../db/repositories/app-earnings", () => ({
  appEarningsRepository: {
    findTransactionByPaymentIntent,
    createTransaction,
    addPurchaseEarnings,
    addInferenceEarnings,
  },
}));

const findAppById = mock();
const trackAppUserActivity = mock();

mock.module("../../../db/repositories/apps", () => ({
  appsRepository: {
    findById: findAppById,
    trackAppUserActivity,
  },
}));

const findOrgById = mock();

mock.module("../../../db/repositories/organizations", () => ({
  organizationsRepository: {
    findById: findOrgById,
  },
}));

const findUserById = mock();

mock.module("../../../db/repositories/users", () => ({
  usersRepository: {
    findById: findUserById,
  },
}));

const addCredits = mock();
const reserveAndDeductCredits = mock();
const refundCredits = mock();
const markReservationSettled = mock();

class MockInsufficientCreditsError extends Error {
  constructor(
    public readonly required: number,
    public readonly available: number,
    public readonly reason?: string,
  ) {
    super(
      `Insufficient credits. Required: $${required.toFixed(4)}, Available: $${available.toFixed(4)}`,
    );
    this.name = "InsufficientCreditsError";
  }
}

mock.module("../credits", () => ({
  InsufficientCreditsError: MockInsufficientCreditsError,
  // Must mirror the real export — app-credits.ts imports it for the $0-estimate
  // floor; a missing export would break the module link under this mock.
  MIN_RESERVATION: 0.000001,
  creditsService: {
    addCredits,
    reserveAndDeductCredits,
    refundCredits,
    markReservationSettled,
  },
}));

const addEarnings = mock();
const reduceEarnings = mock();

mock.module("../redeemable-earnings", () => ({
  redeemableEarningsService: {
    addEarnings,
    reduceEarnings,
  },
}));

const whereMock = mock();
const setMock = mock(() => ({ where: whereMock }));
const updateMock = mock(() => ({ set: setMock }));

mock.module("../../../db/helpers", () => ({
  dbWrite: { update: updateMock },
}));

const cacheGet = mock(async () => null);
const cacheSet = mock(async () => undefined);
const cacheDel = mock(async () => undefined);

mock.module("../../cache/client", () => ({
  cache: {
    get: cacheGet,
    set: cacheSet,
    del: cacheDel,
    delete: cacheDel,
  },
}));

const { AppCreditsService } = await import("../app-credits");

const APP_ID = "app-1";
const USER_ID = "user-1";
const ORG_ID = "org-1";

const monetizedApp = {
  id: APP_ID,
  name: "SupaKan",
  monetization_enabled: true,
  platform_offset_amount: "1.00",
  purchase_share_percentage: "20",
  inference_markup_percentage: "10",
  created_by_user_id: "creator-1",
};

function freshService() {
  return new AppCreditsService();
}

beforeEach(() => {
  findTransactionByPaymentIntent.mockReset();
  createTransaction.mockReset();
  addPurchaseEarnings.mockReset();
  addInferenceEarnings.mockReset();
  findAppById.mockReset();
  trackAppUserActivity.mockReset();
  findOrgById.mockReset();
  findUserById.mockReset();
  addCredits.mockReset();
  reserveAndDeductCredits.mockReset();
  refundCredits.mockReset();
  markReservationSettled.mockReset();
  addEarnings.mockReset();
  reduceEarnings.mockReset();
  updateMock.mockClear();
  cacheGet.mockReset();
  cacheSet.mockReset();
  cacheDel.mockReset();
  cacheGet.mockResolvedValue(null);
  cacheSet.mockResolvedValue(undefined);
  cacheDel.mockResolvedValue(undefined);

  findAppById.mockResolvedValue(monetizedApp);
  findUserById.mockResolvedValue({ id: USER_ID, organization_id: ORG_ID });
  findOrgById.mockResolvedValue({ id: ORG_ID, credit_balance: "42.50" });
  findTransactionByPaymentIntent.mockResolvedValue(null);
  addCredits.mockResolvedValue({ transaction: { id: "tx-1" }, newBalance: 52.5 });
  reserveAndDeductCredits.mockResolvedValue({
    success: true,
    newBalance: 41.4,
    transaction: { id: "tx-2" },
  });
  refundCredits.mockResolvedValue({ newBalance: 43.6 });
  markReservationSettled.mockResolvedValue(true);
  addEarnings.mockResolvedValue({ success: true });
  reduceEarnings.mockResolvedValue({ success: true });
  trackAppUserActivity.mockResolvedValue(undefined);
  createTransaction.mockResolvedValue(undefined);
  addPurchaseEarnings.mockResolvedValue(undefined);
});

describe("processPurchase — funds the org ledger (#8253)", () => {
  test("credits the purchasing user's org balance with the full purchase amount", async () => {
    const result = await freshService().processPurchase({
      appId: APP_ID,
      userId: USER_ID,
      organizationId: ORG_ID,
      purchaseAmount: 10,
      stripePaymentIntentId: "pi_123",
    });

    expect(addCredits).toHaveBeenCalledTimes(1);
    const args = addCredits.mock.calls[0][0];
    expect(args.organizationId).toBe(ORG_ID);
    expect(args.amount).toBe(10); // full purchase — user gets every credit
    expect(args.stripePaymentIntentId).toBe("pi_123");

    expect(result.success).toBe(true);
    expect(result.creditsAdded).toBe(10);
    expect(result.newBalance).toBe(52.5); // the ORG balance from creditsService
  });

  test("still records creator purchase-share revenue on the monetized app", async () => {
    const result = await freshService().processPurchase({
      appId: APP_ID,
      userId: USER_ID,
      organizationId: ORG_ID,
      purchaseAmount: 10,
      stripePaymentIntentId: "pi_123",
    });

    // (10 - 1.00 offset) * 20% = 1.80
    expect(result.platformOffset).toBe(1);
    expect(result.creatorEarnings).toBeCloseTo(1.8, 10);
    expect(addPurchaseEarnings).toHaveBeenCalledWith(APP_ID, expect.closeTo(1.8, 10));
    expect(addEarnings).toHaveBeenCalledTimes(1);
  });

  test("webhook retry dedup returns the org balance without re-crediting", async () => {
    findTransactionByPaymentIntent.mockResolvedValue({ id: "existing-tx" });

    const result = await freshService().processPurchase({
      appId: APP_ID,
      userId: USER_ID,
      organizationId: ORG_ID,
      purchaseAmount: 10,
      stripePaymentIntentId: "pi_123",
    });

    expect(addCredits).not.toHaveBeenCalled();
    expect(result.creditsAdded).toBe(0);
    expect(result.newBalance).toBe(42.5); // read straight off the org row
  });
});

describe("deductCredits — debits the same org ledger", () => {
  test("purchase and spend round-trip through one ledger", async () => {
    const service = freshService();

    await service.processPurchase({
      appId: APP_ID,
      userId: USER_ID,
      organizationId: ORG_ID,
      purchaseAmount: 10,
    });
    const spend = await service.deductCredits({
      appId: APP_ID,
      userId: USER_ID,
      baseCost: 1,
      description: "inference",
    });

    // The credit and the debit hit the SAME org.
    expect(addCredits.mock.calls[0][0].organizationId).toBe(ORG_ID);
    expect(reserveAndDeductCredits).toHaveBeenCalledTimes(1);
    expect(reserveAndDeductCredits.mock.calls[0][0].organizationId).toBe(ORG_ID);

    // 10% markup on $1 base.
    expect(spend.success).toBe(true);
    expect(spend.totalCost).toBeCloseTo(1.1, 10);
    expect(spend.creatorEarnings).toBeCloseTo(0.1, 10);
  });

  test("insufficient org balance reports a cloud-credits message", async () => {
    reserveAndDeductCredits.mockResolvedValue({ success: false, newBalance: 0.2 });

    const spend = await freshService().deductCredits({
      appId: APP_ID,
      userId: USER_ID,
      baseCost: 1,
      description: "inference",
    });

    expect(spend.success).toBe(false);
    expect(spend.message).toContain("Insufficient cloud credits");
  });

  // Money-safety: the org balance is debited BEFORE the earnings/activity
  // accounting runs. If that post-debit accounting throws, the user has already
  // paid for an inference whose bookkeeping failed — they must be made whole, or
  // they're charged with nothing to show for it. deductCredits() compensates the
  // full totalCost and rethrows so the caller still sees the failure.
  test("compensates the full charge and rethrows when post-debit accounting fails", async () => {
    // The atomic debit succeeds...
    reserveAndDeductCredits.mockResolvedValue({
      success: true,
      newBalance: 41.4,
      transaction: { id: "tx-2" },
    });
    // ...but the very next step (earnings/activity bookkeeping) blows up.
    trackAppUserActivity.mockRejectedValue(new Error("accounting down"));

    await expect(
      freshService().deductCredits({
        appId: APP_ID,
        userId: USER_ID,
        baseCost: 1,
        description: "inference",
      }),
    ).rejects.toThrow("accounting down");

    // The $1.10 debit (base $1 + 10% markup) MUST be refunded — exactly once,
    // to the same org, tagged so it reconciles against the original charge.
    expect(addCredits).toHaveBeenCalledTimes(1);
    const refund = addCredits.mock.calls[0][0];
    expect(refund.organizationId).toBe(ORG_ID);
    expect(refund.amount).toBeCloseTo(1.1, 10);
    expect(refund.metadata.reason).toBe("post_debit_accounting_failed");
    expect(refund.metadata.originalChargeTransactionId).toBe("tx-2");
  });

  // #10846: when the failure happens AFTER creator earnings are committed (the
  // apps aggregate-counter update throws), compensating only the consumer would
  // leave the creator holding `creatorMarkup` of unbacked redeemable earnings.
  // The catch must ALSO reverse those earnings.
  test("reverses committed creator earnings when the apps-counter update throws post-earnings", async () => {
    reserveAndDeductCredits.mockResolvedValue({
      success: true,
      newBalance: 41.4,
      transaction: { id: "tx-2" },
    });
    // trackAppUserActivity + recordCreatorEarnings (addInferenceEarnings /
    // createTransaction / addEarnings) all succeed (defaults) — so the creator's
    // app-earnings + redeemable balance ARE committed...
    // ...then the very next write, the apps aggregate-counter update, throws.
    whereMock.mockRejectedValueOnce(new Error("apps counter update failed"));

    await expect(
      freshService().deductCredits({
        appId: APP_ID,
        userId: USER_ID,
        baseCost: 1, // 10% markup → creatorMarkup = 0.10, totalCost = 1.10
        description: "inference",
      }),
    ).rejects.toThrow("apps counter update failed");

    // Consumer is made whole (the full $1.10).
    expect(addCredits).toHaveBeenCalledTimes(1);
    expect(addCredits.mock.calls[0][0].amount).toBeCloseTo(1.1, 10);

    // AND the committed creator earnings are reversed — the two stores
    // recordCreatorEarnings incremented: the app-earnings ledger gets a NEGATIVE
    // adjustment, and the creator's redeemable balance is reduced. Without the
    // fix, neither of these fires and unbacked earnings are minted.
    const negativeAppEarnings = addInferenceEarnings.mock.calls.filter(
      (c) => typeof c[1] === "number" && c[1] < 0,
    );
    expect(negativeAppEarnings.length).toBe(1);
    expect(negativeAppEarnings[0][1]).toBeCloseTo(-0.1, 10);
    expect(reduceEarnings).toHaveBeenCalledTimes(1);
  });
});

describe("reserveInferenceCredits — holds app inference cost before model work", () => {
  test("atomically debits the estimated marked-up cost up front", async () => {
    const reservation = await freshService().reserveInferenceCredits({
      appId: APP_ID,
      userId: USER_ID,
      estimatedBaseCost: 1,
      description: "messages estimate",
      idempotencyKey: "req-1",
      metadata: { model: "anthropic/claude-sonnet-4" },
    });

    expect(reserveAndDeductCredits).toHaveBeenCalledTimes(1);
    const debit = reserveAndDeductCredits.mock.calls[0][0];
    expect(debit.organizationId).toBe(ORG_ID);
    expect(debit.amount).toBeCloseTo(1.1, 10);
    expect(debit.metadata.idempotencyKey).toBe("req-1");
    expect(reservation.reservedAmount).toBeCloseTo(1.1, 10);
    expect(reservation.reservationTransactionId).toBe("tx-2");
    // #10847: the movement leg — not a route-level phase suffix — makes the
    // earnings dedupe key unique per movement: `${chargeKey}:${type}:${leg}`.
    expect(addEarnings.mock.calls[0][0].sourceId).toBe("req-1:inference_markup:deduct");
  });

  test("fails before model work when the upfront app hold cannot be collected", async () => {
    reserveAndDeductCredits.mockResolvedValue({
      success: false,
      newBalance: 0.05,
      transaction: null,
    });

    await expect(
      freshService().reserveInferenceCredits({
        appId: APP_ID,
        userId: USER_ID,
        estimatedBaseCost: 1,
        description: "messages estimate",
      }),
    ).rejects.toThrow("Insufficient credits");

    expect(trackAppUserActivity).not.toHaveBeenCalled();
    expect(addInferenceEarnings).not.toHaveBeenCalled();
    expect(addEarnings).not.toHaveBeenCalled();
  });

  test("settling to zero refunds the upfront app hold and reverses creator earnings", async () => {
    const reservation = await freshService().reserveInferenceCredits({
      appId: APP_ID,
      userId: USER_ID,
      estimatedBaseCost: 1,
      description: "messages estimate",
      idempotencyKey: "req-2",
    });

    const result = await reservation.reconcile(0);

    expect(result?.adjustmentType).toBe("refund");
    expect(refundCredits).toHaveBeenCalledTimes(1);
    expect(refundCredits.mock.calls[0][0].organizationId).toBe(ORG_ID);
    expect(refundCredits.mock.calls[0][0].amount).toBeCloseTo(1.1, 10);
    expect(refundCredits.mock.calls[0][0].metadata.reservation_transaction_id).toBe("tx-2");
    expect(markReservationSettled).toHaveBeenCalledWith({
      organizationId: ORG_ID,
      reservationTransactionId: "tx-2",
    });
    expect(reduceEarnings).toHaveBeenCalledTimes(1);
    expect(reduceEarnings.mock.calls[0][0].amount).toBeCloseTo(0.1, 10);
  });

  test("uses distinct stable creator-earning keys for estimate and overage", async () => {
    const reservation = await freshService().reserveInferenceCredits({
      appId: APP_ID,
      userId: USER_ID,
      estimatedBaseCost: 1,
      description: "messages estimate",
      idempotencyKey: "req-3",
    });

    const result = await reservation.reconcile(2);

    expect(result?.adjustmentType).toBe("overage");
    expect(addEarnings).toHaveBeenCalledTimes(2);
    expect(addEarnings.mock.calls[0][0].sourceId).toBe("req-3:inference_markup:deduct");
    expect(addEarnings.mock.calls[1][0].sourceId).toBe("req-3:inference_markup:reconcile_charge");
  });
});

describe("reconcileCredits — charges/refunds the estimate↔actual delta (#9145)", () => {
  test("no-ops when the difference is below the reconciliation threshold", async () => {
    const result = await freshService().reconcileCredits({
      appId: APP_ID,
      userId: USER_ID,
      estimatedBaseCost: 1,
      actualBaseCost: 1,
      description: "recon",
      reservationTransactionId: "app-hold-1",
    });
    expect(result.reconciled).toBe(false);
    expect(result.action).toBe("none");
    expect(reserveAndDeductCredits).not.toHaveBeenCalled();
    expect(refundCredits).not.toHaveBeenCalled();
    expect(markReservationSettled).toHaveBeenCalledWith({
      organizationId: ORG_ID,
      reservationTransactionId: "app-hold-1",
    });
  });

  test("charges the markup'd delta to the org when actual exceeds estimated", async () => {
    const result = await freshService().reconcileCredits({
      appId: APP_ID,
      userId: USER_ID,
      estimatedBaseCost: 1,
      actualBaseCost: 2,
      description: "recon",
    });
    expect(result.reconciled).toBe(true);
    expect(result.action).toBe("charge");
    expect(reserveAndDeductCredits).toHaveBeenCalledTimes(1);
    // $1 base delta × 1.10 markup, against the org ledger.
    expect(reserveAndDeductCredits.mock.calls[0][0].organizationId).toBe(ORG_ID);
    expect(reserveAndDeductCredits.mock.calls[0][0].amount).toBeCloseTo(1.1, 10);
    expect(refundCredits).not.toHaveBeenCalled();
  });

  test("refunds the markup'd overcharge to the org when actual is below estimated", async () => {
    const result = await freshService().reconcileCredits({
      appId: APP_ID,
      userId: USER_ID,
      estimatedBaseCost: 2,
      actualBaseCost: 1,
      description: "recon",
    });
    expect(result.reconciled).toBe(true);
    expect(result.action).toBe("refund");
    expect(result.adjustedAmount).toBeCloseTo(1.1, 10);
    expect(refundCredits).toHaveBeenCalledTimes(1);
    expect(refundCredits.mock.calls[0][0].organizationId).toBe(ORG_ID);
    expect(reserveAndDeductCredits).not.toHaveBeenCalled();
  });

  test("does not reconcile when the user has no organization", async () => {
    findUserById.mockResolvedValue({ id: USER_ID, organization_id: null });
    const result = await freshService().reconcileCredits({
      appId: APP_ID,
      userId: USER_ID,
      estimatedBaseCost: 1,
      actualBaseCost: 5,
      description: "recon",
    });
    expect(result.reconciled).toBe(false);
    expect(reserveAndDeductCredits).not.toHaveBeenCalled();
    expect(refundCredits).not.toHaveBeenCalled();
  });

  test("does not reconcile when the app is missing", async () => {
    findAppById.mockResolvedValue(null);
    const result = await freshService().reconcileCredits({
      appId: APP_ID,
      userId: USER_ID,
      estimatedBaseCost: 1,
      actualBaseCost: 5,
      description: "recon",
    });
    expect(result.reconciled).toBe(false);
    expect(result.action).toBe("none");
  });

  // Money-safety: the inference already ran, so when the upward reconcile charge
  // can't be collected (org out of credits), the platform absorbs the delta. It
  // must NOT credit the creator for revenue that was never collected, and must
  // report the charge as un-reconciled (adjustedAmount 0) for loss tracking.
  test("absorbs the loss without crediting the creator when the reconcile charge is uncollectable", async () => {
    reserveAndDeductCredits.mockResolvedValue({ success: false, newBalance: 0.05 });

    const result = await freshService().reconcileCredits({
      appId: APP_ID,
      userId: USER_ID,
      estimatedBaseCost: 1,
      actualBaseCost: 2,
      description: "recon",
    });

    expect(result.reconciled).toBe(false);
    expect(result.action).toBe("charge");
    expect(result.adjustedAmount).toBe(0);
    expect(result.newBalance).toBe(0.05);
    // No revenue was collected — the creator's earnings ledgers stay untouched.
    expect(addInferenceEarnings).not.toHaveBeenCalled();
    expect(addEarnings).not.toHaveBeenCalled();
  });
});

describe("checkBalance — reads the org ledger", () => {
  test("gates on the org balance, not a per-app pool", async () => {
    const check = await freshService().checkBalance(APP_ID, USER_ID, 40);
    expect(check).toEqual({ sufficient: true, balance: 42.5, required: 40 });

    const tooMuch = await freshService().checkBalance(APP_ID, USER_ID, 50);
    expect(tooMuch.sufficient).toBe(false);
  });
});

// The per-inference billing PRICE quoted on the LLM hot path
// (/v1/messages, /v1/chat/*). calculateCostWithMarkup reads the markup config
// through getCostMarkupConfig, which is cache-backed: a miss falls through to
// the apps repo, and a missing app is negative-cached so the hot path stops
// hammering Postgres for an id that doesn't exist.
describe("calculateCostWithMarkup — quotes the inference price", () => {
  test("monetized app marks the base cost up by its inference_markup_percentage", async () => {
    // monetizedApp: monetization_enabled true, inference_markup_percentage 10.
    const quote = await freshService().calculateCostWithMarkup(APP_ID, 2);

    // 10% markup on a $2 base.
    expect(quote.markupPercentage).toBe(10);
    expect(quote.creatorMarkup).toBeCloseTo(0.2, 10);
    expect(quote.totalCost).toBeCloseTo(2.2, 10);
    expect(quote.baseCost).toBe(2);
  });

  test("monetization disabled collapses to base cost with zero markup", async () => {
    findAppById.mockResolvedValue({
      ...monetizedApp,
      monetization_enabled: false,
    });

    const quote = await freshService().calculateCostWithMarkup(APP_ID, 2);

    expect(quote.markupPercentage).toBe(0);
    expect(quote.creatorMarkup).toBe(0);
    expect(quote.totalCost).toBe(2); // totalCost === baseCost
  });

  test("missing app quotes zero markup AND negative-caches the __none marker", async () => {
    findAppById.mockResolvedValue(null);

    const quote = await freshService().calculateCostWithMarkup(APP_ID, 2);

    // No markup, total collapses to base.
    expect(quote.markupPercentage).toBe(0);
    expect(quote.creatorMarkup).toBe(0);
    expect(quote.totalCost).toBe(2);
    expect(quote.baseCost).toBe(2);

    // The miss was written through to the negative cache: the __none marker
    // under the cost-markup key, with the short "none" TTL (CacheTTL.app.none).
    expect(cacheSet).toHaveBeenCalledTimes(1);
    const [key, value, ttl] = cacheSet.mock.calls[0];
    expect(key).toBe(`app:cost-markup:${APP_ID}:v1`);
    expect(value).toEqual({ __none: true });
    expect(ttl).toBe(60);
  });
});

// The platform offset is a flat fee skimmed off a purchase before the creator
// share. If a creator sets an offset larger than the purchase, the clamp
// (Math.min(offset, purchaseAmount)) keeps the buyer's post-offset amount —
// and therefore the creator's share — at 0 instead of going negative.
describe("processPurchase — clamps an oversized platform offset", () => {
  test("offset >= purchase is clamped to the purchase; creator earns 0, never negative", async () => {
    findAppById.mockResolvedValue({
      ...monetizedApp,
      platform_offset_amount: "5.00", // bigger than the $2 purchase
      purchase_share_percentage: "20",
    });

    const result = await freshService().processPurchase({
      appId: APP_ID,
      userId: USER_ID,
      organizationId: ORG_ID,
      purchaseAmount: 2,
      stripePaymentIntentId: "pi_clamp",
    });

    // Clamped to the purchase amount, not the configured 5.00.
    expect(result.platformOffset).toBe(2);
    // amountAfterOffset is 0, so 20% of nothing is 0 — not -0.60.
    expect(result.creatorEarnings).toBe(0);
    // Buyer still receives the full purchase as spendable credits.
    expect(result.creditsAdded).toBe(2);
    // Zero creator earnings ⇒ no creator-share bookkeeping fires.
    expect(addPurchaseEarnings).not.toHaveBeenCalled();
    expect(addEarnings).not.toHaveBeenCalled();
  });
});

// Even with monetization OFF, a purchase carrying a Stripe payment-intent id
// still writes a dedup transaction so a webhook retry can't double-credit. The
// row records zero earnings and is tagged monetizationDisabled.
describe("processPurchase — monetization-disabled dedup record", () => {
  test("writes a zero-amount dedup transaction and records no creator earnings", async () => {
    findAppById.mockResolvedValue({
      ...monetizedApp,
      monetization_enabled: false,
    });

    const result = await freshService().processPurchase({
      appId: APP_ID,
      userId: USER_ID,
      organizationId: ORG_ID,
      purchaseAmount: 10,
      stripePaymentIntentId: "pi_disabled",
    });

    // Buyer still gets full credits; no platform/creator economics apply.
    expect(result.creditsAdded).toBe(10);
    expect(result.platformOffset).toBe(0);
    expect(result.creatorEarnings).toBe(0);

    // The dedup record was written with the disabled-purchase shape.
    expect(createTransaction).toHaveBeenCalledTimes(1);
    const tx = createTransaction.mock.calls[0][0];
    expect(tx.app_id).toBe(APP_ID);
    expect(tx.user_id).toBe(USER_ID);
    expect(tx.type).toBe("credit_purchase");
    expect(tx.amount).toBe("0");
    expect(tx.metadata.monetizationDisabled).toBe(true);
    expect(tx.metadata.stripePaymentIntentId).toBe("pi_disabled");

    // No creator earnings recorded when monetization is off.
    expect(addPurchaseEarnings).not.toHaveBeenCalled();
    expect(addEarnings).not.toHaveBeenCalled();
  });
});

// validateMetadata guards the metadata blob persisted with each charge against
// storage bloat / DOS (size) and stack-overflow (depth). It runs first thing in
// deductCredits and throws on violation, so the bad call never reaches the
// ledger.
describe("deductCredits — validateMetadata size & depth guards", () => {
  test("rejects metadata that serializes beyond the 10KB cap", async () => {
    const oversized = { blob: "x".repeat(11000) }; // > 10240 bytes serialized

    await expect(
      freshService().deductCredits({
        appId: APP_ID,
        userId: USER_ID,
        baseCost: 1,
        description: "inference",
        metadata: oversized,
      }),
    ).rejects.toThrow("Metadata exceeds maximum size");

    // The guard short-circuits before any debit is attempted.
    expect(reserveAndDeductCredits).not.toHaveBeenCalled();
  });

  test("rejects metadata nested deeper than the max depth", async () => {
    // 7 levels deep (a > b > c > d > e > f > g) exceeds MAX_METADATA_DEPTH (5).
    const deep = { a: { b: { c: { d: { e: { f: { g: 1 } } } } } } };

    await expect(
      freshService().deductCredits({
        appId: APP_ID,
        userId: USER_ID,
        baseCost: 1,
        description: "inference",
        metadata: deep,
      }),
    ).rejects.toThrow("Metadata exceeds maximum nesting depth");

    expect(reserveAndDeductCredits).not.toHaveBeenCalled();
  });

  test("accepts small, shallow metadata and proceeds to the debit", async () => {
    const ok = { requestId: "r-1", model: "gpt-oss-120b" };

    const spend = await freshService().deductCredits({
      appId: APP_ID,
      userId: USER_ID,
      baseCost: 1,
      description: "inference",
      metadata: ok,
    });

    expect(spend.success).toBe(true);
    expect(reserveAndDeductCredits).toHaveBeenCalledTimes(1);
    // The validated metadata is forwarded onto the debit's metadata.
    expect(reserveAndDeductCredits.mock.calls[0][0].metadata.requestId).toBe("r-1");
  });
});
