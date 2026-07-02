/**
 * Group M — Direct crypto credit purchase routes.
 *
 * These tests cover the API contract up to the wallet-signing boundary:
 * public config shape, auth gates, payment intent creation, and tx-hash
 * validation. They intentionally do not submit mainnet transactions.
 *
 * Skip behavior: with REQUIRE_E2E_SERVER=0 and no reachable Worker (or no
 * bootstrapped TEST_API_KEY) every test in this file reports as a counted,
 * named `skip` — never a silent pass. The session-driven happy path also
 * skips loudly when the test-session exchange is unavailable
 * (PLAYWRIGHT_TEST_AUTH not enabled on the target) or when the target has
 * the Base direct-wallet network disabled.
 */

import { describe, expect, test } from "bun:test";
import {
  api,
  bearerHeaders,
  exchangeApiKeyForSession,
  getBaseUrl,
  isServerReachable,
} from "./_helpers/api";

const serverReachable = await isServerReachable();
const hasTestApiKey = Boolean(process.env.TEST_API_KEY?.trim());
if (!serverReachable) {
  console.warn(
    `[group-m-direct-crypto] ${getBaseUrl()} did not respond to /api/health. ` +
      "Tests will SKIP. Start the Worker (bun run dev:api → wrangler dev) " +
      "or set TEST_API_BASE_URL to a reachable host.",
  );
}
if (!hasTestApiKey) {
  console.warn(
    "[group-m-direct-crypto] TEST_API_KEY is not set; the preload could not " +
      "bootstrap a test API key. Tests will SKIP.",
  );
}

