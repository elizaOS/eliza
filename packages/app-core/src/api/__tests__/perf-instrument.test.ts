/**
 * Behavioural coverage for opt-in route-latency and cache-counter
 * instrumentation in `../perf-instrument.ts`. Drives the real module, reloading
 * it so `ELIZA_PERF_INSTRUMENT` is observed at module load the same way
 * production observes it. There is no reset API; enabled-path tests use unique
 * keys and inspect only those snapshot rows.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type CacheCounterEntry,
  normalizeRouteKey,
  type PerfSnapshot,
  type RouteTimingEntry,
} from "../perf-instrument.ts";

const ORIGINAL_FLAG = process.env.ELIZA_PERF_INSTRUMENT;

afterEach(() => {
  if (ORIGINAL_FLAG === undefined) {
    delete process.env.ELIZA_PERF_INSTRUMENT;
  } else {
    process.env.ELIZA_PERF_INSTRUMENT = ORIGINAL_FLAG;
  }
});

async function loadInstrument(flag: string | undefined) {
  vi.resetModules();
  if (flag === undefined) {
    delete process.env.ELIZA_PERF_INSTRUMENT;
  } else {
    process.env.ELIZA_PERF_INSTRUMENT = flag;
  }
  return import("../perf-instrument.ts");
}

function requireRoute(snapshot: PerfSnapshot, key: string): RouteTimingEntry {
  const entry = snapshot.routes.find((row) => row.route === key);
  if (!entry) {
    throw new Error(`missing route ${key} in snapshot`);
  }
  return entry;
}

function requireCache(snapshot: PerfSnapshot, name: string): CacheCounterEntry {
  const entry = snapshot.caches.find((row) => row.cache === name);
  if (!entry) {
    throw new Error(`missing cache ${name} in snapshot`);
  }
  return entry;
}

describe("normalizeRouteKey", () => {
  it("combines method and collapsed pathname", () => {
    expect(normalizeRouteKey("GET", "/api/users/123")).toBe(
      "GET /api/users/:n",
    );
  });

  it("collapses numeric segments only", () => {
    const key = normalizeRouteKey("POST", "/v1/accounts/abc123/orders/999");
    expect(key).toBe("POST /v1/accounts/abc123/orders/:n");
  });

  it("preserves the method verb", () => {
    expect(normalizeRouteKey("DELETE", "/x/1")).toContain("DELETE");
  });

  it("leaves non-numeric paths unchanged", () => {
    expect(normalizeRouteKey("GET", "/api/health")).toBe("GET /api/health");
  });

  it("collapses a UUID segment to :id", () => {
    expect(
      normalizeRouteKey(
        "GET",
        "/api/users/550e8400-e29b-41d4-a716-446655440000/profile",
      ),
    ).toBe("GET /api/users/:id/profile");
  });

  it("collapses a UUID at the end of the path", () => {
    expect(
      normalizeRouteKey(
        "GET",
        "/api/users/550e8400-e29b-41d4-a716-446655440000",
      ),
    ).toBe("GET /api/users/:id");
  });

  it("collapses uppercase UUIDs", () => {
    expect(
      normalizeRouteKey("GET", "/items/550E8400-E29B-41D4-A716-446655440000"),
    ).toBe("GET /items/:id");
  });

  it("collapses every UUID in a path", () => {
    expect(
      normalizeRouteKey(
        "GET",
        "/a/550e8400-e29b-41d4-a716-446655440000/b/6ba7b810-9dad-11d1-80b4-00c04fd430c8",
      ),
    ).toBe("GET /a/:id/b/:id");
  });

  it("does not treat a non-hex 8-4-4-4-12 token as an id", () => {
    expect(
      normalizeRouteKey("GET", "/items/zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz"),
    ).toBe("GET /items/zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz");
  });

  it("collapses every purely numeric path segment", () => {
    expect(normalizeRouteKey("GET", "/a/1/b/2/c/3")).toBe(
      "GET /a/:n/b/:n/c/:n",
    );
  });

  it("collapses a numeric segment that is the whole path tail", () => {
    expect(normalizeRouteKey("GET", "/items/007")).toBe("GET /items/:n");
  });

  it("does not collapse alphanumerics that merely contain digits", () => {
    expect(normalizeRouteKey("GET", "/api/v2/users")).toBe("GET /api/v2/users");
  });

  it("collapses /tables/<name>/ to /tables/:table/", () => {
    expect(normalizeRouteKey("GET", "/api/tables/user-prefs/rows/1")).toBe(
      "GET /api/tables/:table/rows/:n",
    );
  });

  it("does not collapse a table name that has no trailing slash", () => {
    expect(normalizeRouteKey("GET", "/api/tables/users")).toBe(
      "GET /api/tables/users",
    );
  });

  it("leaves the root path unchanged aside from the method prefix", () => {
    expect(normalizeRouteKey("GET", "/")).toBe("GET /");
  });

  it("prefixes an empty pathname with the method and a space", () => {
    expect(normalizeRouteKey("GET", "")).toBe("GET ");
  });
});

describe("when ELIZA_PERF_INSTRUMENT is not exactly 1", () => {
  it("reports disabled for an unset flag and leaves the snapshot empty", async () => {
    const mod = await loadInstrument(undefined);
    expect(mod.isPerfInstrumentEnabled()).toBe(false);

    mod.recordRouteTiming("GET /disabled-unset", 12);
    mod.recordCacheHit("disabled-unset-cache");
    mod.recordCacheMiss("disabled-unset-cache");

    const snapshot = mod.getPerfSnapshot();
    expect(snapshot.enabled).toBe(false);
    expect(snapshot.routes).toEqual([]);
    expect(snapshot.caches).toEqual([]);
  });

  it("treats a non-1 flag value as disabled", async () => {
    const mod = await loadInstrument("true");
    expect(mod.isPerfInstrumentEnabled()).toBe(false);
    mod.recordRouteTiming("GET /disabled-true", 4);
    expect(mod.getPerfSnapshot().routes).toEqual([]);
  });

  it("treats 0 as disabled", async () => {
    const mod = await loadInstrument("0");
    expect(mod.isPerfInstrumentEnabled()).toBe(false);
    mod.recordCacheHit("disabled-zero-cache");
    expect(mod.getPerfSnapshot().caches).toEqual([]);
  });
});

describe("when ELIZA_PERF_INSTRUMENT=1", () => {
  it("reports enabled on a fresh snapshot with empty collections", async () => {
    const mod = await loadInstrument("1");
    expect(mod.isPerfInstrumentEnabled()).toBe(true);
    const snapshot = mod.getPerfSnapshot();
    expect(snapshot.enabled).toBe(true);
    expect(snapshot.routes).toEqual([]);
    expect(snapshot.caches).toEqual([]);
  });

  it("records a single timing and derives p50/p95/max/avg from that sample", async () => {
    const mod = await loadInstrument("1");
    const key = "GET /single";
    mod.recordRouteTiming(key, 42);

    const entry = requireRoute(mod.getPerfSnapshot(), key);
    expect(entry).toEqual({
      route: key,
      count: 1,
      p50Ms: 42,
      p95Ms: 42,
      maxMs: 42,
      avgMs: 42,
    });
  });

  it("uses the floor-index percentile of the sorted samples, not an interpolated quantile", async () => {
    const mod = await loadInstrument("1");
    const key = "GET /percentiles";
    for (const duration of [10, 20, 30, 40]) {
      mod.recordRouteTiming(key, duration);
    }

    // n=4, p50 idx = floor(4*0.5)=2 → 30; p95 idx = floor(4*0.95)=3 → 40
    const entry = requireRoute(mod.getPerfSnapshot(), key);
    expect(entry.count).toBe(4);
    expect(entry.p50Ms).toBe(30);
    expect(entry.p95Ms).toBe(40);
    expect(entry.maxMs).toBe(40);
    expect(entry.avgMs).toBe(25);
  });

  it("sorts samples before reading percentiles so insertion order does not matter", async () => {
    const mod = await loadInstrument("1");
    const key = "GET /unsorted";
    for (const duration of [50, 10, 30]) {
      mod.recordRouteTiming(key, duration);
    }

    // sorted [10, 30, 50]; n=3, p50 idx = floor(1.5)=1 → 30; p95 idx = floor(2.85)=2 → 50
    const entry = requireRoute(mod.getPerfSnapshot(), key);
    expect(entry.p50Ms).toBe(30);
    expect(entry.p95Ms).toBe(50);
    expect(entry.maxMs).toBe(50);
  });

  it("does not raise maxMs on an equal duration (strict greater-than)", async () => {
    const mod = await loadInstrument("1");
    const key = "GET /max-tie";
    mod.recordRouteTiming(key, 7);
    mod.recordRouteTiming(key, 7);
    expect(requireRoute(mod.getPerfSnapshot(), key).maxMs).toBe(7);
  });

  it("accumulates count and average across repeats of the same route key", async () => {
    const mod = await loadInstrument("1");
    const key = "POST /avg";
    mod.recordRouteTiming(key, 10);
    mod.recordRouteTiming(key, 20);
    const entry = requireRoute(mod.getPerfSnapshot(), key);
    expect(entry.count).toBe(2);
    expect(entry.avgMs).toBe(15);
    expect(entry.maxMs).toBe(20);
  });

  it("rounds avgMs to three decimal places", async () => {
    const mod = await loadInstrument("1");
    const key = "GET /round-avg";
    mod.recordRouteTiming(key, 1);
    mod.recordRouteTiming(key, 1);
    mod.recordRouteTiming(key, 2);
    // 4/3 = 1.333... → 1.333
    expect(requireRoute(mod.getPerfSnapshot(), key).avgMs).toBe(1.333);
  });

  it("orders snapshot routes by count descending and keeps insertion order on ties", async () => {
    const mod = await loadInstrument("1");
    mod.recordRouteTiming("GET /tie-a", 1);
    mod.recordRouteTiming("GET /tie-a", 1);
    mod.recordRouteTiming("GET /low", 1);
    mod.recordRouteTiming("GET /tie-c", 1);
    mod.recordRouteTiming("GET /tie-c", 1);

    expect(mod.getPerfSnapshot().routes.map((row) => row.route)).toEqual([
      "GET /tie-a",
      "GET /tie-c",
      "GET /low",
    ]);
  });

  it("keeps count/total/max unbounded while percentiles read the 1000-sample ring", async () => {
    const mod = await loadInstrument("1");
    const key = "GET /overflow";
    for (let i = 0; i < 1000; i += 1) {
      mod.recordRouteTiming(key, 1);
    }
    const filled = requireRoute(mod.getPerfSnapshot(), key);
    expect(filled.count).toBe(1000);
    expect(filled.p50Ms).toBe(1);
    expect(filled.avgMs).toBe(1);
    expect(filled.maxMs).toBe(1);

    for (let i = 0; i < 1000; i += 1) {
      mod.recordRouteTiming(key, 9);
    }
    const wrapped = requireRoute(mod.getPerfSnapshot(), key);
    expect(wrapped.count).toBe(2000);
    expect(wrapped.maxMs).toBe(9);
    expect(wrapped.avgMs).toBe(5);
    expect(wrapped.p50Ms).toBe(9);
    expect(wrapped.p95Ms).toBe(9);
  });

  it("creates independent stats per route key", async () => {
    const mod = await loadInstrument("1");
    mod.recordRouteTiming("GET /one", 5);
    mod.recordRouteTiming("POST /two", 8);
    const snapshot = mod.getPerfSnapshot();
    expect(requireRoute(snapshot, "GET /one").count).toBe(1);
    expect(requireRoute(snapshot, "POST /two").maxMs).toBe(8);
    expect(snapshot.routes).toHaveLength(2);
  });

  it("records cache hits and misses and computes hitRate from their sum", async () => {
    const mod = await loadInstrument("1");
    mod.recordCacheHit("alpha");
    mod.recordCacheHit("alpha");
    mod.recordCacheMiss("alpha");

    const entry = requireCache(mod.getPerfSnapshot(), "alpha");
    expect(entry).toEqual({
      cache: "alpha",
      hits: 2,
      misses: 1,
      hitRate: 0.667,
    });
  });

  it("reports hitRate 1 for hits with no misses and 0 for misses with no hits", async () => {
    const mod = await loadInstrument("1");
    mod.recordCacheHit("only-hits");
    mod.recordCacheMiss("only-misses");
    const snapshot = mod.getPerfSnapshot();
    expect(requireCache(snapshot, "only-hits").hitRate).toBe(1);
    expect(requireCache(snapshot, "only-misses")).toEqual({
      cache: "only-misses",
      hits: 0,
      misses: 1,
      hitRate: 0,
    });
  });

  it("keeps separate counters per cache name", async () => {
    const mod = await loadInstrument("1");
    mod.recordCacheHit("cache-a");
    mod.recordCacheMiss("cache-b");
    const snapshot = mod.getPerfSnapshot();
    expect(snapshot.caches).toHaveLength(2);
    expect(requireCache(snapshot, "cache-a").hits).toBe(1);
    expect(requireCache(snapshot, "cache-b").misses).toBe(1);
  });

  it("does not create a cache row for a name that was never recorded", async () => {
    const mod = await loadInstrument("1");
    mod.recordCacheHit("present");
    expect(
      mod.getPerfSnapshot().caches.find((row) => row.cache === "absent"),
    ).toBeUndefined();
  });
});

describe("getPerfSnapshot enabled flag", () => {
  it("matches isPerfInstrumentEnabled on the statically loaded module", async () => {
    const { getPerfSnapshot, isPerfInstrumentEnabled } = await import(
      "../perf-instrument.ts"
    );
    const snapshot = getPerfSnapshot();
    expect(snapshot.enabled).toBe(isPerfInstrumentEnabled());
    expect(Array.isArray(snapshot.routes)).toBe(true);
    expect(Array.isArray(snapshot.caches)).toBe(true);
  });
});
