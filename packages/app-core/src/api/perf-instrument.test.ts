/** Exercises route normalization and opt-in metrics through real record/snapshot calls with isolated module state. */
import { afterEach, expect, it, vi } from "vitest";
import { normalizeRouteKey } from "./perf-instrument";

afterEach(() => vi.unstubAllEnvs());

async function loadInstrument(flag: string | undefined) {
  vi.resetModules();
  vi.stubEnv("ELIZA_PERF_INSTRUMENT", flag);
  return import("./perf-instrument");
}

it.each([
  ["/api/users/123", "/api/users/:n"],
  ["/v1/accounts/abc123/orders/999", "/v1/accounts/abc123/orders/:n"],
  ["/api/health", "/api/health"],
  [
    "/api/users/550e8400-e29b-41d4-a716-446655440000/profile",
    "/api/users/:id/profile",
  ],
  ["/items/550E8400-E29B-41D4-A716-446655440000", "/items/:id"],
  [
    "/a/550e8400-e29b-41d4-a716-446655440000/b/6ba7b810-9dad-11d1-80b4-00c04fd430c8",
    "/a/:id/b/:id",
  ],
  [
    "/items/zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz",
    "/items/zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz",
  ],
  ["/a/1/b/2/c/3", "/a/:n/b/:n/c/:n"],
  ["/items/007", "/items/:n"],
  ["/api/tables/user-prefs/rows/1", "/api/tables/:table/rows/:n"],
  ["/api/tables/users", "/api/tables/users"],
  ["/", "/"],
  ["", ""],
])("normalizes %s without changing the method", (path, normalized) => {
  expect(normalizeRouteKey("DELETE", path)).toBe(`DELETE ${normalized}`);
});

it.each([undefined, "true", "0"])(
  "records nothing when the opt-in flag is %s",
  async (flag) => {
    const mod = await loadInstrument(flag);
    expect(mod.isPerfInstrumentEnabled()).toBe(false);
    mod.recordRouteTiming("GET /disabled", 12);
    mod.recordCacheHit("disabled");
    mod.recordCacheMiss("disabled");
    expect(mod.getPerfSnapshot()).toEqual({
      enabled: false,
      routes: [],
      caches: [],
    });
  },
);

it.each([
  [[42], 42, 42, 42, 42],
  [[10, 20, 30, 40], 30, 40, 40, 25],
  [[50, 10, 30], 30, 50, 50, 30],
  [[7, 7], 7, 7, 7, 7],
  [[10, 20], 20, 20, 20, 15],
  [[1, 1, 2], 1, 2, 2, 1.333],
] as const)(
  "aggregates latency samples %j",
  async (samples, p50Ms, p95Ms, maxMs, avgMs) => {
    const mod = await loadInstrument("1");
    expect(mod.isPerfInstrumentEnabled()).toBe(true);
    for (const sample of samples) mod.recordRouteTiming("GET /route", sample);
    expect(mod.getPerfSnapshot()).toEqual({
      enabled: true,
      routes: [
        {
          route: "GET /route",
          count: samples.length,
          p50Ms,
          p95Ms,
          maxMs,
          avgMs,
        },
      ],
      caches: [],
    });
  },
);

it("keeps independent route and cache counters and stable descending route counts", async () => {
  const mod = await loadInstrument("1");
  expect(mod.getPerfSnapshot()).toEqual({
    enabled: true,
    routes: [],
    caches: [],
  });
  for (const [route, duration] of [
    ["a", 2],
    ["a", 4],
    ["low", 1],
    ["c", 5],
    ["c", 7],
  ] as const) {
    mod.recordRouteTiming(route, duration);
  }
  mod.recordCacheHit("mixed");
  mod.recordCacheHit("mixed");
  mod.recordCacheMiss("mixed");
  mod.recordCacheHit("hits");
  mod.recordCacheMiss("misses");
  expect(mod.getPerfSnapshot()).toEqual({
    enabled: true,
    routes: [
      { route: "a", count: 2, p50Ms: 4, p95Ms: 4, maxMs: 4, avgMs: 3 },
      { route: "c", count: 2, p50Ms: 7, p95Ms: 7, maxMs: 7, avgMs: 6 },
      { route: "low", count: 1, p50Ms: 1, p95Ms: 1, maxMs: 1, avgMs: 1 },
    ],
    caches: [
      { cache: "mixed", hits: 2, misses: 1, hitRate: 0.667 },
      { cache: "hits", hits: 1, misses: 0, hitRate: 1 },
      { cache: "misses", hits: 0, misses: 1, hitRate: 0 },
    ],
  });
});

it("retains lifetime aggregates when old samples leave the percentile window", async () => {
  const mod = await loadInstrument("1");
  for (let i = 0; i < 1000; i++) mod.recordRouteTiming("route", 9);
  expect(mod.getPerfSnapshot().routes).toEqual([
    { route: "route", count: 1000, p50Ms: 9, p95Ms: 9, maxMs: 9, avgMs: 9 },
  ]);
  for (let i = 0; i < 1000; i++) mod.recordRouteTiming("route", 1);
  expect(mod.getPerfSnapshot().routes).toEqual([
    { route: "route", count: 2000, p50Ms: 1, p95Ms: 1, maxMs: 9, avgMs: 5 },
  ]);
});
