/**
 * API Services
 *
 * @module api/services
 *
 * @description
 * Infrastructure and API-related services for user management, notifications, and system operations.
 */

export * from './achievement-service';
// Keep Solana registration service out of this barrel so lightweight routes
// importing @feed/api do not pull Solana SDK dependencies into shared Lambdas.
// Claude LLM Service
export * from './claude-service';
export * from './cron-relay-service';
// Daily Login Service (BAB-88)
export * from './daily-login-service';
// Distributed Lock Service
export {
  DistributedLockService,
  type LockOptions,
} from './distributed-lock-service';
// Event Cache Service (Redis-backed event lookup)
export * from './event-cache-service';
// Feedback Service
export * from './feedback-service';
// Generation Lock Service
export * from './generation-lock-service';
export * from './leaderboard-types';
export * from './market-reputation-service';
export * from './model-pilot-inquiry-email-service';
// Moderation Services
export * from './moderation';
export * from './nft-chat-gating-service';
export * from './nft-group-service';
export * from './nft-indexer-service';
export * from './nft-mint-service';
export * from './nft-verification-service';
export * from './notification-email-service';
export * from './notification-service';
// Org Coordination Service (Cross-NPC messaging coordination)
export * from './org-coordination-service';
export * from './participation-service';
export * from './points-service';
export * from './referral-service';
export * from './reputation-service';
// Resource-Level Locks (question, market, NPC)
export {
  isQuestionLocked,
  withMarketLock,
  withNPCLock,
  withQuestionLock,
} from './resource-locks';
export * from './sentry-webhook-inbox-service';
export * from './system-status-service';
export * from './trading-balance-funding-service';
export * from './trading-balance-transfer-service';
export * from './trading-leaderboard-service';
export * from './trading-performance-service';
export * from './waitlist-service';
export * from './whitelist-service';
