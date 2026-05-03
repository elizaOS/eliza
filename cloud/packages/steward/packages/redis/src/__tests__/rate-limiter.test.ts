import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { disconnectRedis, getRedis } from "../client.js";
import { checkRateLimit, getRateLimitStatus } from "../rate-limiter.js";

const runRedis = process.env.STEWARD_REDIS_TESTS === "1";
const describeRedis = runRedis ? describe : describe.skip;

const TEST_PREFIX = "test:ratelimit";

function testKey(suffix: string): string {
  return `${TEST_PREFIX}:${suffix}:${Date.now()}`;
}

beforeEach(async () => {
  if (!runRedis) return;
  // Clean up test keys
  const redis = getRedis();
  let cursor = "0";
  do {
    const [newCursor, keys] = await redis.scan(cursor, "MATCH", `${TEST_PREFIX}:*`, "COUNT", 100);
    cursor = newCursor;
    if (keys.length > 0) await redis.del(...keys);
  } while (cursor !== "0");
});

afterAll(async () => {
  if (!runRedis) return;
  await disconnectRedis();
});

describeRedis("Rate Limiter", () => {
  test("allows requests within limit", async () => {
    const key = testKey("within-limit");

    const r1 = await checkRateLimit(key, 60000, 5);
    expect(r1.allowed).toBe(true);
    expect(r1.remaining).toBe(4);

    const r2 = await checkRateLimit(key, 60000, 5);
    expect(r2.allowed).toBe(true);
    expect(r2.remaining).toBe(3);
  });

  test("denies requests over limit", async () => {
    const key = testKey("over-limit");

    // Use up all 3 slots
    for (let i = 0; i < 3; i++) {
      const r = await checkRateLimit(key, 60000, 3);
      expect(r.allowed).toBe(true);
    }

    // 4th should be denied
    const denied = await checkRateLimit(key, 60000, 3);
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
  });

  test("window expiry resets counter", async () => {
    const key = testKey("expiry");

    // Fill up with 2/2 limit
    await checkRateLimit(key, 100, 2); // 100ms window
    await checkRateLimit(key, 100, 2);

    const denied = await checkRateLimit(key, 100, 2);
    expect(denied.allowed).toBe(false);

    // Wait for window to expire
    await new Promise((r) => setTimeout(r, 150));

    const allowed = await checkRateLimit(key, 100, 2);
    expect(allowed.allowed).toBe(true);
    expect(allowed.remaining).toBe(1);
  });

  test("concurrent access is safe", async () => {
    const key = testKey("concurrent");
    const limit = 5;

    // Fire 10 concurrent requests with limit of 5
    const results = await Promise.all(
      Array.from({ length: 10 }, () => checkRateLimit(key, 60000, limit)),
    );

    const allowed = results.filter((r) => r.allowed).length;
    const denied = results.filter((r) => !r.allowed).length;

    expect(allowed).toBe(limit);
    expect(denied).toBe(5);
  });

  test("getRateLimitStatus does not increment", async () => {
    const key = testKey("status");

    await checkRateLimit(key, 60000, 10);
    await checkRateLimit(key, 60000, 10);

    const status = await getRateLimitStatus(key, 60000, 10);
    expect(status.allowed).toBe(true);
    expect(status.remaining).toBe(8); // still 8, not 7

    // Verify another check still shows 8 remaining
    const status2 = await getRateLimitStatus(key, 60000, 10);
    expect(status2.remaining).toBe(8);
  });
});
