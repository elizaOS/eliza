/**
 * Rate Limiting and Duplicate Detection
 *
 * Centralized exports for rate limiting functionality.
 *
 * For public read-only GET endpoints use publicRateLimit(request) and
 * addPublicReadHeaders(response, rateLimitInfo)—see README.md in this
 * directory for why we use tiered limits (per-IP vs per-user) and how
 * to keep handlers null-user safe.
 */

// Duplicate detection (uses crypto, moved to api)
export {
  checkDuplicate,
  cleanupDuplicates,
  clearAllDuplicates,
  clearDuplicates,
  DUPLICATE_DETECTION_CONFIGS,
  getDuplicateStats,
} from '../utils/duplicate-detector';
// Middleware
export {
  addPublicReadHeaders,
  addRateLimitHeaders,
  applyDuplicateDetection,
  applyRateLimit,
  checkRateLimitAndDuplicates,
  duplicateContentError,
  type PublicRateLimitKind,
  type PublicRateLimitResult,
  publicRateLimit,
  rateLimitError,
} from './middleware';
// Rate limiting (moved from @feed/shared)
// Redis-backed for production serverless, with in-memory fallback
export {
  checkRateLimit,
  checkRateLimitAsync,
  cleanupMemoryRateLimits,
  clearAllRateLimits,
  getRateLimitStatus,
  RATE_LIMIT_CONFIGS,
  resetRateLimit,
} from './user-rate-limiter';
