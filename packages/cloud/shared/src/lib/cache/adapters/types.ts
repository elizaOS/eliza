/**
 * Shared Redis-shaped client interface that all cache adapters implement.
 *
 * Internal to the cache layer — adapters live in this `adapters/` directory and
 * are wired into `CacheClient` in `../client.ts`. Not part of the public API.
 */
export interface CacheRedisClient {
  readonly backend: string;
  get(key: string): Promise<string | null>;
  setex(key: string, ttlSeconds: number, value: string): Promise<unknown>;
  set(key: string, value: string, options?: { nx?: boolean; px?: number }): Promise<string | null>;
  incr(key: string): Promise<number>;
  expire(key: string, ttlSeconds: number): Promise<unknown>;
  pexpire(key: string, ttlMs: number): Promise<unknown>;
  pttl(key: string): Promise<number | null>;
  getdel(key: string): Promise<string | null>;
  del(...keys: string[]): Promise<unknown>;
  scan(
    cursor: string | number,
    options: { match: string; count: number },
  ): Promise<[string | number, string[]]>;
  mget(...keys: string[]): Promise<Array<string | null>>;
  lpush(key: string, ...values: string[]): Promise<number>;
  rpop(key: string): Promise<string | null>;
  llen(key: string): Promise<number>;
  /** LMOVE source destination RIGHT LEFT: the tail of `source` becomes the head of `destination`. */
  rpoplpush(source: string, destination: string): Promise<string | null>;
  /** LREM: removes `count` occurrences of `value` (0 = all, negative = from the tail). */
  lrem(key: string, count: number, value: string): Promise<number>;
  /** LRANGE with inclusive `stop`; negative offsets count from the tail. */
  lrange(key: string, start: number, stop: number): Promise<string[]>;
}
