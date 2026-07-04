/**
 * CacheRedisClient adapter over the Upstash REST Redis client, for environments
 * that reach Redis over HTTP rather than a raw socket.
 */

import type { Redis as UpstashRedis } from "@upstash/redis";
import type { CacheRedisClient } from "./types";

export class UpstashRedisAdapter implements CacheRedisClient {
  readonly backend = "redis-rest";

  constructor(private readonly client: UpstashRedis) {}

  get(key: string): Promise<string | null> {
    return this.client.get<string>(key);
  }

  setex(key: string, ttlSeconds: number, value: string): Promise<unknown> {
    return this.client.setex(key, ttlSeconds, value);
  }

  set(key: string, value: string, options?: { nx?: boolean; px?: number }): Promise<string | null> {
    return this.client.set(key, value, options as never) as Promise<string | null>;
  }

  incr(key: string): Promise<number> {
    return this.client.incr(key);
  }

  expire(key: string, ttlSeconds: number): Promise<unknown> {
    return this.client.expire(key, ttlSeconds);
  }

  pexpire(key: string, ttlMs: number): Promise<unknown> {
    return this.client.pexpire(key, ttlMs);
  }

  pttl(key: string): Promise<number | null> {
    return this.client.pttl(key);
  }

  getdel(key: string): Promise<string | null> {
    return this.client.getdel<string>(key);
  }

  del(...keys: string[]): Promise<unknown> {
    return this.client.del(...keys);
  }

  scan(
    cursor: string | number,
    options: { match: string; count: number },
  ): Promise<[string | number, string[]]> {
    return this.client.scan(cursor, options);
  }

  mget(...keys: string[]): Promise<Array<string | null>> {
    return this.client.mget<string[]>(...keys) as Promise<Array<string | null>>;
  }

  lpush(key: string, ...values: string[]): Promise<number> {
    return this.client.lpush(key, ...values);
  }

  rpop(key: string): Promise<string | null> {
    return this.client.rpop<string>(key) as Promise<string | null>;
  }

  llen(key: string): Promise<number> {
    return this.client.llen(key);
  }
}
