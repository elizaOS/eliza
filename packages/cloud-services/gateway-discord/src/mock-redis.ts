/**
 * Tiny in-memory mock that mirrors the subset of the `@upstash/redis` client
 * surface used by the Discord gateway. Selected only when `MOCK_REDIS=1` is
 * set in the environment — never used as a silent fallback.
 *
 * Backed by `ioredis-mock`; methods are normalized so callers can keep using
 * Upstash-style option objects (e.g. `set(key, value, { ex, nx })`).
 */

import { createRequire } from "node:module";

let _requireCJS: NodeJS.Require | null = null;
function getRequireCJS(): NodeJS.Require {
  if (_requireCJS) return _requireCJS;
  const url = import.meta.url;
  if (!url) {
    throw new Error(
      "mock-redis: import.meta.url is undefined; cannot resolve ioredis-mock via createRequire",
    );
  }
  _requireCJS = createRequire(url);
  return _requireCJS;
}

interface IoRedisLike {
  get(key: string): Promise<string | null>;
  set(...args: Array<string | number>): Promise<string | null>;
  setex(key: string, seconds: number, value: string): Promise<string>;
  del(...keys: string[]): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  sadd(key: string, ...members: string[]): Promise<number>;
  srem(key: string, ...members: string[]): Promise<number>;
  smembers(key: string): Promise<string[]>;
  lpush(key: string, ...values: string[]): Promise<number>;
  ltrim(key: string, start: number, stop: number): Promise<string>;
  quit(): Promise<string>;
}

function createIoRedisMock(): IoRedisLike {
  // biome-ignore lint/suspicious/noExplicitAny: ESM/CJS interop with ioredis-mock
  const mod = getRequireCJS()("ioredis-mock") as any;
  const Ctor = mod?.default ?? mod;
  return new Ctor() as IoRedisLike;
}

interface SetOptions {
  ex?: number;
  px?: number;
  nx?: boolean;
}

/**
 * Drop-in mock for the subset of `@upstash/redis` methods the Discord
 * gateway uses. Not exhaustive — extend only as new call sites appear.
 */
export class MockUpstashRedis {
  private readonly client: IoRedisLike;

  constructor(client?: IoRedisLike) {
    this.client = client ?? createIoRedisMock();
  }

  async get<T = string>(key: string): Promise<T | null> {
    const v = await this.client.get(key);
    if (v === null) return null;
    try {
      return JSON.parse(v) as T;
    } catch {
      return v as T;
    }
  }

  async set(
    key: string,
    value: unknown,
    options?: SetOptions,
  ): Promise<string | null> {
    const serialized =
      typeof value === "string" ? value : JSON.stringify(value);
    const args: Array<string | number> = [key, serialized];
    if (options?.ex !== undefined) args.push("EX", options.ex);
    if (options?.px !== undefined) args.push("PX", options.px);
    if (options?.nx) args.push("NX");
    return this.client.set(...args);
  }

  async setex(key: string, ttlSeconds: number, value: string): Promise<string> {
    return this.client.setex(key, ttlSeconds, value);
  }

  async del(...keys: string[]): Promise<number> {
    if (keys.length === 0) return 0;
    return this.client.del(...keys);
  }

  async expire(key: string, seconds: number): Promise<number> {
    return this.client.expire(key, seconds);
  }

  async sadd(key: string, ...members: string[]): Promise<number> {
    if (members.length === 0) return 0;
    return this.client.sadd(key, ...members);
  }

  async srem(key: string, ...members: string[]): Promise<number> {
    if (members.length === 0) return 0;
    return this.client.srem(key, ...members);
  }

  async smembers(key: string): Promise<string[]> {
    return this.client.smembers(key);
  }

  async lpush(key: string, ...values: string[]): Promise<number> {
    if (values.length === 0) return 0;
    return this.client.lpush(key, ...values);
  }

  async ltrim(key: string, start: number, stop: number): Promise<string> {
    return this.client.ltrim(key, start, stop);
  }

  async quit(): Promise<void> {
    try {
      await this.client.quit();
    } catch {
      // ignore
    }
  }
}
