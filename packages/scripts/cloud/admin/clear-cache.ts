#!/usr/bin/env bun
/**
 * Clear Redis cache for local development.
 * Works with both local Redis and Upstash.
 *
 * Usage:
 *   bun run cache:clear           # Clear all cache
 *   bun run cache:clear auth      # Clear auth-related cache only
 *   bun run cache:clear session   # Clear session cache only
 */

import { loadEnvFiles } from "./local-dev-helpers";

loadEnvFiles();

import { Redis as UpstashRedis } from "@upstash/redis";
import { createClient } from "redis";

const redisUrl = process.env.REDIS_URL || process.env.KV_URL;
const restUrl = process.env.KV_REST_API_URL;
const restToken = process.env.KV_REST_API_TOKEN;

const pattern = process.argv[2];

async function clearWithNodeRedis(url: string) {
  const redis = createClient({ url });
  await redis.connect();

  if (pattern) {
    const patterns: Record<string, string[]> = {
      auth: ["session:*", "proxy:auth:*", "steward:*"],
      session: ["session:*"],
      org: ["org:*"],
      analytics: ["analytics:*"],
    };

    const toDelete = patterns[pattern];
    if (!toDelete) {
      console.log(`Unknown pattern: ${pattern}`);
      console.log(`Available: ${Object.keys(patterns).join(", ")}`);
      process.exit(1);
    }

    for (const p of toDelete) {
      let cursor = "0";
      let deleted = 0;
      do {
        const { cursor: nextCursor, keys } = await redis.scan(cursor, {
          MATCH: p,
          COUNT: 100,
        });
        cursor = nextCursor;
        if (keys.length > 0) {
          await redis.del(keys);
          deleted += keys.length;
        }
      } while (cursor !== "0");
      console.log(`✓ Deleted ${deleted} keys matching "${p}"`);
    }
  } else {
    await redis.flushAll();
    console.log("✓ Cleared all cache");
  }

  await redis.quit();
}

async function clearWithUpstash(url: string, token: string) {
  const redis = new UpstashRedis({ url, token });

  if (pattern) {
    console.log("Pattern-based clearing not fully supported with Upstash REST API.");
    console.log("Use FLUSHALL for full clear or switch to local Redis.");
    process.exit(1);
  }

  await redis.flushall();
  console.log("✓ Cleared all cache (Upstash)");
}

async function main() {
  console.log("🧹 Clearing Redis cache...\n");
  console.log(`REDIS_URL: ${redisUrl?.slice(0, 30)}...`);

  // Prioritize native Redis (local development)
  if (redisUrl?.startsWith("redis://")) {
    console.log("Using local Redis (node-redis)\n");
    await clearWithNodeRedis(redisUrl);
  } else if (redisUrl?.startsWith("rediss://localhost")) {
    console.log("Using local Redis with TLS (node-redis)\n");
    await clearWithNodeRedis(redisUrl);
  } else if (restUrl && restToken) {
    console.log("Using Upstash REST API\n");
    await clearWithUpstash(restUrl, restToken);
  } else if (redisUrl) {
    console.log("Using Upstash via REDIS_URL\n");
    await clearWithUpstash(process.env.KV_REST_API_URL || "", process.env.KV_REST_API_TOKEN || "");
  } else {
    console.error("No Redis configuration found!");
    console.error("Set REDIS_URL=redis://localhost:6379 for local or configure Upstash.");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Failed to clear cache:", err);
  process.exit(1);
});
