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
 *   - ioredis : REDIS_URL (default redis://localhost:6379). In production the
 *               URL must use rediss:// (TLS) unless it points at localhost or
 *               STEWARD_ALLOW_INSECURE_REDIS=true is set (assertRedisUrlTls).
 *   - upstash : KV_REST_API_URL + KV_REST_API_TOKEN
 *               (or UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN).
 *               In production the REST URL must be https:// — the REST token
 *               rides every request, so http:// exposes it cleartext — unless
 *               it targets localhost or STEWARD_ALLOW_INSECURE_REDIS=true is
 *               set (assertUpstashRestUrlTls).
 */

import { ElizaError, logger } from "@elizaos/core";
import { Redis as UpstashRedis } from "@upstash/redis";
import { Redis } from "ioredis";
import {
  createUpstashIoredisAdapter,
  type IoredisLike,
} from "./upstash-adapter.js";

export type RedisDriver = "ioredis" | "upstash";

let instance: IoredisLike | null = null;

/**
 * Refuse to start in production if REDIS_URL is not using TLS (rediss://).
 * Redis carries spend-limit state, rate-limit state, policy cache, and auth KV
 * (SIWE nonces), so a cleartext link lets a network-positioned attacker read
 * and tamper with enforcement data. Localhost connections are exempt. Set
 * STEWARD_ALLOW_INSECURE_REDIS=true to override for private-network
 * deployments (logs a loud warning), matching the STEWARD_ALLOW_INSECURE_DB
 * posture in server/db.
 */
export function assertRedisUrlTls(
  url: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (env.NODE_ENV !== "production") return;

  const allowInsecure = env.STEWARD_ALLOW_INSECURE_REDIS === "true";
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    if (allowInsecure) {
      logger.warn(
        {
          details: [
            "[steward:redis] WARNING: STEWARD_ALLOW_INSECURE_REDIS=true — REDIS_URL is not a valid URL, so TLS cannot be verified.",
          ],
        },
        "[Login:client] warn",
      );
      return;
    }
    throw new Error(
      "REDIS_URL must be a valid URL so TLS settings can be verified in production",
    );
  }

  if (parsed.protocol === "rediss:") return;
  if (parsed.protocol !== "redis:") {
    throw new Error("REDIS_URL must use the redis:// or rediss:// scheme");
  }

  const host = parsed.hostname.toLowerCase();
  // URL.hostname keeps the brackets on IPv6 literals ([::1]).
  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]"
  )
    return;

  if (allowInsecure) {
    logger.warn(
      {
        details: [
          "[steward:redis] WARNING: STEWARD_ALLOW_INSECURE_REDIS=true — REDIS_URL is cleartext redis://. " +
            "This is only safe on a private network. SOC2 CC6.7 requires encryption in transit.",
        ],
      },
      "[Login:client] warn",
    );
    return;
  }

  throw new Error(
    "REDIS_URL must use rediss:// (TLS) in production. " +
      "Set STEWARD_ALLOW_INSECURE_REDIS=true to override for private-network deployments.",
  );
}

/**
 * SEC-032, upstash path: the Upstash REST token authenticates every request,
 * so a cleartext http:// endpoint exposes it (and lets a network-positioned
 * attacker read/tamper with spend-limit, rate-limit, and auth KV state) even
 * though the ioredis path is TLS-asserted. In production require https://
 * unless the endpoint is loopback; STEWARD_ALLOW_INSECURE_REDIS=true overrides
 * (loud warning), matching assertRedisUrlTls.
 */
