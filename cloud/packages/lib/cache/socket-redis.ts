/**
 * RESP2 Redis client over `cloudflare:sockets` for Cloudflare Workers.
 *
 * Why this exists: Workers cannot use the `redis` or `ioredis` npm packages
 * (both depend on Node's `net` module). Upstash REST is the usual workaround
 * but we now run Redis on Railway (TCP only), so we speak RESP2 directly via
 * the Workers `connect()` API.
 *
 * One socket per CacheClient instance; reused across pipelined ops within
 * the same Worker request lifetime. `cloudflare:sockets` connections close
 * automatically when the request finishes.
 *
 * Also runs in Node (Bun, Railway services) by routing `connect` through
 * a thin `node:net`/`node:tls` shim — same client, two transports.
 */

type SocketLike = {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  closed: Promise<void>;
  close(): Promise<void>;
};

type ConnectFn = (
  address: { hostname: string; port: number },
  options?: { secureTransport?: "on" | "off" | "starttls"; allowHalfOpen?: boolean },
) => SocketLike;

let cachedConnect: ConnectFn | null = null;

async function getConnect(): Promise<ConnectFn> {
  if (cachedConnect) return cachedConnect;

  if (typeof globalThis !== "undefined" && "WebSocketPair" in globalThis) {
    // `cloudflare:sockets` only resolves inside the Workers bundler.
    const mod = (await import(/* @vite-ignore */ "cloudflare:sockets" as string)) as {
      connect: ConnectFn;
    };
    cachedConnect = mod.connect;
    return cachedConnect;
  }

  const { Socket } = await import("node:net");
  const { connect: tlsConnect } = await import("node:tls");
  cachedConnect = ((address, options) => {
    const useTls = options?.secureTransport === "on";
    const sock = useTls
      ? tlsConnect({ host: address.hostname, port: address.port, servername: address.hostname })
      : new Socket().connect(address.port, address.hostname);

    let resolveClosed!: () => void;
    const closed = new Promise<void>((r) => {
      resolveClosed = r;
    });
    sock.on("close", resolveClosed);
    sock.on("error", resolveClosed);

    const readable = new ReadableStream<Uint8Array>({
      start(controller) {
        sock.on("data", (chunk: Buffer) =>
          controller.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)),
        );
        sock.on("end", () => {
          try {
            controller.close();
          } catch {
            // already closed
          }
        });
        sock.on("error", (err: Error) => controller.error(err));
      },
      cancel() {
        sock.destroy();
      },
    });

    const writable = new WritableStream<Uint8Array>({
      write(chunk) {
        return new Promise((resolve, reject) => {
          sock.write(chunk, (err?: Error | null) => (err ? reject(err) : resolve()));
        });
      },
      close() {
        return new Promise((resolve) => sock.end(resolve));
      },
      abort() {
        sock.destroy();
      },
    });

    return {
      readable,
      writable,
      closed,
      async close() {
        sock.destroy();
        await closed;
      },
    };
  }) as ConnectFn;
  return cachedConnect;
}

interface ParsedUrl {
  hostname: string;
  port: number;
  username?: string;
  password?: string;
  tls: boolean;
}

function parseRedisUrl(url: string): ParsedUrl {
  const u = new URL(url);
  if (u.protocol !== "redis:" && u.protocol !== "rediss:") {
    throw new Error(`Unsupported Redis URL scheme: ${u.protocol}`);
  }
  return {
    hostname: u.hostname,
    port: u.port ? Number(u.port) : 6379,
    username: u.username || undefined,
    password: u.password ? decodeURIComponent(u.password) : undefined,
    tls: u.protocol === "rediss:",
  };
}

const CRLF = "\r\n";
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8");

function encodeCommand(args: ReadonlyArray<string | number>): Uint8Array {
  let out = `*${args.length}${CRLF}`;
  for (const arg of args) {
    const s = typeof arg === "number" ? String(arg) : arg;
    const bytes = encoder.encode(s);
    out += `$${bytes.byteLength}${CRLF}`;
    out += s;
    out += CRLF;
  }
  return encoder.encode(out);
}

