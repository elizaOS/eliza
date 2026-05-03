/**
 * Cache contract — domain-layer interface consumed by `Cached*Repository`
 * decorators in the infrastructure layer.
 *
 * Intentionally narrow: only the operations decorators actually need. The full
 * `CacheClient` god-object surface (queues, locks, SWR plumbing, metrics,
 * env prefix logic, circuit-breaker bookkeeping) is infrastructure detail and
 * does NOT belong in the domain.
 *
 * Implementations: `packages/lib/cache/client.ts` (`CacheClient`) satisfies
 * this interface today via structural typing. After Phase D, the per-request
 * `CacheClient` is constructed in `buildContainer` and passed to decorators
 * as a `Cache` — the singleton export goes away.
 */

export interface Cache {
  /** Read by key. Returns null on miss / expired / not present. */
  get<T>(key: string): Promise<T | null>;

  /** Write a JSON-serializable value with TTL in seconds. */
  set<T>(key: string, value: T, ttlSeconds: number): Promise<void>;

  /**
   * Atomically write only if the key does not already exist (SET NX PX).
   * Returns true if the value was written, false if the key already had a value.
   * Used for single-use nonces (SIWE) and distributed lock acquisition.
   */
  setIfNotExists<T>(key: string, value: T, ttlMs: number): Promise<boolean>;

  /**
   * Atomically read and delete a key (GETDEL). Returns the value if present,
   * null otherwise. Used to consume single-use values like SIWE nonces.
   */
  getAndDelete<T>(key: string): Promise<T | null>;

  /** Delete a single key. */
  del(key: string): Promise<void>;

  /** Delete keys by pattern (SCAN-based, non-blocking). */
  delPattern(pattern: string): Promise<void>;

  /**
   * Cache wrapper for loaders that may legitimately return null. Caches
   * negative results under a sentinel for `negativeTtl` seconds (default 60).
   *
   * Decorators use this for read-by-key reads where the key might not exist.
   */
  wrapNullable<T>(
    loader: () => Promise<T | null>,
    opts: {
      key: string;
      ttl: number;
      negativeTtl?: number;
      singleflight?: boolean;
    },
  ): Promise<T | null>;

  /**
   * Cache-aside with a non-null loader. Returns cached value if present,
   * else invokes loader, caches result, and returns it.
   */
  getOrSet<T>(
    key: string,
    ttlSeconds: number,
    loader: () => Promise<T>,
    options?: { singleflight?: boolean },
  ): Promise<T>;
}
