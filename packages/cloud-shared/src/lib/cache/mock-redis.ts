/**
 * In-memory mock of the {@link SocketRedis} client surface, backed by
 * `ioredis-mock`. Selected only when `MOCK_REDIS=1` is set in the
 * environment — never used as a silent fallback.
 *
 * The exposed methods match the subset of `SocketRedis` that callers in this
 * repo use (rate limiters, credit events, agent gateway relay, A2A task
 * store, generic cache). Values are JSON-encoded on the way in and decoded
 * on the way out so the round-trip behaviour matches `SocketRedis`.
 */

import { createRequire } from "node:module";

// Lazy: `import.meta.url` is undefined in some bundle contexts (e.g. the
// Cloudflare Workers dev bundle reload path), so building createRequire at
// module load throws. Defer until first use, which only happens when
// MOCK_REDIS=1 and ioredis-mock is actually needed.
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
  getdel(key: string): Promise<string | null>;
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  pexpire(key: string, ms: number): Promise<number>;
  pttl(key: string): Promise<number>;
  del(...keys: string[]): Promise<number>;
  mget(...keys: string[]): Promise<Array<string | null>>;
  scan(cursor: string | number, ...args: Array<string | number>): Promise<[string, string[]]>;
  lpush(key: string, ...values: string[]): Promise<number>;
  rpush(key: string, ...values: string[]): Promise<number>;
  lpop(key: string, count?: number): Promise<string | string[] | null>;
  rpop(key: string): Promise<string | null>;
  llen(key: string): Promise<number>;
  sadd(key: string, ...members: string[]): Promise<number>;
  srem(key: string, ...members: string[]): Promise<number>;
  smembers(key: string): Promise<string[]>;
  zadd(key: string, score: number, member: string): Promise<number>;
  zcard(key: string): Promise<number>;
  zrange(key: string, start: number, stop: number): Promise<string[]>;
  zrem(key: string, ...members: string[]): Promise<number>;
  zremrangebyscore(key: string, min: number | string, max: number | string): Promise<number>;
  ping(): Promise<string>;
  quit(): Promise<string>;
}

type IoRedisMockCtor = new () => IoRedisLike;

function createIoRedisMock(): IoRedisLike {
  const mod = getRequireCJS()("ioredis-mock") as IoRedisMockCtor | { default: IoRedisMockCtor };
  const Ctor: IoRedisMockCtor = "default" in mod ? mod.default : mod;
  return new Ctor();
}

