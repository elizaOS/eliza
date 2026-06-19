/**
 * Opt-in server performance instrumentation (route latency + DB-query count +
 * cache hit/miss counters), gated entirely behind `ELIZA_PERF_INSTRUMENT=1`.
 *
 * Design contract: when the flag is OFF this module does ZERO work on the hot
 * path. `isPerfInstrumentEnabled()` is read once at module load (env is process
 * scoped), and every record* helper early-returns before touching any state, so
 * the only cost when disabled is a single boolean compare. The dev endpoint
 * `GET /api/dev/route-timings` (loopback) reads back the accumulated snapshot.
 */

const ENABLED = process.env.ELIZA_PERF_INSTRUMENT === "1";

/** Cap on retained latency samples per route — bounds memory under load. */
const MAX_SAMPLES_PER_ROUTE = 1000;

interface RouteSamples {
  count: number;
  /** Ring buffer of recent durations (ms); sized by MAX_SAMPLES_PER_ROUTE. */
  samples: number[];
  /** Next write index into `samples` (ring buffer). */
  cursor: number;
  totalMs: number;
  maxMs: number;
}

interface CacheCounters {
  hits: number;
  misses: number;
}

const routeStats = new Map<string, RouteSamples>();
const cacheStats = new Map<string, CacheCounters>();
let dbQueryCount = 0;

export function isPerfInstrumentEnabled(): boolean {
  return ENABLED;
}

/**
 * Collapse a concrete pathname into a low-cardinality route key so per-request
 * ids (table names, UUIDs, numeric ids) don't explode the stats map.
 */
export function normalizeRouteKey(method: string, pathname: string): string {
  const collapsed = pathname
    .replace(
      /\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=\/|$)/gi,
      "/:id",
    )
    .replace(/\/\d+(?=\/|$)/g, "/:n")
    .replace(/\/tables\/[^/]+\//g, "/tables/:table/");
  return `${method} ${collapsed}`;
}

export function recordRouteTiming(routeKey: string, durationMs: number): void {
  if (!ENABLED) return;
  let stat = routeStats.get(routeKey);
  if (!stat) {
    stat = { count: 0, samples: [], cursor: 0, totalMs: 0, maxMs: 0 };
    routeStats.set(routeKey, stat);
  }
  stat.count += 1;
  stat.totalMs += durationMs;
  if (durationMs > stat.maxMs) stat.maxMs = durationMs;
  if (stat.samples.length < MAX_SAMPLES_PER_ROUTE) {
    stat.samples.push(durationMs);
  } else {
    stat.samples[stat.cursor] = durationMs;
    stat.cursor = (stat.cursor + 1) % MAX_SAMPLES_PER_ROUTE;
  }
}

export function recordDbQuery(n = 1): void {
  if (!ENABLED) return;
  dbQueryCount += n;
}

export function recordCacheHit(cacheName: string): void {
  if (!ENABLED) return;
  bumpCache(cacheName).hits += 1;
}

export function recordCacheMiss(cacheName: string): void {
  if (!ENABLED) return;
  bumpCache(cacheName).misses += 1;
}

function bumpCache(cacheName: string): CacheCounters {
  let counters = cacheStats.get(cacheName);
  if (!counters) {
    counters = { hits: 0, misses: 0 };
    cacheStats.set(cacheName, counters);
  }
  return counters;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}

export interface RouteTimingEntry {
  route: string;
  count: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  avgMs: number;
}

export interface CacheCounterEntry {
  cache: string;
  hits: number;
  misses: number;
  hitRate: number;
}

export interface PerfSnapshot {
  enabled: boolean;
  routes: RouteTimingEntry[];
  dbQueries: number;
  caches: CacheCounterEntry[];
}

export function getPerfSnapshot(): PerfSnapshot {
  const routes: RouteTimingEntry[] = [];
  for (const [route, stat] of routeStats) {
    const sorted = [...stat.samples].sort((a, b) => a - b);
    routes.push({
      route,
      count: stat.count,
      p50Ms: round(percentile(sorted, 0.5)),
      p95Ms: round(percentile(sorted, 0.95)),
      maxMs: round(stat.maxMs),
      avgMs: round(stat.count > 0 ? stat.totalMs / stat.count : 0),
    });
  }
  routes.sort((a, b) => b.count - a.count);

  const caches: CacheCounterEntry[] = [];
  for (const [cache, counters] of cacheStats) {
    const total = counters.hits + counters.misses;
    caches.push({
      cache,
      hits: counters.hits,
      misses: counters.misses,
      hitRate: total > 0 ? round(counters.hits / total) : 0,
    });
  }

  return { enabled: ENABLED, routes, dbQueries: dbQueryCount, caches };
}

export function resetPerfSnapshot(): void {
  routeStats.clear();
  cacheStats.clear();
  dbQueryCount = 0;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
