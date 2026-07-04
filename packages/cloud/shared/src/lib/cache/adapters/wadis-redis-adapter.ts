/**
 * CacheRedisClient adapter over Wadis, the in-process WASM Redis used as the
 * local-dev default (no Docker) in non-Worker environments. WadisClientLike is
 * the structural subset this adapter depends on, avoiding a hard `wadis` import.
 */

import type { CacheRedisClient } from "./types";

export interface WadisClientLike {
  get(key: string): Promise<string | null>;
  setex(key: string, ttlSeconds: number, value: string): Promise<unknown>;
  set(...args: Array<string | number>): Promise<"OK" | null>;
  incr(key: string): Promise<number>;
  expire(key: string, ttlSeconds: number): Promise<unknown>;
  pexpire(key: string, ttlMs: number): Promise<unknown>;
  pttl(key: string): Promise<number>;
  getdel(key: string): Promise<string | null>;
  del(...keys: string[]): Promise<unknown>;
  scan(
    cursor: string | number,
    ...args: Array<string | number>
  ): Promise<[string | number, string[]]>;
  mget(...keys: string[]): Promise<Array<string | null>>;
  lpush(key: string, ...values: string[]): Promise<number>;
  rpop(key: string): Promise<string | null>;
  llen(key: string): Promise<number>;
}

export class WadisRedisAdapter implements CacheRedisClient {
  readonly backend = "wadis";

  constructor(private readonly client: WadisClientLike) {}

  get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  setex(key: string, ttlSeconds: number, value: string): Promise<unknown> {
    return this.client.setex(key, ttlSeconds, value);
  }

  set(key: string, value: string, options?: { nx?: boolean; px?: number }): Promise<string | null> {
    const args: Array<string | number> = [key, value];
    if (options?.nx) args.push("NX");
    if (options?.px) args.push("PX", options.px);
    return this.client.set(...args);
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
    return this.client.getdel(key);
  }

  del(...keys: string[]): Promise<unknown> {
    return this.client.del(...keys);
  }

  scan(
    cursor: string | number,
    options: { match: string; count: number },
  ): Promise<[string | number, string[]]> {
    return this.client.scan(cursor, "MATCH", options.match, "COUNT", options.count);
  }

  mget(...keys: string[]): Promise<Array<string | null>> {
    return this.client.mget(...keys);
  }

  lpush(key: string, ...values: string[]): Promise<number> {
    return this.client.lpush(key, ...values);
  }

  rpop(key: string): Promise<string | null> {
    return this.client.rpop(key);
  }

  llen(key: string): Promise<number> {
    return this.client.llen(key);
  }
}
