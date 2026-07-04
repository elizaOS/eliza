// Exercises the agent-server redis mock path with deterministic cloud service fixtures.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

const PREV_MOCK = process.env.MOCK_REDIS;

beforeAll(() => {
  process.env.MOCK_REDIS = "1";
});

afterAll(() => {
  if (PREV_MOCK === undefined) {
    delete process.env.MOCK_REDIS;
  } else {
    process.env.MOCK_REDIS = PREV_MOCK;
  }
});

describe("agent-server getRedis (MOCK_REDIS=1)", () => {
  test("returns an in-memory ioredis-mock that supports set/get/expire", async () => {
    const { getRedis } = await import("../../src/redis");
    const redis = getRedis();

    await redis.set("greeting", "hello");
    expect(await redis.get("greeting")).toBe("hello");

    await redis.set("ttl-target", "x");
    const expired = await redis.expire("ttl-target", 30);
    expect(expired).toBe(1);

    await redis.del("greeting");
    expect(await redis.get("greeting")).toBeNull();
  });
});
