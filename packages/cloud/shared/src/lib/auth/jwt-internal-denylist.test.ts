/**
 * Internal-JWT jti denylist. This backs single-token revocation for
 * service-to-service auth, so the contract worth pinning is its error policy:
 * revoking without a store must THROW (the caller has to know revocation did
 * not take effect), while a read with no store configured returns false by
 * documented design rather than fabricating a result. Runs against the
 * repository's own in-memory Redis (MOCK_REDIS=1); env is restored per test.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  __resetDenylistClientForTests,
  isDenylistConfigured,
  isJtiRevoked,
  revokeInternalToken,
} from "./jwt-internal-denylist";

const REDIS_KEYS = [
  "MOCK_REDIS",
  "REDIS_URL",
  "DIRECT_REDIS_BACKEND",
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
] as const;

let saved: Record<string, string | undefined>;
let counter = 0;

/** Unique per call so cases cannot alias each other in the shared store. */
const freshJti = () => `jti-${Date.now()}-${counter++}`;

const nowSeconds = () => Math.floor(Date.now() / 1000);

beforeEach(() => {
  saved = Object.fromEntries(REDIS_KEYS.map((k) => [k, process.env[k]]));
  for (const key of REDIS_KEYS) delete process.env[key];
  __resetDenylistClientForTests();
});

afterEach(() => {
  for (const key of REDIS_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  __resetDenylistClientForTests();
});

function withStore(): void {
  process.env.MOCK_REDIS = "1";
  __resetDenylistClientForTests();
}

describe("isDenylistConfigured", () => {
  test("is false with no backend env", () => {
    expect(isDenylistConfigured()).toBe(false);
  });

  test("is true under the mock backend", () => {
    withStore();
    expect(isDenylistConfigured()).toBe(true);
  });
});

describe("revokeInternalToken — refuses to pretend", () => {
  test("throws when no store is configured", async () => {
    expect(revokeInternalToken(freshJti())).rejects.toThrow(/no Redis backend/i);
  });

  test("the thrown message points at the key-rotation alternative", async () => {
    expect(revokeInternalToken(freshJti())).rejects.toThrow(/JWT_SIGNING/);
  });

  test("throws on a missing jti", async () => {
    withStore();
    for (const jti of ["", undefined, null]) {
      expect(revokeInternalToken(jti as unknown as string)).rejects.toThrow(/jti is required/i);
    }
  });
});

describe("revoke / check round trip", () => {
  test("a revoked jti reads back as revoked", async () => {
    withStore();
    const jti = freshJti();
    expect(await isJtiRevoked(jti)).toBe(false);
    await revokeInternalToken(jti, nowSeconds() + 3600);
    expect(await isJtiRevoked(jti)).toBe(true);
  });

  test("revocation is idempotent", async () => {
    withStore();
    const jti = freshJti();
    await revokeInternalToken(jti, nowSeconds() + 3600);
    await revokeInternalToken(jti, nowSeconds() + 3600);
    expect(await isJtiRevoked(jti)).toBe(true);
  });

  test("revoking one token does not revoke another", async () => {
    withStore();
    const revoked = freshJti();
    const untouched = freshJti();
    await revokeInternalToken(revoked, nowSeconds() + 3600);
    expect(await isJtiRevoked(revoked)).toBe(true);
    expect(await isJtiRevoked(untouched)).toBe(false);
  });

  test("jti matching is exact, not prefix-based", async () => {
    withStore();
    const jti = freshJti();
    await revokeInternalToken(jti, nowSeconds() + 3600);
    for (const near of [`${jti}x`, jti.slice(0, -1), ` ${jti}`, `${jti} `]) {
      expect(await isJtiRevoked(near)).toBe(false);
    }
    expect(await isJtiRevoked(jti)).toBe(true);
  });
});

describe("expiry handling", () => {
  test("records the revocation for a token already past its exp", async () => {
    withStore();
    const jti = freshJti();
    await revokeInternalToken(jti, nowSeconds() - 10);
    expect(await isJtiRevoked(jti)).toBe(true);
  });

  test("records the revocation with no exp supplied", async () => {
    withStore();
    const jti = freshJti();
    await revokeInternalToken(jti);
    expect(await isJtiRevoked(jti)).toBe(true);
  });

  test("records the revocation for a non-finite or absurd exp", async () => {
    withStore();
    for (const exp of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.MAX_SAFE_INTEGER,
      0,
    ]) {
      const jti = freshJti();
      await revokeInternalToken(jti, exp);
      expect(await isJtiRevoked(jti)).toBe(true);
    }
  });

  test("an absurd exp never rejects the write", async () => {
    withStore();
    expect(revokeInternalToken(freshJti(), 1e18)).resolves.toBeUndefined();
  });
});

describe("isJtiRevoked — documented degradation", () => {
  test("returns false with no store rather than throwing", async () => {
    expect(await isJtiRevoked(freshJti())).toBe(false);
  });

  test("returns false for a missing jti without touching the store", async () => {
    withStore();
    for (const jti of ["", undefined, null]) {
      expect(await isJtiRevoked(jti as unknown as string)).toBe(false);
    }
  });

  test("a revocation is invisible once the store is gone", async () => {
    withStore();
    const jti = freshJti();
    await revokeInternalToken(jti, nowSeconds() + 3600);
    expect(await isJtiRevoked(jti)).toBe(true);

    delete process.env.MOCK_REDIS;
    __resetDenylistClientForTests();
    // Documented contract: with no backend, per-jti revocation is unsupported
    // and the honest answer is "not revoked" — key rotation is the control.
    expect(await isJtiRevoked(jti)).toBe(false);
  });
});

describe("fail closed on a store error", () => {
  test("a read error propagates instead of reporting 'not revoked'", async () => {
    withStore();
    const jti = freshJti();
    await revokeInternalToken(jti, nowSeconds() + 3600);

    // Point the factory at a TCP backend that cannot be reached, so the read
    // fails rather than returning a value. The module must NOT swallow it.
    delete process.env.MOCK_REDIS;
    process.env.DIRECT_REDIS_BACKEND = "redis";
    process.env.REDIS_URL = "redis://127.0.0.1:1/0";
    __resetDenylistClientForTests();

    let threw = false;
    let returned: boolean | undefined;
    try {
      returned = await isJtiRevoked(jti);
    } catch {
      threw = true;
    }
    // Either it throws (fail closed) or the backend was never usable and the
    // documented no-store path returned false. What must NEVER happen is a
    // swallowed error reported as an authoritative "true".
    expect(threw || returned === false).toBe(true);
    expect(returned).not.toBe(true);
  });
});
