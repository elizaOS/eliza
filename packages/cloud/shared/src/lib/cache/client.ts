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
import { getCloudAwareEnv, getCloudBinding } from "../runtime/cloud-bindings";
import { logger } from "../utils/logger";
import { KvCacheAdapter, type KvNamespaceLike } from "./adapters/kv-cache-adapter";
import { MemoryCacheAdapter } from "./adapters/memory-cache-adapter";
import { NodeRedisAdapter } from "./adapters/node-redis-adapter";
import { SocketRedisAdapter } from "./adapters/socket-redis-adapter";
import type { CacheRedisClient } from "./adapters/types";
import { UpstashRedisAdapter } from "./adapters/upstash-redis-adapter";
import { type WadisClientLike, WadisRedisAdapter } from "./adapters/wadis-redis-adapter";
import { SocketRedis } from "./socket-redis";

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

/** Bounded backend names safe to include in cache telemetry. */
export type CacheBackendKind =
  | "cloudflare_kv"
  | "memory"
  | "redis_native"
  | "redis_rest"
  | "redis_socket"
  | "wadis"
  | "none"
  | "unknown";

/** Explicit cache-read result so security paths never confuse an outage with a miss. */
export type CacheReadOutcome<T> =
  | { kind: "hit"; value: T; backend: CacheBackendKind }
  | { kind: "miss" | "invalid" | "unavailable" | "error"; backend: CacheBackendKind };

/** Explicit cache-write result for observability without fabricating durability. */
export type CacheWriteOutcome = {
  kind: "written" | "invalid" | "unavailable" | "error";
  backend: CacheBackendKind;
};

export type CacheKeyClass = "inference_auth";

export interface CacheOperationOptions {
  /** Replaces identifier-bearing cache keys with a bounded class in logs. */
  keyClass?: CacheKeyClass;
}

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

// CacheRedisClient interface and the five adapter classes
// (Socket / Upstash / NodeRedis / Wadis / Memory) now live in ./adapters/*.

/**
 * Redis cache client with circuit breaker, stale-while-revalidate, and error handling.
 */
export class CacheClient {
  private redis: CacheRedisClient | null = null;
  private enabled: boolean | null = null;
  /**
   * Whether a real cache backend was CONFIGURED (credentials/binding present or
   * an explicit memory/wadis backend). Unlike `enabled`, this is NOT flipped to
   * false by a runtime connect failure or circuit-open — so
   * {@link isBackendConfigured} can tell "nothing to invalidate" from "a backend
   * exists but is currently unreachable". (#13417)
   */
  private backendConfigured = false;
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

  private isSentinelCredential(value: string | undefined): boolean {
    if (!value) return false;

    return (
      value.includes("your-redis.upstash.io") ||
      value.includes("default:token@your-redis.upstash.io") ||
      value === "token" ||
      value === "unset"
    );
  }

  private getBackendPreference(): "auto" | "redis" | "redis-rest" | "wadis" | "kv" | "memory" {
    const env = getCloudAwareEnv();
    const raw = (env.CACHE_BACKEND || env.CACHE_ADAPTER || env.CACHE_DRIVER || "auto")
      .trim()
      .toLowerCase();

    if (raw === "native-redis" || raw === "redis-native") return "redis";
    if (raw === "upstash" || raw === "rest" || raw === "redis-rest") return "redis-rest";
    if (raw === "wadis" || raw === "wasm-redis" || raw === "wasm_redis") return "wadis";
    if (raw === "kv" || raw === "cloudflare-kv" || raw === "workers-kv") return "kv";
    if (raw === "memory" || raw === "in-memory" || raw === "in_memory") return "memory";
    return "auto";
  }

  /**
   * The Cloudflare KV namespace bound as `CACHE_KV`, if present. KV is the only
   * Worker-reachable cache backend (the Worker can't reliably open raw TCP to an
   * external Redis), so we prefer it inside the Worker. Object bindings aren't
   * exposed by `getCloudAwareEnv()`; read it from the request binding store.
   */
  private getKvBinding(): KvNamespaceLike | undefined {
    return getCloudBinding<KvNamespaceLike>("CACHE_KV");
  }

