/**
 * `CacheClient.getWithSWR` over the real memory backend: miss → revalidate →
 * cache, fresh hit skips revalidation, a stale hit serves the last-good value
 * while revalidating in background — and the regression this pins: a FAILING
 * background revalidation must not become an unhandled rejection (nothing
 * awaits the queued promise; bun's unhandled-rejection detector fails the run
 * pre-fix) and must keep serving the last-good value so the next stale hit can
 * retry.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("CacheClient getWithSWR over the memory backend", () => {
  const prevBackend = process.env.CACHE_BACKEND;
  const prevCacheEnabled = process.env.CACHE_ENABLED;

  beforeEach(() => {
    process.env.CACHE_BACKEND = "memory";
    process.env.CACHE_ENABLED = "true";
  });
  afterAll(() => {
    if (prevBackend === undefined) delete process.env.CACHE_BACKEND;
    else process.env.CACHE_BACKEND = prevBackend;
    if (prevCacheEnabled === undefined) delete process.env.CACHE_ENABLED;
    else process.env.CACHE_ENABLED = prevCacheEnabled;
  });

  test("miss revalidates once and caches; a fresh hit skips revalidation", async () => {
    const { CacheClient } = await import("./client");
    const cache = new CacheClient();
    expect(cache.getBackendKind()).toBe("memory");

    let calls = 0;
    const load = async () => {
      calls += 1;
      return { v: "fresh" };
    };

    // Cold miss: revalidate runs and the result is cached.
    expect(await cache.getWithSWR("swr:hit", 60, load, 120)).toEqual({
      v: "fresh",
    });
    expect(calls).toBe(1);

    // Fresh hit (staleAt is a minute away): served from cache, no revalidate.
    expect(await cache.getWithSWR("swr:hit", 60, load, 120)).toEqual({
      v: "fresh",
    });
    expect(calls).toBe(1);
  });

  test("a stale hit serves the last-good value and revalidates in background", async () => {
    const { CacheClient } = await import("./client");
    const cache = new CacheClient();

    let version = 0;
    const load = async () => {
      version += 1;
      return { v: version };
    };

    // staleTTL 0 → the entry is stale on the next read; ttl keeps it stored.
    expect(await cache.getWithSWR("swr:stale", 0, load, 120)).toEqual({ v: 1 });
    await sleep(5);

    // Stale hit: the OLD value is served immediately…
    expect(await cache.getWithSWR("swr:stale", 0, load, 120)).toEqual({ v: 1 });

    // …and the background revalidation lands the fresh one for the next read.
    await sleep(25);
    expect(await cache.getWithSWR("swr:stale", 60, load, 120)).toEqual({
      v: 2,
    });
  });

  test("a FAILING background revalidation keeps the last-good value and does not unhandled-reject", async () => {
    const { CacheClient } = await import("./client");
    const cache = new CacheClient();

    let calls = 0;
    let fail = false;
    const load = async () => {
      calls += 1;
      if (fail) throw new Error("upstream 503");
      return { v: "good" };
    };

    expect(await cache.getWithSWR("swr:fail", 0, load, 120)).toEqual({
      v: "good",
    });
    await sleep(5);

    // Stale hit with a now-failing loader: the stale value is served and the
    // background revalidation rejects. Pre-fix, that rejection was unhandled
    // (bun's detector fails this run); post-fix it is logged and swallowed.
    fail = true;
    expect(await cache.getWithSWR("swr:fail", 0, load, 120)).toEqual({
      v: "good",
    });
    await sleep(25);
    expect(calls).toBe(2);

    // The queue slot was released (finally), so the next stale hit retries…
    fail = false;
    expect(await cache.getWithSWR("swr:fail", 0, load, 120)).toEqual({
      v: "good",
    });
    await sleep(25);
    expect(calls).toBe(3);

    // …and the recovered revalidation refreshed the entry for a fresh read.
    expect(await cache.getWithSWR("swr:fail", 60, load, 120)).toEqual({
      v: "good",
    });
  });
});

// Contract tests for the memory-backend CacheClient surface that the SWR path
// composes with (get/set/del, TTL, atomic helpers, queues, getOrSet). Real
// round-trips against the same client instance the SWR tests use.
describe("CacheClient memory-backend contracts", () => {
  const prevBackend = process.env.CACHE_BACKEND;
  const prevCacheEnabled = process.env.CACHE_ENABLED;

  beforeEach(() => {
    process.env.CACHE_BACKEND = "memory";
    process.env.CACHE_ENABLED = "true";
  });
  afterAll(() => {
    if (prevBackend === undefined) delete process.env.CACHE_BACKEND;
    else process.env.CACHE_BACKEND = prevBackend;
    if (prevCacheEnabled === undefined) delete process.env.CACHE_ENABLED;
    else process.env.CACHE_ENABLED = prevCacheEnabled;
  });

  async function makeCache() {
    const { CacheClient } = await import("./client");
    const cache = new CacheClient();
    expect(cache.getBackendKind()).toBe("memory");
    return cache;
  }

  test("get/set/del round-trip", async () => {
    const cache = await makeCache();
    expect(await cache.get("ct:absent")).toBeNull();
    await cache.set("ct:a", { n: 1 }, 60);
    expect(await cache.get("ct:a")).toEqual({ n: 1 });
    await cache.del("ct:a");
    expect(await cache.get("ct:a")).toBeNull();
  });

  test("getWithOutcome distinguishes a miss from a hit", async () => {
    const cache = await makeCache();
    const miss = await cache.getWithOutcome("ct:outcome");
    expect(miss.kind).toBe("miss");
    await cache.setWithOutcome("ct:outcome", { ok: true }, 60);
    const hit = await cache.getWithOutcome<{ ok: boolean }>("ct:outcome");
    expect(hit.kind).toBe("hit");
    if (hit.kind === "hit") {
      expect(hit.value).toEqual({ ok: true });
    }
  });

  test("setIfNotExists is first-writer-wins", async () => {
    const cache = await makeCache();
    expect(await cache.setIfNotExists("ct:nx", "first", 60_000)).toBe(true);
    expect(await cache.setIfNotExists("ct:nx", "second", 60_000)).toBe(false);
    expect(await cache.get("ct:nx")).toBe("first");
  });

  test("incr counts atomically from zero", async () => {
    const cache = await makeCache();
    expect(await cache.incr("ct:count")).toBe(1);
    expect(await cache.incr("ct:count")).toBe(2);
  });

  test("pttl/pexpire/expire manage a key's lifetime", async () => {
    const cache = await makeCache();
    await cache.set("ct:ttl", "v", 60);
    const remaining = await cache.pttl("ct:ttl");
    expect(remaining).not.toBeNull();
    expect(remaining as number).toBeGreaterThan(0);
    await cache.pexpire("ct:ttl", 120_000);
    await cache.expire("ct:ttl", 300);
    expect(await cache.get("ct:ttl")).toBe("v");
  });

  test("getAndDelete returns the value exactly once", async () => {
    const cache = await makeCache();
    await cache.set("ct:once", { claim: 1 }, 60);
    expect(await cache.getAndDelete("ct:once")).toEqual({ claim: 1 });
    expect(await cache.getAndDelete("ct:once")).toBeNull();
  });

  test("delConfirmed confirms the delete round-trip and the key is gone", async () => {
    const cache = await makeCache();
    await cache.set("ct:delc", 1, 60);
    // Confirms the DEL command succeeded (fail-closed callers key off `false`
    // meaning the invalidation could NOT be confirmed), not prior existence.
    expect(await cache.delConfirmed("ct:delc")).toBe(true);
    expect(await cache.get("ct:delc")).toBeNull();
  });

  test("mget returns values and nulls positionally", async () => {
    const cache = await makeCache();
    await cache.set("ct:m1", "a", 60);
    await cache.set("ct:m3", "c", 60);
    expect(await cache.mget(["ct:m1", "ct:m2", "ct:m3"])).toEqual(["a", null, "c"]);
  });

  test("queue push/pop/length behaves FIFO from head to tail", async () => {
    const cache = await makeCache();
    await cache.pushQueueHead("ct:q", "first");
    await cache.pushQueueHead("ct:q", "second");
    expect(await cache.getQueueLength("ct:q")).toBe(2);
    // Tail pop returns the oldest push.
    expect(await cache.popQueueTail("ct:q")).toBe("first");
    expect(await cache.popQueueTail("ct:q")).toBe("second");
    expect(await cache.popQueueTail("ct:q")).toBeNull();
  });

  test("getOrSet loads once and serves the cached value after", async () => {
    const cache = await makeCache();
    let calls = 0;
    const loader = async () => {
      calls += 1;
      return { loaded: true };
    };
    expect(await cache.getOrSet("ct:gos", 60, loader)).toEqual({
      loaded: true,
    });
    expect(await cache.getOrSet("ct:gos", 60, loader)).toEqual({
      loaded: true,
    });
    expect(calls).toBe(1);
  });
});
