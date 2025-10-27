/**
 * @deprecated This file is deprecated. Import from '../../middleware' instead.
 * This file is kept for backward compatibility only.
 *
 * All middleware has been consolidated into packages/server/src/middleware/
 */

// Re-export everything from the new consolidated middleware location
export {
  apiKeyAuthMiddleware,
  securityMiddleware,
  createApiRateLimit,
  createFileSystemRateLimit,
  createUploadRateLimit,
  createChannelValidationRateLimit,
  agentExistsMiddleware,
  validateUuidMiddleware,
  validateChannelIdMiddleware,
  validateContentTypeMiddleware,
} from '../../middleware';
