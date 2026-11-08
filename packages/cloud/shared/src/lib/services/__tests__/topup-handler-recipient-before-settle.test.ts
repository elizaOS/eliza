import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { privateKeyToAccount } from "viem/accounts";

process.env.NODE_ENV = "test";
process.env.X402_RECIPIENT_ADDRESS = "0x00000000000000000000000000000000000000aa";

const { createTopupHandler } = await import("../topup-handler");
const { x402FacilitatorService } = await import("../x402-facilitator");
const { cache } = await import("../../cache/client");
const { creditsService } = await import("../credits");
const { referralsService } = await import("../referrals");
const { usersService } = await import("../users");
const walletSignup = await import("../wallet-signup");
const { cryptoPaymentsRepository } = await import("../../../db/repositories/crypto-payments");
const { x402SettlementIntentsRepository } = await import(
  "../../../db/repositories/x402-settlement-intents"
);
const { reconcileX402SettlementIntents } = await import("../x402-settlement-reconciler");

type Intent = Awaited<ReturnType<typeof x402SettlementIntentsRepository.open>>;

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

let intents: Map<string, Intent>;

/** An in-memory stand-in for the x402_settlement_intents table. */
beforeEach(() => {
  intents = new Map();
  const repo = x402SettlementIntentsRepository;
  const byId = (id: string) => [...intents.values()].find((row) => row.id === id);
  const touch = (id: string, patch: Partial<Intent>) => {
    const row = byId(id);
    if (row) Object.assign(row, patch, { updated_at: new Date() });
    return row;
  };
  spyOn(repo, "open").mockImplementation(async (params) => {
    const key = `${params.network}:${params.payer.toLowerCase()}:${params.nonce.toLowerCase()}`;
    const existing = intents.get(key);
    if (existing) return existing;
    const now = new Date();
    const row: Intent = {
      id: crypto.randomUUID(),
      network: params.network,
      payer: params.payer.toLowerCase(),
      nonce: params.nonce.toLowerCase(),
      status: "pending",
      wallet_address: params.walletAddress.toLowerCase(),
      amount_usd: params.amountUsd.toFixed(2),
      transaction: null,
      credit_key: null,
      source_id: null,
      organization_id: null,
      last_error: null,
      settled_at: null,
      credited_at: null,
      created_at: now,
      updated_at: now,
    };
    intents.set(key, row);
    return row;
  });
  spyOn(repo, "recordBroadcast").mockImplementation(async (id, transaction) => {
    touch(id, { transaction });
  });
  spyOn(repo, "markSettled").mockImplementation(async (id, params) => {
    const row = byId(id)!;
    if (row.status !== "pending") return row;
    return touch(id, {
      status: "settled",
      transaction: params.transaction,
      credit_key: params.creditKey,
      source_id: params.sourceId,
      settled_at: new Date(),
    })!;
  });
  spyOn(repo, "markCredited").mockImplementation(async (id, organizationId) => {
    if (byId(id)?.status === "settled") {
      touch(id, { status: "credited", organization_id: organizationId, credited_at: new Date() });
    }
  });
  spyOn(repo, "recordError").mockImplementation(async (id, message) => {
    touch(id, { last_error: message });
  });
  spyOn(repo, "listSettledBefore").mockImplementation(async (before, limit) =>
    [...intents.values()]
      .filter((row) => row.status === "settled" && row.updated_at < before)
      .slice(0, limit),
  );
});

afterEach(() => {
  mock.restore();
});

const later = () => new Date(Date.now() + 60 * 60 * 1000);

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

test("an account lookup failure after settlement leaves a settled intent that the cron credits once", async () => {
  const settle = stubSettlement();
  const lookup = spyOn(usersService, "getByWalletAddressWithOrganization").mockRejectedValue(
    new Error("database connection refused"),
  );
  const addCredits = spyOn(creditsService, "addCredits").mockResolvedValue({
    transaction: { id: "credit-tx-late" },
    newBalance: 10,
  } as never);
  spyOn(referralsService, "calculateRevenueSplits").mockResolvedValue({ splits: [] } as never);

  const response = await topup(
    new Request("https://cloud.test/api/v1/topup/10", {
      method: "POST",
      headers: { "X-PAYMENT": paymentHeader },
      body: JSON.stringify({ walletAddress: account.address }),
    }),
  );

  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({
    code: "x402_credit_pending",
    transaction: `0x${"ab".repeat(32)}`,
  });
  expect(settle.mock.calls.length).toBe(1);
  expect(addCredits).not.toHaveBeenCalled();
  const [intent] = [...intents.values()];
  expect(intent).toMatchObject({
    status: "settled",
    wallet_address: account.address.toLowerCase(),
    credit_key: `x402:eip155:8453:0x${"ab".repeat(32)}`,
    last_error: "database connection refused",
  });

  // Too recent: the cron leaves it to the request that settled it.
  expect(await reconcileX402SettlementIntents()).toEqual({ credited: 0, failed: 0 });

  lookup.mockRestore();
  spyOn(walletSignup, "findOrCreateUserByWalletAddress").mockResolvedValue({
    user: {
      id: "30000000-0000-4000-8000-000000000011",
      organization_id: "30000000-0000-4000-8000-000000000012",
    },
  } as never);
  expect(await reconcileX402SettlementIntents({ now: later() })).toEqual({
    credited: 1,
    failed: 0,
  });
  expect(await reconcileX402SettlementIntents({ now: later() })).toEqual({
    credited: 0,
    failed: 0,
  });
  expect(addCredits.mock.calls.length).toBe(1);
  expect(addCredits.mock.calls[0]?.[0]).toMatchObject({
    organizationId: "30000000-0000-4000-8000-000000000012",
    amount: 10,
    stripePaymentIntentId: `x402:eip155:8453:0x${"ab".repeat(32)}`,
  });
  expect(intent?.status).toBe("credited");
});

