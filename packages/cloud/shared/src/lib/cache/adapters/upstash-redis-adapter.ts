/**
 * CacheRedisClient adapter over the Upstash REST Redis client, for environments
 * that reach Redis over HTTP rather than a raw socket.
 *
 * The Upstash client JSON-parses replies by default, so a list entry holding a
 * JSON envelope comes back as an object. List reads re-stringify it, as
 * SocketRedisAdapter does, so queue callers always get the stored text.
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

  async rpop(key: string): Promise<string | null> {
    const v = await this.client.rpop<unknown>(key);
    return v === null ? null : typeof v === "string" ? v : JSON.stringify(v);
  }

  llen(key: string): Promise<number> {
    return this.client.llen(key);
  }

  async rpoplpush(source: string, destination: string): Promise<string | null> {
    const v = await this.client.lmove<unknown>(source, destination, "right", "left");
    return v === null ? null : typeof v === "string" ? v : JSON.stringify(v);
  }

  lrem(key: string, count: number, value: string): Promise<number> {
    return this.client.lrem(key, count, value);
  }

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    const values = await this.client.lrange<unknown>(key, start, stop);
    return values.map((v) => (typeof v === "string" ? v : JSON.stringify(v)));
  }
}
