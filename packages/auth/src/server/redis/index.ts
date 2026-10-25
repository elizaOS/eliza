/** Exposes Redis connections, rate limits, transaction spend and policy caches. */

export {
  type AggregationEvent,
  type AggregationMetricFamily,
  type AggregationScope,
  type AggregationSnapshotQuery,
  getAggregationSnapshot,
  recordAggregationEvent,
} from "./aggregation-tracker.js";
export {
  assertRedisUrlTls,
  assertUpstashRestUrlTls,
  disconnectRedis,
  getRedis,
  getRedisDriver,
  type IoredisLike,
  type RedisDriver,
} from "./client.js";
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
  reserveSpend,
  type SpendLimitSnapshot,
  type SpendPeriod,
  type SpendReservation,
  settleReservedSpend,
} from "./spend-tracker.js";
export type { IoredisPipelineLike } from "./upstash-adapter.js";
export { createUpstashIoredisAdapter } from "./upstash-adapter.js";