test("a retry of a settled but uncredited top-up credits it without settling again", async () => {
  const settle = stubSettlement();
  const findOrCreate = spyOn(walletSignup, "findOrCreateUserByWalletAddress").mockRejectedValueOnce(
    new Error("database connection refused"),
  );
  const addCredits = spyOn(creditsService, "addCredits").mockResolvedValue({
    transaction: { id: "credit-tx-retry" },
    newBalance: 10,
  } as never);
  spyOn(referralsService, "calculateRevenueSplits").mockResolvedValue({ splits: [] } as never);

  expect((await unsignedTopup(account.address)).status).toBe(503);
  findOrCreate.mockResolvedValue({
    user: {
      id: "30000000-0000-4000-8000-000000000013",
      organization_id: "30000000-0000-4000-8000-000000000014",
    },
  } as never);
  const retry = await unsignedTopup(account.address);

  expect(retry.status).toBe(200);
  expect(settle.mock.calls.length).toBe(1);
  expect(addCredits.mock.calls.length).toBe(1);
  expect([...intents.values()][0]?.status).toBe("credited");
});

test("the same authorization cannot be redirected to another wallet", async () => {
  const settle = stubSettlement();
  spyOn(walletSignup, "findOrCreateUserByWalletAddress").mockRejectedValue(
    new Error("database connection refused"),
  );

  expect((await unsignedTopup(account.address)).status).toBe(503);
  const redirected = await unsignedTopup("0x00000000000000000000000000000000000000dd");

  expect(redirected.status).toBe(409);
  expect(await redirected.json()).toMatchObject({ code: "payment_in_use" });
  expect(settle.mock.calls.length).toBe(1);
});

test("an unsigned top-up opens no account before the payment settles", async () => {
  const settle = spyOn(x402FacilitatorService, "settle").mockResolvedValue({
    success: false,
    transaction: "",
    network: "eip155:8453",
    errorReason: "invalid_signature",
  } as Settlement);
  const findOrCreate = spyOn(walletSignup, "findOrCreateUserByWalletAddress");

  const response = await unsignedTopup(account.address);

  expect(response.status).toBe(402);
  expect(settle.mock.calls.length).toBe(1);
  expect(findOrCreate).not.toHaveBeenCalled();
  expect([...intents.values()][0]?.status).toBe("pending");
});

function stubCredit(walletUser: { id: string; organization_id: string }) {
  spyOn(creditsService, "addCredits").mockResolvedValue({
    transaction: { id: "credit-tx-ref" },
    newBalance: 10,
  } as never);
  spyOn(referralsService, "calculateRevenueSplits").mockResolvedValue({
    splits: [],
  } as never);
  return walletUser;
}

test("an unsigned request does not apply a referral to the wallet it names", async () => {
  stubSettlement();
  const walletUser = stubCredit({
    id: "30000000-0000-4000-8000-000000000005",
    organization_id: "30000000-0000-4000-8000-000000000006",
  });
  spyOn(walletSignup, "findOrCreateUserByWalletAddress").mockResolvedValue({
    user: walletUser,
  } as never);
  const applyReferral = spyOn(referralsService, "applyReferralCode").mockResolvedValue({
    success: true,
    message: "applied",
  } as never);

  const response = await topup(
    new Request("https://cloud.test/api/v1/topup/10?appOwnerId=attacker-user", {
      method: "POST",
      headers: { "X-PAYMENT": paymentHeader },
      body: JSON.stringify({ walletAddress: account.address, ref: "ATTACKER" }),
    }),
  );

  expect(response.status).toBe(200);
  expect(applyReferral.mock.calls.length).toBe(0);
});

