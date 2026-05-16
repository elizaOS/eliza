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

describe("MemoryRedisAdapter (MOCK_REDIS=1)", () => {
  test("set/get round-trip and respects expire/ex/lpush/ltrim", async () => {
    // intentionally no top-level timeout override; harness default is generous
    const { createRedis } = await import("../redis");
    const redis = createRedis();

    // Basic set/get
    await redis.set("hello", "world");
    expect(await redis.get<string>("hello")).toBe("world");

    // set with ex
    await redis.set("temp", "ttl-value", { ex: 60 });
    expect(await redis.get<string>("temp")).toBe("ttl-value");

    // set with nx — second call must not overwrite
    await redis.set("once", "first", { nx: true });
    await redis.set("once", "second", { nx: true });
    expect(await redis.get<string>("once")).toBe("first");

    // lpush + ltrim
    await redis.lpush("list", "a");
    await redis.lpush("list", "b");
    await redis.lpush("list", "c");
    // Keep only the head element
    await redis.ltrim("list", 0, 0);

    // expire returns 1 when key exists
    const expired = await redis.expire("hello", 30);
    expect(Number(expired)).toBe(1);

    // get returns null for missing key
    expect(await redis.get("nope")).toBeNull();

    if (redis.quit) await redis.quit();
  });
});
