/**
 * Redis-based cache client with stale-while-revalidate support and circuit breaker.
 *
 * Backends:
 *   - Socket Redis (`REDIS_URL`)                       — Workers (`cloudflare:sockets`) + Node fallback.
 *   - Native Redis protocol (`redis://...`)            — production / CI / self-hosted (non-Worker).
 *   - Upstash REST (`KV_REST_API_URL` + token)         — legacy fallback for existing Upstash deploys.
 *   - Wadis (in-process WASM Redis)                    — local dev default, no Docker (non-Worker).
 */

import { randomUUID } from "node:crypto";
import { Redis as UpstashRedis } from "@upstash/redis";
import { createClient } from "redis";
import { SocketRedis } from "@/lib/cache/socket-redis";
import { getCloudAwareEnv } from "@/lib/runtime/cloud-bindings";
import { logger } from "@/lib/utils/logger";

function isCloudflareWorkerRuntime(): boolean {
  return typeof globalThis !== "undefined" && "WebSocketPair" in globalThis;
}

/**
 * Sentinel value persisted in cache to represent "loader returned null".
 * Lets `wrapNullable` distinguish "we cached a known-absent answer" from
 * "key not found in cache" without a separate flag column.
 */
export const NEGATIVE_CACHE_SENTINEL = { __none: true } as const;
type NegativeSentinel = typeof NEGATIVE_CACHE_SENTINEL;

function isNegativeSentinel(value: unknown): value is NegativeSentinel {
  return (
    typeof value === "object" && value !== null && (value as { __none?: unknown }).__none === true
  );
}

/**
 * Environment prefix for Redis cache keys.
 *
 * Prevents cross-environment cache contamination when multiple deployments
 * (e.g. dev / preview / production) share the same Redis instance.
 *
 * Uses ENVIRONMENT ("production" | "staging" | "development"), falling back
 * to "local" when unset.
 */
/**
 * Cached value wrapper with metadata for stale-while-revalidate.
 */
interface CachedValue<T> {
  /** The cached data. */
  data: T;
  /** Timestamp when the value was cached. */
  cachedAt: number;
  /** Timestamp when the value becomes stale. */
  staleAt: number;
}

function serializeCacheValue<T>(value: T): string {
  return JSON.stringify(value);
}

function parseCacheValue<T>(value: unknown): T {
  if (typeof value !== "string") {
    return value as T;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return value as T;
  }
}

interface CacheRedisClient {
  readonly backend: string;
  get(key: string): Promise<string | null>;
  setex(key: string, ttlSeconds: number, value: string): Promise<unknown>;
  set(key: string, value: string, options?: { nx?: boolean; px?: number }): Promise<string | null>;
  incr(key: string): Promise<number>;
  expire(key: string, ttlSeconds: number): Promise<unknown>;
  pexpire(key: string, ttlMs: number): Promise<unknown>;
  pttl(key: string): Promise<number | null>;
  getdel(key: string): Promise<string | null>;
  del(...keys: string[]): Promise<unknown>;
  scan(
    cursor: string | number,
    options: { match: string; count: number },
  ): Promise<[string | number, string[]]>;
  mget(...keys: string[]): Promise<Array<string | null>>;
  lpush(key: string, ...values: string[]): Promise<number>;
  rpop(key: string): Promise<string | null>;
  llen(key: string): Promise<number>;
}

type NativeRedisClient = ReturnType<typeof createClient>;

class SocketRedisAdapter implements CacheRedisClient {
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

class UpstashRedisAdapter implements CacheRedisClient {
  readonly backend = "redis-rest";

  constructor(private readonly client: UpstashRedis) {}

  get(key: string): Promise<string | null> {
    return this.client.get<string>(key);
  }

  setex(key: string, ttlSeconds: number, value: string): Promise<unknown> {
    return this.client.setex(key, ttlSeconds, value);
  }

  set(key: string, value: string, options?: { nx?: boolean; px?: number }): Promise<string | null> {
    return this.client.set(key, value, options as never) as Promise<string | null>;
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
    return this.client.getdel<string>(key);
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
    return this.client.mget<string[]>(...keys) as Promise<Array<string | null>>;
  }

  lpush(key: string, ...values: string[]): Promise<number> {
    return this.client.lpush(key, ...values);
  }

  rpop(key: string): Promise<string | null> {
    return this.client.rpop<string>(key) as Promise<string | null>;
  }

  llen(key: string): Promise<number> {
    return this.client.llen(key);
  }
}

class NodeRedisAdapter implements CacheRedisClient {
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

interface WadisClientLike {
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

class WadisRedisAdapter implements CacheRedisClient {
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

class MemoryCacheAdapter implements CacheRedisClient {
  readonly backend = "memory";
  private readonly values = new Map<string, { value: string; expireAt: number | null }>();
  private readonly lists = new Map<string, { values: string[]; expireAt: number | null }>();

  private now(): number {
    return Date.now();
  }

  private getValue(key: string): string | null {
    const entry = this.values.get(key);
    if (!entry) return null;
    if (entry.expireAt !== null && entry.expireAt <= this.now()) {
      this.values.delete(key);
      return null;
    }
    return entry.value;
  }

