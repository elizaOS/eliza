import type { CacheRedisClient } from "./types";

/**
 * Minimal structural type for a Cloudflare KV namespace binding — only the
 * methods this adapter uses. Avoids pulling `@cloudflare/workers-types` into
 * `cloud-shared` (which is also consumed by the browser frontend).
 */
export interface KvNamespaceLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  list(options?: { prefix?: string; limit?: number; cursor?: string }): Promise<{
    keys: Array<{ name: string }>;
    list_complete: boolean;
    cursor?: string;
  }>;
}

// Cloudflare KV rejects expirationTtl < 60s.
const KV_MIN_TTL_SECONDS = 60;

function clampTtlSeconds(ttlSeconds: number): number {
  return Math.max(Math.ceil(ttlSeconds), KV_MIN_TTL_SECONDS);
}

/**
 * Cloudflare KV-backed cache adapter for the Cloudflare Worker.
 *
 * KV is the only Worker-reachable cache backend: the Worker cannot reliably
 * open raw TCP (`cloudflare:sockets`) to an external Redis (e.g. Railway's
 * public proxy), so it falls back to KV's HTTP-native API.
 *
 * KV is a key/value store with TTLs, **eventually consistent**, and has **no
 * atomic operations, lists, or TTL introspection**. This adapter therefore
 * serves the read-through caches (auth, api-key, model catalog, …) faithfully
 * and provides best-effort, non-atomic emulation for the rest:
 *   - `set …{nx}` / `incr` are NOT atomic (racy under concurrency); callers that
 *     need atomicity gate on `CacheClient.supportsAtomicOperations()`, which
 *     returns false for this backend, so distributed locks use dummy locks.
 *   - list ops (`lpush`/`rpop`/`llen`) are emulated via a JSON array value.
 *   - `pttl` cannot be derived from KV and returns -1 (present, ttl unknown).
 *
 * KV's 60s minimum TTL is clamped transparently.
 */
export class KvCacheAdapter implements CacheRedisClient {
  readonly backend = "cloudflare-kv";

  constructor(private readonly kv: KvNamespaceLike) {}

  async get(key: string): Promise<string | null> {
    return this.kv.get(key);
  }

  async setex(key: string, ttlSeconds: number, value: string): Promise<unknown> {
    await this.kv.put(key, value, { expirationTtl: clampTtlSeconds(ttlSeconds) });
    return "OK";
  }

  async set(
    key: string,
    value: string,
    options?: { nx?: boolean; px?: number },
  ): Promise<string | null> {
    // Non-atomic NX: a best-effort existence check. Real atomicity is gated by
    // supportsAtomicOperations() (false here), so the lock path never relies on
    // this; setIfNotExists callers accept the weaker guarantee.
    if (options?.nx) {
      const existing = await this.kv.get(key);
      if (existing !== null) return null;
    }
    const putOptions =
      options?.px !== undefined ? { expirationTtl: clampTtlSeconds(options.px / 1000) } : undefined;
    await this.kv.put(key, value, putOptions);
    return "OK";
  }

  async incr(key: string): Promise<number> {
    // Non-atomic; acceptable for approximate counters (rate limiting). Loses
    // increments under concurrency / eventual consistency.
    const next = Number.parseInt((await this.kv.get(key)) ?? "0", 10) + 1;
    await this.kv.put(key, String(next));
    return next;
  }

  async expire(key: string, ttlSeconds: number): Promise<unknown> {
    return this.reput(key, clampTtlSeconds(ttlSeconds));
  }

  async pexpire(key: string, ttlMs: number): Promise<unknown> {
    return this.reput(key, clampTtlSeconds(ttlMs / 1000));
  }

  /** Re-write the value to apply a new TTL (KV can't mutate TTL in place). */
  private async reput(key: string, ttlSeconds: number): Promise<number> {
    const value = await this.kv.get(key);
    if (value === null) return 0;
    await this.kv.put(key, value, { expirationTtl: ttlSeconds });
    return 1;
  }

  async pttl(): Promise<number | null> {
    // KV exposes no remaining-TTL. -1 = "exists, ttl unknown" in Redis terms.
    return -1;
  }

  async getdel(key: string): Promise<string | null> {
    const value = await this.kv.get(key);
    if (value !== null) await this.kv.delete(key);
    return value;
  }

  async del(...keys: string[]): Promise<unknown> {
    await Promise.all(keys.map((key) => this.kv.delete(key)));
    return keys.length;
  }

  async scan(
    cursor: string | number,
    options: { match: string; count: number },
  ): Promise<[string | number, string[]]> {
    // KV list is prefix-based, not glob. Use the literal prefix up to the first
    // wildcard, then filter the page against the full glob for correctness.
    const wildcardAt = options.match.indexOf("*");
    const prefix = wildcardAt === -1 ? options.match : options.match.slice(0, wildcardAt);
    const startCursor = cursor === "0" || cursor === 0 ? undefined : String(cursor);
    const page = await this.kv.list({
      prefix,
      limit: options.count,
      cursor: startCursor,
    });
    const regex = this.globToRegExp(options.match);
    const keys = page.keys.map((k) => k.name).filter((name) => regex.test(name));
    const nextCursor = page.list_complete ? "0" : (page.cursor ?? "0");
    return [nextCursor, keys];
  }

  async mget(...keys: string[]): Promise<Array<string | null>> {
    return Promise.all(keys.map((key) => this.kv.get(key)));
  }

  // List emulation via a JSON-array value. Non-atomic; for low-contention use.
  async lpush(key: string, ...values: string[]): Promise<number> {
    const list = await this.readList(key);
    list.unshift(...values);
    await this.kv.put(key, JSON.stringify(list));
    return list.length;
  }

  async rpop(key: string): Promise<string | null> {
    const list = await this.readList(key);
    const value = list.pop() ?? null;
    if (value !== null) await this.kv.put(key, JSON.stringify(list));
    return value;
  }

  async llen(key: string): Promise<number> {
    return (await this.readList(key)).length;
  }

  private async readList(key: string): Promise<string[]> {
    const raw = await this.kv.get(key);
    if (raw === null) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as string[]) : [];
    } catch {
      return [];
    }
  }

  private globToRegExp(pattern: string): RegExp {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp(`^${escaped}$`);
  }
}
