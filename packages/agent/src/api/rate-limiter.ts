/**
 * Simple in-memory sliding-window rate limiter for API endpoints.
 *
 * Each key (typically `agentId:operationName`) tracks request timestamps
 * within a configurable window. When the count hits the limit, new requests
 * are rejected with a `retryAfterMs` hint.
 *
 * This is intentionally per-process / in-memory. It resets on restart, which
 * is fine for a local-first app — the goal is to prevent runaway scripts and
 * accidental tight loops, not to enforce billing quotas.
 */

export interface RateLimitConfig {
  /** Maximum number of requests allowed within the window. */
  maxRequests: number;
  /** Sliding window size in milliseconds. */
  windowMs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfterMs: number;
}

interface RateLimitEntry {
  timestamps: number[];
}

const buckets = new Map<string, RateLimitEntry>();

/** Interval between full-map cleanup sweeps (ms). */
const CLEANUP_INTERVAL_MS = 5 * 60 * 1_000;
let lastCleanup = Date.now();

function cleanup(windowMs: number): void {
  const now = Date.now();
  if (now - lastCleanup < CLEANUP_INTERVAL_MS) return;
  lastCleanup = now;
  const cutoff = now - windowMs;
  for (const [key, entry] of buckets) {
    entry.timestamps = entry.timestamps.filter((t) => t > cutoff);
    if (entry.timestamps.length === 0) buckets.delete(key);
  }
}

/**
 * Check whether a request identified by `key` is within the rate limit
 * defined by `config`. If allowed, the request is recorded in the window.
 */
export function checkRateLimit(
  key: string,
  config: RateLimitConfig,
): RateLimitResult {
  const now = Date.now();
  cleanup(config.windowMs);

  let entry = buckets.get(key);
  if (!entry) {
    entry = { timestamps: [] };
    buckets.set(key, entry);
  }

  // Evict timestamps outside the sliding window.
  const cutoff = now - config.windowMs;
  entry.timestamps = entry.timestamps.filter((t) => t > cutoff);

  if (entry.timestamps.length >= config.maxRequests) {
    const oldestInWindow = entry.timestamps[0];
    if (oldestInWindow === undefined) {
      return { allowed: true, retryAfterMs: 0 };
    }
    const retryAfterMs = oldestInWindow + config.windowMs - now;
    return { allowed: false, retryAfterMs: Math.max(retryAfterMs, 0) };
  }

  entry.timestamps.push(now);
  return { allowed: true, retryAfterMs: 0 };
}

/** Clear all rate limit state. Useful in tests. */
export function resetRateLimits(): void {
  buckets.clear();
}