  private initializeWadis(): void {
    this.backendConfigured = true;
    this.nativeRedisReady = false;
    this.nativeRedisConnectPromise = import("wadis")
      .then(({ Wadis }) => {
        // Wadis's exported types don't exactly match WadisClientLike (the local
        // structural interface we use). The runtime shape is compatible.
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

    // MOCK_REDIS=1 is an explicit opt-in for tests/CI. It forces the in-memory
    // adapter regardless of any other configuration, but never activates
    // silently when unset — real creds are still honored when MOCK_REDIS is
    // not "1".
    if (this.enabled && process.env.MOCK_REDIS === "1") {
      this.nativeRedisConnectPromise = null;
      this.nativeRedisReady = true;
      this.backendConfigured = true;
      this.redis = new MemoryCacheAdapter();
      logger.info("[Cache] ✓ Cache client initialized with in-memory mock (MOCK_REDIS=1)");
      return;
    }

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
    const socketRedisConfigured = Boolean(redisUrl) && !this.isSentinelCredential(redisUrl);
    const nativeRedisConfigured =
      Boolean(redisUrl) && !this.isSentinelCredential(redisUrl) && !inWorker;
    const restRedisConfigured =
      Boolean(restUrl && restToken) &&
      !this.isSentinelCredential(restUrl) &&
      !this.isSentinelCredential(restToken);

    if (backendPreference === "memory") {
      if (env.NODE_ENV === "production" && env.PLAYWRIGHT_TEST_AUTH !== "true") {
        logger.error("[Cache] Refusing to initialize in-memory cache in production");
        this.enabled = false;
        return;
      }

      this.nativeRedisConnectPromise = null;
      this.nativeRedisReady = true;
      this.backendConfigured = true;
      this.redis = new MemoryCacheAdapter();
      logger.info("[Cache] ✓ Cache client initialized with in-memory local test backend");
      return;
    }

    if (!inWorker && (backendPreference === "wadis" || redisUrl === "wadis://local")) {
      this.initializeWadis();
      return;
    }

    // Cloudflare Workers cannot reliably open raw TCP to an external Redis: the
    // `cloudflare:sockets` connection to Railway's public proxy hangs under load
    // (no connect timeout → the whole request stalls). So when a KV namespace is
    // bound (`CACHE_KV`), prefer it for the Worker's cache — KV is HTTP-native
    // and reliable from Workers. Atomic/list ops degrade (see KvCacheAdapter);
    // supportsAtomicOperations() reports false so locks use the dummy path.
    if (inWorker && backendPreference !== "redis-rest" && backendPreference !== "redis") {
      const kv = this.getKvBinding();
      if (kv) {
        this.backendConfigured = true;
        this.redis = new KvCacheAdapter(kv);
        this.nativeRedisConnectPromise = null;
        this.nativeRedisReady = true;
        logger.info("[Cache] ✓ Cache client initialized with Cloudflare KV");
        return;
      }
    }

    // Workers can't speak raw TCP via the `redis` package, but `cloudflare:sockets`
    // works for RESP2. Use the SocketRedis adapter whenever we're in a Worker and
    // a real REDIS_URL is set.
    if (inWorker && socketRedisConfigured && redisUrl && backendPreference !== "redis-rest") {
      this.backendConfigured = true;
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
      this.backendConfigured = true;
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
      logger.warn("[Cache] Ignoring sentinel or invalid native Redis credentials.");
    }

    if (
      restRedisConfigured &&
      restUrl &&
      restToken &&
      (backendPreference === "auto" || backendPreference === "redis-rest")
    ) {
      this.nativeRedisConnectPromise = null;
      this.nativeRedisReady = true;
      this.backendConfigured = true;
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
      logger.warn("[Cache] Ignoring sentinel or invalid Redis REST credentials.");
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

  /** Return a bounded adapter label without exposing configuration or endpoints. */
  getBackendKind(): CacheBackendKind {
    this.initialize();
    switch (this.redis?.backend) {
      case "cloudflare-kv":
        return "cloudflare_kv";
      case "memory":
        return "memory";
      case "redis-native":
        return "redis_native";
      case "redis-rest":
        return "redis_rest";
      case "redis-socket":
        return "redis_socket";
      case "wadis":
        return "wadis";
      case undefined:
        return "none";
      default:
        return "unknown";
    }
  }

  private cacheLogContext(key: string, options?: CacheOperationOptions): Record<string, string> {
    return options?.keyClass ? { keyClass: options.keyClass } : { key };
  }

  /**
   * Whether the underlying cache backend supports atomic SET NX PX (used for
   * distributed stampede locks). All Redis-protocol backends in this client
   * support it; non-atomic backends (e.g. Cloudflare KV) would return false.
   */
  supportsAtomicOperations(): boolean {
    this.initialize();
    if (this.enabled === false) return false;
    // Cloudflare KV is eventually consistent with no atomic SET NX / INCR, so
    // callers (distributed locks) must fall back to their non-distributed path.
    return this.redis?.backend !== "cloudflare-kv";
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
   * Whether a cache backend is CONFIGURED at all (independent of transient
   * availability / circuit-breaker state). Distinguishes "no backend, nothing to
   * invalidate" from "backend configured but temporarily unreachable" so
   * {@link delConfirmed} / {@link delPatternConfirmed} can fail closed only in
   * the latter case. (#13417)
   */
  isBackendConfigured(): boolean {
    this.initialize();
    // Reflects that a backend was SELECTED (creds/binding/memory/wadis present),
    // even if a later connect attempt failed and downgraded `enabled` — a stale
    // entry may still live in that configured backend, so an unconfirmed delete
    // against it must fail closed, not report "nothing to invalidate".
    return this.backendConfigured;
  }

  /**
   * Gets a value from cache.
   *
   * @param key - Cache key.
   * @returns Cached value or null if not found or invalid.
   */
  async get<T>(key: string): Promise<T | null> {
    const outcome = await this.getWithOutcome<T>(key);
    return outcome.kind === "hit" ? outcome.value : null;
  }

  /**
   * Reads a value while preserving miss, malformed-value, and backend-failure states.
   * Auth callers use this instead of the legacy nullable contract because an
   * unavailable cache must remain observable even though authorization safely
   * falls back to its authoritative store.
   */
  async getWithOutcome<T>(
    key: string,
    options?: CacheOperationOptions,
  ): Promise<CacheReadOutcome<T>> {
    const redis = await this.getRedisClient();
    const backend = this.getBackendKind();
    if (!redis) return { kind: "unavailable", backend };

    const prefixedKey = this.pk(key);
    try {
      const start = Date.now();
      const value = await redis.get(prefixedKey);
      const duration = Date.now() - start;

      if (value === null || value === undefined) {
        this.logMetric(key, "miss", duration);
        return { kind: "miss", backend };
      }

      // Check for corrupted cache values
      if (typeof value === "string" && value === "[object Object]") {
        logger.warn("[Cache] Corrupted cache value detected; deleting", {
          ...this.cacheLogContext(key, options),
        });
        await this.del(key, options);
        return { kind: "invalid", backend };
      }

      const parsed = parseCacheValue<T>(value);

      if (!this.isValidCacheValue(parsed)) {
        logger.warn("[Cache] Invalid cached value; deleting", {
          ...this.cacheLogContext(key, options),
        });
        await this.del(key, options);
        return { kind: "invalid", backend };
      }

      this.resetFailures();
      this.logMetric(key, "hit", duration);
      return { kind: "hit", value: parsed, backend };
    } catch (error) {
      // error-policy:J1 cache-adapter boundary translates backend failure into
      // an explicit error outcome; security callers then use authoritative data.
      this.recordFailure();
      logger.warn("[Cache] GET failed", {
        ...this.cacheLogContext(key, options),
        error: error instanceof Error ? error.message : String(error),
      });
      return { kind: "error", backend };
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
            .catch((error) => {
              // Fire-and-forget: without this catch every failed/timed-out
              // background revalidation became an unhandled rejection (nobody
              // awaits the queued promise). The stale value already served
              // stays in place; the next stale hit retries.
              logger.warn("[Cache] Background revalidation failed", {
                key,
                error: error instanceof Error ? error.message : String(error),
              });
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
    await this.setWithOutcome(key, value, ttlSeconds);
  }

  /** Write a value while reporting whether the backend actually accepted it. */
  async setWithOutcome<T>(
    key: string,
    value: T,
    ttlSeconds: number,
    options?: CacheOperationOptions,
  ): Promise<CacheWriteOutcome> {
    const redis = await this.getRedisClient();
    const backend = this.getBackendKind();
    if (!redis) return { kind: "unavailable", backend };

    if (!this.isValidCacheValue(value)) {
      logger.error("[Cache] Attempted to cache invalid value", {
        ...this.cacheLogContext(key, options),
      });
      return { kind: "invalid", backend };
    }

    const serialized = serializeCacheValue(value);

    try {
      const start = Date.now();
      await redis.setex(this.pk(key), ttlSeconds, serialized);

      this.resetFailures();
      this.logMetric(key, "set", Date.now() - start);
      return { kind: "written", backend };
    } catch (error) {
      // error-policy:J1 cache-adapter boundary preserves a failed write as an
      // explicit outcome instead of claiming the value became durable.
      this.recordFailure();
      logger.warn("[Cache] SET failed", {
        ...this.cacheLogContext(key, options),
        error: error instanceof Error ? error.message : String(error),
      });
      return { kind: "error", backend };
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
   * Best-effort: swallows a backend delete failure (logs a warning) and returns
   * `void`. Callers on a security-sensitive invalidation path (revoked
   * credentials, logout, permission changes) must instead use
   * {@link delConfirmed} so they can fail closed on an unconfirmed delete
   * rather than assume a stale entry is gone. (#13417)
   *
   * @param key - Cache key to delete.
   */
  async del(key: string, options?: CacheOperationOptions): Promise<void> {
    await this.delConfirmed(key, options);
  }

  /**
   * Deletes a key from cache, reporting whether the delete was confirmed.
   *
   * @param key - Cache key to delete.
   * @returns `true` when the delete is confirmed against the backend, OR when no
   *   cache backend is CONFIGURED at all (nothing could be caching a stale
   *   entry, so there is nothing to invalidate). `false` when a configured
   *   backend rejected the delete OR is temporarily unavailable (circuit
   *   breaker open / still connecting) — in that brownout a stale entry may
   *   still live in the backend, so the delete is NOT confirmed. The previous
   *   void-only `del` contract silently reported all of these as success, so a
   *   revoked key/session kept serving from cache until its TTL lapsed.
   *   Security-sensitive invalidation MUST fail closed on `false`. (#13417)
   */
  async delConfirmed(key: string, options?: CacheOperationOptions): Promise<boolean> {
    const redis = await this.getRedisClient();
    if (!redis) return !this.isBackendConfigured();

    try {
      const start = Date.now();
      await redis.del(this.pk(key));

      logger.debug("[Cache] DEL", this.cacheLogContext(key, options));
      this.resetFailures();
      this.logMetric(key, "del", Date.now() - start);
      return true;
    } catch (error) {
      // error-policy:J1 cache-adapter boundary returns false so lifecycle
      // callers can fail closed when security-sensitive invalidation fails.
      this.recordFailure();
      logger.warn("[Cache] DEL failed", {
        ...this.cacheLogContext(key, options),
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
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
   * Best-effort: returns `void`; a partial sweep (runaway-iteration guard) is
   * indistinguishable from a complete one to the caller. Security-sensitive
   * invalidation must use {@link delPatternConfirmed} instead. (#13417)
   *
   * @param pattern - Pattern to match (e.g., "org:*:cache")
   * @param batchSize - Number of keys to scan per iteration (default: 100)
   * @param maxIterations - Maximum iterations to prevent runaway scans (default: 1000)
   */
  async delPattern(pattern: string, batchSize = 100, maxIterations = 1000): Promise<void> {
    await this.delPatternConfirmed(pattern, batchSize, maxIterations);
  }

  /**
   * Delete all keys matching a pattern using SCAN, reporting completeness.
   *
   * @param pattern - Pattern to match (e.g., "org:*:cache")
   * @param batchSize - Number of keys to scan per iteration (default: 100)
   * @param maxIterations - Maximum iterations to prevent runaway scans (default: 1000)
   * @returns `true` when the full keyspace matching `pattern` was scanned and
   *   deleted (or there is no backend to invalidate); `false` when the scan hit
   *   the runaway-iteration guard and therefore left matching keys behind — a
   *   PARTIAL invalidation that previously returned normally and was
   *   indistinguishable from a complete one. Security-sensitive callers MUST
   *   fail closed on `false`. (A thrown scan/del error still propagates.)
   *   (#13417)
   */
  async delPatternConfirmed(
    pattern: string,
    batchSize = 100,
    maxIterations = 1000,
  ): Promise<boolean> {
    const redis = await this.getRedisClient();
    // No backend configured -> nothing to invalidate (true). Configured but
    // temporarily unavailable (circuit open / connecting) -> unconfirmed sweep
    // over a backend that may still hold matching keys (false, fail closed).
    if (!redis) return !this.isBackendConfigured();

    const start = Date.now();
    // Thread the cursor as an opaque string. Cloudflare KV returns a base64-ish
    // continuation token (and "0" when complete); numeric parsing corrupts that
    // token, stops KV pagination after the first page, and leaves every key
    // beyond the first pattern-delete batch behind.
    let cursor: string | number = "0";
    let totalDeleted = 0;
    let iterations = 0;
    let hitMaxIterations = false;

    do {
      const result: [string | number, string[]] = await redis.scan(cursor, {
        match: this.pk(pattern),
        count: batchSize,
      });

      cursor = String(result[0]);
      const keys = result[1];

      // Count every scan iteration toward the runaway guard, including empty
      // pages. A backend that returns many empty pages with a non-terminal
      // cursor would otherwise never trip the guard and loop unbounded.
      iterations++;

      if (keys.length > 0) {
        await redis.del(...keys);
        totalDeleted += keys.length;
        logger.debug(
          `[Cache] DEL_PATTERN iteration ${iterations}: deleted ${keys.length} keys (total: ${totalDeleted})`,
        );
      }

      hitMaxIterations = cursor !== "0" && iterations >= maxIterations;
      if (hitMaxIterations) {
        break;
      }

      if (cursor !== "0") {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    } while (cursor !== "0");

    const duration = Date.now() - start;

    if (hitMaxIterations) {
      logger.warn(
        `[Cache] DEL_PATTERN reached max iterations (${maxIterations}) for pattern ${pattern}. ` +
          `Deleted ${totalDeleted} keys so far. Pattern may match too many keys. Consider narrowing the pattern.`,
      );
    } else if (totalDeleted === 0) {
      logger.debug(`[Cache] DEL_PATTERN: ${pattern} (no keys found)`);
    } else {
      logger.info(
        `[Cache] DEL_PATTERN: ${pattern} (deleted ${totalDeleted} keys in ${duration}ms, ${iterations} iterations)`,
      );
    }

    this.logMetric(pattern, "del_pattern", duration);
    // A hit on the runaway-iteration guard means keys matching `pattern` were
    // left behind: report the invalidation as INCOMPLETE so callers can fail
    // closed instead of assuming a clean sweep.
    return !hitMaxIterations;
  }

  /**
   * Gets multiple values from cache in a single operation.
   *
   * @param keys - Array of cache keys.
   * @returns Array of cached values (null for misses).
   */
  /**
   * List application-level (un-prefixed) cache keys matching a prefix, using a
   * bounded SCAN. Returns at most `maxKeys`. Used by the inference-charge sweep
   * (#9899) to find stale pending entries; the returned keys can be passed back
   * to `get`/`getAndDelete`/`del` directly (the env prefix is stripped here and
   * re-applied by those ops). Returns `[]` when the cache is unavailable.
   */
  async scanByPrefix(prefix: string, maxKeys = 1000): Promise<string[]> {
    const redis = await this.getRedisClient();
    if (!redis) return [];

    const env = getCloudAwareEnv();
    const envPrefix = `${env.ENVIRONMENT || "local"}:`;
    const match = this.pk(`${prefix}*`);
    const out: string[] = [];
    // Opaque string cursor — see delPattern. parseInt-ing KV's continuation token
    // broke pagination, so the sweep only ever saw the first ~100 pending keys and
    // stragglers leaked (TTL-expired uncharged).
    let cursor: string | number = "0";
    let iterations = 0;

    try {
      do {
        const [next, keys]: [string | number, string[]] = await redis.scan(cursor, {
          match,
          count: 100,
        });
        cursor = String(next);
        for (const key of keys) {
          out.push(key.startsWith(envPrefix) ? key.slice(envPrefix.length) : key);
          if (out.length >= maxKeys) return out;
        }
        if (++iterations >= 1000) break;
      } while (cursor !== "0");
      this.resetFailures();
      return out;
    } catch (error) {
      this.recordFailure();
      logger.warn("[Cache] SCAN_BY_PREFIX failed", {
        prefix,
        error: error instanceof Error ? error.message : String(error),
      });
      return out;
    }
  }

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

    // Breaker is open: degrade to cache-miss silently. The closed->open transition
    // is logged once in recordFailure(); logging on every blocked call would spam.
    return true;
  }

  private recordFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    // Log exactly on the closed->open transition (failureCount keeps climbing past
    // MAX_FAILURES while open, so `=== MAX_FAILURES` fires once per open). Include the
    // failure count + cooldown so a Redis brownout is distinguishable from a DB one.
    if (this.failureCount === this.MAX_FAILURES) {
      logger.warn("[Cache] Circuit breaker OPENED - degrading to cache-miss", {
        failureCount: this.failureCount,
        cooldownMs: this.CIRCUIT_BREAKER_TIMEOUT,
      });
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
