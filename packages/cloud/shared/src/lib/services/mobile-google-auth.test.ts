/**
 * Exercises the real direct-Redis nonce store, including exact request binding,
 * atomic replay refusal, concurrency, deployment readiness, and URL policy.
 */

import { describe, expect, test } from "bun:test";
import { MockSocketRedis } from "../cache/mock-redis";
import type { MobileAppAuthPkceBinding } from "./mobile-app-auth";
import {
  consumeMobileGoogleAuthNonce,
  issueMobileGoogleAuthNonce,
  MOBILE_GOOGLE_AUTH_NONCE_TTL_SECONDS,
  type MobileGoogleAuthEnv,
  resolveMobileGoogleAuthReadiness,
} from "./mobile-google-auth";

const BINDING: MobileAppAuthPkceBinding = {
  clientId: "ai.elizaos.app",
  environment: "staging",
  redirectUri: "https://eliza.app/auth/callback",
  state: "s".repeat(43),
  codeChallenge: "c".repeat(43),
  codeChallengeMethod: "S256",
  deviceName: "Pixel 11 Pro",
};

const ENV: MobileGoogleAuthEnv = {
  DIRECT_REDIS_BACKEND: "redis-rest",
  ENVIRONMENT: "staging",
  GOOGLE_CLIENT_ID: "google-web-client.apps.googleusercontent.com",
  MOBILE_GOOGLE_SERVER_CLIENT_ID: "google-mobile-server-client.apps.googleusercontent.com",
  KV_REST_API_TOKEN: "redis-token",
  KV_REST_API_URL: "https://redis.example.test",
  NEXT_PUBLIC_API_URL: "https://api-staging.eliza.app",
  STEWARD_JWT_SECRET: "s".repeat(32),
  STEWARD_REQUEST_SIGNING_SECRET: "r".repeat(32),
  STEWARD_TENANT_ID: "elizacloud-staging",
};

function dependencies(redis: MockSocketRedis) {
  return { buildRedisClient: () => redis };
}

describe("mobile Google auth readiness", () => {
  test("uses a dedicated native server client without changing browser OAuth", () => {
    expect(resolveMobileGoogleAuthReadiness(ENV)?.serverClientId).toBe(
      "google-mobile-server-client.apps.googleusercontent.com",
    );
    expect(
      resolveMobileGoogleAuthReadiness({
        ...ENV,
        MOBILE_GOOGLE_SERVER_CLIENT_ID: "  ",
      })?.serverClientId,
    ).toBe("google-web-client.apps.googleusercontent.com");
  });

  test("preserves the canonical /steward base path", () => {
    expect(resolveMobileGoogleAuthReadiness(ENV)?.stewardEndpoint.href).toBe(
      "https://api-staging.eliza.app/steward/auth/oauth/google/id-token",
    );
  });

  test("allows HTTP only for exact loopback hosts", () => {
    expect(
      resolveMobileGoogleAuthReadiness({
        ...ENV,
        NEXT_PUBLIC_API_URL: undefined,
        STEWARD_API_URL: "http://127.0.0.1:8787/steward",
      })?.stewardEndpoint.href,
    ).toBe("http://127.0.0.1:8787/steward/auth/oauth/google/id-token");
    for (const value of [
      "http://api.example.test/steward",
      "http://127.0.0.1.example.test/steward",
      "ftp://127.0.0.1/steward",
      "https://user:password@api.example.test/steward",
      "https://api.example.test/steward?target=other",
    ]) {
      expect(
        resolveMobileGoogleAuthReadiness({
          ...ENV,
          NEXT_PUBLIC_API_URL: undefined,
          STEWARD_API_URL: value,
        }),
      ).toBeNull();
    }
  });

  test("fails closed when every required prerequisite is missing", () => {
    const fields = [
      "ENVIRONMENT",
      "KV_REST_API_TOKEN",
      "KV_REST_API_URL",
      "NEXT_PUBLIC_API_URL",
      "STEWARD_JWT_SECRET",
      "STEWARD_REQUEST_SIGNING_SECRET",
      "STEWARD_TENANT_ID",
    ] as const;
    for (const field of fields) {
      const candidate = { ...ENV, [field]: undefined };
      expect(resolveMobileGoogleAuthReadiness(candidate)).toBeNull();
    }
    expect(
      resolveMobileGoogleAuthReadiness({
        ...ENV,
        GOOGLE_CLIENT_ID: undefined,
        MOBILE_GOOGLE_SERVER_CLIENT_ID: undefined,
      }),
    ).toBeNull();
    expect(
      resolveMobileGoogleAuthReadiness({
        ...ENV,
        MOCK_REDIS: "1",
      }),
    ).toBeNull();
  });

  test("accepts the deprecated Steward session secret only as the existing verifier fallback", () => {
    expect(
      resolveMobileGoogleAuthReadiness({
        ...ENV,
        STEWARD_JWT_SECRET: undefined,
        STEWARD_SESSION_SECRET: "legacy-session-secret".padEnd(32, "x"),
      }),
    ).not.toBeNull();
  });
});

