/**
 * Steward JWT lifecycle claims: a token under the shared HS256 secret must
 * carry an `exp` (jose only enforces it when present, so a no-exp token would
 * never expire) whose horizon stays within the Steward access-token TTL plus
 * the issuer clock-skew allowance. Real jose verification through
 * `verifyStewardTokenCached`; Redis cache, db helpers, and logger mocked (the
 * staging-session binding module names dbRead at module scope).
 */

import { describe, expect, mock, test } from "bun:test";
import { SignJWT } from "jose";

const SECRET = "steward-client-test-secret-0123456789abcdef";
const ENV = { STEWARD_JWT_SECRET: SECRET };

mock.module("../../db/helpers", () => ({
  dbRead: {},
  dbWrite: {},
  writeTransaction: async () => {
    throw new Error("transaction is outside this steward-client test path");
  },
}));

mock.module("../cache/client", () => ({
  cache: {
    get: async () => null,
    set: async () => undefined,
    del: async () => undefined,
  },
}));

mock.module("../utils/logger", () => ({
  logger: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} },
  redact: { id: (v: string) => v, orgId: (v: string) => v, userId: (v: string) => v },
}));

const { mintStewardTokenFromClaims, STEWARD_ACCESS_TOKEN_TTL_SECONDS, verifyStewardTokenCached } =
  await import("./steward-client");

function secretKey(): Uint8Array {
  return new TextEncoder().encode(SECRET);
}

async function mint(claims: Record<string, unknown> = {}): Promise<string> {
  return await new SignJWT({ sub: "steward-user-1", ...claims })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt()
    .sign(secretKey());
}

async function verify(token: string) {
  return await verifyStewardTokenCached(ENV, token);
}

describe("verifyStewardTokenCached — token lifecycle claims", () => {
  test("accepts a token minted at the standard Steward access-token TTL", async () => {
    const minted = await mintStewardTokenFromClaims(ENV, {
      userId: "steward-user-standard",
      expiration: 0,
      issuedAt: 0,
    });
    expect(minted).not.toBeNull();
    if (!minted) return;
    expect(minted.expiresIn).toBe(STEWARD_ACCESS_TOKEN_TTL_SECONDS);

    const claims = await verify(minted.token);
    expect(claims?.userId).toBe("steward-user-standard");
    expect(claims?.expiration).toBe(minted.expiresAt);
  });

  test("rejects a token with no exp claim (would never expire)", async () => {
    const token = await mint({ sub: "steward-user-noexp" });
    expect(await verify(token)).toBeNull();
  });

  test("rejects a token whose TTL exceeds the Steward maximum", async () => {
    const token = await new SignJWT({ sub: "steward-user-longttl" })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuedAt()
      .setExpirationTime("24h")
      .sign(secretKey());
    expect(await verify(token)).toBeNull();
  });

  test("accepts a token just inside the issuer clock-skew allowance", async () => {
    const expiresAt = Math.floor(Date.now() / 1000) + STEWARD_ACCESS_TOKEN_TTL_SECONDS + 240;
    const token = await new SignJWT({ sub: "steward-user-skew" })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuedAt()
      .setExpirationTime(expiresAt)
      .sign(secretKey());
    const claims = await verify(token);
    expect(claims?.userId).toBe("steward-user-skew");
  });

  test("rejects an already-expired token", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ sub: "steward-user-expired" })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuedAt(now - 120)
      .setExpirationTime(now - 60)
      .sign(secretKey());
    expect(await verify(token)).toBeNull();
  });

  test("rejects a token signed with a different secret", async () => {
    const token = await new SignJWT({ sub: "steward-user-wrongkey" })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode("attacker-controlled-secret"));
    expect(await verify(token)).toBeNull();
  });
});
