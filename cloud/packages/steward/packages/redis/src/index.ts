// @stwd/redis — Redis client, rate limiting, spend tracking, policy caching

export {
  disconnectRedis,
  getRedis,
  getRedisDriver,
  type IoredisLike,
  type RedisDriver,
} from "./client.js";
export type { IoredisPipelineLike } from "./upstash-adapter.js";
export { createUpstashIoredisAdapter } from "./upstash-adapter.js";
export {
  estimateCost,
  getPricingTable,
  isKnownHost,
} from "./cost-estimator.js";
export {
  type CachedPolicy,
  getCachedPolicies,
  invalidateCache,
  invalidateTenantCache,
  setCachedPolicies,
} from "./policy-cache.js";
export {
  checkRateLimit,
  getRateLimitStatus,
  type RateLimitResult,
} from "./rate-limiter.js";
export {
  checkSpendLimit,
  getSpend,
  getSpendByHost,
  recordSpend,
  type SpendPeriod,
} from "./spend-tracker.js";
