/**
 * Service-JWT claim contract: a token under the shared HS256 secret must carry
 * an `exp` (jose only enforces it when present, so a no-exp token would never
 * expire) whose horizon stays within the service maximum, and must match the
 * operator-pinned issuer/audience when ELIZA_SERVICE_JWT_ISSUER/AUDIENCE are
 * configured. Real jose verification; db helpers and logger mocked (the
 * staging-session token-class guard names dbRead at module scope).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { SignJWT } from "jose";

const SECRET = "service-jwt-test-secret-0123456789abcdef";
const ENV_KEYS = [
  "ELIZA_SERVICE_JWT_SECRET",
  "ELIZA_SERVICE_JWT_ISSUER",
  "ELIZA_SERVICE_JWT_AUDIENCE",
] as const;

mock.module("../../db/helpers", () => ({
  dbRead: {},
  dbWrite: {},
  writeTransaction: async () => {
    throw new Error("transaction is outside this service-JWT test path");
  },
}));

mock.module("../utils/logger", () => ({
  logger: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} },
  redact: { id: (v: string) => v, orgId: (v: string) => v, userId: (v: string) => v },
}));

const { verifyServiceJwt } = await import("./service-jwt");

function secretKey(): Uint8Array {
  return new TextEncoder().encode(SECRET);
}

async function mint(claims: Record<string, unknown> = {}): Promise<string> {
  return await new SignJWT({ userId: "waifu:svc", ...claims })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .sign(secretKey());
}

describe("verifyServiceJwt — token lifecycle claims", () => {
  const savedEnv = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      savedEnv.set(key, process.env[key]);
      delete process.env[key];
    }
    process.env.ELIZA_SERVICE_JWT_SECRET = SECRET;
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const saved = savedEnv.get(key);
      if (saved === undefined) delete process.env[key];
      else process.env[key] = saved;
    }
    savedEnv.clear();
  });

  async function verify(token: string) {
    return await verifyServiceJwt(`Bearer ${token}`);
  }

  test("accepts a short-lived token and returns its claims", async () => {
    const token = await new SignJWT({ userId: "waifu:svc", email: "svc@waifu.test" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(secretKey());

    const payload = await verify(token);
    expect(payload?.userId).toBe("waifu:svc");
    expect(payload?.email).toBe("svc@waifu.test");
  });

  test("rejects a token with no exp claim (would never expire)", async () => {
    const token = await mint();
    expect(await verify(token)).toBeNull();
  });

  test("rejects a token whose TTL exceeds the service maximum", async () => {
    const token = await new SignJWT({ userId: "waifu:svc" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("2h")
      .sign(secretKey());
    expect(await verify(token)).toBeNull();
  });

  test("rejects a long-lived token presented during its final hour", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ userId: "waifu:svc" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(now - 23 * 60 * 60)
      .setExpirationTime(now + 60 * 60)
      .sign(secretKey());
    expect(await verify(token)).toBeNull();
  });

  test("rejects exp without iat and malformed NumericDate relationships", async () => {
    const now = Math.floor(Date.now() / 1000);
    const invalidClaims = [
      ["missing iat", { exp: now + 60 }],
      ["inverted", { iat: now, exp: now }],
      ["fractional", { iat: now + 0.5, exp: now + 60 }],
      ["future iat", { iat: now + 301, exp: now + 601 }],
      ["nbf after exp", { iat: now, exp: now + 60, nbf: now + 61 }],
    ] as const;
    for (const [label, claims] of invalidClaims) {
      const token = await new SignJWT({ userId: "waifu:svc", ...claims })
        .setProtectedHeader({ alg: "HS256" })
        .sign(secretKey());
      expect(await verify(token), label).toBeNull();
    }
  });

  test("rejects an already-expired token", async () => {
    const token = await new SignJWT({ userId: "waifu:svc" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(Math.floor(Date.now() / 1000) - 420)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 301)
      .sign(secretKey());
    expect(await verify(token)).toBeNull();
  });

  test("enforces the pinned issuer only when configured", async () => {
    const withoutIss = await new SignJWT({ userId: "waifu:svc" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(secretKey());
    const withIss = await new SignJWT({ userId: "waifu:svc" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("5m")
      .setIssuer("waifu-core")
      .sign(secretKey());

    process.env.ELIZA_SERVICE_JWT_ISSUER = "waifu-core";
    expect(await verify(withoutIss)).toBeNull();
    expect(await verify(withIss)).not.toBeNull();
  });

  test("enforces the pinned audience only when configured", async () => {
    const wrongAud = await new SignJWT({ userId: "waifu:svc" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("5m")
      .setAudience("some-other-service")
      .sign(secretKey());
    const rightAud = await new SignJWT({ userId: "waifu:svc" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("5m")
      .setAudience("eliza-cloud")
      .sign(secretKey());

    process.env.ELIZA_SERVICE_JWT_AUDIENCE = "eliza-cloud";
    expect(await verify(wrongAud)).toBeNull();
    expect(await verify(rightAud)).not.toBeNull();
  });

  test("rejects a token signed with a different secret", async () => {
    const token = await new SignJWT({ userId: "waifu:svc" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(new TextEncoder().encode("attacker-controlled-secret"));
    expect(await verify(token)).toBeNull();
  });
});
