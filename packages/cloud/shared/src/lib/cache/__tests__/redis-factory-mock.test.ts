/** Covers buildRedisClient/hasRedisConfig under MOCK_REDIS=1; no real Redis connection. */

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

  test("implements the full data-structure and pipeline contract used by callers", async () => {
    const { buildRedisClient } = await import("../redis-factory");
    const { MockSocketRedis } = await import("../mock-redis");
    const client = buildRedisClient();
    if (!(client instanceof MockSocketRedis)) throw new Error("expected mock Redis client");
    const prefix = `factory-contract:${crypto.randomUUID()}`;
    const key = (name: string) => `${prefix}:${name}`;

    await client.set(key("getdel"), { id: 1 });
    expect(await client.getdel(key("getdel"))).toEqual({ id: 1 });
    expect(await client.get(key("getdel"))).toBeNull();

    expect(await client.incr(key("counter"))).toBe(1);
    expect(await client.incr(key("counter"))).toBe(2);
    await client.set(key("a"), "one");
    await client.set(key("b"), { two: 2 });
    expect(await client.mget(key("a"), key("b"), key("missing"))).toEqual([
      "one",
      { two: 2 },
      null,
    ]);
    expect(await client.mget()).toEqual([]);

    const [cursor, keys] = await client.scan(0, { match: `${prefix}:?`, count: 100 });
    expect(cursor).toBe("0");
    expect(keys).toEqual(expect.arrayContaining([key("a"), key("b")]));

    expect(await client.lpush(key("list"), "middle", "first")).toBe(2);
    expect(await client.rpush(key("list"), "last")).toBe(3);
    expect(await client.llen(key("list"))).toBe(3);
    expect(await client.lpop(key("list"))).toBe("first");
    expect(await client.lpop(key("list"), 1)).toEqual(["middle"]);
    expect(await client.rpop(key("list"))).toBe("last");
    expect(await client.rpop(key("list"))).toBeNull();

    expect(await client.sadd(key("set"), "a", "b", "a")).toBe(2);
    expect(await client.srem(key("set"), "a", "missing")).toBe(1);
    expect(await client.smembers(key("set"))).toEqual(["b"]);

    expect(await client.zadd(key("zset"), { score: 2, member: "b" })).toBe(1);
    expect(await client.zadd(key("zset"), { score: 1, member: "a" })).toBe(1);
    expect(await client.zadd(key("zset"), { score: 3, member: "c" })).toBe(1);
    expect(await client.zrange(key("zset"), 0, -1)).toEqual(["a", "b", "c"]);
    expect(await client.zremrangebyscore(key("zset"), "-inf", 1)).toBe(1);
    expect(await client.zrem(key("zset"), "c")).toBe(1);
    expect(await client.zcard(key("zset"))).toBe(1);

    await client.set(key("ttl"), "value");
    const ttlPipeline = client.pipeline().pexpire(key("ttl"), 10_000).pttl(key("ttl"));
    const [expireResult, ttl] = await ttlPipeline.exec<[number, number]>();
    expect(expireResult).toBe(1);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(10_000);

    const pipelineResults = await client
      .pipeline()
      .set(key("pipeline-value"), { ok: true })
      .get(key("pipeline-value"))
      .incr(key("pipeline-counter"))
      .setex(key("pipeline-expiring"), 60, "soon")
      .del(key("pipeline-expiring"))
      .exec();
    expect(pipelineResults).toEqual(["OK", '{"ok":true}', 1, "OK", 1]);
    expect(await client.pipeline().exec()).toEqual([]);

    expect(await client.del()).toBe(0);
    expect(await client.expire(key("missing"), 10)).toBe(0);
    expect(await client.pexpire(key("missing"), 10)).toBe(0);
    expect(await client.pttl(key("missing"))).toBe(-2);
    expect(await client.ping()).toBe("PONG");
    await expect(client.quit()).resolves.toBeUndefined();
  });
});

describe("hasRedisConfig", () => {
  test("mirrors buildRedisClient resolution (incl. TCP REDIS_URL)", async () => {
    const { hasRedisConfig } = await import("../redis-factory");
    // no config -> false
    expect(hasRedisConfig({})).toBe(false);
    // TCP REDIS_URL (Railway) -> true
    expect(hasRedisConfig({ REDIS_URL: "redis://default:pw@host:6379" })).toBe(true);
    // legacy Upstash REST creds -> true
    expect(
      hasRedisConfig({ KV_REST_API_URL: "https://x.upstash.io", KV_REST_API_TOKEN: "tok" }),
    ).toBe(true);
    // Upstash alias creds -> true
    expect(
      hasRedisConfig({
        UPSTASH_REDIS_REST_URL: "https://x.upstash.io",
        UPSTASH_REDIS_REST_TOKEN: "tok",
      }),
    ).toBe(true);
    // half-configured Upstash -> false
    expect(hasRedisConfig({ KV_REST_API_URL: "https://x.upstash.io" })).toBe(false);
    // explicit mock -> true
    expect(hasRedisConfig({ MOCK_REDIS: "1" })).toBe(true);
  });
});
