/**
 * Topup handler boundary tests for the x402 quote path.
 * The facilitator service fails fast internally when secrets cannot be read;
 * the public topup endpoint translates that setup failure into an explicit
 * unavailable response so callers do not see a generic Worker error.
 */

import { expect, mock, test } from "bun:test";

const initialize = mock(async () => {
  throw new Error("[x402-facilitator] Failed to read FACILITATOR_PRIVATE_KEY from secrets service");
});
const getSignerAddress = mock(() => null as string | null);
const settle = mock(async () => ({
  success: false,
  transaction: "",
  network: "eip155:8453",
  errorReason: "not configured",
}));

mock.module("./x402-facilitator", () => ({
  x402FacilitatorService: {
    initialize,
    getSignerAddress,
    settle,
  },
}));

mock.module("../auth/wallet-auth", () => ({
  verifyWalletSignature: mock(async () => null),
}));

mock.module("../stripe-products/messages", () => ({
  getStripeProductMessages: mock(() => ({
    topupDescription: (amount: number) => `Top up $${amount}`,
    creditsName: "Eliza credits",
  })),
}));

mock.module("../utils/logger", () => ({
  logger: {
    error: mock(() => undefined),
    info: mock(() => undefined),
  },
}));

mock.module("./credits", () => ({
  creditsService: {
    addCredits: mock(async () => {
      throw new Error("not exercised");
    }),
  },
}));

mock.module("./redeemable-earnings", () => ({
  redeemableEarningsService: {
    addEarnings: mock(async () => {
      throw new Error("not exercised");
    }),
  },
}));

mock.module("./referrals", () => ({
  referralsService: {
    applyReferralCode: mock(async () => ({ success: false })),
    calculateRevenueSplits: mock(async () => ({ splits: [] })),
  },
}));

mock.module("./wallet-signup", () => ({
  findOrCreateUserByWalletAddress: mock(async () => {
    throw new Error("not exercised");
  }),
}));

const { createTopupHandler } = await import("./topup-handler");

test("topup quote returns x402_not_configured when facilitator setup fails", async () => {
  initialize.mockClear();
  getSignerAddress.mockClear();

  const handler = createTopupHandler({
    amount: 10,
    getSourceId: (walletAddress, paymentId) => `${walletAddress}:${paymentId}`,
  });

  const response = await handler(
    new Request("https://api.example.test/api/v1/topup/10", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        walletAddress: "0x1111111111111111111111111111111111111111",
      }),
    }),
    {},
  );

  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({
    success: false,
    code: "x402_not_configured",
  });
  expect(initialize).toHaveBeenCalledTimes(1);
  expect(getSignerAddress).not.toHaveBeenCalled();
});

test("exact_permit quote fails closed when facilitator setup fails despite a configured recipient", async () => {
  initialize.mockClear();
  getSignerAddress.mockClear();

  const handler = createTopupHandler({
    amount: 10,
    getSourceId: (walletAddress, paymentId) => `${walletAddress}:${paymentId}`,
  });

  // A configured recipient skips facilitator init during recipient resolution,
  // so a bsc (exact_permit) quote reaches the signer-init call — the second,
  // separately guarded initialize() on the quote path.
  const response = await handler(
    new Request("https://api.example.test/api/v1/topup/10", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        walletAddress: "0x1111111111111111111111111111111111111111",
      }),
    }),
    {
      X402_RECIPIENT_ADDRESS: "0x2222222222222222222222222222222222222222",
      X402_NETWORK: "bsc",
    },
  );

  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({
    success: false,
    code: "x402_not_configured",
  });
  expect(initialize).toHaveBeenCalledTimes(1);
  expect(getSignerAddress).not.toHaveBeenCalled();
});
