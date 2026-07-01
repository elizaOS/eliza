import { describe, expect, test } from "bun:test";
import { rateLimitConfigVerdict } from "./rate-limit-hono-cloudflare";

// #9853 P1.1 — production must never silently serve with rate limiting OFF.
describe("rateLimitConfigVerdict", () => {
  test("non-production is always ok (local/dev/staging may fall open)", () => {
    for (const environment of [undefined, "staging", "development", "test"]) {
      expect(
        rateLimitConfigVerdict({
          environment,
          redisRateLimiting: "false",
          hasRedisClient: false,
        }),
      ).toBe("ok");
      expect(
        rateLimitConfigVerdict({
          environment,
          redisRateLimiting: "true",
          hasRedisClient: false,
        }),
      ).toBe("ok");
    }
  });

  test("prod + limiting enabled + Redis reachable → ok", () => {
    expect(
      rateLimitConfigVerdict({
        environment: "production",
        redisRateLimiting: "true",
        hasRedisClient: true,
      }),
    ).toBe("ok");
  });

  test("prod + REDIS_RATE_LIMITING=true but NO Redis → fail-closed (the deploy footgun)", () => {
    expect(
      rateLimitConfigVerdict({
        environment: "production",
        redisRateLimiting: "true",
        hasRedisClient: false,
      }),
    ).toBe("fail-closed");
  });

  test("prod + limiting not enabled → warn-disabled (falls open today; ops cutover pending)", () => {
    for (const redisRateLimiting of [undefined, "false", "0", "no"]) {
      expect(
        rateLimitConfigVerdict({
          environment: "production",
          redisRateLimiting,
          hasRedisClient: false,
        }),
      ).toBe("warn-disabled");
      // even with a reachable client, an un-flipped flag means limiting is off
      expect(
        rateLimitConfigVerdict({
          environment: "production",
          redisRateLimiting,
          hasRedisClient: true,
        }),
      ).toBe("warn-disabled");
    }
  });
});
