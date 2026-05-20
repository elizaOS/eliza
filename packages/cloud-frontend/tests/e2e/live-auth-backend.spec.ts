// Live auth/backend smoke for real SIWE and SIWS endpoints.
//
// This intentionally talks to the configured live API with no route mocks.
// It is opt-in because successful runs create real wallet-backed users/API
// keys in the target environment.
//
// Enable with:
//   CLOUD_E2E_LIVE_URL=https://www.elizacloud.ai \
//   CLOUD_E2E_LIVE_AUTH=1 \
//   bun run test:e2e tests/e2e/live-auth-backend.spec.ts

import { expect, test } from "@playwright/test";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const LIVE_URL = process.env.CLOUD_E2E_LIVE_URL?.trim();
const LIVE_AUTH_ENABLED = process.env.CLOUD_E2E_LIVE_AUTH === "1";
const API_BASE_URL = resolveApiBaseUrl();

interface NonceResponse {
  nonce: string;
  domain: string;
  uri: string;
  chainId: string | number;
  version: string;
  statement?: string;
}

interface WalletVerifyResponse {
  apiKey: string;
  address: string;
  isNewAccount: boolean;
  user: { id: string; wallet_address: string | null; organization_id: string };
  organization: { id: string; name: string; slug: string } | null;
}

function resolveApiBaseUrl(): string {
  const explicit = process.env.CLOUD_E2E_LIVE_API_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  if (!LIVE_URL) return "https://api.elizacloud.ai";

  const url = new URL(LIVE_URL);
  if (
    url.hostname === "elizacloud.ai" ||
    url.hostname === "www.elizacloud.ai"
  ) {
    return "https://api.elizacloud.ai";
  }
  if (url.hostname === "dev.elizacloud.ai") {
    return "https://api-dev.elizacloud.ai";
  }
  return url.origin;
}

function endpoint(path: string): string {
  return `${API_BASE_URL}${path}`;
}

function buildWalletMessage(params: {
  chain: "Ethereum" | "Solana";
  domain: string;
  address: string;
  statement?: string;
  uri: string;
  chainId: string | number;
  nonce: string;
  issuedAt: Date;
}): string {
  const lines = [
    `${params.domain} wants you to sign in with your ${params.chain} account:`,
    params.address,
    "",
  ];
  if (params.statement) {
    lines.push(params.statement, "");
  }
  lines.push(
    `URI: ${params.uri}`,
    "Version: 1",
    `Chain ID: ${params.chainId}`,
    `Nonce: ${params.nonce}`,
    `Issued At: ${params.issuedAt.toISOString()}`,
  );
  return lines.join("\n");
}

async function fetchJson<T>(
  path: string,
  init?: RequestInit,
): Promise<{ response: Response; body: T }> {
  const response = await fetch(endpoint(path), {
    signal: AbortSignal.timeout(30_000),
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  const text = await response.text();
  const body = text ? (JSON.parse(text) as T) : ({} as T);
  return { response, body };
}

async function expectDashboardAccepts(apiKey: string) {
  const { response, body } = await fetchJson<{
    user?: unknown;
    organization?: unknown;
  }>("/api/v1/dashboard", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  expect(response.status, JSON.stringify(body)).toBe(200);
  expect(body.user, "dashboard user").toBeTruthy();
}

test.describe("live: wallet auth backend", () => {
  test.skip(!LIVE_URL, "set CLOUD_E2E_LIVE_URL to enable live cloud tests");
  test.skip(
    !LIVE_AUTH_ENABLED,
    "set CLOUD_E2E_LIVE_AUTH=1 to run real wallet auth against the live API",
  );

  test("SIWE issues a real API key that can read dashboard data", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const { response: nonceResponse, body: nonce } =
      await fetchJson<NonceResponse>("/api/auth/siwe/nonce?chainId=1");
    expect(nonceResponse.status, JSON.stringify(nonce)).toBe(200);
    expect(nonce.nonce).toMatch(/^[0-9a-f]{32}$/);

    const message = buildWalletMessage({
      chain: "Ethereum",
      domain: nonce.domain,
      address: account.address,
      statement: nonce.statement,
      uri: nonce.uri,
      chainId: nonce.chainId,
      nonce: nonce.nonce,
      issuedAt: new Date(),
    });
    const signature = await account.signMessage({ message });

    const { response: verifyResponse, body: verify } =
      await fetchJson<WalletVerifyResponse>("/api/auth/siwe/verify", {
        method: "POST",
        body: JSON.stringify({ message, signature }),
      });

    expect(verifyResponse.status, JSON.stringify(verify)).toBe(200);
    expect(verify.apiKey).toBeTruthy();
    expect(verify.address.toLowerCase()).toBe(account.address.toLowerCase());
    expect(verify.user.organization_id).toBeTruthy();
    await expectDashboardAccepts(verify.apiKey);
  });

  test("SIWS issues a real API key that can read dashboard data", async () => {
    const keypair = nacl.sign.keyPair();
    const address = bs58.encode(keypair.publicKey);
    const { response: nonceResponse, body: nonce } =
      await fetchJson<NonceResponse>("/api/auth/siws/nonce");
    expect(nonceResponse.status, JSON.stringify(nonce)).toBe(200);
    expect(nonce.nonce).toMatch(/^[0-9a-f]{32}$/);

    const message = buildWalletMessage({
      chain: "Solana",
      domain: nonce.domain,
      address,
      statement: nonce.statement,
      uri: nonce.uri,
      chainId: nonce.chainId,
      nonce: nonce.nonce,
      issuedAt: new Date(),
    });
    const signature = bs58.encode(
      nacl.sign.detached(new TextEncoder().encode(message), keypair.secretKey),
    );

    const { response: verifyResponse, body: verify } =
      await fetchJson<WalletVerifyResponse>("/api/auth/siws/verify", {
        method: "POST",
        body: JSON.stringify({ message, signature }),
      });

    expect(verifyResponse.status, JSON.stringify(verify)).toBe(200);
    expect(verify.apiKey).toBeTruthy();
    expect(verify.address).toBe(address);
    expect(verify.user.organization_id).toBeTruthy();
    await expectDashboardAccepts(verify.apiKey);
  });
});
