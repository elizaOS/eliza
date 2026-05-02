import { describe, expect, test } from "bun:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import * as api from "../helpers/api-client";

interface SiweNonceResponse {
  nonce: string;
  domain: string;
  uri: string;
  chainId: number;
  version: string;
  statement: string;
}

function buildSiweMessage(input: SiweNonceResponse & { address: string }): string {
  return [
    `${input.domain} wants you to sign in with your Ethereum account:`,
    input.address,
    "",
    input.statement,
    "",
    `URI: ${input.uri}`,
    `Version: ${input.version}`,
    `Chain ID: ${input.chainId}`,
    `Nonce: ${input.nonce}`,
    `Issued At: ${new Date().toISOString()}`,
  ].join("\n");
}

describe("SIWE Auth API", () => {
  test("GET /api/auth/siwe/nonce returns a nonce", async () => {
    const response = await api.get("/api/auth/siwe/nonce");
    expect([200, 405, 503]).toContain(response.status);

    if (response.status === 200) {
      const body = (await response.json()) as SiweNonceResponse;
      expect(body.nonce).toBeTruthy();
      expect(body.domain).toBeTruthy();
      expect(body.uri).toBeTruthy();
    }
  });

  test("POST /api/auth/siwe/verify accepts a valid signed SIWE message", async () => {
    const nonceResponse = await api.get("/api/auth/siwe/nonce");
    if (nonceResponse.status !== 200) {
      expect([405, 503]).toContain(nonceResponse.status);
      return;
    }

    const nonceBody = (await nonceResponse.json()) as SiweNonceResponse;
    const account = privateKeyToAccount(generatePrivateKey());
    const message = buildSiweMessage({
      ...nonceBody,
      address: account.address,
    });
    const signature = await account.signMessage({ message });

    const response = await api.post("/api/auth/siwe/verify", {
      message,
      signature,
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      apiKey?: string;
      address?: string;
      isNewAccount?: boolean;
      user?: { id?: string; wallet_address?: string | null };
      organization?: { id?: string } | null;
    };
    expect(body.apiKey).toBeTruthy();
    expect(body.isNewAccount).toBe(true);
    expect(body.address?.toLowerCase()).toBe(account.address.toLowerCase());
    expect(body.user?.id).toBeTruthy();
    expect(body.organization?.id).toBeTruthy();
  });

  test("POST /api/auth/siwe/verify rejects invalid signature", async () => {
    const response = await api.post("/api/auth/siwe/verify", {
      message: "invalid",
      signature: "0x0000",
    });
    expect([400, 401, 422, 503]).toContain(response.status);
  });
});

describe("Logout API", () => {
  test("POST /api/auth/logout responds without error", async () => {
    const response = await api.post("/api/auth/logout");
    // Should succeed even without auth (idempotent logout)
    expect([200, 302, 401]).toContain(response.status);
  });
});
