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

test("402 quote carries the required x402 v2 top-level resource object (exact scheme)", async () => {
  // A configured recipient skips facilitator init for an `exact` EVM network,
  // so this drives a real HTTP 402 PaymentRequired with no X-PAYMENT header.
  const url = "https://api.example.test/api/v1/topup/10";
  const handler = createTopupHandler({
    amount: 10,
    getSourceId: (walletAddress, paymentId) => `${walletAddress}:${paymentId}`,
  });

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
  const body = (await response.json()) as {
    x402Version: number;
    resource: { url: string; description: string; mimeType: string };
    accepts: Array<{ resource: string; description: string; mimeType: string; scheme: string }>;
  };

  // The defect under test: the top-level `resource` object was missing even
  // though `x402Version: 2` was declared. A strict facilitator validates the
  // top-level object, not accepts[0].
  expect(body.x402Version).toBe(2);
  expect(typeof body.resource).toBe("object");
  expect(body.resource).not.toBeNull();
  expect(body.resource.url).toBe(url);
  expect(body.resource.url.length).toBeGreaterThan(0);
  expect(body.resource.description).toBe("Top up $10");
  expect(body.resource.mimeType).toBe("application/json");

  // The same object must appear in the base64 PAYMENT-REQUIRED header. Both
  // header spellings collapse into one case-insensitive header value, so the
  // Fetch API returns them comma-joined; decode the first encoded segment.
  const header = response.headers.get("PAYMENT-REQUIRED");
  expect(header).toBeTruthy();
  const encodedSegment = (header as string).split(", ")[0];
  const decoded = JSON.parse(Buffer.from(encodedSegment, "base64").toString("utf-8")) as {
    resource: { url: string; description: string; mimeType: string };
  };
  expect(decoded.resource).toEqual(body.resource);
  expect(response.headers.get("Payment-Required")).toBe(header);

  // Regression guard: the additive v1 fields on accepts[0] are still present.
  const entry = body.accepts[0];
  expect(entry.scheme).toBe("exact");
  expect(entry.resource).toBe(url);
  expect(entry.description).toBe("Top up $10");
  expect(entry.mimeType).toBe("application/json");
});

test("402 quote carries the top-level resource and extensions on the exact_permit path", async () => {
  initialize.mockClear();
  getSignerAddress.mockClear();
  // exact_permit (bsc) reaches the signer-init call; let it succeed so the
  // full PaymentRequired with extensions is emitted.
  initialize.mockResolvedValueOnce(undefined as never);
  getSignerAddress.mockReturnValueOnce("0x2222222222222222222222222222222222222222");

  const url = "https://api.example.test/api/v1/topup/10";
  const handler = createTopupHandler({
    amount: 10,
    getSourceId: (walletAddress, paymentId) => `${walletAddress}:${paymentId}`,
  });

  const response = await handler(
    new Request(url, {
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

  expect(response.status).toBe(402);
  const body = (await response.json()) as {
    resource: { url: string; description: string; mimeType: string };
    accepts: Array<{ scheme: string; resource: string }>;
    extensions?: { paymentPermitContext?: { meta?: { kind?: string } } };
  };
  expect(body.resource.url).toBe(url);
  expect(body.resource.description).toBe("Top up $10");
  expect(body.resource.mimeType).toBe("application/json");
  expect(body.accepts[0].scheme).toBe("exact_permit");
  expect(body.accepts[0].resource).toBe(url);
  expect(body.extensions?.paymentPermitContext?.meta?.kind).toBe("PAYMENT_ONLY");

  const header = response.headers.get("PAYMENT-REQUIRED");
  const encodedSegment = (header as string).split(", ")[0];
  const decoded = JSON.parse(Buffer.from(encodedSegment, "base64").toString("utf-8")) as {
    resource: { url: string };
  };
  expect(decoded.resource.url).toBe(url);
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
