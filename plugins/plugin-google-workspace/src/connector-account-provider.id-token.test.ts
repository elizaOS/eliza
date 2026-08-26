/**
 * Verifies Google connector ID-token admission rejects unsigned, unverifiable,
 * stale, and incorrectly bound identities with a deterministic verifier double.
 */

import { describe, expect, it, vi } from "vitest";
import { verifyGoogleIdTokenWithVerifier } from "./connector-account-provider.js";

const NOW_MS = Date.UTC(2026, 7, 24, 4, 0, 0);
const NOW_SECONDS = Math.floor(NOW_MS / 1000);

function token(header: Record<string, unknown> = { alg: "RS256", kid: "test-key" }): string {
  return `${Buffer.from(JSON.stringify(header)).toString("base64url")}.payload.signature`;
}

function claims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: "https://accounts.google.com",
    aud: "client-id",
    iat: NOW_SECONDS - 10,
    exp: NOW_SECONDS + 3600,
    nonce: "expected-nonce",
    sub: "subject-1",
    email: "owner@example.com",
    ...overrides,
  };
}

function verifier(payload: Record<string, unknown>) {
  return {
    verifyIdToken: vi.fn(async () => ({ getPayload: () => payload })),
  };
}

describe("Google ID-token verification", () => {
  it("accepts a signature-verified and fully bound Google identity", async () => {
    const result = await verifyGoogleIdTokenWithVerifier(
      {
        idToken: token(),
        clientId: "client-id",
        expectedNonce: "expected-nonce",
        nowMs: NOW_MS,
      },
      verifier(claims())
    );

    expect(result).toMatchObject({ sub: "subject-1", email: "owner@example.com" });
  });

  it("rejects alg:none before invoking a verifier", async () => {
    const fake = verifier(claims());
    await expect(
      verifyGoogleIdTokenWithVerifier(
        {
          idToken: token({ alg: "none" }),
          clientId: "client-id",
          expectedNonce: "expected-nonce",
          nowMs: NOW_MS,
        },
        fake
      )
    ).rejects.toMatchObject({ code: "GOOGLE_OAUTH_ID_TOKEN_INVALID" });
    expect(fake.verifyIdToken).not.toHaveBeenCalled();
  });

  it("preserves signature-verifier rejection as a typed invalid-token failure", async () => {
    const fake = {
      verifyIdToken: vi.fn(async () => {
        throw new Error("bad signature");
      }),
    };
    await expect(
      verifyGoogleIdTokenWithVerifier(
        {
          idToken: token(),
          clientId: "client-id",
          expectedNonce: "expected-nonce",
          nowMs: NOW_MS,
        },
        fake
      )
    ).rejects.toMatchObject({ code: "GOOGLE_OAUTH_ID_TOKEN_INVALID" });
  });

  it.each([
    ["wrong issuer", { iss: "https://attacker.invalid" }],
    ["wrong audience", { aud: "other-client" }],
    ["expired", { exp: NOW_SECONDS - 1 }],
    ["future issued-at", { iat: NOW_SECONDS + 301 }],
  ])("rejects %s claims", async (_label, overrides) => {
    await expect(
      verifyGoogleIdTokenWithVerifier(
        {
          idToken: token(),
          clientId: "client-id",
          expectedNonce: "expected-nonce",
          nowMs: NOW_MS,
        },
        verifier(claims(overrides))
      )
    ).rejects.toMatchObject({ code: "GOOGLE_OAUTH_ID_TOKEN_INVALID" });
  });
});
