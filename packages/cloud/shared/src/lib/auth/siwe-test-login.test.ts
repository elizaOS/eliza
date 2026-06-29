/**
 * SIWE headless login helper.
 *
 * The default suite is hermetic but NOT a larp: the helper's real signature is
 * driven through the actual server-side validator (`validateSIWEMessage`, which
 * runs viem's real `verifyMessage`) via an in-process fetch shim. So the crypto
 * that secures login is exercised for real — only the network + DB persistence
 * seam is stood in for.
 *
 * Set `SIWE_LIVE_BASE=https://api.elizacloud.ai` to additionally run the live
 * path against a real cloud-api (creates a real free account). That test is
 * skipped by default so PR runs never touch the network.
 */

import { describe, expect, test } from "bun:test";
import { validateSIWEMessage } from "../utils/siwe-helpers";
import { siweTestLogin } from "./siwe-test-login";

const NONCE_DOMAIN = "localhost:3000";
const NONCE_URI = "http://localhost:3000";

/**
 * Minimal in-process stand-in for the two SIWE endpoints. The verify handler
 * runs the REAL `validateSIWEMessage` against the helper's REAL signature, so a
 * forged or malformed signature fails exactly as the live server would.
 */
function makeSiweFetchShim(opts: { tamper?: boolean } = {}): typeof fetch {
  const issuedNonces = new Set<string>();

  return (async (input: Request | string | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();

    if (url.includes("/api/auth/siwe/nonce")) {
      const nonce = `n${issuedNonces.size}${Math.random().toString(16).slice(2)}`;
      issuedNonces.add(nonce);
      return new Response(
        JSON.stringify({
          nonce,
          domain: NONCE_DOMAIN,
          uri: NONCE_URI,
          chainId: 1,
          version: "1",
          statement: "Sign in to Eliza Cloud",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    if (url.includes("/api/auth/siwe/verify")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        message: string;
        signature: `0x${string}`;
      };
      const message = opts.tamper
        ? body.message.replace(/Nonce: \w+/, "Nonce: forged000")
        : body.message;
      try {
        const { address } = await validateSIWEMessage(message, body.signature, NONCE_DOMAIN);
        return new Response(
          JSON.stringify({
            apiKey: "eliza_test_account_key_0123456789",
            address,
            isNewAccount: true,
            user: {
              id: "00000000-0000-4000-8000-000000000001",
              wallet_address: address,
              organization_id: "00000000-0000-4000-8000-000000000002",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      } catch {
        return new Response(JSON.stringify({ error: "SIWE verification failed" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }
    }

    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

describe("siweTestLogin", () => {
  test("completes a real SIWE handshake and returns a usable session", async () => {
    const session = await siweTestLogin({
      baseUrl: NONCE_URI,
      fetchImpl: makeSiweFetchShim(),
    });

    expect(session.apiKey).toBe("eliza_test_account_key_0123456789");
    expect(session.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(session.isNewAccount).toBe(true);
    expect(session.userId).toBe("00000000-0000-4000-8000-000000000001");
    expect(session.organizationId).toBe("00000000-0000-4000-8000-000000000002");
    expect(session.privateKey).toMatch(/^0x[0-9a-fA-F]{64}$/);
  });

  test("signs in deterministically when a private key is supplied", async () => {
    const privateKey =
      "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
    const a = await siweTestLogin({
      baseUrl: NONCE_URI,
      privateKey,
      fetchImpl: makeSiweFetchShim(),
    });
    const b = await siweTestLogin({
      baseUrl: NONCE_URI,
      privateKey,
      fetchImpl: makeSiweFetchShim(),
    });
    expect(a.address).toBe(b.address);
    // The well-known hardhat account #1 derived from this key.
    expect(a.address).toBe("0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
  });

  test("throws (does not return a dead key) when the signature is rejected", async () => {
    await expect(
      siweTestLogin({
        baseUrl: NONCE_URI,
        fetchImpl: makeSiweFetchShim({ tamper: true }),
      }),
    ).rejects.toThrow(/SIWE verify failed/);
  });
});

describe("siweTestLogin (live)", () => {
  const liveBase = process.env.SIWE_LIVE_BASE;
  test.skipIf(!liveBase)("creates a real free cloud account and authorizes a request", async () => {
    const session = await siweTestLogin({ baseUrl: liveBase as string });
    expect(session.apiKey).toMatch(/^eliza_/);
    expect(session.isNewAccount).toBe(true);

    const balance = await fetch(`${liveBase}/api/v1/credits/balance`, {
      headers: { authorization: `Bearer ${session.apiKey}` },
    });
    expect(balance.status).toBe(200);
  });
});