  private getList(key: string): string[] | null {
    const entry = this.lists.get(key);
    if (!entry) return null;
    if (entry.expireAt !== null && entry.expireAt <= this.now()) {
      this.lists.delete(key);
      return null;
    }
    return entry.values;
  }

  private setValue(key: string, value: string, ttlMs?: number): void {
    this.values.set(key, {
      value,
      expireAt: ttlMs === undefined ? null : this.now() + ttlMs,
    });
    this.lists.delete(key);
  }

  private setExpiry(key: string, ttlMs: number): number {
    const expireAt = this.now() + ttlMs;
    const valueEntry = this.values.get(key);
    if (valueEntry && this.getValue(key) !== null) {
      valueEntry.expireAt = expireAt;
      return 1;
    }

    const listEntry = this.lists.get(key);
    if (listEntry && this.getList(key) !== null) {
      listEntry.expireAt = expireAt;
      return 1;
    }

    return 0;
  }

  private deleteExpired(): void {
    for (const key of this.values.keys()) {
      this.getValue(key);
    }
    for (const key of this.lists.keys()) {
      this.getList(key);
    }
  }

  private patternToRegExp(pattern: string): RegExp {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp(`^${escaped}$`);
  }

  async get(key: string): Promise<string | null> {
    return this.getValue(key);
  }

  async setex(key: string, ttlSeconds: number, value: string): Promise<unknown> {
    this.setValue(key, value, ttlSeconds * 1000);
    return "OK";
  }

  async set(
    key: string,
    value: string,
    options?: { nx?: boolean; px?: number },
  ): Promise<string | null> {
    if (options?.nx && this.getValue(key) !== null) {
      return null;
    }
    this.setValue(key, value, options?.px);
    return "OK";
  }

  async incr(key: string): Promise<number> {
    const next = Number.parseInt(this.getValue(key) ?? "0", 10) + 1;
    this.setValue(key, String(next));
    return next;
  }

  async expire(key: string, ttlSeconds: number): Promise<unknown> {
    return this.setExpiry(key, ttlSeconds * 1000);
  }

  async pexpire(key: string, ttlMs: number): Promise<unknown> {
    return this.setExpiry(key, ttlMs);
  }

  async pttl(key: string): Promise<number | null> {
    const valueEntry = this.values.get(key);
    if (valueEntry && this.getValue(key) !== null) {
      return valueEntry.expireAt === null ? -1 : Math.max(valueEntry.expireAt - this.now(), 0);
    }

    const listEntry = this.lists.get(key);
    if (listEntry && this.getList(key) !== null) {
      return listEntry.expireAt === null ? -1 : Math.max(listEntry.expireAt - this.now(), 0);
    }

    return -2;
  }

  async getdel(key: string): Promise<string | null> {
    const value = this.getValue(key);
    this.values.delete(key);
    return value;
  }

  async del(...keys: string[]): Promise<unknown> {
    let deleted = 0;
    for (const key of keys) {
      if (this.values.delete(key)) deleted += 1;
      if (this.lists.delete(key)) deleted += 1;
    }
    return deleted;
  }

  async scan(
    cursor: string | number,
    options: { match: string; count: number },
  ): Promise<[string | number, string[]]> {
    this.deleteExpired();
    const pattern = this.patternToRegExp(options.match);
    const keys = [...this.values.keys(), ...this.lists.keys()].filter((key) => pattern.test(key));
    return [0, keys.slice(0, options.count)];
  }

  async mget(...keys: string[]): Promise<Array<string | null>> {
    return keys.map((key) => this.getValue(key));
  }

  async lpush(key: string, ...values: string[]): Promise<number> {
    const existing = this.getList(key) ?? [];
    const entry = this.lists.get(key) ?? { values: existing, expireAt: null };
    entry.values.unshift(...values);
    this.lists.set(key, entry);
    this.values.delete(key);
    return entry.values.length;
  }

  async rpop(key: string): Promise<string | null> {
    const list = this.getList(key);
    return list?.pop() ?? null;
  }

  async llen(key: string): Promise<number> {
    return this.getList(key)?.length ?? 0;
  }
}

/**
 * Redis cache client with circuit breaker, stale-while-revalidate, and error handling.
 */
export class CacheClient {
  private redis: CacheRedisClient | null = null;
  private enabled: boolean | null = null;
  private initialized = false;
  private failureCount = 0;
  private lastFailureTime = 0;
  private readonly MAX_FAILURES = 5;
  private readonly CIRCUIT_BREAKER_TIMEOUT = 60000;
  private revalidationQueue = new Map<string, Promise<void>>();
  private readonly MAX_REVALIDATION_QUEUE_SIZE = 100;
  private readonly REVALIDATION_TIMEOUT_MS = 30000;
  private nativeRedisConnectPromise: Promise<void> | null = null;
  private nativeRedisReady = false;
  private readonly instanceId = randomUUID();
  private metricsSampleRate: number | null = null;

  /**
   * Prepends the environment prefix to a cache key or pattern.
   * Ensures keys from different environments (production / preview / local) never collide
   * when they share the same Redis instance.
   */
  private pk(key: string): string {
    const env = getCloudAwareEnv();
    const envPrefix = env.ENVIRONMENT || "local";
    return `${envPrefix}:${key}`;
  }

