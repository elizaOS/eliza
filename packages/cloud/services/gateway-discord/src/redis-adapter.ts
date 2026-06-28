/**
 * Adapts an `ioredis`-shaped client to the subset of the `@upstash/redis`
 * surface the Discord gateway uses (`get`/`set`/`setex`/`del`/`expire`/
 * `sadd`/`srem`/`smembers`), so the same call sites work against either:
 *   - a real TCP Redis (Railway) via `ioredis` — `createNativeRedis(url)`, or
 *   - the in-memory `ioredis-mock` for tests/CI — `createMockRedis()`.
 *
 * Upstash's REST client exposes the same Upstash-style option objects (e.g.
 * `set(key, value, { ex, nx })`); this adapter normalizes those to the
 * positional RESP arguments `ioredis` expects, and returns the same values
 * (`"OK"`/`null` for `set NX`) the gateway's leader-election code compares on.
 */

import { createRequire } from "node:module";
import IORedis from "ioredis";

let _requireCJS: NodeJS.Require | null = null;
function getRequireCJS(): NodeJS.Require {
  if (_requireCJS) return _requireCJS;
  const url = import.meta.url;
  if (!url) {
    throw new Error(
      "redis-adapter: import.meta.url is undefined; cannot resolve ioredis-mock via createRequire",
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

function createIoRedisMock(): IoRedisLike {
  const mod = getRequireCJS()("ioredis-mock") as RedisMockModule<IoRedisLike>;
  const Ctor = resolveRedisMockConstructor(mod);
  return new Ctor();
}

interface SetOptions {
  ex?: number;
  px?: number;
  nx?: boolean;
}

/**
 * Upstash-compatible facade over an `ioredis`-shaped client. Not exhaustive —
 * extend only as new call sites appear.
 */
export class UpstashCompatRedis {
  private readonly client: IoRedisLike;

  constructor(client: IoRedisLike) {
    this.client = client;
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

/** In-memory adapter for tests/CI (`MOCK_REDIS=1`). */
export function createMockRedis(): UpstashCompatRedis {
  return new UpstashCompatRedis(createIoRedisMock());
}

/** Real TCP Redis adapter (e.g. Railway `redis://` / `rediss://`). */
export function createNativeRedis(url: string): UpstashCompatRedis {
  // lazyConnect: defer the socket until the first command (the gateway issues
  // one immediately) so construction never throws on a transient outage.
  return new UpstashCompatRedis(
    new IORedis(url, { lazyConnect: true }) as unknown as IoRedisLike,
  );
}
