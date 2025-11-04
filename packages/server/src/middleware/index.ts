/**
 * Consolidated middleware for the ElizaOS server
 * All middleware is organized into logical modules for better maintainability
 */

// Authentication middleware
export { apiKeyAuthMiddleware } from './auth';

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

// x402 Payment middleware
// Note: PaymentEnabledRoute, X402Config, Network, X402ValidationResult, and X402RequestValidator
// are exported from @elizaos/core so plugins can use them without depending on server
export {
  applyPaymentProtection,
  createPaymentAwareHandler,
  type PaymentEnabledRoute,
  type X402ValidationResult,
  type X402RequestValidator,
  type X402Response,
  type Accepts,
  PAYMENT_CONFIGS,
  getPaymentConfig
} from './x402';
