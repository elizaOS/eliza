// Exercises the gateway-discord redis adapter path with deterministic cloud service fixtures.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createMockRedis,
  createNativeRedis,
  UpstashCompatRedis,
} from "../src/redis-adapter";

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

describe("UpstashCompatRedis (mock client)", () => {
  test("round-trip across the gateway-discord call surface", async () => {
    const redis = createMockRedis();

    // set + get round-trip
    await redis.set("hello", "world");
    expect(await redis.get<string>("hello")).toBe("world");

    // set with {ex, nx} — same option mapping the native (Railway TCP) path uses
    await redis.set("once", "first", { nx: true, ex: 60 });
    await redis.set("once", "second", { nx: true, ex: 60 });
    expect(await redis.get<string>("once")).toBe("first");

    // expire returns 1 on existing key
    expect(await redis.expire("hello", 30)).toBe(1);

    // setex + del
    await redis.setex("pod:state", 60, JSON.stringify({ ok: true }));
    expect(await redis.get<{ ok: boolean }>("pod:state")).toEqual({ ok: true });
    expect(await redis.del("pod:state")).toBe(1);

    // sadd / smembers / srem
    await redis.sadd("active_pods", "pod-a", "pod-b");
    const members = await redis.smembers("active_pods");
    expect(members.sort()).toEqual(["pod-a", "pod-b"]);
    await redis.srem("active_pods", "pod-a");
    expect(await redis.smembers("active_pods")).toEqual(["pod-b"]);

    await redis.quit();
  });
});

describe("createNativeRedis (Railway TCP)", () => {
  test("builds an UpstashCompatRedis without connecting eagerly", () => {
    // lazyConnect-style: constructing must not throw or require a live server.
    const redis = createNativeRedis("redis://default:pw@127.0.0.1:6390");
    expect(redis).toBeInstanceOf(UpstashCompatRedis);
    // close the idle ioredis socket so the test process can exit cleanly.
    void redis.quit();
  });
});