let sessionCookie: string | null = null;
if (serverReachable && hasTestApiKey) {
  try {
    sessionCookie = await exchangeApiKeyForSession();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[group-m-direct-crypto] session exchange failed (session tests will SKIP): ${msg}`,
    );
  }
}

// Whether the target has the Base direct-wallet network enabled decides the
// create-payment happy path; resolve it up front so the skip is counted.
let baseNetworkEnabled = false;
if (serverReachable) {
  const statusRes = await api.get("/api/crypto/status");
  const status = (await statusRes.json()) as {
    directWallet?: {
      networks?: Array<{ network?: string; enabled?: boolean }>;
    };
  };
  baseNetworkEnabled =
    status.directWallet?.networks?.some(
      (network) => network.network === "base" && network.enabled,
    ) ?? false;
  if (!baseNetworkEnabled) {
    console.warn(
      "[group-m-direct-crypto] Base direct-wallet network is disabled on " +
        "this target; the create-payment happy path will SKIP.",
    );
  }
}

// Loud, counted skip instead of a silent pass when the Worker/key is absent.
const describeE2E = describe.skipIf(!serverReachable || !hasTestApiKey);

async function getCurrentUserWallet(): Promise<string> {
  if (!sessionCookie) throw new Error("session cookie missing");
  const res = await api.get("/api/v1/user", {
    headers: { Cookie: sessionCookie },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { wallet_address?: string };
  expect(body.wallet_address).toMatch(/^0x[a-fA-F0-9]{40}$/);
  if (!body.wallet_address) throw new Error("current user has no wallet");
  return body.wallet_address;
}

describeE2E("GET /api/crypto/status", () => {
  test("public config is JSON and never leaks RPC URLs or secure wallets", async () => {
    const res = await api.get("/api/crypto/status");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("application/json");
    const body = (await res.json()) as {
      directWallet?: {
        enabled?: boolean;
        networks?: Array<Record<string, unknown>>;
        promotion?: Record<string, unknown>;
      };
    };
    expect(typeof body.directWallet?.enabled).toBe("boolean");
    expect(body.directWallet?.promotion).toMatchObject({
      code: "bsc",
      network: "bsc",
      minimumUsd: 10,
      bonusCredits: 5,
    });
    for (const network of body.directWallet?.networks ?? []) {
      expect(network.rpcUrl).toBeUndefined();
      expect(network.secureAddress).toBeUndefined();
      expect(
        network.receiveAddress === null ||
          typeof network.receiveAddress === "string",
      ).toBe(true);
    }
  });
});

describeE2E("/api/crypto/direct-payments", () => {
  test("config subroute is public and sanitized", async () => {
    const res = await api.get("/api/crypto/direct-payments/config");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      enabled?: boolean;
      networks?: Array<Record<string, unknown>>;
    };
    expect(typeof body.enabled).toBe("boolean");
    for (const network of body.networks ?? []) {
      expect(network.rpcUrl).toBeUndefined();
      expect(network.secureAddress).toBeUndefined();
    }
  });

  test("auth gate: create rejects anonymous callers", async () => {
    const res = await api.post("/api/crypto/direct-payments", {
      amount: 10,
      network: "base",
      payerAddress: "0x19E7E376E7C213B7E7E7E46CC70A5DD086DAFF2A",
    });
    expect(res.status).toBe(401);
  });

  test("validation: amount must be in the accepted range", async () => {
    const res = await api.post(
      "/api/crypto/direct-payments",
      {
        amount: 0,
        network: "base",
        payerAddress: "0x19E7E376E7C213B7E7E7E46CC70A5DD086DAFF2A",
      },
      { headers: bearerHeaders() },
    );
    expect(res.status).toBe(400);
  });

  // Loud, counted skip when the test-session exchange is unavailable or the
  // target has the Base network disabled.
  test.skipIf(sessionCookie === null || !baseNetworkEnabled)(
    "happy path: creates a Base USDC payment for the account wallet",
    async () => {
      if (!sessionCookie) throw new Error("session cookie missing");

      const payerAddress = await getCurrentUserWallet();
      const createRes = await api.post(
        "/api/crypto/direct-payments",
        { amount: 1, network: "base", payerAddress },
        {
          headers: {
            Cookie: sessionCookie,
            "Content-Type": "application/json",
          },
        },
      );
      expect(createRes.status).toBe(200);
      const created = (await createRes.json()) as {
        paymentId?: string;
        status?: string;
        instructions?: {
          network?: string;
          tokenSymbol?: string;
          amountToken?: string;
          amountUnits?: string;
          receiveAddress?: string;
          creditsToAdd?: string;
          bonusCredits?: number;
          payerProofMessage?: string;
          payerProofTypedData?: {
            domain?: { name?: string; version?: string; chainId?: number };
            primaryType?: string;
            message?: Record<string, unknown>;
          };
          payerProofScheme?: string;
        };
      };
      expect(created.paymentId).toBeTruthy();
      expect(created.status).toBe("pending");
      expect(created.instructions).toMatchObject({
        network: "base",
        tokenSymbol: "USDC",
        amountToken: "1.000000",
        amountUnits: "1000000",
        creditsToAdd: "1.00",
        bonusCredits: 0,
      });
      expect(created.instructions?.receiveAddress).toMatch(
        /^0x[a-fA-F0-9]{40}$/,
      );
      expect(created.instructions?.payerProofScheme).toBe("evm-eip712");
      expect(created.instructions?.payerProofTypedData).toMatchObject({
        domain: { name: "Eliza Cloud Direct Wallet", version: "1" },
        primaryType: "DirectWalletPayment",
      });
      const proofMessage = created.instructions?.payerProofTypedData?.message;
      expect(proofMessage).toMatchObject({
        paymentId: created.paymentId,
        amountUnits: "1000000",
      });
      expect(String(proofMessage?.payerAddress).toLowerCase()).toBe(
        payerAddress.toLowerCase(),
      );
      expect(proofMessage?.nonce).toEqual(expect.any(String));

      const confirmRes = await api.post(
        `/api/crypto/direct-payments/${created.paymentId}/confirm`,
        { transactionHash: "not-a-tx", payerSignature: "0x00" },
        {
          headers: {
            Cookie: sessionCookie,
            "Content-Type": "application/json",
          },
        },
      );
      expect(confirmRes.status).toBe(400);
    },
  );
});
