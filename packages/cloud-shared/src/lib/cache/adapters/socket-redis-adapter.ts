import type { SocketRedis } from "../socket-redis";
import type { CacheRedisClient } from "./types";

export class SocketRedisAdapter implements CacheRedisClient {
  readonly backend = "redis-socket";

  constructor(private readonly client: SocketRedis) {}

  async get(key: string): Promise<string | null> {
    const v = await this.client.get<string>(key);
    return v === null ? null : typeof v === "string" ? v : JSON.stringify(v);
  }

  setex(key: string, ttlSeconds: number, value: string): Promise<unknown> {
    return this.client.setex(key, ttlSeconds, value);
  }

  set(key: string, value: string, options?: { nx?: boolean; px?: number }): Promise<string | null> {
    return this.client.set(key, value, options);
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

  async getdel(key: string): Promise<string | null> {
    const v = await this.client.getdel<string>(key);
    return v === null ? null : typeof v === "string" ? v : JSON.stringify(v);
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
    return this.client.mget(...keys) as Promise<Array<string | null>>;
  }

  lpush(key: string, ...values: string[]): Promise<number> {
    return this.client.lpush(key, ...values);
  }

  async rpop(key: string): Promise<string | null> {
    const v = await this.client.rpop<string>(key);
    return v === null ? null : typeof v === "string" ? v : JSON.stringify(v);
  }

  llen(key: string): Promise<number> {
    return this.client.llen(key);
  }
}
