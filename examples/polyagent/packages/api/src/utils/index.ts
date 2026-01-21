/**
 * API Utilities
 *
 * Server-side utilities that require Node.js crypto module.
 * These are exported from @polyagent/api for server-side use only.
 */

export {
  generateApiKey,
  generateTestApiKey,
  hashApiKey,
  verifyApiKey,
} from "./api-keys";
export {
  checkDuplicate,
  cleanupDuplicates,
  clearAllDuplicates,
  clearDuplicates,
  DUPLICATE_DETECTION_CONFIGS,
  getDuplicateStats,
} from "./duplicate-detector";
export {
  getClientIp,
  getHashedClientIp,
  hashIpAddress,
} from "./ip-utils";

// Token counter utilities (moved from @polyagent/shared)
export {
  budgetTokens,
  countTokens,
  countTokensSync,
  getModelTokenLimit,
  getSafeContextLimit,
  MODEL_TOKEN_LIMITS,
  truncateToTokenLimit,
  truncateToTokenLimitSync,
} from "./token-counter";
