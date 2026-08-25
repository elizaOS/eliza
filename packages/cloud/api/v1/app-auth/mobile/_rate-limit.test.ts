/** Exercises the real native-auth limiters with shared Redis and outage buckets. */
import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { MockSocketRedis } from "@/lib/cache/mock-redis";
import {
  _resetHonoRateLimitLeases,
  _resetRedisUnavailableFallbackBuckets,
  type RateLimitDependencies,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { MOBILE_APP_AUTH_CLEANUP_DRAIN_CAPACITY } from "@/lib/services/mobile-app-auth";
import type { AppEnv, Bindings } from "@/types/cloud-worker-env";
import {
  MOBILE_APP_AUTH_ACK_RATE_LIMIT,
  MOBILE_APP_AUTH_CONFIG_RATE_LIMIT,
  MOBILE_APP_AUTH_GRANT_GLOBAL_MAX,
  MOBILE_APP_AUTH_GRANT_IP_MAX,
  MOBILE_APP_AUTH_GRANT_USER_MAX,
  MOBILE_APP_AUTH_TOKEN_RATE_LIMIT,
  mobileAppAuthGrantAdmissionRateLimits,
  mobileAppAuthRateLimitMiddleware,
  runMobileAppAuthGrantAdmission,
} from "./_rate-limit";

class FailingRedis extends MockSocketRedis {
  override pipeline(): ReturnType<MockSocketRedis["pipeline"]> {
    const pipeline = super.pipeline();
    pipeline.exec = async () => {
      throw new Error("redis unavailable");
    };
    return pipeline;
  }
}

const env = {
  ENVIRONMENT: "production",
  INFERENCE_HOT_PATH_CACHES: "false",
  NODE_ENV: "production",
  REDIS_RATE_LIMITING: "true",
  REDIS_URL: "redis://test",
} as Bindings;

function request(path: string): Request {
  return new Request(`https://api.example.test${path}`, {
    headers: { "cf-connecting-ip": "203.0.113.12" },
  });
}

function makeApp(
  buildRedisClient: NonNullable<RateLimitDependencies["buildRedisClient"]>,
): Hono {
  const app = new Hono();
  const dependencies = { buildRedisClient };
  app.use(
    "/config",
    mobileAppAuthRateLimitMiddleware(
      MOBILE_APP_AUTH_CONFIG_RATE_LIMIT,
      dependencies,
    ),
  );
  app.use(
    "/token",
    mobileAppAuthRateLimitMiddleware(
      MOBILE_APP_AUTH_TOKEN_RATE_LIMIT,
      dependencies,
    ),
  );
  app.use(
    "/ack",
    mobileAppAuthRateLimitMiddleware(
      MOBILE_APP_AUTH_ACK_RATE_LIMIT,
      dependencies,
    ),
  );
  app.get("*", (c) => c.json({ success: true }));
  return app;
}

beforeEach(() => {
  _resetHonoRateLimitLeases();
  _resetRedisUnavailableFallbackBuckets();
});

describe("mobile App Auth route limiters", () => {
  test("config, token, and ACK consume independent Redis counters", async () => {
    const redis = new MockSocketRedis();
    const app = makeApp(() => redis);

    const config = await app.fetch(request("/config"), env);
    expect(config.status).toBe(200);
    expect(config.headers.get("X-RateLimit-Limit")).toBe("60");

    for (let index = 0; index < 10; index++) {
      expect((await app.fetch(request("/token"), env)).status).toBe(200);
    }
    const denied = await app.fetch(request("/token"), env);
    expect(denied.status).toBe(429);
    expect(denied.headers.get("X-RateLimit-Limit")).toBe("10");
    const retryAfter = Number(denied.headers.get("Retry-After"));
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(60);
    await expect(denied.json()).resolves.toMatchObject({
      success: false,
      error: "slow_down",
      retryable: true,
      retryAfter,
    });

    const ack = await app.fetch(request("/ack"), env);
    expect(ack.status).toBe(200);
    expect(ack.headers.get("X-RateLimit-Remaining")).toBe("9");
    expect(
      await redis.get<number>(
        "ratelimit:mobile-app-auth:config:ip:203.0.113.12",
      ),
    ).toBe(1);
    expect(
      await redis.get<number>(
        "ratelimit:mobile-app-auth:token:ip:203.0.113.12",
      ),
    ).toBe(11);
    expect(
      await redis.get<number>("ratelimit:mobile-app-auth:ack:ip:203.0.113.12"),
    ).toBe(1);
  });

  test("Redis outage fallback buckets remain route-isolated and return a real retry window", async () => {
    const app = makeApp(() => new FailingRedis());

    for (let index = 0; index < 10; index++) {
      expect((await app.fetch(request("/token"), env)).status).toBe(200);
    }
    const denied = await app.fetch(request("/token"), env);
    expect(denied.status).toBe(429);
    expect(Number(denied.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect((await app.fetch(request("/ack"), env)).status).toBe(200);
  });

  test("a missing Redis client still uses the route-isolated fallback", async () => {
    const app = makeApp(() => null);

    for (let index = 0; index < 10; index++) {
      expect((await app.fetch(request("/token"), env)).status).toBe(200);
    }
    const denied = await app.fetch(request("/token"), env);
    expect(denied.status).toBe(429);
    expect(Number(denied.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect((await app.fetch(request("/ack"), env)).status).toBe(200);
  });

  test("grant admission capacity never exceeds one cleanup cadence's bounded drain", () => {
    const [userConfig, ipConfig, globalConfig] =
      mobileAppAuthGrantAdmissionRateLimits(
        "11111111-1111-4111-8111-111111111111",
      );
    expect(MOBILE_APP_AUTH_CLEANUP_DRAIN_CAPACITY).toBeGreaterThanOrEqual(
      MOBILE_APP_AUTH_GRANT_GLOBAL_MAX * 2,
    );
    expect(globalConfig.maxRequests).toBe(MOBILE_APP_AUTH_GRANT_GLOBAL_MAX);
    expect(userConfig.maxRequests).toBe(MOBILE_APP_AUTH_GRANT_USER_MAX);
    expect(ipConfig.maxRequests).toBe(MOBILE_APP_AUTH_GRANT_IP_MAX);
    expect(globalConfig.failClosed).toBe(true);
    expect(userConfig.failClosed).toBe(true);
    expect(ipConfig.failClosed).toBe(true);
    expect(globalConfig.redisUnavailableFallback).toBeUndefined();
  });

  test("a user-limit rejection does not consume shared global capacity", async () => {
    const redis = new MockSocketRedis();
    const dependencies = { buildRedisClient: () => redis };
    const app = new Hono<AppEnv>();
    app.post(
      "/",
      async (c) =>
        await runMobileAppAuthGrantAdmission(
          c,
          "11111111-1111-4111-8111-111111111111",
          async () => c.json({ success: true }),
          dependencies,
        ),
    );

    for (let index = 0; index < MOBILE_APP_AUTH_GRANT_USER_MAX; index++) {
      expect(
        (
          await app.fetch(
            new Request("https://api.example.test/", {
              method: "POST",
              headers: { "cf-connecting-ip": `203.0.113.${index + 1}` },
            }),
            env,
          )
        ).status,
      ).toBe(200);
    }
    expect(
      (
        await app.fetch(
          new Request("https://api.example.test/", {
            method: "POST",
            headers: { "cf-connecting-ip": "198.51.100.1" },
          }),
          env,
        )
      ).status,
    ).toBe(429);
    expect(
      await redis.get<number>(
        "ratelimit:mobile-app-auth:grant:production:global",
      ),
    ).toBe(MOBILE_APP_AUTH_GRANT_USER_MAX);
  });

  test("grant admission fails closed when its shared limiter is unavailable", async () => {
    const app = new Hono<AppEnv>();
    app.post(
      "/",
      async (c) =>
        await runMobileAppAuthGrantAdmission(
          c,
          "11111111-1111-4111-8111-111111111111",
          async () => c.json({ success: true }),
          { buildRedisClient: () => null },
        ),
    );
    const response = await app.fetch(
      new Request("https://api.example.test/", {
        method: "POST",
        headers: { "cf-connecting-ip": "203.0.113.12" },
      }),
      env,
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: "temporarily_unavailable",
      errorDescription:
        "Mobile authorization rate limiting is temporarily unavailable",
      retryable: true,
      success: false,
    });
  });

  test("user and IP dimensions independently stop identity rotation before grant creation", async () => {
    const redis = new MockSocketRedis();
    await redis.del("ratelimit:mobile-app-auth:grant:production:global");
    const dependencies = { buildRedisClient: () => redis };
    const app = new Hono<AppEnv>();
    let grantsCreated = 0;
    app.post(
      "/:user",
      async (c) =>
        await runMobileAppAuthGrantAdmission(
          c,
          c.req.param("user"),
          async () => {
            grantsCreated++;
            return c.json({ success: true });
          },
          dependencies,
        ),
    );

    for (let index = 0; index < MOBILE_APP_AUTH_GRANT_USER_MAX; index++) {
      const response = await app.fetch(
        new Request("https://api.example.test/user-a", {
          method: "POST",
          headers: { "cf-connecting-ip": `203.0.113.${index + 1}` },
        }),
        env,
      );
      expect(response.status).toBe(200);
    }
    const rotatedIpDenied = await app.fetch(
      new Request("https://api.example.test/user-a", {
        method: "POST",
        headers: { "cf-connecting-ip": "198.51.100.1" },
      }),
      env,
    );
    expect(rotatedIpDenied.status).toBe(429);

    for (let index = 0; index < MOBILE_APP_AUTH_GRANT_IP_MAX; index++) {
      const response = await app.fetch(
        new Request(`https://api.example.test/ip-user-${index}`, {
          method: "POST",
          headers: { "cf-connecting-ip": "192.0.2.44" },
        }),
        env,
      );
      expect(response.status).toBe(200);
    }
    const rotatedUserDenied = await app.fetch(
      new Request("https://api.example.test/ip-user-overflow", {
        method: "POST",
        headers: { "cf-connecting-ip": "192.0.2.44" },
      }),
      env,
    );
    expect(rotatedUserDenied.status).toBe(429);
    expect(grantsCreated).toBe(
      MOBILE_APP_AUTH_GRANT_USER_MAX + MOBILE_APP_AUTH_GRANT_IP_MAX,
    );
  });

  test("global admission rejects the first request beyond the bounded cadence budget", async () => {
    const redis = new MockSocketRedis();
    await redis.del("ratelimit:mobile-app-auth:grant:production:global");
    const dependencies = { buildRedisClient: () => redis };
    const app = new Hono<AppEnv>();
    let grantsCreated = 0;
    app.post(
      "/:user",
      async (c) =>
        await runMobileAppAuthGrantAdmission(
          c,
          c.req.param("user"),
          async () => {
            grantsCreated++;
            return c.json({ success: true });
          },
          dependencies,
        ),
    );

    for (let index = 0; index < MOBILE_APP_AUTH_GRANT_GLOBAL_MAX; index++) {
      const response = await app.fetch(
        new Request(`https://api.example.test/global-user-${index}`, {
          method: "POST",
          headers: {
            "cf-connecting-ip": `198.51.${Math.floor(index / 256)}.${index % 256}`,
          },
        }),
        env,
      );
      expect(response.status).toBe(200);
    }
    const denied = await app.fetch(
      new Request("https://api.example.test/global-user-overflow", {
        method: "POST",
        headers: { "cf-connecting-ip": "203.0.113.250" },
      }),
      env,
    );
    expect(denied.status).toBe(429);
    expect(grantsCreated).toBe(MOBILE_APP_AUTH_GRANT_GLOBAL_MAX);
  });
});