type RespValue = string | number | null | RespError | RespValue[];

class RespError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RespError";
  }
}

class RespParser {
  private buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);

  push(chunk: Uint8Array<ArrayBufferLike>): void {
    if (this.buffer.length === 0) {
      this.buffer = chunk;
      return;
    }
    const merged = new Uint8Array(this.buffer.length + chunk.length);
    merged.set(this.buffer);
    merged.set(chunk, this.buffer.length);
    this.buffer = merged;
  }

  /** Returns the next parsed value, or undefined if more data needed. */
  next(): RespValue | undefined {
    const result = this.parseAt(0);
    if (result === undefined) return undefined;
    this.buffer = this.buffer.subarray(result.consumed);
    return result.value;
  }

  private indexOfCrlf(start: number): number {
    for (let i = start; i + 1 < this.buffer.length; i++) {
      if (this.buffer[i] === 0x0d && this.buffer[i + 1] === 0x0a) return i;
    }
    return -1;
  }

  private parseAt(offset: number): { value: RespValue; consumed: number } | undefined {
    if (offset >= this.buffer.length) return undefined;
    const type = this.buffer[offset];
    const lineEnd = this.indexOfCrlf(offset + 1);
    if (lineEnd === -1) return undefined;
    const line = decoder.decode(this.buffer.subarray(offset + 1, lineEnd));
    const headerConsumed = lineEnd + 2;

    switch (type) {
      case 0x2b: // '+' simple string
        return { value: line, consumed: headerConsumed };
      case 0x2d: // '-' error
        return { value: new RespError(line), consumed: headerConsumed };
      case 0x3a: // ':' integer
        return { value: Number(line), consumed: headerConsumed };
      case 0x24: {
        // '$' bulk string
        const length = Number(line);
        if (length === -1) return { value: null, consumed: headerConsumed };
        const dataEnd = headerConsumed + length;
        if (dataEnd + 2 > this.buffer.length) return undefined;
        const value = decoder.decode(this.buffer.subarray(headerConsumed, dataEnd));
        return { value, consumed: dataEnd + 2 };
      }
      case 0x2a: {
        // '*' array
        const length = Number(line);
        if (length === -1) return { value: null, consumed: headerConsumed };
        const items: RespValue[] = [];
        let cursor = headerConsumed;
        for (let i = 0; i < length; i++) {
          const child = this.parseAt(cursor);
          if (child === undefined) return undefined;
          items.push(child.value);
          cursor = child.consumed;
        }
        return { value: items, consumed: cursor };
      }
      default:
        throw new RespError(`Unknown RESP type byte: 0x${type.toString(16)}`);
    }
  }
}

class Connection {
  private socket: SocketLike | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private parser = new RespParser();
  private readonly opts: ParsedUrl;
  private inflight: Promise<unknown> = Promise.resolve();

  constructor(opts: ParsedUrl) {
    this.opts = opts;
  }

  private async ensureOpen(): Promise<void> {
    if (this.socket) return;
    const connect = await getConnect();
    this.socket = connect(
      { hostname: this.opts.hostname, port: this.opts.port },
      { secureTransport: this.opts.tls ? "on" : "off", allowHalfOpen: false },
    );
    this.writer = this.socket.writable.getWriter();
    this.reader = this.socket.readable.getReader();

    if (this.opts.password) {
      const args = this.opts.username
        ? ["AUTH", this.opts.username, this.opts.password]
        : ["AUTH", this.opts.password];
      const result = await this.sendRaw([args]);
      if (result[0] instanceof RespError) {
        throw result[0];
      }
    }
  }

