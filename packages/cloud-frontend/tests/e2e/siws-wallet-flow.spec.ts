/**
 * End-to-end test for native Solana (SIWS) auth + agent provisioning.
 *
 * Mints a fresh ed25519 Solana keypair, hits the SIWS nonce/verify
 * endpoints to obtain an API key, then exercises the real
 * /api/v1/eliza/agents create + provision contract.
 *
 * Skips when the local cloud API is not reachable so CI without the dev
 * stack stays green.
 */

import bs58 from "bs58";
import nacl from "tweetnacl";
import { expect, test } from "@playwright/test";

const apiBaseUrl =
  process.env.TEST_API_BASE_URL?.trim() ||
  process.env.PLAYWRIGHT_API_URL?.trim() ||
  "http://127.0.0.1:8787";

async function requireLocalCloud() {
  const health = await fetch(`${apiBaseUrl}/api/health`, {
    signal: AbortSignal.timeout(5_000),
  }).catch(() => null);
  test.skip(
    !health || !health.ok,
    `local cloud API is not reachable at ${apiBaseUrl}/api/health`,
  );
}

interface NonceResponse {
  nonce: string;
  domain: string;
  uri: string;
  chainId: string;
  version: string;
  statement: string;
}

interface VerifyResponse {
  apiKey: string;
  address: string;
  isNewAccount: boolean;
  user: { id: string; wallet_address: string | null; organization_id: string };
  organization: { id: string; name: string; slug: string } | null;
}

function buildSiwsMessage(params: {
  domain: string;
  address: string;
  statement: string;
  uri: string;
  chainId: string;
  nonce: string;
  issuedAt: Date;
}): string {
  return [
    `${params.domain} wants you to sign in with your Solana account:`,
    params.address,
    "",
    params.statement,
    "",
    `URI: ${params.uri}`,
    `Version: 1`,
    `Chain ID: ${params.chainId}`,
    `Nonce: ${params.nonce}`,
    `Issued At: ${params.issuedAt.toISOString()}`,
  ].join("\n");
}

