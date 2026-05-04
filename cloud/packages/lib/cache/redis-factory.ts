/**
 * Single factory for the Upstash-shaped Redis client used across the
 * codebase (rate limiters, credit events, agent gateway relay, A2A task
 * store, generic cache).
 *
 * Resolution order:
 *   1. `REDIS_URL` (or per-bindings env)  → `SocketRedis` (RESP2 over
 *      `cloudflare:sockets` in Workers, or `node:net` in Bun/Node).
 *   2. `KV_REST_API_URL` + `KV_REST_API_TOKEN` → `@upstash/redis` REST
 *      client (legacy fallback; kept so existing Upstash deploys still work).
 *   3. null — caller decides what to do.
 */

import { Redis as UpstashRedis } from "@upstash/redis";
import { SocketRedis } from "@/lib/cache/socket-redis";

export type CompatibleRedis = SocketRedis | UpstashRedis;

export interface RedisFactoryEnv {
  REDIS_URL?: string;
  KV_REST_API_URL?: string;
  KV_REST_API_TOKEN?: string;
  UPSTASH_REDIS_REST_URL?: string;
  UPSTASH_REDIS_REST_TOKEN?: string;
}

export function buildRedisClient(env?: RedisFactoryEnv): CompatibleRedis | null {
  const e = env ?? (process.env as RedisFactoryEnv);

  const url = e.REDIS_URL;
  if (url) return new SocketRedis({ url });

  const restUrl = e.KV_REST_API_URL || e.UPSTASH_REDIS_REST_URL;
  const restToken = e.KV_REST_API_TOKEN || e.UPSTASH_REDIS_REST_TOKEN;
  if (restUrl && restToken) {
    return new UpstashRedis({ url: restUrl, token: restToken });
  }

  return null;
}
