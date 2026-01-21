/**
 * Polyagent API Package
 *
 * Provides API middleware and utilities for authentication, authorization,
 * and common API patterns.
 */

// Re-export auth types from shared
export type { AuthenticatedUser } from "@polyagent/shared";
// Logger
export {
  extractErrorMessage,
  type LogData,
  Logger,
  type LogLevel,
  logger,
} from "@polyagent/shared";
// Admin Audit Logging
export {
  type AdminAuditContext,
  logAdminAction,
  logAdminDelete,
  logAdminModify,
  logAdminView,
} from "./admin-audit";
// Admin Middleware
export {
  type AuthenticatedAdminUser,
  getAdminRole,
  getAllAdmins,
  isUserAdmin,
  requireAdmin,
  requirePermission,
  requireSuperAdmin,
} from "./admin-middleware";
// Agent Authentication
export {
  type AgentSession,
  cleanupExpiredSessions,
  createAgentSession,
  getSessionDuration,
  type SessionStore,
  setSessionStore,
  verifyAgentCredentials,
  verifyAgentSession,
} from "./agent-auth";
// Auth Middleware
export {
  type AuthenticationError,
  authErrorResponse,
  authenticate,
  authenticateUser,
  authenticateWithDbUser,
  getPrivyClient,
  isAuthenticationError,
  optionalAuth,
  optionalAuthFromHeaders,
} from "./auth-middleware";
// Cache
export {
  CACHE_KEYS,
  type CacheOptions,
  cachedDb,
  clearAllCache,
  DEFAULT_TTLS,
  getCache,
  getCacheOrFetch,
  getCacheStats,
  invalidateCache,
  invalidateCachePattern,
  setCache,
  warmCache,
} from "./cache";
// Cron Authentication
export {
  cronUnauthorizedResponse,
  requireCronAuth,
  verifyCronAuth,
} from "./cron-auth";
// Development credentials (for local testing)
export {
  type DevCredentials,
  getDevAdminUser,
  getDevCredentials,
  isValidAgentSecret,
  isValidCronSecret,
  isValidDevAdminToken,
  logDevCredentials,
} from "./dev-credentials";
// Error Handler (Next.js specific)
export {
  asyncHandler,
  type ErrorHandlerOptions,
  errorHandler,
  errorResponse,
  type RouteContext,
  successResponse,
  withErrorHandling,
} from "./error-handler";
// Errors
export {
  ApiError,
  AuthenticationError as AuthError,
  AuthorizationError,
  BadRequestError,
  BusinessLogicError,
  ConflictError,
  ForbiddenError,
  InternalServerError,
  isAuthenticationError as isAuthError,
  isAuthorizationError,
  NotFoundError,
  PolyagentError,
  RateLimitError,
  ServiceUnavailableError,
  UnauthorizedError,
  ValidationError,
} from "./errors";
// Fetch utilities
export { type ApiFetchOptions, apiFetch, getPrivyAccessToken } from "./fetch";
// Linear Integration
export {
  type CreateIssueInput,
  createLinearIssue,
  type FeedbackType,
  type FeedbackUser,
  formatFeedbackForLinear,
  getLinearConfig,
  type LinearConfig,
  type LinearFeedbackData,
  type LinearIssue,
  syncFeedbackToLinear,
} from "./linear";
// Monitoring
export { cronMetrics, recordCronExecution } from "./monitoring/cron-metrics";
export * from "./monitoring/monitored-cache";
export * from "./monitoring/monitored-storage";
// Performance monitoring (moved from @polyagent/shared)
export { performanceMonitor } from "./monitoring/performance-monitor";
// Profile utilities
export {
  type BackendSignedUpdateParams,
  type BackendSignedUpdateResult,
  checkProfileUpdateRateLimit,
  getProfileUpdateHistory,
  isBackendSigningEnabled,
  logProfileUpdate,
  type ProfileMetadata,
  updateProfileBackendSigned,
  verifyBackendSignedUpdate,
} from "./profile";
// Query Parameter Utilities
export {
  createEnumValidator,
  MAX_DATE_RANGE_DAYS,
  parseDateParam,
  validateDateRange,
  validateEnum,
} from "./query-params";
// Rate Limiting
export {
  addRateLimitHeaders,
  applyDuplicateDetection,
  applyRateLimit,
  checkDuplicate,
  checkRateLimit,
  checkRateLimitAndDuplicates,
  checkRateLimitAsync,
  cleanupDuplicates,
  cleanupMemoryRateLimits,
  clearAllDuplicates,
  clearAllRateLimits,
  clearDuplicates,
  DUPLICATE_DETECTION_CONFIGS,
  duplicateContentError,
  getDuplicateStats,
  getRateLimitStatus,
  RATE_LIMIT_CONFIGS,
  rateLimitError,
  resetRateLimit,
} from "./rate-limiting";
// Realtime
export {
  generateConnectionId,
  issueRealtimeToken,
  publishEvent,
  type RealtimeChannel,
  type RealtimeEventEnvelope,
  type RealtimeTokenPayload,
  signRealtimeToken,
  toStreamKey,
  verifyRealtimeToken,
} from "./realtime";
export { connections } from "./realtime/connection-registry";
export { drainOutboxBatch, enqueueOutbox } from "./realtime/outbox";
// Redis
export {
  closeRedis,
  getRedis,
  getRedisClient,
  isRedisAvailable,
  type RedisInstance,
  redis,
  type StreamMessage,
  safePoll,
  safePublish,
  streamAdd,
  streamRead,
} from "./redis";
// Services
export * from "./services";
// SSE Event Broadcasting
export {
  type AgentActivityEvent,
  broadcastAgentActivity,
  broadcastChatMessage,
  broadcastToChannel,
  broadcastTypingIndicator,
  type CommentActivityData,
  type MessageActivityData,
  type PostActivityData,
  type TradeActivityData,
} from "./sse/event-broadcaster";
// Storage utilities (moved from @polyagent/shared)
export {
  getStorageClient,
  type UploadOptions,
  type UploadResult,
} from "./storage/s3-client";
// Swagger
export * from "./swagger";
// Types
export type { ErrorLike, JsonValue, StringRecord } from "./types";
// User management utilities
export {
  type CanonicalUser,
  type EnsureUserOptions,
  ensureUserForAuth,
  findTargetByIdentifier,
  findUserByIdentifier,
  findUserByIdentifierWithSelect,
  getCanonicalUserId,
  requireTargetByIdentifier,
  requireUserByIdentifier,
  type TargetLookupResult,
} from "./users";
// Server-side utilities (require Node.js crypto)
export {
  budgetTokens,
  // Token counter utilities (moved from @polyagent/shared)
  countTokens,
  countTokensSync,
  generateApiKey,
  generateTestApiKey,
  getClientIp,
  getHashedClientIp,
  getModelTokenLimit,
  getSafeContextLimit,
  hashApiKey,
  hashIpAddress,
  MODEL_TOKEN_LIMITS,
  truncateToTokenLimit,
  truncateToTokenLimitSync,
  verifyApiKey,
} from "./utils";
