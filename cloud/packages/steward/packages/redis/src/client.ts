/**
 * Redis client singleton for Steward.
 *
 * Selects an implementation based on the `REDIS_DRIVER` env var:
 *   - "ioredis" (default)  — long-lived TCP connection via the `ioredis`
 *                            package. Used by Bun/Node entry points and
 *                            `getRedis()` returns the underlying client
 *                            unchanged for backward compatibility.
 *   - "upstash"            — HTTP-only adapter over `@upstash/redis`. Used by
 *                            Cloudflare Workers (no TCP). The adapter exposes
 *                            the subset of ioredis method shapes that the
 *                            rate-limiter, spend-tracker, policy-cache, and
 *                            auth `RedisLike` consumer rely on.
 *
 * Reading the connection URL:
 *   - ioredis : REDIS_URL (default redis://localhost:6379)
 *   - upstash : KV_REST_API_URL + KV_REST_API_TOKEN
 *               (or UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN)
 */

import { Redis as UpstashRedis } from "@upstash/redis";
import { Redis } from "ioredis";
import { createUpstashIoredisAdapter, type IoredisLike } from "./upstash-adapter.js";

export type RedisDriver = "ioredis" | "upstash";

let instance: IoredisLike | null = null;
let shutdownRegistered = false;

export function getRedisDriver(): RedisDriver {
  const raw = process.env.REDIS_DRIVER?.trim().toLowerCase();
  if (raw === "upstash") return "upstash";
  return "ioredis";
}

function buildIoredis(): Redis {
  const url = process.env.REDIS_URL || "redis://localhost:6379";
  const client = new Redis(url, {
    maxRetriesPerRequest: 3,
    retryStrategy(times: number) {
      if (times > 10) return null; // stop retrying after 10 attempts
      return Math.min(times * 200, 5000); // exponential backoff, max 5s
    },
    lazyConnect: false,
    enableReadyCheck: true,
  });

  client.on("error", (err) => {
    console.error("[steward:redis] connection error:", (err as Error).message);
  });

  client.on("connect", () => {
    console.log("[steward:redis] connected to", url.replace(/\/\/.*@/, "//***@"));
  });

  if (!shutdownRegistered) {
    shutdownRegistered = true;
    const shutdown = async () => {
      if (instance && "quit" in instance && typeof instance.quit === "function") {
        console.log("[steward:redis] shutting down connection...");
        await (instance as Redis).quit().catch(() => {});
        instance = null;
      }
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    process.on("beforeExit", shutdown);
  }

  return client;
}

function buildUpstash(): IoredisLike {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";

  if (!url || !token) {
    throw new Error(
      "REDIS_DRIVER=upstash requires KV_REST_API_URL + KV_REST_API_TOKEN " +
        "(or UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN) to be set",
    );
  }

  const upstash = new UpstashRedis({ url, token });
  console.log("[steward:redis] using upstash REST adapter");
  return createUpstashIoredisAdapter(upstash);
}

/**
 * Get the Redis client singleton.
 * Creates the connection on first call.
 */
export function getRedis(): IoredisLike {
  if (!instance) {
    const driver = getRedisDriver();
    instance = driver === "upstash" ? buildUpstash() : (buildIoredis() as unknown as IoredisLike);
  }
  return instance;
}

/**
 * Disconnect and reset the singleton (useful for tests).
 */
export async function disconnectRedis(): Promise<void> {
  if (!instance) return;
  if ("quit" in instance && typeof instance.quit === "function") {
    await (instance as Redis).quit().catch(() => {});
  }
  instance = null;
}

export type { IoredisLike };
