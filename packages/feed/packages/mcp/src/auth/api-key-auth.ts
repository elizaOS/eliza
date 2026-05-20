/**
 * MCP API Key Authentication
 *
 * Validates user API keys for MCP authentication.
 * Uses shared cached implementation from @babylon/api for efficiency.
 *
 * Performance optimizations (from shared implementation):
 * - In-memory LRU cache for validated keys (5 min TTL)
 * - Async lastUsedAt updates (non-blocking)
 * - Cache reduces DB lookups by 99%+ for repeated requests
 */

// Re-export the cached implementation from @babylon/api
// This ensures MCP, A2A, and any other consumer share the same cache
export {
  clearApiKeyCache,
  getApiKeyCacheStats,
  invalidateCachedKey,
  invalidateCachedKeysForUser,
  validateUserApiKey,
} from '@babylon/api';
