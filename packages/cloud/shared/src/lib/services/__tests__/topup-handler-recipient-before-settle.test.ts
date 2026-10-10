import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { privateKeyToAccount } from "viem/accounts";

process.env.NODE_ENV = "test";
process.env.X402_RECIPIENT_ADDRESS = "0x00000000000000000000000000000000000000aa";

const { createTopupHandler } = await import("../topup-handler");
const { x402FacilitatorService } = await import("../x402-facilitator");
const { cache } = await import("../../cache/client");
const { creditsService } = await import("../credits");
const { referralsService } = await import("../referrals");
const { usersService } = await import("../users");

type Settlement = Awaited<ReturnType<typeof x402FacilitatorService.settle>>;

const account = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);

const topup = createTopupHandler({
  amount: 10,
  getSourceId: (walletAddress, paymentId) => `${walletAddress.toLowerCase()}:10:${paymentId}`,
});

const paymentHeader = Buffer.from(
  JSON.stringify({
    x402Version: 2,
    accepted: {
      scheme: "exact",
      network: "eip155:8453",
      amount: "10000000",
      payTo: "0x00000000000000000000000000000000000000aa",
    },
    payload: {
      signature: "0x01",
      authorization: { from: account.address, nonce: `0x${"1".repeat(64)}` },
    },
  }),
).toString("base64");

function stubSettlement() {
  return spyOn(x402FacilitatorService, "settle").mockResolvedValue({
    success: true,
    transaction: `0x${"ab".repeat(32)}`,
    network: "eip155:8453",
    payer: account.address,
  } as Settlement);
}

afterEach(() => {
  mock.restore();
});

test("an expired wallet signature is rejected before the payment is settled", async () => {
  const settle = stubSettlement();
  const timestamp = Date.now() - 10 * 60 * 1000;
  const signature = await account.signMessage({
    message: `Eliza Cloud Authentication\nTimestamp: ${timestamp}\nMethod: POST\nPath: /api/v1/topup/10`,
  });

  const response = await topup(
    new Request("https://cloud.test/api/v1/topup/10", {
      method: "POST",
      headers: {
        "X-PAYMENT": paymentHeader,
        "X-Wallet-Address": account.address,
        "X-Timestamp": String(timestamp),
        "X-Wallet-Signature": signature,
      },
    }),
  );

  expect({
    status: response.status,
    body: await response.json(),
    settleCalls: settle.mock.calls.length,
  }).toEqual({
    status: 401,
    body: { error: "Signature timestamp expired" },
    settleCalls: 0,
  });
});

test("a signature header without the wallet address and timestamp is rejected before the payment is settled", async () => {
  const settle = stubSettlement();

  const response = await topup(
    new Request("https://cloud.test/api/v1/topup/10", {
      method: "POST",
      headers: {
        "X-PAYMENT": paymentHeader,
        "X-Wallet-Signature": "0x1234",
      },
    }),
  );

  expect({
    status: response.status,
    body: await response.json(),
    settleCalls: settle.mock.calls.length,
  }).toEqual({
    status: 401,
    body: { error: "Wallet signature verification failed" },
    settleCalls: 0,
  });
});

test("a signature header with a body walletAddress is rejected before the payment is settled", async () => {
  const settle = stubSettlement();

  const response = await topup(
    new Request("https://cloud.test/api/v1/topup/10", {
      method: "POST",
      headers: {
        "X-PAYMENT": paymentHeader,
        "X-Wallet-Signature": "0x1234",
      },
      body: JSON.stringify({ walletAddress: account.address }),
    }),
  );

  expect({
    status: response.status,
    body: await response.json(),
    settleCalls: settle.mock.calls.length,
  }).toEqual({
    status: 401,
    body: { error: "Wallet signature verification failed" },
    settleCalls: 0,
  });
});

test.each([
  {
    name: "an empty body",
    body: {},
    status: 400,
    error: "walletAddress is required (body or wallet signature headers)",
  },
  {
    name: "a whitespace-only walletAddress",
    body: { walletAddress: "   " },
    status: 400,
    error: "walletAddress is required (body or wallet signature headers)",
  },
  {
    name: "a non-EVM walletAddress",
    body: { walletAddress: "not-an-evm-address" },
    status: 400,
    error: "Valid EVM walletAddress is required",
  },
])(
  "an unsigned request with $name is rejected before the payment is settled",
  async ({ body, status, error }) => {
    const settle = stubSettlement();

    const response = await topup(
      new Request("https://cloud.test/api/v1/topup/10", {
        method: "POST",
        headers: { "X-PAYMENT": paymentHeader },
        body: JSON.stringify(body),
      }),
    );

    expect({
      status: response.status,
      body: await response.json(),
      settleCalls: settle.mock.calls.length,
    }).toEqual({
      status,
      body: { error },
      settleCalls: 0,
    });
  },
);

