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
const addCredits = mock(async () => ({
  transaction: { id: "credit-tx-1" },
  newBalance: 10,
}));
const findOrCreateUserByWalletAddress = mock(async (walletAddress: string) => ({
  user: {
    id: "user-1",
    organization_id: "org-1",
    wallet_address: walletAddress,
  },
  isNewAccount: true,
  initialCreditsGranted: false,
  initialFreeCreditsUsd: 0,
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
    addCredits,
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
  findOrCreateUserByWalletAddress,
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

test("topup quote exposes the required x402 v2 resource in its body and header", async () => {
  const handler = createTopupHandler({
    amount: 10,
    getSourceId: (walletAddress, paymentId) => `${walletAddress}:${paymentId}`,
  });
  const url = "https://api.example.test/api/v1/topup/10";

  const response = await handler(
    new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        walletAddress: "0x1111111111111111111111111111111111111111",
      }),
    }),
    { X402_RECIPIENT_ADDRESS: "0x2222222222222222222222222222222222222222" },
  );

  expect(response.status).toBe(402);
  const paymentRequired = await response.json();
  expect(paymentRequired).toMatchObject({
    x402Version: 2,
    resource: {
      url,
      description: "Top up $10",
      mimeType: "application/json",
    },
    accepts: [{ resource: url }],
  });

  const header = response.headers.get("PAYMENT-REQUIRED");
  expect(header).not.toBeNull();
  expect(JSON.parse(Buffer.from(header!, "base64").toString("utf-8"))).toEqual(paymentRequired);
});

test("a settled top-up creates a zero-balance wallet account then credits only the paid amount", async () => {
  settle.mockResolvedValueOnce({
    success: true,
    transaction: "0xpaid",
    network: "eip155:8453",
    payer: "0x3333333333333333333333333333333333333333",
  });
  findOrCreateUserByWalletAddress.mockClear();
  addCredits.mockClear();

  const walletAddress = "0x1111111111111111111111111111111111111111";
  const handler = createTopupHandler({
    amount: 10,
    getSourceId: (wallet, paymentId) => `${wallet}:${paymentId}`,
  });
  const response = await handler(
    new Request("https://api.example.test/api/v1/topup/10", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-PAYMENT": JSON.stringify({
          x402Version: 2,
          accepted: {
            scheme: "exact",
            network: "eip155:8453",
            asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            amount: "10000000",
            payTo: "0x2222222222222222222222222222222222222222",
          },
          payload: {
            signature: "0xsigned",
            authorization: {
              from: walletAddress,
              to: "0x2222222222222222222222222222222222222222",
              value: "10000000",
              validAfter: "0",
              validBefore: "9999999999",
              nonce: "1",
            },
          },
        }),
      },
      body: JSON.stringify({ walletAddress }),
    }),
    { X402_RECIPIENT_ADDRESS: "0x2222222222222222222222222222222222222222" },
  );

  expect(response.status).toBe(200);
  expect(findOrCreateUserByWalletAddress).toHaveBeenCalledWith(walletAddress);
  expect(addCredits).toHaveBeenCalledTimes(1);
  expect(addCredits).toHaveBeenCalledWith(
    expect.objectContaining({
      organizationId: "org-1",
      amount: 10,
      description: "x402 wallet top-up: $10",
      stripePaymentIntentId: "x402:eip155:8453:0xpaid",
    }),
  );
  expect(await response.json()).toMatchObject({
    success: true,
    amount: 10,
    newBalance: 10,
  });
});
