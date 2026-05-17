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

describe("buildRedisClient (MOCK_REDIS=1)", () => {
  test("returns an in-memory MockSocketRedis that supports round-trip", async () => {
    const { buildRedisClient } = await import("../redis-factory");
    const { MockSocketRedis } = await import("../mock-redis");

    const client = buildRedisClient();
    expect(client).not.toBeNull();
    expect(client).toBeInstanceOf(MockSocketRedis);
    if (!client) throw new Error("expected client");

    // Basic set/get
    await client.set("greeting", "hello");
    expect(await client.get<string>("greeting")).toBe("hello");

    // SET with ex/nx
    await client.set("once", "first", { nx: true, ex: 60 });
    await client.set("once", "second", { nx: true, ex: 60 });
    expect(await client.get<string>("once")).toBe("first");

    // SETEX
    await client.setex("temp", 5, "soon-gone");
    expect(await client.get<string>("temp")).toBe("soon-gone");

    // del + expire
    await client.set("kill-me", "x");
    const delCount = await client.del("kill-me");
    expect(delCount).toBe(1);
    expect(await client.get("kill-me")).toBeNull();

    await client.set("ttl-target", "x");
    const expired = await client.expire("ttl-target", 30);
    expect(expired).toBe(1);

    // Sorted set + pipeline (used by rate limiter)
    const pipeline = client.pipeline();
    pipeline.zadd("zset", { score: 1, member: "a" });
    pipeline.zadd("zset", { score: 2, member: "b" });
    pipeline.zcard("zset");
    pipeline.expire("zset", 30);
    const results = await pipeline.exec();
    expect(results.length).toBe(4);
    expect(results[2]).toBe(2);

    // smembers / sadd (used by gateway-discord)
    await client.sadd("members", "alice", "bob");
    const members = await client.smembers("members");
    expect(members.sort()).toEqual(["alice", "bob"]);
  });
});
