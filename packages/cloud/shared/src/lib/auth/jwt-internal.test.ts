/**
 * Tests for internal JWT signing/verification and the `jti` revocation denylist.
 *
 * Covers finding L12 (#12879):
 *  - positive: a freshly minted token verifies within TTL.
 *  - negative: a token whose `jti` is revoked is rejected.
 *  - negative: an expired token is rejected.
 *  - fail-closed: a denylist store error rejects the token (never allow-on-error).
 *  - degradation: with no Redis configured, verification still succeeds
 *    (per-jti revocation unsupported → key-rotation model), and `revoke` throws.
 */

import { afterEach, beforeEach, describe, expect, mock, setSystemTime, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";

// Generate a real ES256 keypair and expose it the way `jwks.ts` reads it:
// base64-encoded PEM in JWT_SIGNING_PRIVATE_KEY / JWT_SIGNING_PUBLIC_KEY.
function makeKeys() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", {
    namedCurve: "P-256",
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return {
    priv: Buffer.from(privateKey).toString("base64"),
    pub: Buffer.from(publicKey).toString("base64"),
  };
}

const KEYS = makeKeys();

const denylistStore = new Map<string, string>();
let denylistGetError: Error | null = null;
let workerRuntime = false;
let lastRedisEnv: Record<string, string | undefined> | undefined;

function hasConfiguredRedis(env: Record<string, string | undefined>): boolean {
  if (env.MOCK_REDIS === "1" || env.REDIS_URL) return true;
  const restUrl = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL;
  const restToken = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  return Boolean(restUrl && restToken);
}

mock.module("../cache/redis-factory", () => ({
  buildRedisClient: (env: Record<string, string | undefined> = process.env) => {
    lastRedisEnv = env;
    if (!hasConfiguredRedis(env)) return null;
    return {
      async get(key: string) {
        if (denylistGetError) throw denylistGetError;
        return denylistStore.get(key) ?? null;
      },
      async set(key: string, value: unknown, options?: { ex?: number }) {
        denylistStore.set(key, String(value));
        if (options?.ex !== undefined) {
          setTimeout(() => denylistStore.delete(key), options.ex * 1000).unref?.();
        }
        return "OK";
      },
    };
  },
  hasRedisConfig: (env: Record<string, string | undefined> = process.env) =>
    hasConfiguredRedis(env),
  isCloudflareWorkerRuntime: () => workerRuntime,
}));

mock.module("../utils/logger", () => ({
  logger: {
    info: mock(() => undefined),
  },
}));

const mod = await import("./jwt-internal");
const denylistMod = await import("./jwt-internal-denylist");

