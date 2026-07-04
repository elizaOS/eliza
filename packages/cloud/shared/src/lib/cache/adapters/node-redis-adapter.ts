/**
 * CacheRedisClient adapter over the node `redis` package, used by Node/Bun
 * services (Railway) that can open a native TCP connection.
 */

import type { createClient } from "redis";
import type { CacheRedisClient } from "./types";

type NativeRedisClient = ReturnType<typeof createClient>;

export class NodeRedisAdapter implements CacheRedisClient {
  readonly backend = "redis-native";

  constructor(private readonly client: NativeRedisClient) {}

  get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  setex(key: string, ttlSeconds: number, value: string): Promise<unknown> {
    return this.client.setEx(key, ttlSeconds, value);
  }

  set(key: string, value: string, options?: { nx?: boolean; px?: number }): Promise<string | null> {
    if (options?.nx || options?.px) {
      return this.client.set(key, value, {
        ...(options.nx ? { NX: true } : {}),
        ...(options.px ? { PX: options.px } : {}),
      });
    }

    return this.client.set(key, value);
  }

  incr(key: string): Promise<number> {
    return this.client.incr(key);
  }

  expire(key: string, ttlSeconds: number): Promise<unknown> {
    return this.client.expire(key, ttlSeconds);
  }

  pexpire(key: string, ttlMs: number): Promise<unknown> {
    return (
      this.client as NativeRedisClient & {
        pExpire: (key: string, ttlMs: number) => Promise<unknown>;
      }
    ).pExpire(key, ttlMs);
  }

  pttl(key: string): Promise<number | null> {
    return (this.client as NativeRedisClient & { pTTL: (key: string) => Promise<number> }).pTTL(
      key,
    );
  }

  getdel(key: string): Promise<string | null> {
    return this.client.getDel(key);
  }

  del(...keys: string[]): Promise<unknown> {
    if (keys.length === 1) {
      return this.client.del(keys[0]);
    }

    return this.client.del(keys);
  }

  async scan(
    cursor: string | number,
    options: { match: string; count: number },
  ): Promise<[string | number, string[]]> {
    // redis v5 typed `scan` expects RedisArgument (string|Buffer) — v4 took a
    // number cursor. Coerce to string so we work cleanly under both.
    const result = await this.client.scan(String(cursor), {
      MATCH: options.match,
      COUNT: options.count,
    });

    return [result.cursor, result.keys];
  }

  mget(...keys: string[]): Promise<Array<string | null>> {
    return this.client.mGet(keys);
  }

  lpush(key: string, ...values: string[]): Promise<number> {
    return this.client.lPush(key, values);
  }

  rpop(key: string): Promise<string | null> {
    return this.client.rPop(key);
  }

  llen(key: string): Promise<number> {
    return this.client.lLen(key);
  }
}
