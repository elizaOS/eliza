/**
 * Barrel for the P0 auth subsystem.
 *
 * Consumers should import from here rather than reaching into the individual
 * module files; this keeps the public surface explicit and lets us reshape
 * internals during P1+ without rippling through callers.
 */

export {
  appendAuditEvent,
  AUDIT_LOG_FILENAME,
  AUDIT_LOG_MAX_BYTES,
  AUDIT_LOG_ROTATE_FILENAME,
  AUDIT_REDACTION_RE,
  redactMetadata,
  resolveAuditLogPath,
  resolveAuditLogRotatedPath,
  type AuditEmitterOptions,
  type AuditEventInput,
} from "./audit";
export {
  BOOTSTRAP_TOKEN_ALG,
  BOOTSTRAP_TOKEN_SCOPE,
  type BootstrapTokenClaims,
  type VerifyBootstrapFailureReason,
  type VerifyBootstrapResult,
  verifyBootstrapToken,
} from "./bootstrap-token";
export {
  _resetSensitiveLimiters,
  bootstrapExchangeLimiter,
  SENSITIVE_RATE_LIMIT_MAX,
  SENSITIVE_RATE_LIMIT_WINDOW_MS,
} from "./sensitive-rate-limit";
