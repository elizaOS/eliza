import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { disconnectRedis, getRedis } from "../client.js";
import { checkSpendLimit, getSpend, getSpendByHost, recordSpend } from "../spend-tracker.js";

const runRedis = process.env.STEWARD_REDIS_TESTS === "1";
const describeRedis = runRedis ? describe : describe.skip;

const TEST_AGENT = `test-agent-${Date.now()}`;
const TEST_TENANT = "test-tenant-1";

beforeEach(async () => {
  if (!runRedis) return;
  // Clean up test keys
  const redis = getRedis();
  let cursor = "0";
  do {
    const [newCursor, keys] = await redis.scan(
      cursor,
      "MATCH",
      `spend:${TEST_AGENT}:*`,
      "COUNT",
      100,
    );
    cursor = newCursor;
    if (keys.length > 0) await redis.del(...keys);
  } while (cursor !== "0");
});

afterAll(async () => {
  if (!runRedis) return;
  await disconnectRedis();
});

describeRedis("Spend Tracker", () => {
  test("records and queries spend", async () => {
    await recordSpend(TEST_AGENT, TEST_TENANT, 0.05, "api.openai.com");
    await recordSpend(TEST_AGENT, TEST_TENANT, 0.03, "api.openai.com");

    const daySpend = await getSpend(TEST_AGENT, "day");
    expect(daySpend).toBeCloseTo(0.08, 4);

    const weekSpend = await getSpend(TEST_AGENT, "week");
    expect(weekSpend).toBeCloseTo(0.08, 4);

    const monthSpend = await getSpend(TEST_AGENT, "month");
    expect(monthSpend).toBeCloseTo(0.08, 4);
  });

  test("tracks per-host breakdown", async () => {
    await recordSpend(TEST_AGENT, TEST_TENANT, 0.1, "api.openai.com");
    await recordSpend(TEST_AGENT, TEST_TENANT, 0.05, "api.anthropic.com");
    await recordSpend(TEST_AGENT, TEST_TENANT, 0.02, "api.openai.com");

    const byHost = await getSpendByHost(TEST_AGENT, "day");
    expect(byHost["api.openai.com"]).toBeCloseTo(0.12, 4);
    expect(byHost["api.anthropic.com"]).toBeCloseTo(0.05, 4);
  });

  test("checks spend limit — under limit", async () => {
    await recordSpend(TEST_AGENT, TEST_TENANT, 10.0, "api.openai.com");

    const result = await checkSpendLimit(TEST_AGENT, 50.0, "day");
    expect(result.allowed).toBe(true);
    expect(result.spent).toBeCloseTo(10.0, 2);
    expect(result.remaining).toBeCloseTo(40.0, 2);
  });

  test("checks spend limit — over limit", async () => {
    await recordSpend(TEST_AGENT, TEST_TENANT, 55.0, "api.openai.com");

    const result = await checkSpendLimit(TEST_AGENT, 50.0, "day");
    expect(result.allowed).toBe(false);
    expect(result.spent).toBeCloseTo(55.0, 2);
    expect(result.remaining).toBe(0);
  });

  test("zero cost is ignored", async () => {
    await recordSpend(TEST_AGENT, TEST_TENANT, 0, "api.unknown.com");
    await recordSpend(TEST_AGENT, TEST_TENANT, -1, "api.unknown.com");

    const spend = await getSpend(TEST_AGENT, "day");
    expect(spend).toBe(0);
  });

  test("high precision costs are tracked correctly", async () => {
    // $0.000123 per request × 100 requests = $0.0123
    for (let i = 0; i < 100; i++) {
      await recordSpend(TEST_AGENT, TEST_TENANT, 0.000123, "api.openai.com");
    }

    const spend = await getSpend(TEST_AGENT, "day");
    // With 0.0001 cent precision (10000 multiplier), each 0.000123 rounds to 1 unit
    // 100 units / 10000 = 0.01
    expect(spend).toBeCloseTo(0.01, 2);
  });
});