test("a signed request applies the referral without an app owner from the request", async () => {
  stubSettlement();
  const organizationId = "30000000-0000-4000-8000-000000000007";
  const walletUser = {
    id: "30000000-0000-4000-8000-000000000008",
    organization_id: organizationId,
    wallet_address: account.address,
    is_active: true,
    organization: { id: organizationId, is_active: true },
  };
  stubCredit(walletUser);
  spyOn(cache, "isAvailable").mockReturnValue(true);
  spyOn(cache, "setIfNotExists").mockResolvedValue(true);
  spyOn(cache, "get").mockResolvedValue(walletUser as never);
  const applyReferral = spyOn(referralsService, "applyReferralCode").mockResolvedValue({
    success: true,
    message: "applied",
  } as never);
  const rawBody = JSON.stringify({ ref: "FRIEND", appOwnerId: "attacker-user" });
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

  expect(response.status).toBe(200);
  expect(applyReferral.mock.calls).toEqual([[walletUser.id, organizationId, "FRIEND"]]);
});

test("a referral that throws does not block the credit", async () => {
  stubSettlement();
  const organizationId = "30000000-0000-4000-8000-000000000015";
  const walletUser = {
    id: "30000000-0000-4000-8000-000000000016",
    organization_id: organizationId,
    wallet_address: account.address,
    is_active: true,
    organization: { id: organizationId, is_active: true },
  };
  stubCredit(walletUser);
  spyOn(cache, "isAvailable").mockReturnValue(true);
  spyOn(cache, "setIfNotExists").mockResolvedValue(true);
  spyOn(cache, "get").mockResolvedValue(walletUser as never);
  spyOn(referralsService, "applyReferralCode").mockRejectedValue(new Error("referrals down"));
  const rawBody = JSON.stringify({ ref: "FRIEND" });
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

  expect(response.status).toBe(200);
  expect(creditsService.addCredits).toHaveBeenCalledTimes(1);
  expect([...intents.values()][0]?.status).toBe("credited");
});

const pendingHash = `0x${"cd".repeat(32)}`;

function stubWalletUser() {
  const walletUser = stubCredit({
    id: "30000000-0000-4000-8000-000000000009",
    organization_id: "30000000-0000-4000-8000-000000000010",
  });
  spyOn(walletSignup, "findOrCreateUserByWalletAddress").mockResolvedValue({
    user: walletUser,
  } as never);
}

function unsignedTopup(walletAddress: string, transaction?: string) {
  return topup(
    new Request("https://cloud.test/api/v1/topup/10", {
      method: "POST",
      headers: {
        "X-PAYMENT": paymentHeader,
        ...(transaction && { "X-PAYMENT-TRANSACTION": transaction }),
      },
      body: JSON.stringify({ walletAddress }),
    }),
  );
}

test("a broadcast top-up with an unknown outcome returns 202 and credits nothing", async () => {
  spyOn(x402FacilitatorService, "settle").mockResolvedValue({
    success: false,
    pending: true,
    transaction: pendingHash,
    network: "eip155:8453",
    payer: account.address,
    errorReason: "settlement_unconfirmed",
  } as Settlement);
  const addCredits = spyOn(creditsService, "addCredits");

  const response = await unsignedTopup(account.address);

  expect(response.status).toBe(202);
  expect(await response.json()).toMatchObject({
    pending: true,
    code: "settlement_pending",
    transaction: pendingHash,
  });
  expect(addCredits).not.toHaveBeenCalled();
});

test("a confirmed pending top-up credits the payer once, keyed on its hash", async () => {
  stubWalletUser();
  const settle = spyOn(x402FacilitatorService, "settle");
  spyOn(cryptoPaymentsRepository, "findByTransactionHash").mockResolvedValue(undefined);
  const confirm = spyOn(x402FacilitatorService, "confirmSettlement").mockResolvedValue({
    success: true,
    transaction: pendingHash,
    network: "eip155:8453",
    payer: account.address,
  } as Settlement);

  const response = await unsignedTopup(account.address, pendingHash);

  expect(response.status).toBe(200);
  expect(settle).not.toHaveBeenCalled();
  expect(confirm.mock.calls[0]?.[0]).toMatchObject({
    transaction: pendingHash,
    payer: account.address,
    authorizationNonce: `0x${"1".repeat(64)}`,
  });
  expect(
    (
      creditsService.addCredits as unknown as {
        mock: { calls: { stripePaymentIntentId?: string }[][] };
      }
    ).mock.calls[0]?.[0].stripePaymentIntentId,
  ).toBe(`x402:eip155:8453:${pendingHash}`);
});

test("a pending top-up cannot be credited to a wallet other than the payer", async () => {
  stubWalletUser();
  const confirm = spyOn(x402FacilitatorService, "confirmSettlement");

  const response = await unsignedTopup("0x00000000000000000000000000000000000000dd", pendingHash);

  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ code: "payer_wallet_mismatch" });
  expect(confirm).not.toHaveBeenCalled();
});

test("a hash that already paid a payment request is not reused for a top-up", async () => {
  stubWalletUser();
  spyOn(cryptoPaymentsRepository, "findByTransactionHash").mockResolvedValue({
    id: "payment-request",
  } as never);
  const confirm = spyOn(x402FacilitatorService, "confirmSettlement");

  const response = await unsignedTopup(account.address, pendingHash);

  expect(response.status).toBe(409);
  expect(confirm).not.toHaveBeenCalled();
});
