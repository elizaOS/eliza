/**
 * Utility exports for the ElizaOS server
 */

// Circuit breaker
export {
  createCircuitBreaker,
  dbCircuitBreaker,
  CircuitBreaker,
  type CircuitBreakerConfig,
} from './circuit-breaker';

// Media transformer
export { attachmentsToApiUrls, transformMessageAttachments } from './media-transformer';

// RLS validation
export { validateServerIdForRls } from './rls-validation';

// Upload utilities
export {
  generateSecureFilename,
  ensureUploadDir,
  agentAudioUpload,
  agentMediaUpload,
  channelUpload,
  genericUpload,
  upload,
  validateAudioFile,
  validateMediaFile,
  processUploadedFile,
} from './upload';

// Config utilities
export {
  DEFAULT_SERVER_ID,
  expandTildePath,
  resolvePgliteDir,
  isWebUIEnabled,
  type ServerMiddleware,
  type ServerConfig,
} from './config';
