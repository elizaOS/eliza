/**
 * API Utilities
 *
 * Server-side utilities that require Node.js crypto module.
 * These are exported from @babylon/api for server-side use only.
 */

export {
  flushLastUsedUpdates,
  getFlusherStats,
  shutdownLastUsedFlusher,
  startLastUsedFlusher,
  stopLastUsedFlusher,
} from './api-key-lastused-flusher';
export {
  clearApiKeyCache,
  generateApiKey,
  generateTestApiKey,
  getApiKeyCacheStats,
  hashApiKey,
  invalidateCachedKey,
  invalidateCachedKeysForUser,
  validateUserApiKey,
  verifyApiKey,
} from './api-keys';
export {
  checkDuplicate,
  cleanupDuplicates,
  clearAllDuplicates,
  clearDuplicates,
  DUPLICATE_DETECTION_CONFIGS,
  getDuplicateStats,
} from './duplicate-detector';
export {
  type DeploymentEnvironment,
  getDeploymentEnvironment,
} from './environment';
export { escapeHtml } from './html';
export {
  getClientIp,
  getHashedClientIp,
  hashIpAddress,
} from './ip-utils';

// Token counter utilities (moved from @babylon/shared)
export {
  budgetTokens,
  countTokens,
  countTokensSync,
  getModelTokenLimit,
  getSafeContextLimit,
  MODEL_TOKEN_LIMITS,
  truncateToTokenLimit,
  truncateToTokenLimitSync,
} from './token-counter';