test("a valid wallet signature is verified once and the settled payment is credited", async () => {
  const settle = stubSettlement();
  const organizationId = "30000000-0000-4000-8000-000000000001";
  const walletUser = {
    id: "30000000-0000-4000-8000-000000000002",
    organization_id: organizationId,
    wallet_address: account.address,
    is_active: true,
    organization: { id: organizationId, is_active: true },
  };
  spyOn(cache, "isAvailable").mockReturnValue(true);
  const claimNonce = spyOn(cache, "setIfNotExists").mockResolvedValue(true);
  spyOn(cache, "get").mockResolvedValue(walletUser as never);
  const addCredits = spyOn(creditsService, "addCredits").mockResolvedValue({
    transaction: { id: "credit-tx-1" },
    newBalance: 10,
  } as never);
  spyOn(referralsService, "calculateRevenueSplits").mockResolvedValue({
    splits: [],
  } as never);
  const timestamp = Date.now();
  const signature = await account.signMessage({
    message: `Eliza Cloud Authentication\nTimestamp: ${timestamp}\nMethod: POST\nPath: /api/v1/topup/10`,
  });

  const response = await topup(
    new Request("https://cloud.test/api/v1/topup/10", {
      method: "POST",
      headers: {
        "X-PAYMENT": paymentHeader,
        "X-Wallet-Address": account.address,
        "X-Timestamp": String(timestamp),
        "X-Wallet-Signature": signature,
      },
    }),
  );
  const body = (await response.json()) as Record<string, unknown>;

  expect({
    status: response.status,
    success: body.success,
    organizationId: body.organizationId,
    newBalance: body.newBalance,
    settleCalls: settle.mock.calls.length,
    nonceClaims: claimNonce.mock.calls.length,
    creditedOrganization: addCredits.mock.calls[0]?.[0].organizationId,
    creditedAmount: addCredits.mock.calls[0]?.[0].amount,
  }).toEqual({
    status: 200,
    success: true,
    organizationId,
    newBalance: 10,
    settleCalls: 1,
    nonceClaims: 1,
    creditedOrganization: organizationId,
    creditedAmount: 10,
  });
});

test("a signed request credits the signer's organization and ignores a different body walletAddress", async () => {
  const settle = stubSettlement();
  const organizationId = "30000000-0000-4000-8000-000000000003";
  const walletUser = {
    id: "30000000-0000-4000-8000-000000000004",
    organization_id: organizationId,
    wallet_address: account.address,
    is_active: true,
    organization: { id: organizationId, is_active: true },
  };
  spyOn(cache, "isAvailable").mockReturnValue(true);
  spyOn(cache, "setIfNotExists").mockResolvedValue(true);
  spyOn(cache, "get").mockResolvedValue(walletUser as never);
  const bodyLookup = spyOn(usersService, "getByWalletAddressWithOrganization");
  const addCredits = spyOn(creditsService, "addCredits").mockResolvedValue({
    transaction: { id: "credit-tx-2" },
    newBalance: 10,
  } as never);
  spyOn(referralsService, "calculateRevenueSplits").mockResolvedValue({
    splits: [],
  } as never);
  const otherWallet = "0x00000000000000000000000000000000000000dd";
  const rawBody = JSON.stringify({ walletAddress: otherWallet });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`\n${rawBody}`));
  const payloadHash = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const timestamp = Date.now();
  const signature = await account.signMessage({
    message: `Eliza Cloud Authentication\nTimestamp: ${timestamp}\nMethod: POST\nPath: /api/v1/topup/10\nPayload-SHA256: ${payloadHash}`,
  });

  const response = await topup(
    new Request("https://cloud.test/api/v1/topup/10", {
      method: "POST",
      headers: {
        "X-PAYMENT": paymentHeader,
        "X-Wallet-Address": account.address,
        "X-Timestamp": String(timestamp),
        "X-Wallet-Signature": signature,
      },
      body: rawBody,
    }),
  );
  const body = (await response.json()) as Record<string, unknown>;

  expect({
    status: response.status,
    organizationId: body.organizationId,
    walletAddress: body.walletAddress,
    settleCalls: settle.mock.calls.length,
    bodyWalletLookups: bodyLookup.mock.calls.length,
    creditedOrganization: addCredits.mock.calls[0]?.[0].organizationId,
    creditedWallet: addCredits.mock.calls[0]?.[0].metadata?.wallet_address,
  }).toEqual({
    status: 200,
    organizationId,
    walletAddress: account.address,
    settleCalls: 1,
    bodyWalletLookups: 0,
    creditedOrganization: organizationId,
    creditedWallet: account.address,
  });
});

test("an account lookup failure after settlement is reported as 503", async () => {
  const settle = stubSettlement();
  spyOn(usersService, "getByWalletAddressWithOrganization").mockRejectedValue(
    new Error("database connection refused"),
  );
  const addCredits = spyOn(creditsService, "addCredits");

  const response = await topup(
    new Request("https://cloud.test/api/v1/topup/10", {
      method: "POST",
      headers: { "X-PAYMENT": paymentHeader },
      body: JSON.stringify({ walletAddress: account.address }),
    }),
  );

  expect({
    status: response.status,
    body: await response.json(),
    settleCalls: settle.mock.calls.length,
    addCreditsCalls: addCredits.mock.calls.length,
  }).toEqual({
    status: 503,
    body: { error: "database connection refused" },
    settleCalls: 1,
    addCreditsCalls: 0,
  });
});