  /** Serialize one batch of commands at a time. */
  async send(commands: ReadonlyArray<ReadonlyArray<string | number>>): Promise<RespValue[]> {
    const previous = this.inflight;
    let release!: () => void;
    this.inflight = new Promise<void>((r) => {
      release = r;
    });
    try {
      await previous;
      await this.ensureOpen();
      return await this.sendRaw(commands);
    } finally {
      release();
    }
  }

  private async sendRaw(
    commands: ReadonlyArray<ReadonlyArray<string | number>>,
  ): Promise<RespValue[]> {
    if (!this.writer || !this.reader) throw new Error("connection not open");

    let totalLen = 0;
    const chunks: Uint8Array[] = [];
    for (const cmd of commands) {
      const c = encodeCommand(cmd);
      chunks.push(c);
      totalLen += c.byteLength;
    }
    const merged = new Uint8Array(totalLen);
    let off = 0;
    for (const c of chunks) {
      merged.set(c, off);
      off += c.byteLength;
    }
    await this.writer.write(merged);

    const out: RespValue[] = [];
    while (out.length < commands.length) {
      const next = this.parser.next();
      if (next !== undefined) {
        out.push(next);
        continue;
      }
      const { value, done } = await this.reader.read();
      if (done) throw new Error("Redis connection closed mid-reply");
      this.parser.push(value);
    }
    return out;
  }

  async close(): Promise<void> {
    try {
      await this.writer?.close();
    } catch {
      // ignore
    }
    try {
      await this.reader?.cancel();
    } catch {
      // ignore
    }
    try {
      await this.socket?.close();
    } catch {
      // ignore
    }
    this.socket = null;
    this.writer = null;
    this.reader = null;
  }
}

function unwrap(value: RespValue): unknown {
  if (value instanceof RespError) throw value;
  if (Array.isArray(value)) return value.map((v) => unwrap(v));
  return value;
}

function asString(value: RespValue): string | null {
  const v = unwrap(value);
  if (v === null) return null;
  return typeof v === "string" ? v : String(v);
}

function asNumber(value: RespValue): number {
  const v = unwrap(value);
  if (typeof v === "number") return v;
  if (typeof v === "string") return Number(v);
  return 0;
}

function asNumberOrNull(value: RespValue): number | null {
  const v = unwrap(value);
  if (v === null) return null;
  if (typeof v === "number") return v;
  if (typeof v === "string") return Number(v);
  return null;
}

function asArray(value: RespValue): unknown[] {
  const v = unwrap(value);
  return Array.isArray(v) ? (v as unknown[]) : [];
}

function asNullableArray(value: RespValue): Array<string | null> {
  const v = unwrap(value);
  if (v === null) return [];
  if (!Array.isArray(v)) return [];
  return v.map((item) => (item === null ? null : typeof item === "string" ? item : String(item)));
}

export interface SetOptions {
  nx?: boolean;
  ex?: number;
  px?: number;
}

interface ZAddMember {
  score: number;
  member: string;
}

/**
 * Drop-in replacement for `@upstash/redis`'s `Redis` class — same method
 * shapes as the subset the codebase uses (rate limit, credit events, agent
 * relay, A2A task store, generic cache).
 *
 * Constructor accepts `{ url }` matching how callers instantiate it; the URL
 * carries auth (`redis://default:password@host:port`).
 */
export class SocketRedis {
  private readonly conn: Connection;

  constructor(opts: { url: string } | string) {
    const url = typeof opts === "string" ? opts : opts.url;
    this.conn = new Connection(parseRedisUrl(url));
  }

  async get<T = string>(key: string): Promise<T | null> {
    const [v] = await this.conn.send([["GET", key]]);
    const s = asString(v);
    return s === null ? null : decodeMaybeJson<T>(s);
  }

  async set(key: string, value: unknown, options?: SetOptions): Promise<string | null> {
    const args: (string | number)[] = ["SET", key, serializeArg(value)];
    if (options?.ex !== undefined) args.push("EX", options.ex);
    if (options?.px !== undefined) args.push("PX", options.px);
    if (options?.nx) args.push("NX");
    const [v] = await this.conn.send([args]);
    return asString(v);
  }