async function signInWithFreshSolanaKey(): Promise<{
  apiKey: string;
  address: string;
  organizationId: string;
}> {
  const keypair = nacl.sign.keyPair();
  const address = bs58.encode(keypair.publicKey);

  const nonceRes = await fetch(`${apiBaseUrl}/api/auth/siws/nonce`, {
    signal: AbortSignal.timeout(10_000),
  });
  expect(nonceRes.status, "nonce status").toBe(200);
  const nonceBody = (await nonceRes.json()) as NonceResponse;
  expect(nonceBody.nonce, "nonce string").toMatch(/^[0-9a-f]{32}$/);
  expect(nonceBody.domain, "domain present").toBeTruthy();

  const message = buildSiwsMessage({
    domain: nonceBody.domain,
    address,
    statement: nonceBody.statement,
    uri: nonceBody.uri,
    chainId: nonceBody.chainId,
    nonce: nonceBody.nonce,
    issuedAt: new Date(),
  });

  const signature = nacl.sign.detached(
    new TextEncoder().encode(message),
    keypair.secretKey,
  );

  const verifyRes = await fetch(`${apiBaseUrl}/api/auth/siws/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message,
      signature: bs58.encode(signature),
    }),
    signal: AbortSignal.timeout(20_000),
  });
  expect(verifyRes.status, "verify status").toBe(200);
  const verifyBody = (await verifyRes.json()) as VerifyResponse;
  expect(verifyBody.apiKey, "apiKey returned").toBeTruthy();
  expect(verifyBody.address, "address echoed").toBe(address);
  expect(verifyBody.user.organization_id, "org assigned").toBeTruthy();

  return {
    apiKey: verifyBody.apiKey,
    address,
    organizationId: verifyBody.user.organization_id,
  };
}

test.describe("SIWS (Solana) wallet flow", () => {
  test.beforeEach(async () => {
    await requireLocalCloud();
  });

  test("rejects invalid SIWS signature", async () => {
    const nonceRes = await fetch(`${apiBaseUrl}/api/auth/siws/nonce`);
    const nonce = (await nonceRes.json()) as NonceResponse;
    const realKey = nacl.sign.keyPair();
    const fakeKey = nacl.sign.keyPair();
    const address = bs58.encode(realKey.publicKey);
    const message = buildSiwsMessage({
      domain: nonce.domain,
      address,
      statement: nonce.statement,
      uri: nonce.uri,
      chainId: nonce.chainId,
      nonce: nonce.nonce,
      issuedAt: new Date(),
    });
    // Sign with the WRONG key — message claims `address` but signature is from fakeKey
    const badSig = nacl.sign.detached(
      new TextEncoder().encode(message),
      fakeKey.secretKey,
    );
    const verifyRes = await fetch(`${apiBaseUrl}/api/auth/siws/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, signature: bs58.encode(badSig) }),
    });
    expect(verifyRes.status).toBe(401);
  });

  test("issues an API key for a fresh Solana keypair", async () => {
    const { apiKey, address, organizationId } = await signInWithFreshSolanaKey();
    expect(apiKey).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$|^eliza/);
    expect(address).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    expect(organizationId).toBeTruthy();

    // Sanity-check the API key actually authenticates against a gated route.
    const dashboardRes = await fetch(`${apiBaseUrl}/api/v1/dashboard`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    expect(
      dashboardRes.status,
      "dashboard reachable with SIWS-issued API key",
    ).toBe(200);
  });

  test("nonce is single-use (replay rejected)", async () => {
    const keypair = nacl.sign.keyPair();
    const address = bs58.encode(keypair.publicKey);
    const nonceRes = await fetch(`${apiBaseUrl}/api/auth/siws/nonce`);
    const nonce = (await nonceRes.json()) as NonceResponse;
    const message = buildSiwsMessage({
      domain: nonce.domain,
      address,
      statement: nonce.statement,
      uri: nonce.uri,
      chainId: nonce.chainId,
      nonce: nonce.nonce,
      issuedAt: new Date(),
    });
    const signature = nacl.sign.detached(
      new TextEncoder().encode(message),
      keypair.secretKey,
    );
    const sigB58 = bs58.encode(signature);

    const first = await fetch(`${apiBaseUrl}/api/auth/siws/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, signature: sigB58 }),
    });
    expect(first.status, "first verify").toBe(200);

    const second = await fetch(`${apiBaseUrl}/api/auth/siws/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, signature: sigB58 }),
    });
    expect(second.status, "replay rejected").toBe(401);
  });

  test("create + provision an agent using SIWS-issued API key", async () => {
    const { apiKey } = await signInWithFreshSolanaKey();

    // Create
    const createRes = await fetch(`${apiBaseUrl}/api/v1/eliza/agents`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ agentName: `siws-e2e-${Date.now()}` }),
      signal: AbortSignal.timeout(20_000),
    });
    expect(createRes.status, "create agent status").toBe(201);
    const createBody = (await createRes.json()) as {
      success: boolean;
      data: { id: string; agentName: string; status: string };
    };
    expect(createBody.success).toBe(true);
    expect(createBody.data.id, "agent id present").toBeTruthy();
    const agentId = createBody.data.id;

    // Provision — async mode returns 202 with jobId, or 200 if a warm pool
    // claim short-circuits, or 200 if the agent was already running.
    const provisionRes = await fetch(
      `${apiBaseUrl}/api/v1/eliza/agents/${agentId}/provision`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        signal: AbortSignal.timeout(30_000),
      },
    );
    expect(
      [200, 202],
      `provision status (got ${provisionRes.status})`,
    ).toContain(provisionRes.status);
    const provisionBody = (await provisionRes.json()) as {
      success: boolean;
      data?: { jobId?: string; agentId?: string; status?: string };
    };
    expect(provisionBody.success).toBe(true);
    if (provisionRes.status === 202) {
      expect(provisionBody.data?.jobId, "jobId on 202").toBeTruthy();
    }
  });
});
