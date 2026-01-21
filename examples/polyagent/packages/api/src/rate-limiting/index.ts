/**
 * Rate Limiting and Duplicate Detection
 *
 * Centralized exports for rate limiting functionality
 */

// Duplicate detection (uses crypto, moved to api)
export {
  checkDuplicate,
  cleanupDuplicates,
  clearAllDuplicates,
  clearDuplicates,
  DUPLICATE_DETECTION_CONFIGS,
  getDuplicateStats,
} from "../utils/duplicate-detector";
// Middleware
export {
  addRateLimitHeaders,
  applyDuplicateDetection,
  applyRateLimit,
  checkRateLimitAndDuplicates,
  duplicateContentError,
  rateLimitError,
} from "./middleware";
// Rate limiting (moved from @polyagent/shared)
// Redis-backed for production serverless, with in-memory fallback
export {
  checkRateLimit,
  checkRateLimitAsync,
  cleanupMemoryRateLimits,
  clearAllRateLimits,
  getRateLimitStatus,
  RATE_LIMIT_CONFIGS,
  resetRateLimit,
} from "./user-rate-limiter";
