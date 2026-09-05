// @stwd/redis — Redis client, rate limiting, spend tracking, policy caching

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
  type CumulativeSpendBatchGroup,
  type CumulativeSpendBatchResult,
  type CumulativeSpendCap,
  type CumulativeSpendScope,
  type CumulativeSpendSnapshot,
  type CumulativeSpendStream,
  getCumulativeSpendSum,
  getWindowedInvokeCount,
  type ReserveCumulativeSpendInput,
  type ReserveCumulativeSpendResult,
  releaseCumulativeSpend,
  releaseLegacyCumulativeSpendAfterCutover,
  releaseLegacyWindowedInvokeAfterCutover,
  releaseWindowedInvoke,
  reserveCumulativeSpend,
  reserveCumulativeSpendBatch,
  reserveWindowedInvoke,
  settleCumulativeSpend,
} from "./cumulative-spend-tracker.js";
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
