/**
 * Group M — Direct crypto credit purchase routes.
 *
 * These tests cover the API contract up to the wallet-signing boundary:
 * public config shape, auth gates, payment intent creation, and tx-hash
 * validation. They intentionally do not submit mainnet transactions.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import {
  api,
  bearerHeaders,
  exchangeApiKeyForSession,
  getBaseUrl,
  isServerReachable,
} from "./_helpers/api";

let serverReachable = false;
let hasTestApiKey = false;
let sessionCookie: string | null = null;

function shouldRunAuthed(): boolean {
  return serverReachable && hasTestApiKey;
}

function shouldRunSession(): boolean {
  return shouldRunAuthed() && sessionCookie !== null;
}

async function getCurrentUserWallet(): Promise<string> {
  if (!sessionCookie) throw new Error("session cookie missing");
  const res = await api.get("/api/v1/user", {
    headers: { Cookie: sessionCookie },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { wallet_address?: string };
  expect(body.wallet_address).toMatch(/^0x[a-fA-F0-9]{40}$/);
  return body.wallet_address!;
}

beforeAll(async () => {
  hasTestApiKey = Boolean(process.env.TEST_API_KEY?.trim());
  serverReachable = await isServerReachable();
  if (!serverReachable) {
    console.warn(
      `[group-m-direct-crypto] ${getBaseUrl()} did not respond to /api/health. Tests will skip.`,
    );
    return;
  }
  if (!hasTestApiKey) {
    console.warn(
      "[group-m-direct-crypto] TEST_API_KEY is not set; authed tests will skip.",
    );
    return;
  }
  try {
    sessionCookie = await exchangeApiKeyForSession();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[group-m-direct-crypto] session exchange failed: ${msg}`);
  }
});

describe("GET /api/crypto/status", () => {
  test("public config is JSON and never leaks RPC URLs or secure wallets", async () => {
    if (!serverReachable) return;
    const res = await api.get("/api/crypto/status");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain(
      "application/json",
    );
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
      expect(network.receiveAddress === null || typeof network.receiveAddress === "string").toBe(
        true,
      );
    }
  });
});

describe("/api/crypto/direct-payments", () => {
  test("config subroute is public and sanitized", async () => {
    if (!serverReachable) return;
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
    if (!serverReachable) return;
    const res = await api.post("/api/crypto/direct-payments", {
      amount: 10,
      network: "base",
      payerAddress: "0x19E7E376E7C213B7E7E7E46CC70A5DD086DAFF2A",
    });
    expect(res.status).toBe(401);
  });

  test("validation: amount must be in the accepted range", async () => {
    if (!shouldRunAuthed()) return;
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

  test("happy path: creates a Base USDC payment for the account wallet", async () => {
    if (!shouldRunSession()) return;

    const statusRes = await api.get("/api/crypto/status");
    const status = (await statusRes.json()) as {
      directWallet?: {
        networks?: Array<{ network?: string; enabled?: boolean }>;
      };
    };
    const baseEnabled = status.directWallet?.networks?.some(
      (network) => network.network === "base" && network.enabled,
    );
    if (!baseEnabled) return;

    const payerAddress = await getCurrentUserWallet();
    const createRes = await api.post(
      "/api/crypto/direct-payments",
      { amount: 1, network: "base", payerAddress },
      { headers: { Cookie: sessionCookie!, "Content-Type": "application/json" } },
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
    expect(created.instructions?.receiveAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);

    const confirmRes = await api.post(
      `/api/crypto/direct-payments/${created.paymentId}/confirm`,
      { transactionHash: "not-a-tx" },
      { headers: { Cookie: sessionCookie!, "Content-Type": "application/json" } },
    );
    expect(confirmRes.status).toBe(400);
  });
});
