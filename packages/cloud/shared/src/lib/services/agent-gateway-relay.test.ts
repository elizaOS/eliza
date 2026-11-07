import { describe, expect, test } from "bun:test";
import type { CompatibleRedis } from "../cache/redis-factory";
import { RedisRelayStore, RelayStateCorruptError } from "./agent-gateway-relay";

/**
 * Minimal Upstash-shaped stand-in. The store prefixes keys with the deployment
 * environment, so the stub answers by shape instead of by literal key: `get`
 * and `lpop` return whatever the test seeded. A seeded corrupt payload then
 * exercises the exact read path production takes after a bad write or a
 * half-truncated key.
 */
function redisReturning(value: string | null): CompatibleRedis {
  return {
    get: async () => value,
    lpop: async () => value,
    setex: async () => "OK",
    del: async () => 1,
    sadd: async () => 1,
    srem: async () => 1,
    expire: async () => 1,
    smembers: async () => [],
    rpush: async () => 1,
  } as unknown as CompatibleRedis;
}

describe("agent gateway relay corrupted state", () => {
  test("a truncated session payload rejects instead of reading as 'no session'", async () => {
    const store = new RedisRelayStore(redisReturning('{"id":"sess-1","organizationId":'));

    // `null` here is indistinguishable from an absent key, and every caller
    // maps it to 404 "Session not found" / "runtime offline" — so a corrupt
    // key looked like a healthy relay whose session had simply gone away.
    await expect(store.getSession("sess-1")).rejects.toThrow(RelayStateCorruptError);
  });

  test("a truncated queue envelope rejects instead of reading as 'queue empty'", async () => {
    const store = new RedisRelayStore(redisReturning('{"requestId":"req-1","rpc":{"id":'));

    // `null` here is the queue-empty signal the 25s long-poll loops on, so a
    // corrupt envelope made the queued request vanish and the caller waited
    // out the full timeout as if nothing had ever been routed.
    await expect(store.dequeueRequest("sess-1")).rejects.toThrow(RelayStateCorruptError);
  });

  test("a truncated response payload rejects instead of reading as 'no answer yet'", async () => {
    const store = new RedisRelayStore(redisReturning('{"result":'));

    await expect(store.getResponse("req-1")).rejects.toThrow(RelayStateCorruptError);
  });

  test("absent keys still read as null", async () => {
    const store = new RedisRelayStore(redisReturning(null));

    expect(await store.getSession("missing")).toBeNull();
    expect(await store.dequeueRequest("missing")).toBeNull();
    expect(await store.getResponse("missing")).toBeNull();
  });
});
