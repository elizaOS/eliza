/**
 * `KvCacheAdapter` behavioral contract (Cloudflare KV-backed CacheRedisClient).
 *
 * KV is eventually consistent, has no TTL introspection, rejects
 * `expirationTtl < 60s`, and offers no atomic ops. The adapter must therefore:
 *   - clamp every TTL to >= 60s (setex/set-px/expire/pexpire);
 *   - emulate NX as a best-effort existence check (return null when present);
 *   - emulate expire/pexpire by re-writing the value with a new TTL (reput),
 *     returning 0 for a missing key and 1 when the TTL was re-applied;
 *   - report pttl as -1 ("present, TTL unknown");
 *   - emulate lists as JSON-array values, tolerating corrupt payloads;
 *   - scan by deriving a KV prefix from the glob and filtering pages client-side,
 *     propagating cursors across paginated list() calls.
 */

import { describe, expect, test } from "bun:test";
import { KvCacheAdapter, type KvNamespaceLike } from "./kv-cache-adapter";

interface PutRecord {
  key: string;
  value: string;
  options?: { expirationTtl?: number };
}

function createFakeKv() {
  const store = new Map<string, string>();
  const puts: PutRecord[] = [];
  const deletes: string[] = [];
  const kv: KvNamespaceLike = {
    async get(key) {
      return store.get(key) ?? null;
    },
    async put(key, value, options) {
      store.set(key, value);
      puts.push({ key, value, options });
    },
    async delete(key) {
      store.delete(key);
      deletes.push(key);
    },
    async list(options) {
      const prefix = options?.prefix ?? "";
      const limit = options?.limit ?? Number.POSITIVE_INFINITY;
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start =
        options?.cursor !== undefined ? Number.parseInt(String(options.cursor), 10) || 0 : 0;
      const page = keys.slice(start, start + limit);
      const listComplete = start + page.length >= keys.length;
      return {
        keys: page.map((name) => ({ name })),
        list_complete: listComplete,
        cursor: listComplete ? undefined : String(start + page.length),
      };
    },
  };
  return { kv, store, puts, deletes };
}

function lastPut(puts: PutRecord[]): PutRecord {
  return puts[puts.length - 1];
}

describe("KvCacheAdapter TTL clamping (KV rejects expirationTtl < 60s)", () => {
  test("setex clamps sub-minute TTLs up to the 60s floor", async () => {
    const { kv, puts } = createFakeKv();
    const adapter = new KvCacheAdapter(kv);
    await adapter.setex("k", 5, "v");
    expect(lastPut(puts).options?.expirationTtl).toBe(60);
  });

  test("setex passes through TTLs at or above the floor (ceil applied)", async () => {
    const { kv, puts } = createFakeKv();
    const adapter = new KvCacheAdapter(kv);
    await adapter.setex("k", 120, "v");
    expect(lastPut(puts).options?.expirationTtl).toBe(120);
    await adapter.setex("k", 60.5, "v");
    expect(lastPut(puts).options?.expirationTtl).toBe(61);
  });

  test("setex with zero or negative TTL clamps to the floor", async () => {
    const { kv, puts } = createFakeKv();
    const adapter = new KvCacheAdapter(kv);
    await adapter.setex("k", 0, "v");
    expect(lastPut(puts).options?.expirationTtl).toBe(60);
    await adapter.setex("k", -10, "v");
    expect(lastPut(puts).options?.expirationTtl).toBe(60);
  });

  test("set with px converts milliseconds to clamped seconds", async () => {
    const { kv, puts } = createFakeKv();
    const adapter = new KvCacheAdapter(kv);
    await adapter.set("k", "v", { px: 5_000 });
    expect(lastPut(puts).options?.expirationTtl).toBe(60);
    await adapter.set("k", "v", { px: 120_000 });
    expect(lastPut(puts).options?.expirationTtl).toBe(120);
  });

  test("expire re-writes the value with a clamped TTL and returns 1", async () => {
    const { kv, store, puts } = createFakeKv();
    const adapter = new KvCacheAdapter(kv);
    await adapter.setex("k", 60, "v");
    puts.length = 0;
    const result = await adapter.expire("k", 5);
    expect(result).toBe(1);
    expect(lastPut(puts).options?.expirationTtl).toBe(60);
    expect(store.get("k")).toBe("v");
  });

  test("expire on a missing key returns 0 and writes nothing", async () => {
    const { kv, puts } = createFakeKv();
    const adapter = new KvCacheAdapter(kv);
    const result = await adapter.expire("missing", 60);
    expect(result).toBe(0);
    expect(puts).toHaveLength(0);
  });

  test("pexpire converts milliseconds and clamps", async () => {
    const { kv, store, puts } = createFakeKv();
    const adapter = new KvCacheAdapter(kv);
    await adapter.setex("k", 60, "v");
    puts.length = 0;
    const result = await adapter.pexpire("k", 10_000);
    expect(result).toBe(1);
    expect(lastPut(puts).options?.expirationTtl).toBe(60);
    expect(store.get("k")).toBe("v");
  });

  test("pttl reports -1 (present, TTL unknown) since KV exposes no introspection", async () => {
    const { kv } = createFakeKv();
    const adapter = new KvCacheAdapter(kv);
    expect(await adapter.pttl()).toBe(-1);
  });
});

