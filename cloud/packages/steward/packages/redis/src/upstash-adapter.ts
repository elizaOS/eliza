/**
 * Upstash REST → ioredis-shaped adapter.
 *
 * Lets the existing rate-limiter, spend-tracker, policy-cache, and auth-store
 * code keep using the ioredis call shapes they already know, while routing
 * through Upstash's HTTP/REST API at runtime. This is what makes the Steward
 * API work on Cloudflare Workers (no TCP, no long-lived connection).
 *
 * The adapter is intentionally narrow — only the operations Steward actually
 * uses are mapped. Adding a new operation is a one-line forward.
 *
 * Differences vs ioredis worth knowing:
 *   - `set(key, value, "PX", ttlMs)` → `set(key, value, { px: ttlMs })`
 *   - `setex(key, ttl, value)`       → `setex(key, ttl, value)`  (same)
 *   - `zrange(key, 0, 0, "WITHSCORES")` → returns [member, score, ...]
 *     (Upstash returns [{member, score}], we flatten)
 *   - `multi()/.exec()` returns the raw result array; we wrap it in the
 *     `[err, val]` tuple shape that ioredis (and our existing code) expects.
 *   - `scan(cursor, "MATCH", pattern, "COUNT", n)` → `scan(cursor, {match, count})`
 */

import type { Redis as UpstashRedis } from "@upstash/redis";

/**
 * Subset of the ioredis surface that Steward consumes. Both the real
 * ioredis client and the upstash adapter satisfy this shape.
 */
export interface IoredisLike {
  // Strings
  set(key: string, value: string): Promise<string | null>;
  set(key: string, value: string, mode: "PX", ttlMs: number): Promise<string | null>;
  get(key: string): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
  setex(key: string, ttlSeconds: number, value: string): Promise<string>;
  expire(key: string, ttlSeconds: number): Promise<number>;
  pexpire(key: string, ttlMs: number): Promise<number>;

  // Hashes
  hincrby(key: string, field: string, increment: number): Promise<number>;
  hset(key: string, field: string, value: string): Promise<number>;
  hget(key: string, field: string): Promise<string | null>;
  hgetall(key: string): Promise<Record<string, string>>;

  // Sorted sets
  zadd(key: string, score: number, member: string): Promise<number | null>;
  zcard(key: string): Promise<number>;
  zrem(key: string, ...members: string[]): Promise<number>;
  zrange(key: string, start: number, stop: number, withscores?: "WITHSCORES"): Promise<string[]>;
  zremrangebyscore(key: string, min: number, max: number): Promise<number>;

  // Scan
  scan(
    cursor: string | number,
    match: "MATCH",
    pattern: string,
    count: "COUNT",
    countValue: number,
  ): Promise<[string, string[]]>;

  // Pipeline / transaction
  multi(): IoredisPipelineLike;

  // Connection lifecycle
  ping(): Promise<string>;
  quit?(): Promise<unknown>;
}

export interface IoredisPipelineLike {
  zremrangebyscore(key: string, min: number, max: number): IoredisPipelineLike;
  zadd(key: string, score: number, member: string): IoredisPipelineLike;
  zcard(key: string): IoredisPipelineLike;
  zrange(key: string, start: number, stop: number, withscores?: "WITHSCORES"): IoredisPipelineLike;
  pexpire(key: string, ttlMs: number): IoredisPipelineLike;
  hincrby(key: string, field: string, increment: number): IoredisPipelineLike;
  hset(key: string, field: string, value: string): IoredisPipelineLike;
  expire(key: string, ttlSeconds: number): IoredisPipelineLike;
  /**
   * Returns ioredis-style [err, value] tuples for each queued command, in
   * order. Errors are swallowed into the per-command tuple so callers see
   * `null` in the err slot on success and an Error instance on failure.
   */
  exec(): Promise<Array<[Error | null, unknown]> | null>;
}

// ─── Pipeline impl ────────────────────────────────────────────────────────────

type Op = (multi: ReturnType<UpstashRedis["multi"]>) => unknown;

class UpstashPipeline implements IoredisPipelineLike {
  private readonly ops: Op[] = [];

  constructor(private readonly upstash: UpstashRedis) {}

  zremrangebyscore(key: string, min: number, max: number): IoredisPipelineLike {
    this.ops.push((m) => m.zremrangebyscore(key, min, max));
    return this;
  }

  zadd(key: string, score: number, member: string): IoredisPipelineLike {
    this.ops.push((m) => m.zadd(key, { score, member }));
    return this;
  }

  zcard(key: string): IoredisPipelineLike {
    this.ops.push((m) => m.zcard(key));
    return this;
  }

  zrange(key: string, start: number, stop: number, withscores?: "WITHSCORES"): IoredisPipelineLike {
    this.ops.push((m) => m.zrange(key, start, stop, { withScores: withscores === "WITHSCORES" }));
    return this;
  }

