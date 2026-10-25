/** Provides native and in-memory Redis adapters for webhook routing state. */
import { createRequire } from "node:module";
import { Redis as UpstashRedis } from "@upstash/redis";
import IORedis from "ioredis";
import { logger } from "./logger";

const requireCJS = createRequire(import.meta.url);

type RedisMockConstructor<T> = new () => T;
type RedisMockModule<T> =
  | RedisMockConstructor<T>
  | { default?: RedisMockConstructor<T> };

function resolveRedisMockConstructor<T>(
  mod: RedisMockModule<T>,
): RedisMockConstructor<T> {
  if (typeof mod === "function") return mod;
  if (mod.default) return mod.default;
  throw new TypeError("ioredis-mock did not export a Redis constructor");
}

interface SetOptions {
  ex?: number;
  nx?: boolean;
}

// Compare-and-act on one key. GET and the write run as a single server-side
// script, so a key that changed owners between them is never touched.
const DEL_IF_EQUALS =
  'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) end return 0';
const EXPIRE_IF_EQUALS =
  'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("expire", KEYS[1], tonumber(ARGV[2])) end return 0';

export interface GatewayRedis {
  get<T = unknown>(key: string): Promise<T | null>;
  set(key: string, value: string, options?: SetOptions): Promise<unknown>;
  del(key: string): Promise<unknown>;
  lpush(key: string, value: string): Promise<unknown>;
  ltrim(key: string, start: number, stop: number): Promise<unknown>;
  expire(key: string, seconds: number): Promise<unknown>;
  /** Delete `key` only while it still holds `value`, as one atomic step. */
  delIfEquals(key: string, value: string): Promise<boolean>;
  /** Reset `key`'s TTL only while it still holds `value`, as one atomic step. */
  expireIfEquals(key: string, value: string, seconds: number): Promise<boolean>;
  /** Sorted-set index used by durable connector holds. */
  zadd(key: string, score: number, member: string): Promise<unknown>;
  zrangebyscore(
    key: string,
    min: number,
    max: number,
    limit: number,
  ): Promise<string[]>;
  zrem(key: string, member: string): Promise<unknown>;
  eval(script: string, keys: string[], args: string[]): Promise<unknown>;
  quit?(): Promise<unknown>;
}

class NativeRedisAdapter implements GatewayRedis {
  constructor(private readonly client: IORedis) {}

  async get<T = unknown>(key: string): Promise<T | null> {
    const value = await this.client.get(key);
    if (value === null) return null;

    try {
      return JSON.parse(value) as T;
    } catch {
      return value as T;
    }
  }

  async set(
    key: string,
    value: string,
    options: SetOptions = {},
  ): Promise<unknown> {
    if (options.ex && options.nx) {
      return this.client.set(key, value, "EX", options.ex, "NX");
    }
    if (options.ex) {
      return this.client.set(key, value, "EX", options.ex);
    }
    if (options.nx) {
      return this.client.set(key, value, "NX");
    }
    return this.client.set(key, value);
  }

  async del(key: string): Promise<unknown> {
    return this.client.del(key);
  }

  async lpush(key: string, value: string): Promise<unknown> {
    return this.client.lpush(key, value);
  }

  async ltrim(key: string, start: number, stop: number): Promise<unknown> {
    return this.client.ltrim(key, start, stop);
  }

  async expire(key: string, seconds: number): Promise<unknown> {
    return this.client.expire(key, seconds);
  }

  async delIfEquals(key: string, value: string): Promise<boolean> {
    return Number(await this.client.eval(DEL_IF_EQUALS, 1, key, value)) === 1;
  }

  async expireIfEquals(
    key: string,
    value: string,
    seconds: number,
  ): Promise<boolean> {
    return (
      Number(
        await this.client.eval(
          EXPIRE_IF_EQUALS,
          1,
          key,
          value,
          String(seconds),
        ),
      ) === 1
    );
  }

  async zadd(key: string, score: number, member: string): Promise<unknown> {
    return this.client.zadd(key, score, member);
  }

  async zrangebyscore(
    key: string,
    min: number,
    max: number,
    limit: number,
  ): Promise<string[]> {
    return this.client.zrangebyscore(key, min, max, "LIMIT", 0, limit);
  }

  async zrem(key: string, member: string): Promise<unknown> {
    return this.client.zrem(key, member);
  }

  eval(script: string, keys: string[], args: string[]): Promise<unknown> {
    return this.client.eval(script, keys.length, ...keys, ...args);
  }

  async quit(): Promise<unknown> {
    return this.client.quit();
  }
}

class MemoryRedisAdapter implements GatewayRedis {
  private readonly client: IORedis;

  constructor() {
    // ioredis-mock implements the same surface as ioredis with an in-memory
    // backend. We type it as IORedis to reuse the native adapter shape.
    const mod = requireCJS("ioredis-mock") as RedisMockModule<IORedis>;
    const RedisMockCtor = resolveRedisMockConstructor(mod);
    this.client = new RedisMockCtor();
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    const value = await this.client.get(key);
    if (value === null) return null;
    try {
      return JSON.parse(value) as T;
    } catch {
      return value as T;
    }
  }