describe("internal JWT jti revocation denylist (#12879)", () => {
  beforeEach(() => {
    process.env.JWT_SIGNING_PRIVATE_KEY = KEYS.priv;
    process.env.JWT_SIGNING_PUBLIC_KEY = KEYS.pub;
    process.env.JWT_SIGNING_KEY_ID = "test";
    process.env.MOCK_REDIS = "1";
    denylistStore.clear();
    denylistGetError = null;
    workerRuntime = false;
    lastRedisEnv = undefined;
    denylistMod.__resetDenylistClientForTests();
    setSystemTime();
  });

  afterEach(() => {
    delete process.env.JWT_SIGNING_PRIVATE_KEY;
    delete process.env.JWT_SIGNING_PUBLIC_KEY;
    delete process.env.JWT_SIGNING_KEY_ID;
    delete process.env.MOCK_REDIS;
    delete process.env.REDIS_URL;
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    workerRuntime = false;
    setSystemTime();
  });

  describe("with a Redis-backed denylist configured", () => {
    beforeEach(() => {
      process.env.MOCK_REDIS = "1";
    });

    test("verifies a freshly minted token within TTL (positive)", async () => {
      const { access_token } = await mod.signInternalToken({
        subject: "pod-1",
        service: "discord-gateway",
      });

      const result = await mod.verifyInternalToken(access_token);
      expect(result.valid).toBe(true);
      expect(result.payload.sub).toBe("pod-1");
      expect(result.payload.service).toBe("discord-gateway");
      expect(typeof result.payload.jti).toBe("string");
    });

    test("rejects a token after its jti is revoked (negative)", async () => {
      const { access_token } = await mod.signInternalToken({ subject: "pod-2" });

      // Sanity: valid before revocation.
      const before = await mod.verifyInternalToken(access_token);
      expect(before.valid).toBe(true);

      // Revoke by jti, then verify must reject.
      const { payload } = before;
      await mod.revokeInternalToken(payload.jti, payload.exp);

      await expect(mod.verifyInternalToken(access_token)).rejects.toThrow(/revoked/i);
    });

    test("does not revoke unrelated tokens (revocation is per-jti)", async () => {
      const a = await mod.signInternalToken({ subject: "pod-a" });
      const b = await mod.signInternalToken({ subject: "pod-b" });

      const va = await mod.verifyInternalToken(a.access_token);
      await mod.revokeInternalToken(va.payload.jti, va.payload.exp);

      // a is revoked, b is untouched.
      await expect(mod.verifyInternalToken(a.access_token)).rejects.toThrow(/revoked/i);
      const vb = await mod.verifyInternalToken(b.access_token);
      expect(vb.valid).toBe(true);
    });

    test("rejects an expired token (negative)", async () => {
      // Mint a token, then advance the system clock past its exp. jose reads
      // the wall clock for exp validation, so fake timers move it forward.
      const now = new Date();
      try {
        setSystemTime(now);
        const { access_token } = await mod.signInternalToken({
          subject: "pod-exp",
          expiresIn: 1,
        });

        // Jump well past exp (+ jose's default clock tolerance).
        setSystemTime(new Date(now.getTime() + 120_000));

        await expect(mod.verifyInternalToken(access_token)).rejects.toThrow(/exp/i);
      } finally {
        setSystemTime();
      }
    });

    test("fails closed when the denylist store errors (never allow-on-error)", async () => {
      // Force the underlying Redis GET to throw. The denylist read is
      // intentionally un-try/catch'd, so the error propagates through
      // verifyInternalToken and the token is rejected (never allowed).
      denylistGetError = new Error("redis unavailable");

      const { access_token } = await mod.signInternalToken({
        subject: "pod-err",
      });

      await expect(mod.verifyInternalToken(access_token)).rejects.toThrow(/redis unavailable/i);
    });
  });

  describe("with no Redis backend configured (revocation unsupported)", () => {
    beforeEach(() => {
      // Ensure no redis creds are present.
      delete process.env.MOCK_REDIS;
      delete process.env.REDIS_URL;
      delete process.env.KV_REST_API_URL;
      delete process.env.KV_REST_API_TOKEN;
      denylistMod.__resetDenylistClientForTests();
    });

    test("still verifies valid tokens (key-rotation + TTL model)", async () => {
      const { access_token } = await mod.signInternalToken({ subject: "pod-nr" });
      const result = await mod.verifyInternalToken(access_token);
      expect(result.valid).toBe(true);
    });

    test("reports the denylist as not configured", async () => {
      expect(mod.isDenylistConfigured()).toBe(false);
    });

    test("revokeInternalToken throws so callers know it did not take effect", async () => {
      await expect(mod.revokeInternalToken("some-jti", undefined)).rejects.toThrow(
        /no Redis backend configured/i,
      );
    });
  });

  describe("runtime-compatible denylist transport selection", () => {
    test("ignores TCP REDIS_URL in Workers and uses key rotation plus TTL", async () => {
      delete process.env.MOCK_REDIS;
      process.env.REDIS_URL = "redis://railway.internal:6379";
      workerRuntime = true;
      denylistMod.__resetDenylistClientForTests();

      expect(mod.isDenylistConfigured()).toBe(false);
      const { access_token } = await mod.signInternalToken({ subject: "worker-tcp-only" });
      const result = await mod.verifyInternalToken(access_token);

      expect(result.valid).toBe(true);
      expect(lastRedisEnv?.REDIS_URL).toBeUndefined();
    });

    test("uses REST Redis in Workers and remains fail-closed on read errors", async () => {
      delete process.env.MOCK_REDIS;
      process.env.REDIS_URL = "redis://railway.internal:6379";
      process.env.KV_REST_API_URL = "https://redis-rest.example.test";
      process.env.KV_REST_API_TOKEN = "test-token";
      workerRuntime = true;
      denylistGetError = new Error("REST Redis unavailable");
      denylistMod.__resetDenylistClientForTests();

      expect(mod.isDenylistConfigured()).toBe(true);
      const { access_token } = await mod.signInternalToken({ subject: "worker-rest" });

      await expect(mod.verifyInternalToken(access_token)).rejects.toThrow(
        /REST Redis unavailable/i,
      );
      expect(lastRedisEnv?.REDIS_URL).toBeUndefined();
      expect(lastRedisEnv?.KV_REST_API_URL).toBe("https://redis-rest.example.test");
    });

    test("keeps TCP REDIS_URL available to Node services", async () => {
      delete process.env.MOCK_REDIS;
      process.env.REDIS_URL = "redis://railway.internal:6379";
      workerRuntime = false;
      denylistMod.__resetDenylistClientForTests();

      expect(mod.isDenylistConfigured()).toBe(true);
      const { access_token } = await mod.signInternalToken({ subject: "node-tcp" });
      const result = await mod.verifyInternalToken(access_token);

      expect(result.valid).toBe(true);
      expect(lastRedisEnv?.REDIS_URL).toBe("redis://railway.internal:6379");
    });
  });
});