export function assertUpstashRestUrlTls(
  url: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const allowInsecure = env.STEWARD_ALLOW_INSECURE_REDIS === "true";
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(
      "KV_REST_API_URL must be a valid URL so TLS settings can be verified in production",
    );
  }

  if (parsed.protocol !== "http:") {
    if (parsed.protocol !== "https:") {
      throw new Error(
        "KV_REST_API_URL must use the http:// or https:// scheme",
      );
    }
    return;
  }

  if (env.NODE_ENV !== "production") return;
  const host = parsed.hostname.toLowerCase();
  // URL.hostname keeps the brackets on IPv6 literals ([::1]).
  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]"
  )
    return;

  if (allowInsecure) {
    logger.warn(
      {
        details: [
          "[steward:redis] WARNING: STEWARD_ALLOW_INSECURE_REDIS=true — Upstash REST URL is cleartext http://. " +
            "The REST token crosses the network unencrypted. This is only safe on a private network. " +
            "SOC2 CC6.7 requires encryption in transit.",
        ],
      },
      "[Login:client] warn",
    );
    return;
  }

  throw new Error(
    "KV_REST_API_URL must use https:// in production — the Upstash REST token would otherwise cross the network in cleartext. " +
      "Set STEWARD_ALLOW_INSECURE_REDIS=true to override for private-network deployments.",
  );
}

export function getRedisDriver(): RedisDriver {
  const raw = process.env.REDIS_DRIVER?.trim().toLowerCase();
  if (raw === "upstash") return "upstash";
  return "ioredis";
}

function buildIoredis(): Redis {
  const url = process.env.REDIS_URL || "redis://localhost:6379";
  assertRedisUrlTls(url);
  const client = new Redis(url, {
    maxRetriesPerRequest: 3,
    retryStrategy(times: number) {
      if (times > 10) return null; // stop retrying after 10 attempts
      return Math.min(times * 200, 5000); // exponential backoff, max 5s
    },
    lazyConnect: false,
    enableReadyCheck: true,
  });

  client.on("error", (_err) => {
    // Redis client errors can embed the configured URL (including its
    // password). Keep diagnostics fixed in this low-level package, which must
    // not depend on the shared logging layer.
    logger.error(
      { details: ["[steward:redis] connection error"] },
      "[Login:client] error",
    );
  });

  client.on("connect", () => {
    logger.info(
      {
        details: [
          "[steward:redis] connected to",
          url.replace(/\/\/.*@/, "//***@"),
        ],
      },
      "[Login:client] info",
    );
  });

  return client;
}

function buildUpstash(): IoredisLike {
  const url =
    process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
  const token =
    process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";

  if (!url || !token) {
    throw new Error(
      "REDIS_DRIVER=upstash requires KV_REST_API_URL + KV_REST_API_TOKEN " +
        "(or UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN) to be set",
    );
  }

  // SEC-032: same TLS posture as the ioredis path — the REST token rides every
  // request, so a cleartext http:// endpoint in production is fail-closed.
  assertUpstashRestUrlTls(url);

  const upstash = new UpstashRedis({ url, token });
  logger.info(
    { details: ["[steward:redis] using upstash REST adapter"] },
    "[Login:client] info",
  );
  return createUpstashIoredisAdapter(upstash);
}

/**
 * Get the Redis client singleton.
 * Creates the connection on first call.
 */
export function getRedis(): IoredisLike {
  if (!instance) {
    const driver = getRedisDriver();
    instance =
      driver === "upstash"
        ? buildUpstash()
        : (buildIoredis() as unknown as IoredisLike);
  }
  return instance;
}

/**
 * Disconnect and reset the singleton (useful for tests).
 */
export async function disconnectRedis(): Promise<void> {
  const owned = instance;
  instance = null;
  if (!(owned instanceof Redis)) return; // REST adapters own no socket.
  if (owned.status !== "ready") {
    // QUIT would enter the offline queue and reconnect a failed startup client.
    owned.disconnect();
    return;
  }
  try {
    await owned.quit();
  } catch (cause) {
    owned.disconnect();
    throw new ElizaError("Unable to close the login Redis connection cleanly", {
      code: "LOGIN_REDIS_SHUTDOWN_FAILED",
      cause,
    });
  }
}

export type { IoredisLike };
