/**
 * Steward-session Redis-outage rate-limit behavior.
 *
 * The route must not repeat the staging outage from #13890: a Redis limiter
 * failure cannot block legitimate session minting before auth validation. It
 * also cannot become naked fail-open, so this drives the real route with a
 * throwing Redis client and proves the route-owned fallback bucket still bounds
 * invalid-token spray.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const emitAudit = mock(async () => undefined);
const verifyStewardTokenCached = mock(async (_env: unknown, token: string) =>
  token === "valid-steward-token"
    ? {
        userId: "steward-user-1",
        email: "person@example.test",
        expiration: Math.floor(Date.now() / 1000) + 900,
      }
    : null,
);
const syncUserFromSteward = mock(async () => ({
  id: "cloud-user-1",
  organization_id: "org-1",
  initialCreditsGranted: false,
  initialFreeCreditsUsd: "0.00",
  welcomeBonusWithheld: false,
  welcomeBonusWithheldReason: undefined,
  welcomeBonusWithheldMessage: undefined,
}));

const throwingRedis = {
  incr: async () => {
    throw new Error("ECONNREFUSED: redis down");
  },
  pttl: async () => {
    throw new Error("ECONNREFUSED: redis down");
  },
  pexpire: async () => {
    throw new Error("ECONNREFUSED: redis down");
  },
};

mock.module("@/lib/cache/redis-factory", () => ({
  buildRedisClient: () => throwingRedis,
  hasRedisConfig: () => true,
  isCloudflareWorkerRuntime: () => false,
}));

mock.module("@/api-app/services/audit-dispatcher-singleton", () => ({
  getAuditDispatcher: () => ({ emit: emitAudit }),
}));

mock.module("@/lib/auth/steward-client", () => ({
  verifyStewardTokenCached,
}));

mock.module("@/lib/steward-sync", () => ({
  describeSyncError: (error: unknown) =>
    error instanceof Error ? error.message : String(error),
  syncUserFromSteward,
}));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    debug: mock(() => undefined),
    error: mock(() => undefined),
    info: mock(() => undefined),
    warn: mock(() => undefined),
  },
}));

const { default: stewardSessionRoute } = await import("./route");
const { _resetRedisUnavailableFallbackBuckets } = await import(
  "@/lib/middleware/rate-limit-hono-cloudflare"
);

const ENV = {
  ENVIRONMENT: "staging",
  NODE_ENV: "production",
  REDIS_URL: "redis://mock:6379",
  STEWARD_SESSION_SECRET: "test-secret",
};

function postStewardSession(body: unknown, ip = "203.0.113.10") {
  const app = new Hono();
  app.route("/api/auth/steward-session", stewardSessionRoute);
  return app.fetch(
    new Request("https://api-staging.elizacloud.ai/api/auth/steward-session", {
      method: "POST",
      headers: {
        "cf-connecting-ip": ip,
        "content-type": "application/json",
        origin: "https://staging.elizacloud.ai",
      },
      body: JSON.stringify(body),
    }),
    ENV,
  );
}

beforeEach(() => {
  emitAudit.mockClear();
  verifyStewardTokenCached.mockClear();
  syncUserFromSteward.mockClear();
  _resetRedisUnavailableFallbackBuckets();
});

describe("POST /api/auth/steward-session — Redis outage fallback limiter", () => {
  test("a missing token reaches normal auth validation instead of rate_limit_unavailable", async () => {
    const res = await postStewardSession({});
    expect(res.status).toBe(400);
    expect(res.headers.get("X-RateLimit-Policy")).toBe(
      "redis-unavailable-local",
    );
    await expect(res.json()).resolves.toMatchObject({
      code: "missing_token",
    });
    expect(verifyStewardTokenCached).not.toHaveBeenCalled();
  });

  test("a valid Steward token can mint staging-scoped cookies while Redis is down", async () => {
    const res = await postStewardSession({
      token: "valid-steward-token",
      refreshToken: "valid-refresh-token",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-RateLimit-Policy")).toBe(
      "redis-unavailable-local",
    );
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      userId: "cloud-user-1",
      stewardUserId: "steward-user-1",
    });
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("steward-token-staging=valid-steward-token");
    expect(setCookie).toContain(
      "steward-refresh-token-staging=valid-refresh-token",
    );
    expect(verifyStewardTokenCached).toHaveBeenCalledTimes(1);
    expect(syncUserFromSteward).toHaveBeenCalledTimes(1);
  });

  test("invalid-token spray is still bounded by the local fallback bucket", async () => {
    for (let i = 0; i < 10; i += 1) {
      const res = await postStewardSession({ token: `invalid-${i}` });
      expect(res.status).toBe(401);
    }

    const blocked = await postStewardSession({ token: "invalid-10" });
    expect(blocked.status).toBe(429);
    await expect(blocked.json()).resolves.toMatchObject({
      success: false,
      code: "rate_limit_exceeded",
    });
    expect(blocked.headers.get("X-RateLimit-Policy")).toBe(
      "redis-unavailable-local",
    );
    expect(verifyStewardTokenCached).toHaveBeenCalledTimes(10);
  });
});