  async set(
    key: string,
    value: string,
    options: SetOptions = {},
  ): Promise<unknown> {
    if (options.ex && options.nx) {
      return this.client.set(key, value, "EX", options.ex, "NX");
    }
    if (options.ex) {
      return this.client.set(key, value, "EX", options.ex);
    }
    if (options.nx) {
      return this.client.set(key, value, "NX");
    }
    return this.client.set(key, value);
  }

  async del(key: string): Promise<unknown> {
    return this.client.del(key);
  }

  async lpush(key: string, value: string): Promise<unknown> {
    return this.client.lpush(key, value);
  }

  async ltrim(key: string, start: number, stop: number): Promise<unknown> {
    return this.client.ltrim(key, start, stop);
  }

  async expire(key: string, seconds: number): Promise<unknown> {
    return this.client.expire(key, seconds);
  }

  async delIfEquals(key: string, value: string): Promise<boolean> {
    return Number(await this.client.eval(DEL_IF_EQUALS, 1, key, value)) === 1;
  }

  async expireIfEquals(
    key: string,
    value: string,
    seconds: number,
  ): Promise<boolean> {
    return (
      Number(
        await this.client.eval(
          EXPIRE_IF_EQUALS,
          1,
          key,
          value,
          String(seconds),
        ),
      ) === 1
    );
  }

  async zadd(key: string, score: number, member: string): Promise<unknown> {
    return this.client.zadd(key, score, member);
  }

  async zrangebyscore(
    key: string,
    min: number,
    max: number,
    limit: number,
  ): Promise<string[]> {
    return this.client.zrangebyscore(key, min, max, "LIMIT", 0, limit);
  }

  async zrem(key: string, member: string): Promise<unknown> {
    return this.client.zrem(key, member);
  }

  eval(script: string, keys: string[], args: string[]): Promise<unknown> {
    return this.client.eval(script, keys.length, ...keys, ...args);
  }

  async quit(): Promise<unknown> {
    return this.client.quit();
  }
}

/** Upstash REST client with the sorted-set calls mapped onto its API. */
class UpstashRedisAdapter implements GatewayRedis {
  constructor(private readonly client: UpstashRedis) {}

  get<T = unknown>(key: string): Promise<T | null> {
    return this.client.get<T>(key);
  }

  set(key: string, value: string, options: SetOptions = {}): Promise<unknown> {
    if (options.ex && options.nx) {
      return this.client.set(key, value, { ex: options.ex, nx: true });
    }
    if (options.ex) return this.client.set(key, value, { ex: options.ex });
    if (options.nx) return this.client.set(key, value, { nx: true });
    return this.client.set(key, value);
  }

  del(key: string): Promise<unknown> {
    return this.client.del(key);
  }

  lpush(key: string, value: string): Promise<unknown> {
    return this.client.lpush(key, value);
  }

  ltrim(key: string, start: number, stop: number): Promise<unknown> {
    return this.client.ltrim(key, start, stop);
  }

  expire(key: string, seconds: number): Promise<unknown> {
    return this.client.expire(key, seconds);
  }

  async delIfEquals(key: string, value: string): Promise<boolean> {
    return Number(await this.client.eval(DEL_IF_EQUALS, [key], [value])) === 1;
  }

  async expireIfEquals(
    key: string,
    value: string,
    seconds: number,
  ): Promise<boolean> {
    return (
      Number(
        await this.client.eval(
          EXPIRE_IF_EQUALS,
          [key],
          [value, String(seconds)],
        ),
      ) === 1
    );
  }

  zadd(key: string, score: number, member: string): Promise<unknown> {
    return this.client.zadd(key, { score, member });
  }

  async zrangebyscore(
    key: string,
    min: number,
    max: number,
    limit: number,
  ): Promise<string[]> {
    const members = await this.client.zrange<string[]>(key, min, max, {
      byScore: true,
      offset: 0,
      count: limit,
    });
    return members.map(String);
  }

  zrem(key: string, member: string): Promise<unknown> {
    return this.client.zrem(key, member);
  }

  eval(script: string, keys: string[], args: string[]): Promise<unknown> {
    return this.client.eval(script, keys, args);
  }
}

export function createRedis(): GatewayRedis {
  if (process.env.MOCK_REDIS === "1") {
    logger.info("[GatewayRedis] using in-memory mock adapter");
    return new MemoryRedisAdapter();
  }

  const kvRestApiUrl = process.env.KV_REST_API_URL;
  const kvRestApiToken = process.env.KV_REST_API_TOKEN;

  if (kvRestApiUrl && kvRestApiToken) {
    logger.info("Using Upstash Redis REST client");
    return new UpstashRedisAdapter(
      new UpstashRedis({
        url: kvRestApiUrl,
        token: kvRestApiToken,
      }),
    );
  }

  if (process.env.REDIS_URL) {
    logger.info("Using native Redis client");
    return new NativeRedisAdapter(new IORedis(process.env.REDIS_URL));
  }

  logger.warn(
    "Redis is not configured; set REDIS_URL or KV_REST_API_URL/KV_REST_API_TOKEN",
  );
  throw new Error("Redis configuration is required");
}
