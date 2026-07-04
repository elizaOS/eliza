/**
 * SCAN pagination — opaque-cursor threading regression guard.
 *
 * scanByPrefix + delPattern must thread the backend's continuation cursor
 * VERBATIM. Cloudflare KV returns a base64-ish token that is not parseable as a
 * number, while Redis numeric cursors are only one backend shape. Cursor
 * corruption stops KV pagination after the first ~100-key page, leaking
 * inference-charge stragglers and leaving delPattern keys behind.
 *
 * The MemoryCacheAdapter now emits a deliberately NON-numeric ("mem:<offset>")
 * cursor, so a memory-backed CacheClient exercises the multi-page path and any
 * parse-the-cursor regression fails these tests.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { logger } from "../utils/logger";
import { MemoryCacheAdapter } from "./adapters/memory-cache-adapter";
import type { CacheRedisClient } from "./adapters/types";

// client.ts statically imports the Upstash/redis adapters; those external libs
// aren't in the unit env. The memory backend never instantiates them, so stub
// the modules just enough for the import to resolve.
mock.module("@upstash/redis", () => ({ Redis: class {} }));
mock.module("redis", () => ({ createClient: () => ({}) }));

describe("MemoryCacheAdapter.scan paginates (no dropped keys, opaque cursor)", () => {
  test("walks all keys across pages and only signals done with '0'", async () => {
    const adapter = new MemoryCacheAdapter();
    const N = 250;
    for (let i = 0; i < N; i++) await adapter.set(`k:${i}`, "v", 300_000);

    const seen = new Set<string>();
    let cursor: string | number = "0";
    let pages = 0;
    let sawOpaqueCursor = false;
    do {
      const [next, keys] = await adapter.scan(cursor, { match: "k:*", count: 100 });
      for (const k of keys) seen.add(k);
      cursor = next;
      if (cursor !== "0") sawOpaqueCursor = true;
      // a numeric parse of a "mem:<n>" cursor would be NaN -> guard against regressions
      expect(Number.isNaN(Number.parseInt(String(cursor), 10)) || cursor === "0").toBe(true);
      if (++pages > 50) throw new Error("scan did not terminate");
    } while (cursor !== "0");

    expect(seen.size).toBe(N);
    expect(pages).toBeGreaterThan(1); // genuinely multi-page
    expect(sawOpaqueCursor).toBe(true);
  });
});

describe("CacheClient SCAN over the memory backend (end-to-end cursor threading)", () => {
  const prevBackend = process.env.CACHE_BACKEND;
  const prevCacheEnabled = process.env.CACHE_ENABLED;
  let CacheClient: typeof import("./client").CacheClient;

  beforeEach(() => {
    // Cloud Tests intentionally run with CACHE_ENABLED=false globally; this
    // regression needs the in-memory backend active to exercise SCAN pagination.
    process.env.CACHE_BACKEND = "memory";
    process.env.CACHE_ENABLED = "true";
  });
  afterAll(() => {
    if (prevBackend === undefined) delete process.env.CACHE_BACKEND;
    else process.env.CACHE_BACKEND = prevBackend;

    if (prevCacheEnabled === undefined) delete process.env.CACHE_ENABLED;
    else process.env.CACHE_ENABLED = prevCacheEnabled;
  });

  test("scanByPrefix returns ALL keys across multiple pages (>100)", async () => {
    ({ CacheClient } = await import("./client"));
    const cache = new CacheClient();
    const N = 250;
    const prefix = "scan-pg-test:";
    for (let i = 0; i < N; i++) await cache.set(`${prefix}${i}`, { i }, 300);

    const mine = (await cache.scanByPrefix(prefix, 1000)).filter((k) => k.startsWith(prefix));
    expect(mine.length).toBe(N);
    expect(new Set(mine).size).toBe(N);
  });

  test("delPattern deletes ALL matching keys across pages", async () => {
    ({ CacheClient } = await import("./client"));
    const cache = new CacheClient();
    const N = 250;
    const prefix = "del-pg-test:";
    for (let i = 0; i < N; i++) await cache.set(`${prefix}${i}`, { i }, 300);

    await cache.delPattern(`${prefix}*`);
    const remaining = (await cache.scanByPrefix(prefix, 1000)).filter((k) => k.startsWith(prefix));
    expect(remaining.length).toBe(0);
  });
});

describe("CacheClient.delPattern empty SCAN page guard", () => {
  let CacheClient: typeof import("./client").CacheClient;
  let warnSpy: ReturnType<typeof spyOn>;

  afterEach(() => {
    warnSpy?.mockRestore();
  });

  test("counts empty non-terminal pages and warns when the iteration cap is exhausted", async () => {
    ({ CacheClient } = await import("./client"));
    const scan = mock(async (cursor: string | number) => [
      cursor === "0" ? "opaque:1" : "opaque:next",
      [],
    ]);
    const del = mock(async () => 0);
    const cache = new CacheClient();
    const fakeRedis = {
      backend: "fake-empty-scan",
      scan,
      del,
    } as unknown as CacheRedisClient;
    Object.assign(cache as unknown as Record<string, unknown>, {
      enabled: true,
      initialized: true,
      nativeRedisConnectPromise: null,
      nativeRedisReady: true,
      redis: fakeRedis,
    });
    warnSpy = spyOn(logger, "warn").mockImplementation(() => {});

    await cache.delPattern("never-matches:*", 10, 3);

    expect(scan).toHaveBeenCalledTimes(3);
    expect(del).not.toHaveBeenCalled();
    expect(String(warnSpy.mock.calls[0]?.[0] ?? "")).toContain("reached max iterations (3)");
  });
});