  async setex(key: string, ttlSeconds: number, value: unknown): Promise<string> {
    const [v] = await this.conn.send([["SETEX", key, ttlSeconds, serializeArg(value)]]);
    return asString(v) ?? "OK";
  }

  async getdel<T = string>(key: string): Promise<T | null> {
    const [v] = await this.conn.send([["GETDEL", key]]);
    const s = asString(v);
    return s === null ? null : decodeMaybeJson<T>(s);
  }

  async incr(key: string): Promise<number> {
    const [v] = await this.conn.send([["INCR", key]]);
    return asNumber(v);
  }

  async expire(key: string, seconds: number): Promise<number> {
    const [v] = await this.conn.send([["EXPIRE", key, seconds]]);
    return asNumber(v);
  }

  async pexpire(key: string, ms: number): Promise<number> {
    const [v] = await this.conn.send([["PEXPIRE", key, ms]]);
    return asNumber(v);
  }

  async pttl(key: string): Promise<number | null> {
    const [v] = await this.conn.send([["PTTL", key]]);
    return asNumberOrNull(v);
  }

  async del(...keys: string[]): Promise<number> {
    if (keys.length === 0) return 0;
    const [v] = await this.conn.send([["DEL", ...keys]]);
    return asNumber(v);
  }

  async mget<T = string>(...keys: string[]): Promise<Array<T | null>> {
    if (keys.length === 0) return [];
    const [v] = await this.conn.send([["MGET", ...keys]]);
    return asNullableArray(v) as Array<T | null>;
  }

  async scan(
    cursor: string | number,
    options: { match: string; count: number },
  ): Promise<[string | number, string[]]> {
    const [v] = await this.conn.send([
      ["SCAN", cursor, "MATCH", options.match, "COUNT", options.count],
    ]);
    const arr = asArray(v);
    const nextCursor = arr[0] as string | number;
    const keys = (arr[1] as unknown[]).map((k) => (typeof k === "string" ? k : String(k)));
    return [nextCursor, keys];
  }

  async lpush(key: string, ...values: string[]): Promise<number> {
    const [v] = await this.conn.send([
      ["LPUSH", key, ...values.map((value) => serializeArg(value))],
    ]);
    return asNumber(v);
  }

  async rpush(key: string, ...values: string[]): Promise<number> {
    const [v] = await this.conn.send([
      ["RPUSH", key, ...values.map((value) => serializeArg(value))],
    ]);
    return asNumber(v);
  }

  async lpop<T = string>(key: string): Promise<T | null>;
  async lpop<T = string>(key: string, count: number): Promise<T[] | null>;
  async lpop<T = string>(key: string, count?: number): Promise<T | T[] | null> {
    const args = count !== undefined ? (["LPOP", key, count] as const) : (["LPOP", key] as const);
    const [v] = await this.conn.send([args as readonly (string | number)[]]);
    if (count !== undefined) {
      const arr = asArray(v);
      if (arr.length === 0 && unwrap(v) === null) return null;
      return arr.map((item) =>
        decodeMaybeJson(typeof item === "string" ? item : String(item)),
      ) as T[];
    }
    const s = asString(v);
    if (s === null) return null;
    return decodeMaybeJson<T>(s);
  }

  async rpop<T = string>(key: string): Promise<T | null> {
    const [v] = await this.conn.send([["RPOP", key]]);
    const s = asString(v);
    return s === null ? null : decodeMaybeJson<T>(s);
  }

  async llen(key: string): Promise<number> {
    const [v] = await this.conn.send([["LLEN", key]]);
    return asNumber(v);
  }

  async sadd(key: string, ...members: string[]): Promise<number> {
    const [v] = await this.conn.send([["SADD", key, ...members]]);
    return asNumber(v);
  }

  async srem(key: string, ...members: string[]): Promise<number> {
    const [v] = await this.conn.send([["SREM", key, ...members]]);
    return asNumber(v);
  }