describe("KvCacheAdapter set semantics", () => {
  test("set without options stores the value and returns OK", async () => {
    const { kv, store } = createFakeKv();
    const adapter = new KvCacheAdapter(kv);
    expect(await adapter.set("k", "v")).toBe("OK");
    expect(store.get("k")).toBe("v");
  });

  test("set nx on an existing key returns null and does not overwrite", async () => {
    const { kv, store, puts } = createFakeKv();
    const adapter = new KvCacheAdapter(kv);
    await adapter.set("k", "original");
    puts.length = 0;
    const result = await adapter.set("k", "replacement", { nx: true });
    expect(result).toBeNull();
    expect(store.get("k")).toBe("original");
    expect(puts).toHaveLength(0);
  });

  test("set nx on an absent key stores the value and returns OK", async () => {
    const { kv, store } = createFakeKv();
    const adapter = new KvCacheAdapter(kv);
    expect(await adapter.set("fresh", "v", { nx: true })).toBe("OK");
    expect(store.get("fresh")).toBe("v");
  });

  test("incr starts at 1 for an absent key and increments existing numeric values", async () => {
    const { kv, store } = createFakeKv();
    const adapter = new KvCacheAdapter(kv);
    expect(await adapter.incr("counter")).toBe(1);
    expect(store.get("counter")).toBe("1");
    await adapter.set("counter", "41");
    expect(await adapter.incr("counter")).toBe(42);
  });
});

describe("KvCacheAdapter read/delete semantics", () => {
  test("getdel returns the value and deletes it; missing key returns null without deleting", async () => {
    const { kv, store, deletes } = createFakeKv();
    const adapter = new KvCacheAdapter(kv);
    await adapter.set("k", "v");
    expect(await adapter.getdel("k")).toBe("v");
    expect(store.has("k")).toBe(false);
    expect(deletes).toContain("k");
    const before = deletes.length;
    expect(await adapter.getdel("missing")).toBeNull();
    expect(deletes).toHaveLength(before);
  });

  test("del removes every key and returns the count", async () => {
    const { kv, store } = createFakeKv();
    const adapter = new KvCacheAdapter(kv);
    await adapter.set("a", "1");
    await adapter.set("b", "2");
    expect(await adapter.del("a", "b")).toBe(2);
    expect(store.has("a")).toBe(false);
    expect(store.has("b")).toBe(false);
  });

  test("mget returns values aligned with keys, null for missing", async () => {
    const { kv } = createFakeKv();
    const adapter = new KvCacheAdapter(kv);
    await adapter.set("a", "1");
    await adapter.set("b", "2");
    expect(await adapter.mget("a", "b", "missing")).toEqual(["1", "2", null]);
  });
});

describe("KvCacheAdapter list emulation (JSON-array values)", () => {
  test("lpush unshifts values and llen reports the list length", async () => {
    const { kv } = createFakeKv();
    const adapter = new KvCacheAdapter(kv);
    expect(await adapter.lpush("l", "a", "b")).toBe(2);
    expect(await adapter.llen("l")).toBe(2);
  });

  test("rpop pops from the tail; empty or missing lists yield null", async () => {
    const { kv } = createFakeKv();
    const adapter = new KvCacheAdapter(kv);
    await adapter.lpush("l", "a", "b");
    expect(await adapter.rpop("l")).toBe("b");
    expect(await adapter.rpop("l")).toBe("a");
    expect(await adapter.rpop("l")).toBeNull();
    expect(await adapter.rpop("never-written")).toBeNull();
  });

  test("corrupt list payloads degrade to empty lists instead of throwing", async () => {
    const { kv } = createFakeKv();
    const adapter = new KvCacheAdapter(kv);
    await adapter.set("corrupt", "{not json");
    expect(await adapter.llen("corrupt")).toBe(0);
    expect(await adapter.rpop("corrupt")).toBeNull();
  });
});

describe("KvCacheAdapter scan (prefix + client-side glob filter)", () => {
  async function seed(adapter: KvCacheAdapter, keys: string[]): Promise<void> {
    for (const key of keys) await adapter.set(key, "v");
  }

  test("globs are filtered against the full pattern, not just the KV prefix", async () => {
    const { kv } = createFakeKv();
    const adapter = new KvCacheAdapter(kv);
    await seed(adapter, ["a:1", "a:2", "b:1", "other"]);
    const [cursor, keys] = await adapter.scan("0", { match: "a:*", count: 10 });
    expect(cursor).toBe("0");
    expect(keys).toEqual(["a:1", "a:2"]);
  });

  test("an exact match without a wildcard acts as a literal prefix lookup", async () => {
    const { kv } = createFakeKv();
    const adapter = new KvCacheAdapter(kv);
    await seed(adapter, ["a:1", "a:2"]);
    const [, keys] = await adapter.scan("0", { match: "a:1", count: 10 });
    expect(keys).toEqual(["a:1"]);
  });

  test("cursors propagate across paginated list() calls", async () => {
    const { kv } = createFakeKv();
    const adapter = new KvCacheAdapter(kv);
    await seed(adapter, ["x:1", "x:2", "x:3"]);
    const [cursor1, page1] = await adapter.scan("0", { match: "x:*", count: 2 });
    expect(page1).toEqual(["x:1", "x:2"]);
    expect(cursor1).not.toBe("0");
    const [cursor2, page2] = await adapter.scan(cursor1, { match: "x:*", count: 2 });
    expect(page2).toEqual(["x:3"]);
    expect(cursor2).toBe("0");
  });
});