function serializeArg(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function decodeMaybeJson<T>(s: string): T {
  try {
    return JSON.parse(s) as T;
  } catch {
    return s as T;
  }
}

export interface MockSetOptions {
  nx?: boolean;
  ex?: number;
  px?: number;
}

interface ZAddMember {
  score: number;
  member: string;
}

export class MockSocketRedis {
  private readonly client: IoRedisLike;

  constructor(client?: IoRedisLike) {
    this.client = client ?? createIoRedisMock();
  }

  async get<T = string>(key: string): Promise<T | null> {
    const v = await this.client.get(key);
    return v === null ? null : decodeMaybeJson<T>(v);
  }

  async set(key: string, value: unknown, options?: MockSetOptions): Promise<string | null> {
    const serialized = serializeArg(value);
    const args: Array<string | number> = [key, serialized];
    if (options?.ex !== undefined) args.push("EX", options.ex);
    if (options?.px !== undefined) args.push("PX", options.px);
    if (options?.nx) args.push("NX");
    return this.client.set(...args);
  }

  async setex(key: string, ttlSeconds: number, value: unknown): Promise<string> {
    return this.client.setex(key, ttlSeconds, serializeArg(value));
  }

  async getdel<T = string>(key: string): Promise<T | null> {
    const v = await this.client.getdel(key);
    return v === null ? null : decodeMaybeJson<T>(v);
  }

  async incr(key: string): Promise<number> {
    return this.client.incr(key);
  }

  async expire(key: string, seconds: number): Promise<number> {
    return this.client.expire(key, seconds);
  }

  async pexpire(key: string, ms: number): Promise<number> {
    return this.client.pexpire(key, ms);
  }

  async pttl(key: string): Promise<number | null> {
    const v = await this.client.pttl(key);
    return v;
  }

  async del(...keys: string[]): Promise<number> {
    if (keys.length === 0) return 0;
    return this.client.del(...keys);
  }

  async mget<T = string>(...keys: string[]): Promise<Array<T | null>> {
    if (keys.length === 0) return [];
    const values = await this.client.mget(...keys);
    return values.map((v) => (v === null ? null : decodeMaybeJson<T>(v)));
  }

  async scan(
    cursor: string | number,
    options: { match: string; count: number },
  ): Promise<[string | number, string[]]> {
    const [next, keys] = await this.client.scan(
      cursor,
      "MATCH",
      options.match,
      "COUNT",
      options.count,
    );
    return [next, keys];
  }

  async lpush(key: string, ...values: string[]): Promise<number> {
    return this.client.lpush(key, ...values.map((v) => serializeArg(v)));
  }

  async rpush(key: string, ...values: string[]): Promise<number> {
    return this.client.rpush(key, ...values.map((v) => serializeArg(v)));
  }

  async lpop<T = string>(key: string): Promise<T | null>;
  async lpop<T = string>(key: string, count: number): Promise<T[] | null>;
  async lpop<T = string>(key: string, count?: number): Promise<T | T[] | null> {
    const result =
      count !== undefined ? await this.client.lpop(key, count) : await this.client.lpop(key);
    if (result === null) return null;
    if (Array.isArray(result)) {
      return result.map((item) => decodeMaybeJson<T>(item)) as T[];
    }
    return decodeMaybeJson<T>(result);
  }

  async rpop<T = string>(key: string): Promise<T | null> {
    const v = await this.client.rpop(key);
    return v === null ? null : decodeMaybeJson<T>(v);
  }

  async llen(key: string): Promise<number> {
    return this.client.llen(key);
  }

  async sadd(key: string, ...members: string[]): Promise<number> {
    return this.client.sadd(key, ...members);
  }

  async srem(key: string, ...members: string[]): Promise<number> {
    return this.client.srem(key, ...members);
  }

  async smembers(key: string): Promise<string[]> {
    return this.client.smembers(key);
  }

  async zadd(key: string, member: ZAddMember): Promise<number> {
    return this.client.zadd(key, member.score, member.member);
  }

  async zcard(key: string): Promise<number> {
    return this.client.zcard(key);
  }

  async zrange(key: string, start: number, stop: number): Promise<string[]> {
    return this.client.zrange(key, start, stop);
  }

  async zrem(key: string, ...members: string[]): Promise<number> {
    return this.client.zrem(key, ...members);
  }

  async zremrangebyscore(key: string, min: number | string, max: number | string): Promise<number> {
    return this.client.zremrangebyscore(key, min, max);
  }

  async ping(): Promise<string> {
    return this.client.ping();
  }

  async quit(): Promise<void> {
    try {
      await this.client.quit();
    } catch {
      // ignore
    }
  }

  pipeline(): MockPipeline {
    return new MockPipeline(this.client);
  }
}

type PipelineOp = () => Promise<unknown>;

export class MockPipeline {
  private readonly ops: PipelineOp[] = [];

  constructor(private readonly client: IoRedisLike) {}

  zremrangebyscore(key: string, min: number | string, max: number | string): this {
    this.ops.push(() => this.client.zremrangebyscore(key, min, max));
    return this;
  }

  zcard(key: string): this {
    this.ops.push(() => this.client.zcard(key));
    return this;
  }

  zadd(key: string, member: ZAddMember): this {
    this.ops.push(() => this.client.zadd(key, member.score, member.member));
    return this;
  }

  zrem(key: string, ...members: string[]): this {
    this.ops.push(() => this.client.zrem(key, ...members));
    return this;
  }

  expire(key: string, seconds: number): this {
    this.ops.push(() => this.client.expire(key, seconds));
    return this;
  }

  pexpire(key: string, ms: number): this {
    this.ops.push(() => this.client.pexpire(key, ms));
    return this;
  }

  set(key: string, value: unknown, options?: MockSetOptions): this {
    const serialized = serializeArg(value);
    const args: Array<string | number> = [key, serialized];
    if (options?.ex !== undefined) args.push("EX", options.ex);
    if (options?.px !== undefined) args.push("PX", options.px);
    if (options?.nx) args.push("NX");
    this.ops.push(() => this.client.set(...args));
    return this;
  }

  setex(key: string, ttlSeconds: number, value: unknown): this {
    this.ops.push(() => this.client.setex(key, ttlSeconds, serializeArg(value)));
    return this;
  }

  get(key: string): this {
    this.ops.push(() => this.client.get(key));
    return this;
  }

  del(...keys: string[]): this {
    if (keys.length > 0) this.ops.push(() => this.client.del(...keys));
    return this;
  }

  incr(key: string): this {
    this.ops.push(() => this.client.incr(key));
    return this;
  }

  async exec<T extends unknown[] = unknown[]>(): Promise<T> {
    if (this.ops.length === 0) return [] as unknown as T;
    const out: unknown[] = [];
    for (const op of this.ops) {
      out.push(await op());
    }
    return out as T;
  }
}
