import { describe, expect, test } from "bun:test";
import { isRecentDestructiveAuth } from "./recent-auth";
import type { StewardTokenClaims } from "./steward-client";

const NOW = 1_800_000_000;

function recent(claims: Partial<StewardTokenClaims>): boolean {
  return isRecentDestructiveAuth({
    claims: {
      userId: "steward-a",
      authMethod: "email",
      issuedAt: NOW - 10,
      expiration: NOW + 3590,
      ...claims,
    },
    expectedStewardUserId: "steward-a",
    nowSeconds: NOW,
    maxAgeSeconds: 5 * 60,
    allowStagingSession: false,
  });
}

describe("isRecentDestructiveAuth", () => {
  test("auth_time decides recency even when iat is fresh", () => {
    expect(recent({ issuedAt: NOW - 10, authTime: NOW - 600 })).toBe(false);
    expect(recent({ issuedAt: NOW - 10, authTime: NOW - 60 })).toBe(true);
  });

  test("a session signed before auth_time existed falls back to iat", () => {
    expect(recent({ issuedAt: NOW - 60 })).toBe(true);
    expect(recent({ issuedAt: NOW - 600 })).toBe(false);
  });

  test("an auth_time in the future is refused", () => {
    expect(recent({ authTime: NOW + 120 })).toBe(false);
  });
});
