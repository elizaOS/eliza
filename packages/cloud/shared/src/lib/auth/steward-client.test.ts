/**
 * Steward JWT lifecycle claims: a token under the shared HS256 secret must
 * carry an `exp` (jose only enforces it when present, so a no-exp token would
 * never expire) whose horizon stays within the Steward access-token TTL plus
 * the issuer clock-skew allowance. Real jose verification through
 * `verifyStewardTokenCached`; Redis cache, db helpers, and logger mocked (the
 * staging-session binding module names dbRead at module scope).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createHash } from "crypto";
import { SignJWT } from "jose";

const SECRET = "steward-client-test-secret-0123456789abcdef";
const ENV = { STEWARD_JWT_SECRET: SECRET };
const memoryCache = new Map<string, unknown>();
let distributedCacheValue: unknown = null;
let tokenSequence = 0;

mock.module("../../db/helpers", () => ({
  dbRead: {},
  dbWrite: {},
  writeTransaction: async () => {
    throw new Error("transaction is outside this steward-client test path");
  },
}));

mock.module("../cache/client", () => ({
  cache: {
    get: async () => distributedCacheValue,
    set: async () => undefined,
    del: async () => undefined,
  },
}));

mock.module("../cache/in-memory-lru-cache", () => ({
  InMemoryLRUCache: class {
    get(key: string) {
      return memoryCache.get(key) ?? null;
    }
    set(key: string, value: unknown) {
      memoryCache.set(key, value);
    }
    delete(key: string) {
      memoryCache.delete(key);
    }
    clear() {
      memoryCache.clear();
    }
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
  tokenSequence += 1;
  return await new SignJWT({
    sub: "steward-user-1",
    jti: `test-${tokenSequence}`,
    iat: Math.floor(Date.now() / 1000),
    ...claims,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .sign(secretKey());
}

async function verify(token: string) {
  return await verifyStewardTokenCached(ENV, token);
}

describe("verifyStewardTokenCached — token lifecycle claims", () => {
  beforeEach(() => {
    memoryCache.clear();
    distributedCacheValue = null;
  });

  afterEach(() => {
    memoryCache.clear();
    distributedCacheValue = null;
  });

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

  test("retains a strictly shaped Telegram identity signed by Steward", async () => {
    const token = await new SignJWT({
      sub: "steward-telegram-user",
      authMethod: "telegram",
      telegramId: "424242",
    })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(secretKey());

    await expect(verify(token)).resolves.toMatchObject({
      userId: "steward-telegram-user",
      authMethod: "telegram",
      telegramId: "424242",
    });
  });

  test("rejects impossible Telegram sessions with missing or malformed sender ids", async () => {
    for (const telegramId of [undefined, "", "0", "0001", "-1", "123abc", "1".repeat(21)]) {
      const token = await new SignJWT({
        sub: `steward-telegram-invalid-${String(telegramId)}`,
        authMethod: "telegram",
        ...(telegramId === undefined ? {} : { telegramId }),
      })
        .setProtectedHeader({ alg: "HS256", typ: "JWT" })
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(secretKey());
      expect(await verify(token)).toBeNull();
    }
  });

  test("does not grant Telegram authority from a claim on another auth method", async () => {
    const token = await new SignJWT({
      sub: "steward-email-user",
      authMethod: "email",
      telegramId: "424242",
    })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(secretKey());

    await expect(verify(token)).resolves.toMatchObject({
      userId: "steward-email-user",
      authMethod: "email",
    });
    expect((await verify(token))?.telegramId).toBeUndefined();
  });

  test("preserves Telegram authority through a verified bearer re-mint", async () => {
    const minted = await mintStewardTokenFromClaims(ENV, {
      userId: "steward-telegram-remint",
      authMethod: "telegram",
      telegramId: "987654321",
      expiration: 0,
      issuedAt: 0,
    });
    expect(minted).not.toBeNull();
    if (!minted) return;

    await expect(verify(minted.token)).resolves.toMatchObject({
      userId: "steward-telegram-remint",
      authMethod: "telegram",
      telegramId: "987654321",
    });
  });

  test("refuses to mint an impossible Telegram claims combination", async () => {
    await expect(
      mintStewardTokenFromClaims(ENV, {
        userId: "steward-telegram-invalid-remint",
        authMethod: "telegram",
        telegramId: "not-a-sender-id",
        expiration: 0,
        issuedAt: 0,
      }),
    ).resolves.toBeNull();
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

  test("accepts a one-hour token whose issuer clock is just ahead", async () => {
    const issuedAt = Math.floor(Date.now() / 1000) + 240;
    const token = await new SignJWT({ sub: "steward-user-skew" })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + STEWARD_ACCESS_TOKEN_TTL_SECONDS)
      .sign(secretKey());
    const claims = await verify(token);
    expect(claims?.userId).toBe("steward-user-skew");
  });

  test("rejects a 24-hour token presented during its final hour", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ sub: "steward-user-old-longttl" })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuedAt(now - 23 * 60 * 60)
      .setExpirationTime(now + 60 * 60)
      .sign(secretKey());
    expect(await verify(token)).toBeNull();
  });

  test("rejects a token with exp but no iat", async () => {
    const token = await new SignJWT({ sub: "steward-user-noiat" })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setExpirationTime("5m")
      .sign(secretKey());
    expect(await verify(token)).toBeNull();
  });

  test("rejects inverted, fractional, and too-far-future NumericDates", async () => {
    const now = Math.floor(Date.now() / 1000);
    const invalidClaims = [
      { iat: now, exp: now },
      { iat: now + 0.5, exp: now + 60 },
      { iat: now, exp: now + 60.5 },
      { iat: now + 301, exp: now + 601 },
      { iat: now, exp: now + 60, nbf: now + 61 },
    ];
    for (const claims of invalidClaims) {
      const token = await mint(claims);
      expect(await verify(token)).toBeNull();
    }
  });

  test("requires the ordinary Steward JWT token class and sub claim", async () => {
    const now = Math.floor(Date.now() / 1000);
    const wrongType = await new SignJWT({ sub: "steward-user", iat: now, exp: now + 60 })
      .setProtectedHeader({ alg: "HS256", typ: "not-a-steward-session" })
      .sign(secretKey());
    const userIdOnly = await new SignJWT({ userId: "legacy-user", iat: now, exp: now + 60 })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .sign(secretKey());
    expect(await verify(wrongType)).toBeNull();
    expect(await verify(userIdOnly)).toBeNull();
  });

  test("accepts canonical Steward session tokens whose protected header omits typ", async () => {
    const now = Math.floor(Date.now() / 1000);
    const canonicalStewardToken = await new SignJWT({
      sub: "canonical-steward-user",
      iat: now,
      exp: now + 60,
    })
      .setProtectedHeader({ alg: "HS256" })
      .sign(secretKey());

    expect((await verify(canonicalStewardToken))?.userId).toBe("canonical-steward-user");
  });

  test("revalidates lifetime on distributed cache hits", async () => {
    const now = Math.floor(Date.now() / 1000);
    const signingKeyFingerprint = createHash("sha256")
      .update(secretKey())
      .digest("hex")
      .substring(0, 16);
    distributedCacheValue = {
      claimsSchemaVersion: 2,
      userId: "cached-user",
      tenantId: "expected-tenant",
      issuedAt: now - 23 * 60 * 60,
      expiration: now + 60 * 60,
      cachedAt: Date.now(),
      signingKeyFingerprint,
    };
    const token = await mint({ tenantId: "expected-tenant", exp: now + 60 });
    expect(
      await verifyStewardTokenCached({ ...ENV, STEWARD_TENANT_ID: "expected-tenant" }, token),
    ).toBeNull();
  });

  test("revalidates tenant policy on distributed cache hits", async () => {
    const now = Math.floor(Date.now() / 1000);
    const signingKeyFingerprint = createHash("sha256")
      .update(secretKey())
      .digest("hex")
      .substring(0, 16);
    distributedCacheValue = {
      claimsSchemaVersion: 2,
      userId: "cached-user",
      tenantId: "wrong-tenant",
      issuedAt: now,
      expiration: now + 60,
      cachedAt: Date.now(),
      signingKeyFingerprint,
    };
    const token = await mint({ tenantId: "expected-tenant", exp: now + 60 });
    expect(
      await verifyStewardTokenCached({ ...ENV, STEWARD_TENANT_ID: "expected-tenant" }, token),
    ).toBeNull();
  });

  test("re-verifies tokens when a pre-Telegram claims memo lacks the current schema", async () => {
    const now = Math.floor(Date.now() / 1000);
    const signingKeyFingerprint = createHash("sha256")
      .update(secretKey())
      .digest("hex")
      .substring(0, 16);
    distributedCacheValue = {
      userId: "stale-cached-user",
      issuedAt: now,
      expiration: now + 300,
      cachedAt: Date.now(),
      signingKeyFingerprint,
    };
    const token = await new SignJWT({
      sub: "current-telegram-user",
      authMethod: "telegram",
      telegramId: "424242",
    })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(secretKey());

    await expect(verify(token)).resolves.toMatchObject({
      userId: "current-telegram-user",
      authMethod: "telegram",
      telegramId: "424242",
    });
  });

  test("revalidates lifecycle on an in-memory cache hit", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await mint({ iat: now, exp: now + 60 });
    expect(await verify(token)).not.toBeNull();
    const cached = [...memoryCache.values()][0] as { issuedAt: number; expiration: number };
    cached.issuedAt = now - 23 * 60 * 60;
    cached.expiration = now + 60 * 60;
    expect(await verify(token)).toBeNull();
  });

  test("does not reuse a verification memo after signing-key rotation", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await mint({ iat: now, exp: now + 60 });
    expect(await verify(token)).not.toBeNull();
    expect(
      await verifyStewardTokenCached(
        { STEWARD_JWT_SECRET: "rotated-steward-secret-0123456789abcdef" },
        token,
      ),
    ).toBeNull();
  });

  test("rejects an already-expired token", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ sub: "steward-user-expired" })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuedAt(now - 420)
      .setExpirationTime(now - 301)
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
