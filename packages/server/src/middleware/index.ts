/**
 * Consolidated middleware for the ElizaOS server
 * All middleware is organized into logical modules for better maintainability
 */

// Authentication middleware
export { apiKeyAuthMiddleware, type ApiKeyAuthRequest } from './api-key';
export {
  createEntityAuthMiddleware,
  jwtAuthMiddleware,
  requireJWT,
  getInternalServiceSecret,
  type AuthenticatedRequest,
} from './entity-auth';

// Security middleware
export { securityMiddleware } from './security';

// Rate limiting middleware
export {
  createApiRateLimit,
  createFileSystemRateLimit,
  createUploadRateLimit,
  createChannelValidationRateLimit,
} from './rate-limit';

// Validation middleware
export {
  agentExistsMiddleware,
  validateUuidMiddleware,
  validateChannelIdMiddleware,
  validateContentTypeMiddleware,
} from './validation';
