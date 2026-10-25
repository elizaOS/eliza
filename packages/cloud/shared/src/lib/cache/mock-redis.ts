/**
 * In-memory mock of the {@link SocketRedis} client surface. Selected only when
 * `MOCK_REDIS=1` is set in the environment — never used as a silent fallback.
 *
 * The exposed methods match the subset of `SocketRedis` that callers in this
 * repo use (rate limiters, credit events, agent gateway relay, A2A task store,
 * generic cache). Values are JSON-encoded on the way in and decoded on the way
 * out so the round-trip behaviour matches `SocketRedis`.
 *
 * The backing store is a plain module-global `Map`, not `ioredis-mock`. Two
 * runtimes have to share one implementation: the Bun unit/integration tests AND
 * the cloud-api Worker bundle (wrangler `--local`) the cloud-e2e stack boots.
 * `ioredis-mock` resolves to its browser build under wrangler/esbuild and throws
 * `ReferenceError: window is not defined` inside workerd, so any nonce-storage
 * route (e.g. SIWE nonce/verify) 500s. A dependency-free store runs identically
 * everywhere. It is process-global on purpose: `buildRedisClient()` is called
 * per request, so SIWE's nonce (written by one request, consumed by the next)
 * must persist across instances within a process — matching `ioredis-mock`'s
 * shared-store default.
 */

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

type StringEntry = { kind: "string"; value: string; expireAt: number | null };
type ListEntry = { kind: "list"; value: string[]; expireAt: number | null };
type SetEntry = { kind: "set"; value: Set<string>; expireAt: number | null };
type ZSetEntry = { kind: "zset"; value: Map<string, number>; expireAt: number | null };
type Entry = StringEntry | ListEntry | SetEntry | ZSetEntry;

/**
 * Process-global store shared by every {@link InMemoryRedis} instance — see the
 * file header for why this must outlive a single `buildRedisClient()` call.
 */
const GLOBAL_STORE = new Map<string, Entry>();

function nowMs(): number {
  return Date.now();
}

