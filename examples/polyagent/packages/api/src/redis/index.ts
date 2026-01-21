/**
 * Redis Module Exports
 *
 * @description Exports Redis client and utilities for use across the application.
 */

export {
  closeRedis,
  getRedis,
  getRedisClient,
  isRedisAvailable,
  type RedisInstance,
  redis,
  safePoll,
  safePublish,
} from "./client";

export { type StreamMessage, streamAdd, streamRead } from "./streams";