  async smembers(key: string): Promise<string[]> {
    const [v] = await this.conn.send([["SMEMBERS", key]]);
    return asArray(v).map((item) => (typeof item === "string" ? item : String(item)));
  }

  async zadd(key: string, member: ZAddMember | { score: number; member: string }): Promise<number> {
    const [v] = await this.conn.send([["ZADD", key, member.score, member.member]]);
    return asNumber(v);
  }

  async zcard(key: string): Promise<number> {
    const [v] = await this.conn.send([["ZCARD", key]]);
    return asNumber(v);
  }

  async zrange(key: string, start: number, stop: number): Promise<string[]> {
    const [v] = await this.conn.send([["ZRANGE", key, start, stop]]);
    return asArray(v).map((item) => (typeof item === "string" ? item : String(item)));
  }

  async zrem(key: string, ...members: string[]): Promise<number> {
    const [v] = await this.conn.send([["ZREM", key, ...members]]);
    return asNumber(v);
  }

  async zremrangebyscore(key: string, min: number | string, max: number | string): Promise<number> {
    const [v] = await this.conn.send([["ZREMRANGEBYSCORE", key, min, max]]);
    return asNumber(v);
  }

  async ping(): Promise<string> {
    const [v] = await this.conn.send([["PING"]]);
    return asString(v) ?? "PONG";
  }

  pipeline(): Pipeline {
    return new Pipeline(this.conn);
  }

  async quit(): Promise<void> {
    try {
      await this.conn.send([["QUIT"]]);
    } catch {
      // ignore
    }
    await this.conn.close();
  }
}

function decodeMaybeJson<T>(s: string): T {
  try {
    return JSON.parse(s) as T;
  } catch {
    return s as T;
  }
}

function serializeArg(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

/**
 * Mirrors the chainable command surface that callers expect from the
 * Upstash pipeline (which is also chainable). `exec()` flushes everything
 * over the same socket in a single write and reads N replies back.
 */
export class Pipeline {
  private readonly commands: (string | number)[][] = [];

  constructor(private readonly conn: Connection) {}

  zremrangebyscore(key: string, min: number | string, max: number | string): this {
    this.commands.push(["ZREMRANGEBYSCORE", key, min, max]);
    return this;
  }

  zcard(key: string): this {
    this.commands.push(["ZCARD", key]);
    return this;
  }

  zadd(key: string, member: ZAddMember): this {
    this.commands.push(["ZADD", key, member.score, member.member]);
    return this;
  }

  zrem(key: string, ...members: string[]): this {
    this.commands.push(["ZREM", key, ...members]);
    return this;
  }

  expire(key: string, seconds: number): this {
    this.commands.push(["EXPIRE", key, seconds]);
    return this;
  }

  pexpire(key: string, ms: number): this {
    this.commands.push(["PEXPIRE", key, ms]);
    return this;
  }

  set(key: string, value: unknown, options?: SetOptions): this {
    const args: (string | number)[] = ["SET", key, serializeArg(value)];
    if (options?.ex !== undefined) args.push("EX", options.ex);
    if (options?.px !== undefined) args.push("PX", options.px);
    if (options?.nx) args.push("NX");
    this.commands.push(args);
    return this;
  }

  setex(key: string, ttlSeconds: number, value: unknown): this {
    this.commands.push(["SETEX", key, ttlSeconds, serializeArg(value)]);
    return this;
  }

  get(key: string): this {
    this.commands.push(["GET", key]);
    return this;
  }

  del(...keys: string[]): this {
    if (keys.length > 0) this.commands.push(["DEL", ...keys]);
    return this;
  }

  incr(key: string): this {
    this.commands.push(["INCR", key]);
    return this;
  }

  async exec<T extends unknown[] = unknown[]>(): Promise<T> {
    if (this.commands.length === 0) return [] as T;
    const replies = await this.conn.send(this.commands);
    return replies.map((r) => unwrap(r)) as T;
  }
}