function globToRegExp(pattern: string): RegExp {
  let out = "";
  for (const ch of pattern) {
    if (ch === "*") out += ".*";
    else if (ch === "?") out += ".";
    else out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

function parseScoreBound(bound: number | string, fallback: number): number {
  if (typeof bound === "number") return bound;
  const s = bound.trim();
  if (s === "-inf") return Number.NEGATIVE_INFINITY;
  if (s === "+inf" || s === "inf") return Number.POSITIVE_INFINITY;
  // Exclusive "(" prefix is treated as inclusive here; callers in this repo use
  // inclusive numeric / ±inf ranges only, so the distinction never bites.
  const n = Number.parseFloat(s.startsWith("(") ? s.slice(1) : s);
  return Number.isNaN(n) ? fallback : n;
}

/**
 * Dependency-free in-memory Redis matching the {@link IoRedisLike} surface used
 * in this repo. Lazy TTL expiry: a key past its `expireAt` is treated as absent
 * and dropped on next access.
 */
class InMemoryRedis implements IoRedisLike {
  private read(key: string): Entry | undefined {
    const entry = GLOBAL_STORE.get(key);
    if (!entry) return undefined;
    if (entry.expireAt !== null && entry.expireAt <= nowMs()) {
      GLOBAL_STORE.delete(key);
      return undefined;
    }
    return entry;
  }

  async get(key: string): Promise<string | null> {
    const entry = this.read(key);
    return entry?.kind === "string" ? entry.value : null;
  }

  async set(...args: Array<string | number>): Promise<string | null> {
    const key = String(args[0]);
    const value = String(args[1]);
    let expireAt: number | null = null;
    let nx = false;
    for (let i = 2; i < args.length; i++) {
      const token = String(args[i]).toUpperCase();
      if (token === "EX") expireAt = nowMs() + Number(args[++i]) * 1000;
      else if (token === "PX") expireAt = nowMs() + Number(args[++i]);
      else if (token === "NX") nx = true;
    }
    if (nx && this.read(key)) return null;
    GLOBAL_STORE.set(key, { kind: "string", value, expireAt });
    return "OK";
  }

  async setex(key: string, seconds: number, value: string): Promise<string> {
    GLOBAL_STORE.set(key, { kind: "string", value, expireAt: nowMs() + seconds * 1000 });
    return "OK";
  }

  async getdel(key: string): Promise<string | null> {
    const entry = this.read(key);
    if (entry?.kind !== "string") return null;
    GLOBAL_STORE.delete(key);
    return entry.value;
  }

  async incr(key: string): Promise<number> {
    const entry = this.read(key);
    const current = entry?.kind === "string" ? Number.parseInt(entry.value, 10) || 0 : 0;
    const next = current + 1;
    GLOBAL_STORE.set(key, {
      kind: "string",
      value: String(next),
      // INCR preserves an existing TTL.
      expireAt: entry?.kind === "string" ? entry.expireAt : null,
    });
    return next;
  }

  async expire(key: string, seconds: number): Promise<number> {
    const entry = this.read(key);
    if (!entry) return 0;
    entry.expireAt = nowMs() + seconds * 1000;
    return 1;
  }

  async pexpire(key: string, ms: number): Promise<number> {
    const entry = this.read(key);
    if (!entry) return 0;
    entry.expireAt = nowMs() + ms;
    return 1;
  }

  async pttl(key: string): Promise<number> {
    const entry = this.read(key);
    if (!entry) return -2;
    if (entry.expireAt === null) return -1;
    return Math.max(0, entry.expireAt - nowMs());
  }

  async del(...keys: string[]): Promise<number> {
    let count = 0;
    for (const key of keys) {
      if (this.read(key)) {
        GLOBAL_STORE.delete(key);
        count++;
      }
    }
    return count;
  }

  async mget(...keys: string[]): Promise<Array<string | null>> {
    return keys.map((key) => {
      const entry = this.read(key);
      return entry?.kind === "string" ? entry.value : null;
    });
  }

  async scan(
    _cursor: string | number,
    ...args: Array<string | number>
  ): Promise<[string, string[]]> {
    let match = "*";
    for (let i = 0; i < args.length; i++) {
      if (String(args[i]).toUpperCase() === "MATCH") match = String(args[i + 1]);
    }
    const re = globToRegExp(match);
    const keys: string[] = [];
    for (const key of GLOBAL_STORE.keys()) {
      if (this.read(key) && re.test(key)) keys.push(key);
    }
    // Single-page scan: cursor "0" signals completion, so the caller's
    // until-"0" loop terminates after one pass with every matching key.
    return ["0", keys];
  }

  private list(key: string): string[] {
    const entry = this.read(key);
    if (entry?.kind === "list") return entry.value;
    const fresh: ListEntry = { kind: "list", value: [], expireAt: null };
    GLOBAL_STORE.set(key, fresh);
    return fresh.value;
  }

  async lpush(key: string, ...values: string[]): Promise<number> {
    const list = this.list(key);
    for (const v of values) list.unshift(v);
    return list.length;
  }

  async rpush(key: string, ...values: string[]): Promise<number> {
    const list = this.list(key);
    for (const v of values) list.push(v);
    return list.length;
  }

  async lpop(key: string, count?: number): Promise<string | string[] | null> {
    const entry = this.read(key);
    if (entry?.kind !== "list" || entry.value.length === 0) return null;
    if (count === undefined) return entry.value.shift() ?? null;
    return entry.value.splice(0, count);
  }

  async rpop(key: string): Promise<string | null> {
    const entry = this.read(key);
    if (entry?.kind !== "list" || entry.value.length === 0) return null;
    return entry.value.pop() ?? null;
  }

  async llen(key: string): Promise<number> {
    const entry = this.read(key);
    return entry?.kind === "list" ? entry.value.length : 0;
  }

  private set_(key: string): Set<string> {
    const entry = this.read(key);
    if (entry?.kind === "set") return entry.value;
    const fresh: SetEntry = { kind: "set", value: new Set(), expireAt: null };
    GLOBAL_STORE.set(key, fresh);
    return fresh.value;
  }

  async sadd(key: string, ...members: string[]): Promise<number> {
    const set = this.set_(key);
    let added = 0;
    for (const m of members) {
      if (!set.has(m)) {
        set.add(m);
        added++;
      }
    }
    return added;
  }

  async srem(key: string, ...members: string[]): Promise<number> {
    const entry = this.read(key);
    if (entry?.kind !== "set") return 0;
    let removed = 0;
    for (const m of members) {
      if (entry.value.delete(m)) removed++;
    }
    return removed;
  }

  async smembers(key: string): Promise<string[]> {
    const entry = this.read(key);
    return entry?.kind === "set" ? [...entry.value] : [];
  }

  private zset(key: string): Map<string, number> {
    const entry = this.read(key);
    if (entry?.kind === "zset") return entry.value;
    const fresh: ZSetEntry = { kind: "zset", value: new Map(), expireAt: null };
    GLOBAL_STORE.set(key, fresh);
    return fresh.value;
  }

  async zadd(key: string, score: number, member: string): Promise<number> {
    const zset = this.zset(key);
    const isNew = !zset.has(member);
    zset.set(member, score);
    return isNew ? 1 : 0;
  }

  async zcard(key: string): Promise<number> {
    const entry = this.read(key);
    return entry?.kind === "zset" ? entry.value.size : 0;
  }

  async zrange(key: string, start: number, stop: number): Promise<string[]> {
    const entry = this.read(key);
    if (entry?.kind !== "zset") return [];
    const sorted = [...entry.value.entries()]
      .sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([member]) => member);
    const len = sorted.length;
    const from = start < 0 ? Math.max(len + start, 0) : start;
    const to = stop < 0 ? len + stop : stop;
    return sorted.slice(from, to + 1);
  }

  async zrem(key: string, ...members: string[]): Promise<number> {
    const entry = this.read(key);
    if (entry?.kind !== "zset") return 0;
    let removed = 0;
    for (const m of members) {
      if (entry.value.delete(m)) removed++;
    }
    return removed;
  }

  async zremrangebyscore(key: string, min: number | string, max: number | string): Promise<number> {
    const entry = this.read(key);
    if (entry?.kind !== "zset") return 0;
    const lo = parseScoreBound(min, Number.NEGATIVE_INFINITY);
    const hi = parseScoreBound(max, Number.POSITIVE_INFINITY);
    let removed = 0;
    for (const [member, score] of entry.value) {
      if (score >= lo && score <= hi) {
        entry.value.delete(member);
        removed++;
      }
    }
    return removed;
  }

  async ping(): Promise<string> {
    return "PONG";
  }

  async quit(): Promise<string> {
    return "OK";
  }
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
    this.client = client ?? new InMemoryRedis();
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

  pttl(key: string): this {
    this.ops.push(() => this.client.pttl(key));
    return this;
  }

  async exec<T extends unknown[] = unknown[]>(): Promise<T> {
    const out: unknown[] = [];
    if (this.ops.length === 0) return out as T;
    for (const op of this.ops) {
      out.push(await op());
    }
    return out as T;
  }
}
