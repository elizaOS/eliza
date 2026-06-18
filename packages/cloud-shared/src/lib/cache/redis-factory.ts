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

// MockSocketRedis is duck-typed to SocketRedis; expose it as such so callers
// don't need to widen their type signatures.
export type CompatibleRedis = SocketRedis | UpstashRedis;

export interface RedisFactoryEnv {
  REDIS_URL?: string;
  KV_REST_API_URL?: string;
  KV_REST_API_TOKEN?: string;
  UPSTASH_REDIS_REST_URL?: string;
  UPSTASH_REDIS_REST_TOKEN?: string;
  MOCK_REDIS?: string;
}

export function buildRedisClient(env?: RedisFactoryEnv): CompatibleRedis | null {
  const e = env ?? (process.env as RedisFactoryEnv);

  if (e.MOCK_REDIS === "1") {
    return new MockSocketRedis() as unknown as SocketRedis;
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
export function hasRedisConfig(env?: RedisFactoryEnv): boolean {
  const e = env ?? (process.env as RedisFactoryEnv);
  if (e.MOCK_REDIS === "1") return true;
  if (e.REDIS_URL) return true;
  const restUrl = e.KV_REST_API_URL || e.UPSTASH_REDIS_REST_URL;
  const restToken = e.KV_REST_API_TOKEN || e.UPSTASH_REDIS_REST_TOKEN;
  return !!(restUrl && restToken);
}