describe("mobile Google auth nonce store", () => {
  test("issues 256 random bits, a five-minute expiry, and no raw capability in the key", async () => {
    const redis = new MockSocketRedis();
    const now = Date.parse("2026-08-25T12:00:00.000Z");
    const issued = await issueMobileGoogleAuthNonce(ENV, BINDING, {
      ...dependencies(redis),
      now: () => now,
    });
    expect(issued.nonce).toMatch(/^[0-9a-f]{64}$/);
    expect(issued.expiresAt).toBe(
      new Date(now + MOBILE_GOOGLE_AUTH_NONCE_TTL_SECONDS * 1_000).toISOString(),
    );
    const [, keys] = await redis.scan(0, {
      match: "staging:mobile-google-auth:nonce:*",
      count: 100,
    });
    let key: string | undefined;
    for (const candidate of keys) {
      if ((await redis.get(candidate)) !== null) key = candidate;
    }
    expect(key).toBeDefined();
    expect(key).not.toContain(issued.nonce);
    expect(key).not.toContain(BINDING.state);
    expect(key).not.toContain(BINDING.codeChallenge);
    expect(await redis.pttl(key as string)).toBeGreaterThan(0);
    expect(await redis.pttl(key as string)).toBeLessThanOrEqual(
      MOBILE_GOOGLE_AUTH_NONCE_TTL_SECONDS * 1_000,
    );
  });

  test("consumes a challenge exactly once", async () => {
    const redis = new MockSocketRedis();
    const issued = await issueMobileGoogleAuthNonce(ENV, BINDING, dependencies(redis));
    expect(
      await consumeMobileGoogleAuthNonce(ENV, BINDING, issued.nonce, dependencies(redis)),
    ).toBe(true);
    expect(
      await consumeMobileGoogleAuthNonce(ENV, BINDING, issued.nonce, dependencies(redis)),
    ).toBe(false);
  });

  test("admits exactly one concurrent consumer", async () => {
    const redis = new MockSocketRedis();
    const issued = await issueMobileGoogleAuthNonce(ENV, BINDING, dependencies(redis));
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        consumeMobileGoogleAuthNonce(ENV, BINDING, issued.nonce, dependencies(redis)),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  test("every changed binding misses without burning the rightful challenge", async () => {
    const mutations: MobileAppAuthPkceBinding[] = [
      { ...BINDING, clientId: "other.client" },
      { ...BINDING, environment: "production" },
      { ...BINDING, redirectUri: "https://example.test/callback" },
      { ...BINDING, state: "x".repeat(43) },
      { ...BINDING, codeChallenge: "x".repeat(43) },
      { ...BINDING, codeChallengeMethod: "plain" },
      { ...BINDING, deviceName: "Other phone" },
      { ...BINDING, deviceName: undefined },
    ];
    for (const mutation of mutations) {
      const redis = new MockSocketRedis();
      const issued = await issueMobileGoogleAuthNonce(ENV, BINDING, dependencies(redis));
      expect(
        await consumeMobileGoogleAuthNonce(ENV, mutation, issued.nonce, dependencies(redis)),
      ).toBe(false);
      expect(
        await consumeMobileGoogleAuthNonce(ENV, BINDING, issued.nonce, dependencies(redis)),
      ).toBe(true);
    }
  });

  test("fails closed on missing or failing direct Redis", async () => {
    await expect(
      issueMobileGoogleAuthNonce(ENV, BINDING, { buildRedisClient: () => null }),
    ).rejects.toThrow("nonce store is unavailable");
    class FailingRedis extends MockSocketRedis {
      override async set(): Promise<string | null> {
        throw new Error("redis set unavailable");
      }
    }
    await expect(
      issueMobileGoogleAuthNonce(ENV, BINDING, dependencies(new FailingRedis())),
    ).rejects.toThrow("redis set unavailable");
  });

  test("rejects a malformed generated nonce before storing it", async () => {
    const redis = new MockSocketRedis();
    await expect(
      issueMobileGoogleAuthNonce(ENV, BINDING, {
        ...dependencies(redis),
        createNonce: () => "not-random",
      }),
    ).rejects.toThrow("generator returned an invalid value");
  });
});
