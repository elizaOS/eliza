/**
 * Pins the "app charges x402 → creator earns" loop.
 *
 * When an x402 payment request carrying an `appId` settles, the app's creator
 * must be credited: app-level earnings (`addPurchaseEarnings` + a
 * `purchase_share` transaction) AND the redeemable balance
 * (`redeemableEarningsService.addEarnings`, deduped by the payment id so a
 * re-settle can never double-credit). This is the monetization contract the
 * PayPerPixel example app and any x402-charging app depend on.
 */

import { beforeEach, expect, mock, test } from "bun:test";

const addPurchaseEarnings = mock();
const addInferenceEarnings = mock();
const createTransaction = mock();
mock.module("../../../db/repositories/app-earnings", () => ({
  appEarningsRepository: { addPurchaseEarnings, addInferenceEarnings, createTransaction },
}));

const findAppById = mock();
mock.module("../../../db/repositories/apps", () => ({
  appsRepository: { findById: findAppById },
}));

const findPaymentById = mock();
const markAsConfirmed = mock();
const updatePayment = mock();
const markAsExpired = mock();
mock.module("../../../db/repositories/crypto-payments", () => ({
  cryptoPaymentsRepository: {
    findById: findPaymentById,
    markAsConfirmed,
    update: updatePayment,
    markAsExpired,
  },
}));

const createMemory = mock();
mock.module("../../../db/repositories/agents/memories", () => ({
  memoriesRepository: { create: createMemory },
}));

const addEarnings = mock();
mock.module("../redeemable-earnings", () => ({
  redeemableEarningsService: { addEarnings },
}));

const settle = mock();
mock.module("../x402-facilitator", () => ({
  x402FacilitatorService: {
    settle,
    initialize: mock(async () => undefined),
    getSignerAddress: mock(() => "0xsigner"),
    getSignerAddressForNetwork: mock(() => "0xsigner"),
  },
}));

mock.module("../../runtime/cloud-bindings", () => ({
  getCloudAwareEnv: () => ({}),
}));

const whereMock = mock();
const setMock = mock(() => ({ where: whereMock }));
const updateMock = mock(() => ({ set: setMock }));
mock.module("../../../db/helpers", () => ({
  dbWrite: { update: updateMock },
}));

const { x402PaymentRequestsService } = await import("../x402-payment-requests");

const APP_ID = "11111111-1111-4111-8111-111111111111";
const CREATOR_ID = "creator-1";
const PAYMENT_ID = "pay_1";

function paymentRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: PAYMENT_ID,
    status: "pending",
    network: "eip155:8453",
    transaction_hash: null,
    expected_amount: "60000",
    credits_to_add: "0.05",
    payment_address: "0xpayto",
    token_address: "0xusdc",
    created_at: new Date(),
    expires_at: new Date(Date.now() + 900_000),
    confirmed_at: null,
    metadata: {
      kind: "x402_payment_request",
      appId: APP_ID,
      amountUsd: 0.05,
      platformFeeUsd: 0.0005,
      serviceFeeUsd: 0.01,
      totalChargedUsd: 0.0605,
      description: "Image",
      requirements: { scheme: "exact", network: "eip155:8453", payTo: "0xpayto" },
    },
    ...overrides,
  };
}

const validPayload = {
  x402Version: 2,
  accepted: {
    scheme: "exact",
    network: "eip155:8453",
    asset: "0xusdc",
    amount: "60000",
    payTo: "0xpayto",
  },
  payload: { signature: "0xsig" },
};

