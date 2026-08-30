/** Verifies destructive-operation recent-auth policy without raw credentials. */

import { describe, expect, test } from "bun:test";
import { isRecentDestructiveAuth } from "./recent-auth";
import type { StewardTokenClaims } from "./steward-client";

const nowSeconds = 1_800_000_000;
const claims: StewardTokenClaims = {
  userId: "steward-user",
  authMethod: "passkey",
  issuedAt: nowSeconds - 60,
  expiration: nowSeconds + 3_600,
};

function accepted(overrides: Partial<StewardTokenClaims> = {}): boolean {
  return isRecentDestructiveAuth({
    claims: { ...claims, ...overrides },
    expectedStewardUserId: "steward-user",
    nowSeconds,
    maxAgeSeconds: 300,
    allowStagingSession: false,
  });
}

describe("destructive recent auth", () => {
  test("accepts a fresh, directly authenticated matching session", () => {
    expect(accepted()).toBe(true);
  });

  test("rejects stale, bridged, wrong-subject, and methodless sessions", () => {
    expect(accepted({ issuedAt: nowSeconds - 301 })).toBe(false);
    expect(accepted({ bridged: true })).toBe(false);
    expect(accepted({ userId: "other-user" })).toBe(false);
    expect(accepted({ authMethod: undefined })).toBe(false);
  });

  test("allows a bound staging session only when the caller opts in", () => {
    const staging = {
      ...claims,
      authMethod: undefined,
      stagingSessionBinding: {
        version: "v1",
        apiKeyId: "api-key",
        cloudUserId: "cloud-user",
        organizationId: "cloud-org",
        credentialFingerprint: "fingerprint",
        sessionIssuedAt: nowSeconds - 60,
        sessionMaxExpiresAt: nowSeconds + 3_600,
      },
    } as StewardTokenClaims;
    expect(
      isRecentDestructiveAuth({
        claims: staging,
        expectedStewardUserId: "steward-user",
        nowSeconds,
        maxAgeSeconds: 300,
        allowStagingSession: true,
      }),
    ).toBe(true);
    expect(
      isRecentDestructiveAuth({
        claims: staging,
        expectedStewardUserId: "steward-user",
        nowSeconds,
        maxAgeSeconds: 300,
        allowStagingSession: false,
      }),
    ).toBe(false);
  });
});
