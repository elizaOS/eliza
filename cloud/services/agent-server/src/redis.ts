import Redis from "ioredis";
import { logger } from "./logger";

let client: Redis | null = null;

/**
 * Returns a shared ioredis client, creating one on first call.
 * Uses REDIS_URL from the environment with automatic retry and error logging.
 */
export function getRedis(): Redis {
  if (!client) {
    client = new Redis(process.env.REDIS_URL!, {
      maxRetriesPerRequest: 3,
      retryStrategy(times: number) {
        return Math.min(times * 200, 5000);
      },
    });
    client.on("error", (err: Error) => logger.error("Redis error", { error: err.message }));
  }
  return client;
}
