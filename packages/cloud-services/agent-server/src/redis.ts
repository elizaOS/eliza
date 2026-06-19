import { createRequire } from "node:module";
import Redis from "ioredis";
import { getRequiredEnv } from "./config";
import { logger } from "./logger";

let client: Redis | null = null;

function createMockRedis(): Redis {
  const requireCJS = createRequire(import.meta.url);
  // biome-ignore lint/suspicious/noExplicitAny: ESM/CJS interop with ioredis-mock
  const mod = requireCJS("ioredis-mock") as any;
  const Ctor = mod?.default ?? mod;
  return new Ctor() as Redis;
}

/**
 * Returns a shared ioredis client, creating one on first call.
 * Uses REDIS_URL from the environment with automatic retry and error logging.
 *
 * MOCK_REDIS=1 is an explicit opt-in for tests/CI that swaps in an in-memory
 * `ioredis-mock`. It is never used as a silent fallback — when unset, real
 * REDIS_URL credentials are still required as before.
 */
export function getRedis(): Redis {
  if (!client) {
    if (process.env.MOCK_REDIS === "1") {
      logger.info("[redis] using in-memory mock (MOCK_REDIS=1)");
      client = createMockRedis();
      return client;
    }

    client = new Redis(getRequiredEnv("REDIS_URL"), {
      maxRetriesPerRequest: 3,
      retryStrategy(times: number) {
        return Math.min(times * 200, 5000);
      },
    });
    client.on("error", (err: Error) =>
      logger.error("Redis error", { error: err.message }),
    );
  }
  return client;
}