  pexpire(key: string, ttlMs: number): IoredisPipelineLike {
    this.ops.push((m) => m.pexpire(key, ttlMs));
    return this;
  }

  hincrby(key: string, field: string, increment: number): IoredisPipelineLike {
    this.ops.push((m) => m.hincrby(key, field, increment));
    return this;
  }

  hset(key: string, field: string, value: string): IoredisPipelineLike {
    this.ops.push((m) => m.hset(key, { [field]: value }));
    return this;
  }

  expire(key: string, ttlSeconds: number): IoredisPipelineLike {
    this.ops.push((m) => m.expire(key, ttlSeconds));
    return this;
  }

  async exec(): Promise<Array<[Error | null, unknown]> | null> {
    const multi = this.upstash.multi();
    for (const op of this.ops) op(multi);

    let raw: unknown[];
    try {
      raw = (await multi.exec()) as unknown[];
    } catch (err) {
      // Upstash throws a single error if the whole transaction fails.
      // Mirror ioredis: every slot gets the same error.
      const error = err instanceof Error ? err : new Error(String(err));
      return this.ops.map(() => [error, null]);
    }

    return this.ops.map((_, i) => [null, raw[i]]);
  }
}

// ─── Adapter ──────────────────────────────────────────────────────────────────

/**
 * Wrap an `@upstash/redis` client in an ioredis-shaped facade.
 */
export function createUpstashIoredisAdapter(upstash: UpstashRedis): IoredisLike {
  return {
    // Strings
    async set(key: string, value: string, mode?: "PX", ttlMs?: number): Promise<string | null> {
      if (mode === "PX" && typeof ttlMs === "number") {
        return upstash.set(key, value, { px: ttlMs });
      }
      return upstash.set(key, value);
    },

    get(key: string): Promise<string | null> {
      // Upstash auto-parses JSON responses; force string return for our callers.
      return upstash.get<string>(key) as Promise<string | null>;
    },

    async del(...keys: string[]): Promise<number> {
      if (keys.length === 0) return 0;
      return upstash.del(...keys);
    },

    setex(key: string, ttlSeconds: number, value: string): Promise<string> {
      return upstash.setex(key, ttlSeconds, value) as Promise<string>;
    },

    expire(key: string, ttlSeconds: number): Promise<number> {
      return upstash.expire(key, ttlSeconds) as Promise<number>;
    },

    pexpire(key: string, ttlMs: number): Promise<number> {
      return upstash.pexpire(key, ttlMs) as Promise<number>;
    },

    // Hashes
    hincrby(key: string, field: string, increment: number): Promise<number> {
      return upstash.hincrby(key, field, increment);
    },

    async hset(key: string, field: string, value: string): Promise<number> {
      return upstash.hset(key, { [field]: value });
    },

    async hget(key: string, field: string): Promise<string | null> {
      const v = await upstash.hget<string>(key, field);
      return (v as string | null) ?? null;
    },

    async hgetall(key: string): Promise<Record<string, string>> {
      const all = await upstash.hgetall<Record<string, string>>(key);
      return all ?? {};
    },

    // Sorted sets
    zadd(key: string, score: number, member: string): Promise<number | null> {
      return upstash.zadd(key, { score, member });
    },

    zcard(key: string): Promise<number> {
      return upstash.zcard(key);
    },

    zrem(key: string, ...members: string[]): Promise<number> {
      if (members.length === 0) return Promise.resolve(0);
      return upstash.zrem(key, ...members);
    },

    async zrange(
      key: string,
      start: number,
      stop: number,
      withscores?: "WITHSCORES",
    ): Promise<string[]> {
      const result = (await upstash.zrange(key, start, stop, {
        withScores: withscores === "WITHSCORES",
      })) as Array<string | number>;

      if (withscores !== "WITHSCORES") {
        return result.map((r) => String(r));
      }
      // Upstash with withScores returns [member, score, member, score, ...].
      // ioredis returns the same flat shape, so we just stringify.
      return result.map((r) => String(r));
    },

    zremrangebyscore(key: string, min: number, max: number): Promise<number> {
      return upstash.zremrangebyscore(key, min, max);
    },

    // Scan
    async scan(
      cursor: string | number,
      _match: "MATCH",
      pattern: string,
      _count: "COUNT",
      countValue: number,
    ): Promise<[string, string[]]> {
      const [next, keys] = await upstash.scan(cursor, { match: pattern, count: countValue });
      return [String(next), keys];
    },

    // Pipeline / transaction
    multi(): IoredisPipelineLike {
      return new UpstashPipeline(upstash);
    },

    // Connection lifecycle
    async ping(): Promise<string> {
      const result = await upstash.ping();
      return result ?? "PONG";
    },

    // Upstash has no persistent connection to close; quit() is a no-op.
    async quit(): Promise<unknown> {
      return "OK";
    },
  };
}