  private isPlaceholderCredential(value: string | undefined): boolean {
    if (!value) return false;

    return (
      value.includes("your-redis.upstash.io") ||
      value.includes("default:token@your-redis.upstash.io") ||
      value === "token" ||
      value === "unset"
    );
  }

  private getBackendPreference(): "auto" | "redis" | "redis-rest" | "wadis" | "memory" {
    const env = getCloudAwareEnv();
    const raw = (env.CACHE_BACKEND || env.CACHE_ADAPTER || env.CACHE_DRIVER || "auto")
      .trim()
      .toLowerCase();

    if (raw === "native-redis" || raw === "redis-native") return "redis";
    if (raw === "upstash" || raw === "rest" || raw === "redis-rest") return "redis-rest";
    if (raw === "wadis" || raw === "wasm-redis" || raw === "wasm_redis") return "wadis";
    if (raw === "memory" || raw === "in-memory" || raw === "in_memory") return "memory";
    return "auto";
  }

  private initializeWadis(): void {
    this.nativeRedisReady = false;
    this.nativeRedisConnectPromise = import("wadis")
      .then(({ Wadis }) => {
        this.redis = new WadisRedisAdapter(new Wadis() as unknown as WadisClientLike);
        this.nativeRedisReady = true;
        logger.info("[Cache] ✓ Cache client initialized with Wadis Wasm Redis");
      })
      .catch((error) => {
        this.recordFailure();
        this.enabled = false;
        this.redis = null;
        logger.warn("[Cache] Failed to initialize Wadis Wasm Redis", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  private initialize(): void {
    if (this.initialized) return;
    this.initialized = true;

    const env = getCloudAwareEnv();
    this.enabled = env.CACHE_ENABLED !== "false";

    if (!this.enabled) {
      // CACHE_DISABLE_REASON acknowledges an intentional disable
      // (e.g. CF Workers cross-request I/O isolation incompatibility while
      // CacheClient remains a module-level singleton). When set, downgrade
      // the production log to warn so monitoring dashboards do not
      // alert on every cold start.
      const disableReason = env.CACHE_DISABLE_REASON;
      if (env.NODE_ENV === "production" && !disableReason) {
        logger.error(
          "🚨 [Cache] CRITICAL: Caching disabled in production! " +
            "This will cause severe performance degradation. " +
            "Set CACHE_ENABLED=true and configure Redis credentials, " +
            "or set CACHE_DISABLE_REASON to acknowledge the disable.",
        );
      } else if (disableReason) {
        logger.warn(`[Cache] Caching is disabled (acknowledged): ${disableReason}`);
      } else {
        logger.warn("[Cache] Caching is disabled via CACHE_ENABLED flag");
      }
      return;
    }

    const redisUrl = env.REDIS_URL || env.KV_URL;
    const restUrl = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL;
    const restToken = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
    const backendPreference = this.getBackendPreference();

    const inWorker = isCloudflareWorkerRuntime();
    const hasNativeRedisConfig = Boolean(redisUrl);
    const hasRestRedisConfig = Boolean(restUrl || restToken);
    const socketRedisConfigured = Boolean(redisUrl) && !this.isPlaceholderCredential(redisUrl);
    const nativeRedisConfigured =
      Boolean(redisUrl) && !this.isPlaceholderCredential(redisUrl) && !inWorker;
    const restRedisConfigured =
      Boolean(restUrl && restToken) &&
      !this.isPlaceholderCredential(restUrl) &&
      !this.isPlaceholderCredential(restToken);

    if (backendPreference === "memory") {
      if (env.NODE_ENV === "production" && env.PLAYWRIGHT_TEST_AUTH !== "true") {
        logger.error("[Cache] Refusing to initialize in-memory cache in production");
        this.enabled = false;
        return;
      }

      this.nativeRedisConnectPromise = null;
      this.nativeRedisReady = true;
      this.redis = new MemoryCacheAdapter();
      logger.info("[Cache] ✓ Cache client initialized with in-memory local test backend");
      return;
    }

    if (!inWorker && (backendPreference === "wadis" || redisUrl === "wadis://local")) {
      this.initializeWadis();
      return;
    }

    // Workers can't speak raw TCP via the `redis` package, but `cloudflare:sockets`
    // works for RESP2. Use the SocketRedis adapter whenever we're in a Worker and
    // a real REDIS_URL is set.
    if (inWorker && socketRedisConfigured && redisUrl && backendPreference !== "redis-rest") {
      this.redis = new SocketRedisAdapter(new SocketRedis({ url: redisUrl }));
      this.nativeRedisConnectPromise = null;
      this.nativeRedisReady = true;
      logger.info(
        "[Cache] ✓ Cache client initialized with socket Redis (RESP2 over cloudflare:sockets)",
      );
      return;
    }

    if (
      nativeRedisConfigured &&
      redisUrl &&
      (backendPreference === "auto" || backendPreference === "redis")
    ) {
      const client = createClient({ url: redisUrl });

      client.on("error", (error: unknown) => {
        logger.warn("[Cache] Native Redis client error", {
          error: error instanceof Error ? error.message : String(error),
        });
      });

      this.nativeRedisReady = false;
      this.nativeRedisConnectPromise = client
        .connect()
        .then(() => {
          this.nativeRedisReady = true;
          logger.info("[Cache] ✓ Cache client initialized with native Redis protocol");
        })
        .catch((error: unknown) => {
          this.recordFailure();
          this.enabled = false;
          this.redis = null;
          logger.warn("[Cache] Failed to connect to native Redis", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      this.redis = new NodeRedisAdapter(client);
      return;
    }

    if (hasNativeRedisConfig && backendPreference !== "redis-rest") {
      logger.warn("[Cache] Ignoring placeholder or invalid native Redis credentials.");
    }

    if (
      restRedisConfigured &&
      restUrl &&
      restToken &&
      (backendPreference === "auto" || backendPreference === "redis-rest")
    ) {
      this.nativeRedisConnectPromise = null;
      this.nativeRedisReady = true;
      this.redis = new UpstashRedisAdapter(
        new UpstashRedis({
          url: restUrl,
          token: restToken,
        }),
      );
      logger.info(
        "[Cache] ✓ Cache client initialized with REST API (consider using native protocol)",
      );
      return;
    }

    if (hasRestRedisConfig) {
      logger.warn("[Cache] Ignoring placeholder or incomplete Redis REST credentials.");
    }

    // Local dev fallback: when nothing real is configured and we're not in a
    // Worker or production, boot embedded Wadis so caching keeps working.
    if (backendPreference === "auto" && !inWorker && env.NODE_ENV !== "production") {
      logger.info("[Cache] No Redis credentials found; falling back to embedded Wadis WASM Redis.");
      this.initializeWadis();
      return;
    }

    if (env.NODE_ENV === "production") {
      logger.error(
        "🚨 [Cache] CRITICAL: Missing Redis credentials in production! " +
          "Caching disabled - this will cause severe performance issues. " +
          "Set KV_REST_API_URL + KV_REST_API_TOKEN for Upstash REST.",
      );
    } else {
      logger.warn(
        "[Cache] Missing Redis credentials, caching disabled. Set CACHE_BACKEND=wadis for embedded local dev.",
      );
    }
    this.enabled = false;
  }

  private async getRedisClient(): Promise<CacheRedisClient | null> {
    this.initialize();
    if (!this.enabled || this.isCircuitOpen()) {
      return null;
    }

    if (this.nativeRedisConnectPromise) {
      await this.nativeRedisConnectPromise;
      if (!this.enabled || !this.redis || this.isCircuitOpen()) {
        return null;
      }
    }

    if (!this.redis) {
      return null;
    }

    return this.redis;
  }

  /**
   * Whether the underlying cache backend supports atomic SET NX PX (used for
   * distributed stampede locks). All Redis-protocol backends in this client
   * support it; non-atomic backends (e.g. Cloudflare KV) would return false.
   */
  supportsAtomicOperations(): boolean {
    this.initialize();
    return this.enabled !== false;
  }

  /**
   * Whether the cache backend (Redis) is connected and the circuit breaker is closed.
   */
  isAvailable(): boolean {
    this.initialize();
    return !!(
      this.enabled &&
      (this.redis || this.nativeRedisConnectPromise) &&
      !this.isCircuitOpen()
    );
  }

  /**
   * Gets a value from cache.
   *
   * @param key - Cache key.
   * @returns Cached value or null if not found or invalid.
   */
  async get<T>(key: string): Promise<T | null> {
    const redis = await this.getRedisClient();
    if (!redis) return null;

    const prefixedKey = this.pk(key);
    try {
      const start = Date.now();
      const value = await redis.get(prefixedKey);
      const duration = Date.now() - start;

      if (value === null || value === undefined) {
        this.logMetric(key, "miss", duration);
        return null;
      }

      // Check for corrupted cache values
      if (typeof value === "string" && value === "[object Object]") {
        logger.warn(`[Cache] Corrupted cache value detected for key ${key}, deleting`);
        await this.del(key);
        return null;
      }

      const parsed = parseCacheValue<T>(value);

      if (!this.isValidCacheValue(parsed)) {
        logger.warn(`[Cache] Invalid cached value for key ${key}, deleting`);
        await this.del(key);
        return null;
      }

      this.resetFailures();
      this.logMetric(key, "hit", duration);
      return parsed;
    } catch (error) {
      this.recordFailure();
      logger.warn("[Cache] GET failed, treating as cache miss", {
        key,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Gets a value from cache with stale-while-revalidate support.
   *
   * Returns stale data immediately if available, then revalidates in the background.
   *
   * @param key - Cache key.
   * @param staleTTL - Time in seconds before data is considered stale.
   * @param revalidate - Function to fetch fresh data.
   * @param ttl - Optional total time to live in seconds. Defaults to staleTTL * 2.
   * @returns Cached value (stale or fresh) or null.
   */
  async getWithSWR<T>(
    key: string,
    staleTTL: number,
    revalidate: () => Promise<T>,
    ttl?: number,
  ): Promise<T | null> {
    const effectiveTTL = ttl ?? staleTTL * 2;
    const redis = await this.getRedisClient();
    if (!redis) {
      return await revalidate();
    }

    try {
      const start = Date.now();
      const value = await redis.get(this.pk(key));
      const duration = Date.now() - start;

      if (value === null || value === undefined) {
        this.logMetric(key, "miss", duration);
        const fresh = await revalidate();
        if (fresh !== null) {
          await this.set(
            key,
            {
              data: fresh,
              cachedAt: Date.now(),
              staleAt: Date.now() + staleTTL * 1000,
            } as CachedValue<T>,
            effectiveTTL,
          );
        }
        return fresh;
      }

      const raw = typeof value === "string" ? JSON.parse(value) : value;
      const parsed = raw as CachedValue<T>;

      const now = Date.now();
      const isStale = now > parsed.staleAt;

      if (isStale) {
        this.logMetric(key, "stale", duration);

        // Return stale data immediately
        const staleData = parsed.data;

        if (this.revalidationQueue.size >= this.MAX_REVALIDATION_QUEUE_SIZE) {
          logger.warn(
            `[Cache] Revalidation queue full (${this.revalidationQueue.size}/${this.MAX_REVALIDATION_QUEUE_SIZE}). ` +
              `Skipping background revalidation for key: ${key}`,
          );
          return staleData;
        }

        // Revalidate in background (deduplicated)
        if (!this.revalidationQueue.has(key)) {
          const timeoutPromise = new Promise<T | null>((_, reject) => {
            setTimeout(
              () => reject(new Error("Revalidation timeout")),
              this.REVALIDATION_TIMEOUT_MS,
            );
          });

          const revalidationPromise = Promise.race([revalidate(), timeoutPromise])
            .then((fresh) => {
              if (fresh !== null) {
                return this.set(
                  key,
                  {
                    data: fresh,
                    cachedAt: Date.now(),
                    staleAt: Date.now() + staleTTL * 1000,
                  } as CachedValue<T>,
                  effectiveTTL,
                );
              }
            })
            .finally(() => {
              this.revalidationQueue.delete(key);
            });

          this.revalidationQueue.set(key, revalidationPromise);
        }

        return staleData;
      }

      this.logMetric(key, "hit", duration);
      this.resetFailures();
      return parsed.data;
    } catch (error) {
      this.recordFailure();
      logger.warn("[Cache] GET-with-SWR failed, falling back to revalidate", {
        key,
        error: error instanceof Error ? error.message : String(error),
      });
      return await revalidate();
    }
  }

  /**
   * Sets a value in cache with TTL.
   *
   * @param key - Cache key.
   * @param value - Value to cache (must be JSON-serializable).
   * @param ttlSeconds - Time to live in seconds.
   */
  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    const redis = await this.getRedisClient();
    if (!redis) return;

    if (!this.isValidCacheValue(value)) {
      logger.error(`[Cache] Attempted to cache invalid value for key ${key}`);
      return;
    }

    const serialized = serializeCacheValue(value);

    try {
      const start = Date.now();
      await redis.setex(this.pk(key), ttlSeconds, serialized);

      this.resetFailures();
      this.logMetric(key, "set", Date.now() - start);
    } catch (error) {
      this.recordFailure();
      logger.warn("[Cache] SET failed", {
        key,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Atomically set key to value with TTL only if key does not exist (SET NX PX).
   * Used for single-use nonces to prevent TOCTOU races between getAndDelete and set.
   *
   * @param key - Cache key.
   * @param value - Value to set (string or serializable).
   * @param ttlMs - Time to live in milliseconds.
   * @returns true if key was set, false if key already existed.
   */
  async setIfNotExists<T>(key: string, value: T, ttlMs: number): Promise<boolean> {
    const redis = await this.getRedisClient();
    if (!redis) {
      throw new Error("Cache unavailable for atomic set-if-not-exists");
    }

    if (!this.isValidCacheValue(value)) {
      throw new Error(`Invalid cache value for key ${key}`);
    }

    const serialized = serializeCacheValue(value);

    const start = Date.now();
    const result = await redis.set(this.pk(key), serialized, { nx: true, px: ttlMs });
    this.resetFailures();
    this.logMetric(key, "setIfNotExists", Date.now() - start);
    return result === "OK";
  }

  /**
   * Atomically increments a numeric value in cache.
   * If the key does not exist, it is set to 0 before incrementing.
   *
   * @param key - Cache key to increment.
   * @returns The new value after incrementing.
   */
  async incr(key: string): Promise<number> {
    const redis = await this.getRedisClient();
    if (!redis) return 1;

    try {
      const result = await redis.incr(this.pk(key));
      this.resetFailures();
      return result;
    } catch (error) {
      this.recordFailure();
      logger.error("[Cache] INCR failed", {
        key,
        error: error instanceof Error ? error.message : String(error),
      });
      return 1;
    }
  }

  /**
   * Sets a TTL (time to live) on an existing key.
   *
   * @param key - Cache key.
   * @param ttlSeconds - Time to live in seconds.
   */
  async expire(key: string, ttlSeconds: number): Promise<void> {
    const redis = await this.getRedisClient();
    if (!redis) return;

    try {
      await redis.expire(this.pk(key), ttlSeconds);
      this.resetFailures();
    } catch (error) {
      this.recordFailure();
      logger.error("[Cache] EXPIRE failed", {
        key,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Atomically gets a value and deletes the key using GETDEL (Redis ≥6.2).
   * Used for single-use values (e.g. SIWE nonce) to prevent replay attacks.
   *
   * @param key - Cache key.
   * @returns The value if present, or null.
   */
  async getAndDelete<T>(key: string): Promise<T | null> {
    const redis = await this.getRedisClient();
    if (!redis) return null;

    try {
      const value = await redis.getdel(this.pk(key));
      if (value === null || value === undefined) return null;

      if (typeof value === "string" && value === "[object Object]") {
        logger.warn(`[Cache] Corrupted cache value detected in getAndDelete for key ${key}`);
        return null;
      }

      // Plain strings (e.g. SIWE nonce, "used") are stored verbatim; only object payloads are JSON-serialized
      let parsed: T;
      if (typeof value === "string") {
        try {
          parsed = JSON.parse(value) as T;
        } catch {
          parsed = value as T;
        }
      } else {
        parsed = value as T;
      }
      this.resetFailures();
      return parsed;
    } catch (error) {
      this.recordFailure();
      logger.error("[Cache] GETDEL failed", {
        key,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new Error("Cache operation failed during getAndDelete", { cause: error });
    }
  }

  /**
   * Deletes a key from cache.
   *
   * @param key - Cache key to delete.
   */
  async del(key: string): Promise<void> {
    const redis = await this.getRedisClient();
    if (!redis) return;

    try {
      const start = Date.now();
      await redis.del(this.pk(key));

      logger.debug(`[Cache] DEL: ${key}`);
      this.resetFailures();
      this.logMetric(key, "del", Date.now() - start);
    } catch (error) {
      this.recordFailure();
      logger.warn("[Cache] DEL failed", {
        key,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async pttl(key: string): Promise<number | null> {
    const redis = await this.getRedisClient();
    if (!redis) return null;

    try {
      return await redis.pttl(this.pk(key));
    } catch (error) {
      this.recordFailure();
      logger.warn("[Cache] PTTL failed", {
        key,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  async pexpire(key: string, ttlMs: number): Promise<void> {
    const redis = await this.getRedisClient();
    if (!redis) return;

    try {
      await redis.pexpire(this.pk(key), ttlMs);
      this.resetFailures();
    } catch (error) {
      this.recordFailure();
      logger.warn("[Cache] PEXPIRE failed", {
        key,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Delete all keys matching a pattern using SCAN (non-blocking)
   *
   * Uses SCAN instead of KEYS to avoid blocking Redis on large keysets.
   *
   * @param pattern - Pattern to match (e.g., "org:*:cache")
   * @param batchSize - Number of keys to scan per iteration (default: 100)
   * @param maxIterations - Maximum iterations to prevent runaway scans (default: 1000)
   */
  async delPattern(pattern: string, batchSize = 100, maxIterations = 1000): Promise<void> {
    const redis = await this.getRedisClient();
    if (!redis) return;

    const start = Date.now();
    let cursor: string | number = 0;
    let totalDeleted = 0;
    let iterations = 0;

    do {
      if (iterations >= maxIterations) {
        logger.warn(
          `[Cache] DEL_PATTERN reached max iterations (${maxIterations}) for pattern ${pattern}. ` +
            `Deleted ${totalDeleted} keys so far. Pattern may match too many keys. Consider narrowing the pattern.`,
        );
        break;
      }

      const result: [string | number, string[]] = await redis.scan(cursor, {
        match: this.pk(pattern),
        count: batchSize,
      });

      cursor = typeof result[0] === "string" ? Number.parseInt(result[0], 10) : result[0];
      const keys = result[1];

      if (keys.length > 0) {
        await redis.del(...keys);
        totalDeleted += keys.length;
        logger.debug(
          `[Cache] DEL_PATTERN iteration ${++iterations}: deleted ${keys.length} keys (total: ${totalDeleted})`,
        );
      }

      if (cursor !== 0) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    } while (cursor !== 0 && iterations < maxIterations);

    const duration = Date.now() - start;

    if (totalDeleted === 0) {
      logger.debug(`[Cache] DEL_PATTERN: ${pattern} (no keys found)`);
    } else {
      logger.info(
        `[Cache] DEL_PATTERN: ${pattern} (deleted ${totalDeleted} keys in ${duration}ms, ${iterations} iterations)`,
      );
    }

    this.logMetric(pattern, "del_pattern", duration);
  }

  /**
   * Gets multiple values from cache in a single operation.
   *
   * @param keys - Array of cache keys.
   * @returns Array of cached values (null for misses).
   */
  async mget<T>(keys: string[]): Promise<Array<T | null>> {
    const redis = await this.getRedisClient();
    if (!redis) {
      return keys.map(() => null);
    }

    try {
      const start = Date.now();
      const values = await redis.mget(...keys.map((k) => this.pk(k)));

      const parsed = await Promise.all(
        values.map(async (value, index) => {
          if (value === null || value === undefined) return null;

          if (typeof value === "string" && value === "[object Object]") {
            logger.warn(`[Cache] Corrupted cache value in mget for key ${keys[index]}, skipping`);
            await this.del(keys[index]);
            return null;
          }

          return parseCacheValue<T>(value);
        }),
      );

      const hitCount = parsed.filter((v) => v !== null).length;
      logger.debug(`[Cache] MGET: ${keys.length} keys (${hitCount} hits)`);
      this.resetFailures();
      this.logMetric("mget", "hit", Date.now() - start, {
        keys: keys.length,
        hits: hitCount,
      });

      return parsed;
    } catch (error) {
      this.recordFailure();
      logger.warn("[Cache] MGET failed", {
        keys: keys.length,
        error: error instanceof Error ? error.message : String(error),
      });
      return keys.map(() => null);
    }
  }

  async pushQueueHead(key: string, ...values: string[]): Promise<number | null> {
    const redis = await this.getRedisClient();
    if (!redis) return null;

    try {
      const result = await redis.lpush(this.pk(key), ...values);
      this.resetFailures();
      return result;
    } catch (error) {
      this.recordFailure();
      logger.error("[Cache] queue push failed", {
        key,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  async popQueueTail(key: string): Promise<string | null> {
    const redis = await this.getRedisClient();
    if (!redis) return null;

    try {
      const value = await redis.rpop(this.pk(key));
      this.resetFailures();
      return value;
    } catch (error) {
      this.recordFailure();
      logger.error("[Cache] queue pop failed", {
        key,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  async getQueueLength(key: string): Promise<number> {
    const redis = await this.getRedisClient();
    if (!redis) return 0;

    try {
      const length = await redis.llen(this.pk(key));
      this.resetFailures();
      return length;
    } catch (error) {
      this.recordFailure();
      logger.warn("[Cache] queue length failed", {
        key,
        error: error instanceof Error ? error.message : String(error),
      });
      return 0;
    }
  }

  private isCircuitOpen(): boolean {
    if (this.failureCount < this.MAX_FAILURES) {
      return false;
    }

    const timeSinceLastFailure = Date.now() - this.lastFailureTime;
    if (timeSinceLastFailure > this.CIRCUIT_BREAKER_TIMEOUT) {
      logger.info("[Cache] Circuit breaker timeout expired, attempting to reconnect");
      this.failureCount = 0;
      return false;
    }

    logger.warn(
      `[Cache] Circuit breaker OPEN (${this.failureCount} failures, retry in ${Math.ceil((this.CIRCUIT_BREAKER_TIMEOUT - timeSinceLastFailure) / 1000)}s)`,
    );
    return true;
  }

  private recordFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.failureCount === this.MAX_FAILURES) {
      logger.error(`[Cache] Circuit breaker OPENED after ${this.MAX_FAILURES} failures`);
    }
  }

  private resetFailures(): void {
    if (this.failureCount > 0) {
      logger.info("[Cache] Circuit breaker CLOSED - cache operational");
      this.failureCount = 0;
    }
  }

  private isValidCacheValue<T>(value: T): boolean {
    if (value === null || value === undefined) {
      return false;
    }

    if (typeof value === "string" && value === "[object Object]") {
      return false;
    }

    if (typeof value === "object") {
      try {
        JSON.stringify(value);
        return true;
      } catch {
        return false;
      }
    }

    return true;
  }

  private getMetricsSampleRate(): number {
    if (this.metricsSampleRate !== null) return this.metricsSampleRate;

    const raw = getCloudAwareEnv().CACHE_METRICS_SAMPLE;
    let rate = 0.01;
    if (raw !== undefined && raw !== "") {
      const parsed = Number.parseFloat(raw);
      if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 1) {
        rate = parsed;
      }
    }
    this.metricsSampleRate = rate;
    return rate;
  }

  /**
   * Returns the first colon-delimited segment of a cache key. We log this
   * (instead of the full key) so structured-log indexing stays bounded.
   */
  private keyPrefix(key: string): string {
    const colon = key.indexOf(":");
    return colon === -1 ? key : key.slice(0, colon);
  }

  private circuitState(): "open" | "closed" {
    return this.failureCount >= this.MAX_FAILURES ? "open" : "closed";
  }

  private logMetric(
    key: string,
    operation:
      | "hit"
      | "miss"
      | "set"
      | "setIfNotExists"
      | "del"
      | "del_pattern"
      | "stale"
      | "getOrSet",
    durationMs: number,
    metadata?: Record<string, unknown>,
  ): void {
    const rate = this.getMetricsSampleRate();
    if (rate <= 0) return;
    if (rate < 1 && Math.random() >= rate) return;

    const isReadOp = operation === "hit" || operation === "miss" || operation === "stale";
    const isGetOrSet = operation === "getOrSet";

    const fields: Record<string, unknown> = {
      op: isReadOp ? "get" : isGetOrSet ? "getOrSet" : operation,
      key_prefix: this.keyPrefix(key),
      latency_ms: durationMs,
      circuit_state: this.circuitState(),
      backend: this.redis?.backend ?? "none",
    };

    if (isReadOp) {
      fields.hit = operation === "hit" || operation === "stale";
    }

    if (isGetOrSet && metadata && typeof metadata.hit === "boolean") {
      fields.hit = metadata.hit;
    }

    if (metadata) {
      for (const [k, v] of Object.entries(metadata)) {
        if (k === "hit") continue;
        fields[k] = v;
      }
    }

    logger.info("[Cache] metric", fields);
  }

  /**
   * Get-or-set with distributed-stampede protection.
   *
   * Behavior:
   *   - If a fresh value is in cache, return it.
   *   - On miss with `singleflight: false` (default), every caller invokes
   *     the loader concurrently — same as a manual get/set pair.
   *   - On miss with `singleflight: true`, the first caller acquires a
   *     short-lived distributed lock (SET NX PX), runs the loader, and
   *     populates the cache; concurrent callers poll the cache for up to
   *     ~4s. If the lock-holder is still computing after that window,
   *     waiters fall through and run the loader themselves rather than
   *     hanging — better to double-fetch than to stall a request.
   *   - If the backend doesn't support atomic ops, stampede protection
   *     is skipped silently.
   */
  async getOrSet<T>(
    key: string,
    ttlSeconds: number,
    loader: () => Promise<T>,
    options: { singleflight?: boolean } = {},
  ): Promise<T> {
    const start = Date.now();
    const cached = await this.get<T>(key);
    if (cached !== null) {
      this.logMetric(key, "getOrSet", Date.now() - start, { hit: true });
      return cached;
    }

    if (!options.singleflight || !this.supportsAtomicOperations()) {
      const fresh = await loader();
      if (fresh !== null && fresh !== undefined) {
        await this.set(key, fresh, ttlSeconds);
      }
      this.logMetric(key, "getOrSet", Date.now() - start, { hit: false });
      return fresh;
    }

    const lockKey = `__lock:${key}`;
    const lockTtlMs = 5000;
    const lockToken = await this.tryAcquireLock(lockKey, lockTtlMs);

    if (lockToken) {
      try {
        const fresh = await loader();
        if (fresh !== null && fresh !== undefined) {
          await this.set(key, fresh, ttlSeconds);
        }
        this.logMetric(key, "getOrSet", Date.now() - start, { hit: false, lock: "acquired" });
        return fresh;
      } finally {
        await this.releaseLock(lockKey, lockToken);
      }
    }

    const maxAttempts = 8;
    const pollIntervalMs = 500;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      const polled = await this.get<T>(key);
      if (polled !== null) {
        this.logMetric(key, "getOrSet", Date.now() - start, {
          hit: true,
          lock: "waited",
          attempts: attempt + 1,
        });
        return polled;
      }
    }

    const fresh = await loader();
    if (fresh !== null && fresh !== undefined) {
      await this.set(key, fresh, ttlSeconds);
    }
    this.logMetric(key, "getOrSet", Date.now() - start, { hit: false, lock: "fallthrough" });
    return fresh;
  }

  private async tryAcquireLock(lockKey: string, ttlMs: number): Promise<string | null> {
    const redis = await this.getRedisClient();
    if (!redis) return null;

    try {
      const token = `${this.instanceId}:${randomUUID()}`;
      const result = await redis.set(this.pk(lockKey), token, {
        nx: true,
        px: ttlMs,
      });
      return result === "OK" ? token : null;
    } catch (error) {
      this.recordFailure();
      logger.warn("[Cache] Lock acquisition failed, skipping stampede protection", {
        lockKey,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private async releaseLock(lockKey: string, token: string): Promise<void> {
    const redis = await this.getRedisClient();
    if (!redis) return;

    try {
      const prefixedKey = this.pk(lockKey);
      const currentToken = await redis.get(prefixedKey);
      if (currentToken === token) {
        await redis.del(prefixedKey);
      }
    } catch (error) {
      this.recordFailure();
      logger.warn("[Cache] Lock release failed", {
        lockKey,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Cache wrapper for loaders that can legitimately return `null` (e.g.
   * "user not found" lookups). Caches negative results under a sentinel
   * for a shorter TTL so we don't hammer the DB on repeated misses.
   *
   * - Positive results cache for `ttl` seconds.
   * - Negative (null) results cache for `negativeTtl` seconds (default 60).
   * - Pass `singleflight: true` to opt in to distributed stampede protection.
   */
  async wrapNullable<T>(
    loader: () => Promise<T | null>,
    opts: { key: string; ttl: number; negativeTtl?: number; singleflight?: boolean },
  ): Promise<T | null> {
    const { key, ttl, negativeTtl = 60, singleflight = false } = opts;

    const cached = await this.get<T | NegativeSentinel>(key);
    if (cached !== null) {
      return isNegativeSentinel(cached) ? null : (cached as T);
    }

    if (!singleflight || !this.supportsAtomicOperations()) {
      const fresh = await loader();
      if (fresh === null) {
        await this.set(key, NEGATIVE_CACHE_SENTINEL, negativeTtl);
      } else {
        await this.set(key, fresh, ttl);
      }
      return fresh;
    }

    const lockKey = `__lock:${key}`;
    const lockTtlMs = 5000;
    const lockToken = await this.tryAcquireLock(lockKey, lockTtlMs);

    if (lockToken) {
      try {
        const fresh = await loader();
        if (fresh === null) {
          await this.set(key, NEGATIVE_CACHE_SENTINEL, negativeTtl);
        } else {
          await this.set(key, fresh, ttl);
        }
        return fresh;
      } finally {
        await this.releaseLock(lockKey, lockToken);
      }
    }

    const maxAttempts = 8;
    const pollIntervalMs = 500;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      const polled = await this.get<T | NegativeSentinel>(key);
      if (polled !== null) {
        return isNegativeSentinel(polled) ? null : (polled as T);
      }
    }

    const fresh = await loader();
    if (fresh === null) {
      await this.set(key, NEGATIVE_CACHE_SENTINEL, negativeTtl);
    } else {
      await this.set(key, fresh, ttl);
    }
    return fresh;
  }
}

export const cache = new CacheClient();
