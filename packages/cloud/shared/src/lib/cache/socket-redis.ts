/**
 * RESP2 Redis client over `cloudflare:sockets` for Cloudflare Workers.
 *
 * Why this exists: Workers cannot use the `redis` or `ioredis` npm packages
 * (both depend on Node's `net` module). Upstash REST is the usual workaround
 * but Redis runs on Railway (TCP only), so we speak RESP2 directly via
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

type SocketAddress = { hostname: string; port: number };
type SocketOptions = {
  secureTransport?: "on" | "off" | "starttls";
  allowHalfOpen?: boolean;
};

type ConnectFn = (address: SocketAddress, options?: SocketOptions) => SocketLike;

let cachedConnect: ConnectFn | null = null;

async function getConnect(): Promise<ConnectFn> {
  if (cachedConnect) return cachedConnect;

  if (typeof globalThis !== "undefined" && "WebSocketPair" in globalThis) {
    // `cloudflare:sockets` only resolves inside the Workers bundler. Keep the
    // specifier non-static so Bun/Node test discovery uses the fallback branch
    // instead of trying to resolve a Worker-only module.
    const workerSocketsSpecifier = "cloudflare:" + "sockets";
    const mod = (await import(/* @vite-ignore */ workerSocketsSpecifier)) as {
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

// Hard ceiling for a single SocketRedis operation (connect + AUTH + command).
// `cloudflare:sockets` connect()/read() never time out on their own, so an
// unreachable or stalled origin (e.g. a Railway TCP proxy that accepts the
// connection but never speaks RESP) would otherwise block the caller for the
// whole request wall-clock. With this bound a stall throws instead, and
// CacheClient falls back to revalidate/DB — the cache degrades, never hangs.
const SOCKET_OP_TIMEOUT_MS = 1000;
const SOCKET_CLOSE_TIMEOUT_MS = 50;

type SocketReader = Pick<ReadableStreamDefaultReader<Uint8Array>, "read" | "cancel">;
type SocketWriter = Pick<WritableStreamDefaultWriter<Uint8Array>, "write" | "abort">;

/**
 * Narrow transport surface used by the test-only constructor. Production
 * callers cannot inject it: the factory is runtime-gated to NODE_ENV=test and
 * the constructor token stays private to this module.
 */
export interface SocketRedisTestTransport {
  reader: SocketReader;
  writer: SocketWriter;
  close(): Promise<void>;
}

export interface SocketRedisTestHooks {
  openTransport(address: SocketAddress, options: SocketOptions): Promise<SocketRedisTestTransport>;
  operationTimeoutMs?: number;
  closeTimeoutMs?: number;
}

interface ConnectionRuntime {
  openTransport(address: SocketAddress, options: SocketOptions): Promise<SocketRedisTestTransport>;
  operationTimeoutMs: number;
  closeTimeoutMs: number;
}

const productionConnectionRuntime: ConnectionRuntime = {
  async openTransport(address, options) {
    const connect = await getConnect();
    const socket = connect(address, options);
    return {
      reader: socket.readable.getReader(),
      writer: socket.writable.getWriter(),
      close: () => socket.close(),
    };
  },
  operationTimeoutMs: SOCKET_OP_TIMEOUT_MS,
  closeTimeoutMs: SOCKET_CLOSE_TIMEOUT_MS,
};

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

interface ConnectionState {
  readonly transport: SocketRedisTestTransport;
  readonly parser: RespParser;
  authenticated: boolean;
  ownerEpoch: number;
  closePromise: Promise<void> | null;
}

class StaleConnectionOperationError extends Error {
  constructor() {
    super("SocketRedis operation no longer owns the connection");
    this.name = "StaleConnectionOperationError";
  }
}

class Connection {
  private state: ConnectionState | null = null;
  private inflight: Promise<unknown> = Promise.resolve();
  private ownershipEpoch = 0;

  constructor(
    private readonly opts: ParsedUrl,
    private readonly runtime: ConnectionRuntime,
  ) {}

  private claimOwnership(): number {
    this.ownershipEpoch += 1;
    return this.ownershipEpoch;
  }

  private owns(epoch: number): boolean {
    return this.ownershipEpoch === epoch;
  }

  private retire(epoch: number): void {
    if (this.owns(epoch)) this.ownershipEpoch += 1;
  }

  private takeCurrent(epoch: number): ConnectionState | null {
    if (!this.owns(epoch)) throw new StaleConnectionOperationError();
    if (!this.state) return null;
    this.state.ownerEpoch = epoch;
    return this.state;
  }

  /**
   * Construct an unpublished state for this operation. The ownership epoch is
   * checked after the asynchronous open, so a timed-out opener can only close
   * its local transport; it cannot overwrite a successor's published state.
   */
  private async openCandidate(epoch: number): Promise<ConnectionState> {
    const transport = await this.runtime.openTransport(
      { hostname: this.opts.hostname, port: this.opts.port },
      { secureTransport: this.opts.tls ? "on" : "off", allowHalfOpen: false },
    );
    const candidate: ConnectionState = {
      transport,
      parser: new RespParser(),
      authenticated: !this.opts.password,
      ownerEpoch: epoch,
      closePromise: null,
    };

    if (!this.owns(epoch)) {
      await this.closeState(candidate);
      throw new StaleConnectionOperationError();
    }
    return candidate;
  }

  private publishCandidate(epoch: number, candidate: ConnectionState): void {
    if (!this.owns(epoch)) throw new StaleConnectionOperationError();
    if (this.state && this.state !== candidate) {
      throw new Error("SocketRedis connection state changed before publication");
    }
    candidate.ownerEpoch = epoch;
    this.state = candidate;
  }

  /** Serialize one batch of commands at a time. */
  async send(commands: ReadonlyArray<ReadonlyArray<string | number>>): Promise<RespValue[]> {
    const previous = this.inflight;
    let release!: () => void;
    this.inflight = new Promise<void>((r) => {
      release = r;
    });
    try {
      // Bound the queue wait too: on Workers a prior REQUEST's op can be
      // orphaned mid-flight (its I/O context ends → workerd never runs its
      // `finally release()`), so an unbounded `await previous` hangs every
      // later caller on this connection forever (observed: 79s /embeddings
      // stalls on staging). Each send() installs its own inflight promise
      // before waiting, so the chain structurally recovers once we stop
      // waiting on the orphan — but the socket's RESP framing state is
      // unknown mid-op, so drop it and reconnect fresh.
      let queueTimer: ReturnType<typeof setTimeout> | undefined;
      const queueWait = await Promise.race([
        previous.then(() => "released" as const),
        new Promise<"orphaned">((resolve) => {
          queueTimer = setTimeout(() => resolve("orphaned"), this.runtime.operationTimeoutMs);
        }),
      ]);
      if (queueTimer) clearTimeout(queueTimer);

      // Claim only after the serialization wait. This invalidates any losing
      // predecessor before a queue-orphan teardown or a fresh open can begin.
      const epoch = this.claimOwnership();
      if (queueWait === "orphaned") {
        await this.detachAndCloseCurrent();
      }

      let opState: ConnectionState | null = null;
      try {
        return await this.withTimeout(async () => {
          // Existing state is captured synchronously before the first await.
          // A fresh state stays unpublished until it is assigned locally,
          // authenticated, and ownership has been rechecked.
          opState = this.takeCurrent(epoch);
          const needsPublication = opState === null;
          if (!opState) opState = await this.openCandidate(epoch);
          if (!this.owns(epoch)) {
            this.detach(opState);
            await this.closeState(opState);
            throw new StaleConnectionOperationError();
          }

          if (!opState.authenticated) {
            const password = this.opts.password;
            if (!password) throw new Error("SocketRedis authentication state is invalid");
            const args = this.opts.username
              ? ["AUTH", this.opts.username, password]
              : ["AUTH", password];
            const result = await this.sendRaw([args], opState);
            if (result[0] instanceof RespError) throw result[0];
            if (!this.owns(epoch)) throw new StaleConnectionOperationError();
            opState.authenticated = true;
          }

          if (!this.owns(epoch)) throw new StaleConnectionOperationError();
          if (needsPublication) this.publishCandidate(epoch, opState);
          return await this.sendRaw(commands, opState);
        });
      } catch (error) {
        // Invalidate before teardown. The timed-out async loser may continue,
        // but it owns only its captured ConnectionState and cannot publish or
        // touch any state created by the next serialized caller.
        this.retire(epoch);
        const failedState = opState ?? (this.state?.ownerEpoch === epoch ? this.state : null);
        if (failedState) {
          this.detach(failedState);
          await this.closeState(failedState);
        }
        throw error;
      }
    } finally {
      release();
    }
  }

  /**
   * Bound a single connect+command to the configured operation timeout. On
   * timeout the error propagates to the caller, which falls back to its
   * non-cached path instead of hanging. The losing operation keeps running,
   * so connection-local state and the ownership epoch provide cancellation
   * safety without relying on the underlying socket promise being abortable.
   */
  private async withTimeout<T>(fn: () => Promise<T>): Promise<T> {
    const op = fn();
    // The losing side of the race keeps running; swallow its late rejection so
    // a post-timeout socket error doesn't surface as an unhandled rejection.
    // error-policy:J5 the winning side's error is observed by the caller via `op`/`timeout`.
    op.catch(() => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(
          new Error(`SocketRedis operation timed out after ${this.runtime.operationTimeoutMs}ms`),
        );
      }, this.runtime.operationTimeoutMs);
    });
    try {
      return await Promise.race([op, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async sendRaw(
    commands: ReadonlyArray<ReadonlyArray<string | number>>,
    state: ConnectionState,
  ): Promise<RespValue[]> {
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
    await state.transport.writer.write(merged);

    const out: RespValue[] = [];
    while (out.length < commands.length) {
      const next = state.parser.next();
      if (next !== undefined) {
        out.push(next);
        continue;
      }
      const { value, done } = await state.transport.reader.read();
      if (done) throw new Error("Redis connection closed mid-reply");
      state.parser.push(value);
    }
    return out;
  }

  private detach(state: ConnectionState): void {
    if (this.state === state) this.state = null;
  }

  private async detachAndCloseCurrent(): Promise<void> {
    const state = this.state;
    if (!state) return;
    this.state = null;
    await this.closeState(state);
  }

  private closeState(state: ConnectionState): Promise<void> {
    if (state.closePromise) return state.closePromise;

    state.closePromise = (async () => {
      // A timed-out Railway socket may never complete graceful teardown.
      // Detach first, abort all three transport layers in parallel, and cap
      // cleanup at 50ms in production. allSettled observes late failures.
      const cleanup = Promise.allSettled([
        Promise.resolve().then(async () => await state.transport.writer.abort()),
        Promise.resolve().then(async () => await state.transport.reader.cancel()),
        Promise.resolve().then(async () => await state.transport.close()),
      ]);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          cleanup,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, this.runtime.closeTimeoutMs);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    })();

    return state.closePromise;
  }

  async close(): Promise<void> {
    // Prevent an openTransport() that is still awaiting from publishing after
    // an explicit close, then detach the currently published state.
    this.ownershipEpoch += 1;
    await this.detachAndCloseCurrent();
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

const SOCKET_REDIS_TEST_CONSTRUCTOR = Symbol("SocketRedisTestConstructor");

function testConnectionRuntime(hooks: SocketRedisTestHooks): ConnectionRuntime {
  if (typeof process === "undefined" || process.env.NODE_ENV !== "test") {
    throw new Error("SocketRedis test transport injection is disabled outside NODE_ENV=test");
  }

  const operationTimeoutMs = hooks.operationTimeoutMs ?? SOCKET_OP_TIMEOUT_MS;
  const closeTimeoutMs = hooks.closeTimeoutMs ?? SOCKET_CLOSE_TIMEOUT_MS;
  if (!Number.isFinite(operationTimeoutMs) || operationTimeoutMs <= 0) {
    throw new Error("SocketRedis test operationTimeoutMs must be positive");
  }
  if (!Number.isFinite(closeTimeoutMs) || closeTimeoutMs <= 0) {
    throw new Error("SocketRedis test closeTimeoutMs must be positive");
  }

  return {
    openTransport: hooks.openTransport,
    operationTimeoutMs,
    closeTimeoutMs,
  };
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

  constructor(opts: { url: string } | string);
  constructor(
    opts: { url: string } | string,
    testConstructor: typeof SOCKET_REDIS_TEST_CONSTRUCTOR,
    testHooks: SocketRedisTestHooks,
  );
  constructor(
    opts: { url: string } | string,
    testConstructor?: typeof SOCKET_REDIS_TEST_CONSTRUCTOR,
    testHooks?: SocketRedisTestHooks,
  ) {
    const url = typeof opts === "string" ? opts : opts.url;
    let runtime = productionConnectionRuntime;
    if (testConstructor !== undefined || testHooks !== undefined) {
      if (testConstructor !== SOCKET_REDIS_TEST_CONSTRUCTOR || !testHooks) {
        throw new Error("Invalid SocketRedis test constructor token");
      }
      runtime = testConnectionRuntime(testHooks);
    }
    this.conn = new Connection(parseRedisUrl(url), runtime);
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

/**
 * Create a SocketRedis instance with deterministic transport controls for
 * resilience tests. The unexported constructor token plus the NODE_ENV guard
 * keep this seam unavailable to accidental production construction.
 */
export function createSocketRedisForTests(
  opts: { url: string } | string,
  hooks: SocketRedisTestHooks,
): SocketRedis {
  return new SocketRedis(opts, SOCKET_REDIS_TEST_CONSTRUCTOR, hooks);
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

  pttl(key: string): this {
    this.commands.push(["PTTL", key]);
    return this;
  }

  async exec<T extends unknown[] = unknown[]>(): Promise<T> {
    const empty: unknown[] = [];
    if (this.commands.length === 0) return empty as T;
    const replies = await this.conn.send(this.commands);
    return replies.map((r) => unwrap(r)) as T;
  }
}
