/**
 * Unit tests for performance instrumentation and route timing metrics.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("perf-instrument", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
    vi.resetModules();
  });

  it("normalizes route pathnames collapsing UUIDs, numbers, and table names", async () => {
    const { normalizeRouteKey } = await import("./perf-instrument.js");

    expect(
      normalizeRouteKey(
        "GET",
        "/api/agents/12345678-1234-1234-1234-123456789abc/rooms",
      ),
    ).toBe("GET /api/agents/:id/rooms");

    expect(normalizeRouteKey("POST", "/api/messages/42/reactions")).toBe(
      "POST /api/messages/:n/reactions",
    );

    expect(normalizeRouteKey("GET", "/api/tables/memories/items")).toBe(
      "GET /api/tables/:table/items",
    );
  });

  it("performs zero-work when ELIZA_PERF_INSTRUMENT is disabled", async () => {
    delete process.env.ELIZA_PERF_INSTRUMENT;

    const {
      getPerfSnapshot,
      isPerfInstrumentEnabled,
      recordCacheHit,
      recordCacheMiss,
      recordRouteTiming,
    } = await import("./perf-instrument.js");

    expect(isPerfInstrumentEnabled()).toBe(false);

    recordRouteTiming("GET /test", 15);
    recordCacheHit("models");
    recordCacheMiss("models");

    const snapshot = getPerfSnapshot();
    expect(snapshot.enabled).toBe(false);
    expect(snapshot.routes).toHaveLength(0);
    expect(snapshot.caches).toHaveLength(0);
  });

  it("records route latencies and cache hits/misses when enabled", async () => {
    process.env.ELIZA_PERF_INSTRUMENT = "1";

    const {
      getPerfSnapshot,
      isPerfInstrumentEnabled,
      recordCacheHit,
      recordCacheMiss,
      recordRouteTiming,
    } = await import("./perf-instrument.js");

    expect(isPerfInstrumentEnabled()).toBe(true);

    recordRouteTiming("GET /api/status", 10);
    recordRouteTiming("GET /api/status", 20);
    recordRouteTiming("GET /api/status", 30);

    recordCacheHit("embeddings");
    recordCacheHit("embeddings");
    recordCacheMiss("embeddings");

    const snapshot = getPerfSnapshot();
    expect(snapshot.enabled).toBe(true);

    const route = snapshot.routes.find((r) => r.route === "GET /api/status");
    expect(route).toBeDefined();
    expect(route?.count).toBe(3);
    expect(route?.p50Ms).toBe(20);
    expect(route?.maxMs).toBe(30);
    expect(route?.avgMs).toBe(20);

    const cache = snapshot.caches.find((c) => c.cache === "embeddings");
    expect(cache).toBeDefined();
    expect(cache?.hits).toBe(2);
    expect(cache?.misses).toBe(1);
    expect(cache?.hitRate).toBe(0.667);
  });
});
