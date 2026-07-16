/**
 * Single factory for the Upstash-shaped Redis client used across the
 * codebase (rate limiters, credit events, agent gateway relay, A2A task
 * store, generic cache).
 *
 * Resolution order:
 *   1. `MOCK_REDIS=1` → in-memory `MockSocketRedis` (test/CI only; never
 *      silently shadows real creds).
 *   2. `REDIS_URL` (or per-bindings env)  → `SocketRedis` (RESP2 over
 *      `cloudflare:sockets` in Workers, or `node:net` in Bun/Node).
 *   3. `KV_REST_API_URL` + `KV_REST_API_TOKEN` → `@upstash/redis` REST
 *      client (legacy fallback; kept so existing Upstash deploys still work).
 *   4. null — caller decides what to do.
 */

import { Redis as UpstashRedis } from "@upstash/redis";
import { MockSocketRedis } from "./mock-redis";
import { SocketRedis } from "./socket-redis";

interface CompatibleRedisPipeline {
  zremrangebyscore(key: string, min: number | string, max: number | string): this;
  zcard(key: string): this;
  zadd(key: string, member: { score: number; member: string }): this;
  zrem(key: string, ...members: string[]): this;
  expire(key: string, seconds: number): this;
  pexpire(key: string, ms: number): this;
  set(key: string, value: unknown, options?: { nx?: boolean; ex?: number; px?: number }): this;
  setex(key: string, ttlSeconds: number, value: unknown): this;
  get(key: string): this;
  del(...keys: string[]): this;
  incr(key: string): this;
  pttl(key: string): this;
  exec<T extends unknown[] = unknown[]>(): Promise<T>;
}

// Keep the TCP side structural so both the real and mock clients must implement
// the same public surface. This avoids a double cast (which hid pipeline drift)
// without adding a third overloaded class to the Upstash union. Override the
// pipeline class itself because its private fields are intentionally nominal.
type CompatibleSocketRedis = Pick<
  SocketRedis,
  Exclude<Extract<keyof SocketRedis, keyof MockSocketRedis>, "pipeline">
> & { pipeline(): CompatibleRedisPipeline };
export type CompatibleRedis = CompatibleSocketRedis | UpstashRedis;

export interface RedisFactoryEnv {
  REDIS_URL?: string;
  KV_REST_API_URL?: string;
  KV_REST_API_TOKEN?: string;
  UPSTASH_REDIS_REST_URL?: string;
  UPSTASH_REDIS_REST_TOKEN?: string;
  MOCK_REDIS?: string;
}

export type RedisFactoryEnvSource = RedisFactoryEnv | NodeJS.ProcessEnv;

export function buildRedisClient(env?: RedisFactoryEnvSource): CompatibleRedis | null {
  const e = env ?? process.env;

  if (e.MOCK_REDIS === "1") {
    return new MockSocketRedis();
  }

  const url = e.REDIS_URL;
  if (url) return new SocketRedis({ url });

  const restUrl = e.KV_REST_API_URL || e.UPSTASH_REDIS_REST_URL;
  const restToken = e.KV_REST_API_TOKEN || e.UPSTASH_REDIS_REST_TOKEN;
  if (restUrl && restToken) {
    return new UpstashRedis({ url: restUrl, token: restToken });
  }

  return null;
}

/**
 * True when {@link buildRedisClient} would return a real client for this env —
 * i.e. a Redis backend is configured. Mirrors the resolution order above so
 * callers gate on the same condition the factory uses, instead of hard-coding
 * an Upstash-only `KV_REST_API_*` check that misses a TCP `REDIS_URL` deploy.
 */
export function hasRedisConfig(env?: RedisFactoryEnvSource): boolean {
  const e = env ?? process.env;
  if (e.MOCK_REDIS === "1") return true;
  if (e.REDIS_URL) return true;
  const restUrl = e.KV_REST_API_URL || e.UPSTASH_REDIS_REST_URL;
  const restToken = e.KV_REST_API_TOKEN || e.UPSTASH_REDIS_REST_TOKEN;
  return !!(restUrl && restToken);
}

/**
 * True inside workerd, where a TCP socket is bound to the I/O context of the
 * request that opened it. A module-cached client built from
 * {@link buildRedisClient} poisons the isolate there after its first request
 * ("Cannot perform I/O on behalf of a different request") — cache clients
 * ONLY when this is false; on Workers, build per call.
 */
export function isCloudflareWorkerRuntime(): boolean {
  return typeof globalThis !== "undefined" && "WebSocketPair" in globalThis;
}
