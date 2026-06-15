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

mock.module("../credits", () => ({
  creditsService: {
    addCredits,
    reserveAndDeductCredits,
  },
}));

const addEarnings = mock();

mock.module("../redeemable-earnings", () => ({
  redeemableEarningsService: {
    addEarnings,
  },
}));

const whereMock = mock();
const setMock = mock(() => ({ where: whereMock }));
const updateMock = mock(() => ({ set: setMock }));

mock.module("../../../db/helpers", () => ({
  dbWrite: { update: updateMock },
}));

mock.module("../../cache/client", () => ({
  cache: {
    get: mock(async () => null),
    set: mock(async () => undefined),
    delete: mock(async () => undefined),
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
  addEarnings.mockReset();
  updateMock.mockClear();

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
  addEarnings.mockResolvedValue({ success: true });
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
});

describe("checkBalance — reads the org ledger", () => {
  test("gates on the org balance, not a per-app pool", async () => {
    const check = await freshService().checkBalance(APP_ID, USER_ID, 40);
    expect(check).toEqual({ sufficient: true, balance: 42.5, required: 40 });

    const tooMuch = await freshService().checkBalance(APP_ID, USER_ID, 50);
    expect(tooMuch.sufficient).toBe(false);
  });
});