beforeEach(() => {
  for (const m of [
    addPurchaseEarnings,
    addInferenceEarnings,
    createTransaction,
    findAppById,
    findPaymentById,
    markAsConfirmed,
    updatePayment,
    markAsExpired,
    createMemory,
    addEarnings,
    settle,
    updateMock,
    setMock,
    whereMock,
  ]) {
    m.mockReset();
  }

  findAppById.mockResolvedValue({
    id: APP_ID,
    name: "PayPerPixel",
    created_by_user_id: CREATOR_ID,
  });
  findPaymentById.mockResolvedValue(paymentRecord());
  markAsConfirmed.mockResolvedValue(
    paymentRecord({ status: "confirmed", transaction_hash: "0xtx" }),
  );
  updatePayment.mockResolvedValue(paymentRecord({ status: "confirmed", transaction_hash: "0xtx" }));
  addPurchaseEarnings.mockResolvedValue(undefined);
  createTransaction.mockResolvedValue(undefined);
  addEarnings.mockResolvedValue({ success: true, newBalance: 0.05 });
  setMock.mockReturnValue({ where: whereMock });
  updateMock.mockReturnValue({ set: setMock });
  settle.mockResolvedValue({
    success: true,
    transaction: "0xtx",
    network: "eip155:8453",
    payer: "0xpayer",
  });
});

test("settling an app-scoped x402 request credits the creator's earnings", async () => {
  const result = await x402PaymentRequestsService.settle(PAYMENT_ID, validPayload);

  expect(result.paymentRequest.paid).toBe(true);

  // App-level earnings: a purchase_share credit for the full amount.
  expect(addPurchaseEarnings).toHaveBeenCalledWith(APP_ID, 0.05);
  expect(createTransaction).toHaveBeenCalledTimes(1);
  const txArg = createTransaction.mock.calls[0][0] as {
    type: string;
    app_id: string;
    user_id: string;
  };
  expect(txArg.type).toBe("purchase_share");
  expect(txArg.app_id).toBe(APP_ID);
  expect(txArg.user_id).toBe(CREATOR_ID);

  // Redeemable balance: credited to the creator, deduped by payment id.
  expect(addEarnings).toHaveBeenCalledTimes(1);
  const earnArg = addEarnings.mock.calls[0][0] as {
    userId: string;
    amount: number;
    source: string;
    sourceId: string;
    dedupeBySourceId: boolean;
  };
  expect(earnArg.userId).toBe(CREATOR_ID);
  expect(earnArg.amount).toBe(0.05);
  expect(earnArg.source).toBe("miniapp");
  expect(earnArg.sourceId).toBe(PAYMENT_ID);
  expect(earnArg.dedupeBySourceId).toBe(true);

  // App rollup (apps.total_creator_earnings) bumped.
  expect(updateMock).toHaveBeenCalledTimes(1);
});

test("re-settling an already-confirmed request does not double-credit", async () => {
  findPaymentById.mockResolvedValue(
    paymentRecord({ status: "confirmed", transaction_hash: "0xtx", confirmed_at: new Date() }),
  );

  const result = await x402PaymentRequestsService.settle(PAYMENT_ID, validPayload);

  expect(result.paymentRequest.paid).toBe(true);
  expect(settle).not.toHaveBeenCalled();
  expect(addPurchaseEarnings).not.toHaveBeenCalled();
  expect(addEarnings).not.toHaveBeenCalled();
});

test("a non-app x402 request credits the payer's own redeemable balance, not an app", async () => {
  findPaymentById.mockResolvedValue(
    paymentRecord({
      user_id: "buyer-1",
      metadata: {
        kind: "x402_payment_request",
        amountUsd: 0.05,
        description: "Solo",
        requirements: { scheme: "exact", network: "eip155:8453", payTo: "0xpayto" },
      },
    }),
  );

  await x402PaymentRequestsService.settle(PAYMENT_ID, validPayload);

  // No app binding → app earnings untouched.
  expect(addPurchaseEarnings).not.toHaveBeenCalled();
  // Payer credited under the creator_revenue_share source.
  expect(addEarnings).toHaveBeenCalledTimes(1);
  const earnArg = addEarnings.mock.calls[0][0] as { userId: string; source: string };
  expect(earnArg.userId).toBe("buyer-1");
  expect(earnArg.source).toBe("creator_revenue_share");
});
