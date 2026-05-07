/**
 * Barrel for the P0 auth subsystem.
 *
 * Consumers should import from here rather than reaching into the individual
 * module files; this keeps the public surface explicit and lets us reshape
 * internals during P1+ without rippling through callers.
 */

export {
  AUDIT_LOG_FILENAME,
  AUDIT_LOG_MAX_BYTES,
  AUDIT_LOG_ROTATE_FILENAME,
  AUDIT_REDACTION_RE,
  type AuditEmitterOptions,
  type AuditEventInput,
  appendAuditEvent,
  redactMetadata,
  resolveAuditLogPath,
  resolveAuditLogRotatedPath,
} from "./audit";
export {
  type AuthContextSource,
  type EnsureSessionOptions,
  ensureSessionForRequest,
  type ResolvedAuthContext,
} from "./auth-context";
export {
  BOOTSTRAP_TOKEN_ALG,
  BOOTSTRAP_TOKEN_SCOPE,
  type BootstrapTokenClaims,
  type VerifyBootstrapFailureReason,
  type VerifyBootstrapResult,
  verifyBootstrapToken,
} from "./bootstrap-token";
export {
  ARGON2_PARAMS,
  assertPasswordStrong,
  hashPassword,
  PASSWORD_MIN_LENGTH,
  type PasswordStrengthFailureReason,
  verifyPassword,
  WeakPasswordError,
} from "./passwords";
export {
  _resetSensitiveLimiters,
  bootstrapExchangeLimiter,
  getSensitiveLimiter,
  SENSITIVE_RATE_LIMIT_MAX,
  SENSITIVE_RATE_LIMIT_WINDOW_MS,
} from "./sensitive-rate-limit";
export {
  BROWSER_SESSION_REMEMBER_CAP_MS,
  BROWSER_SESSION_TTL_MS,
  type CreateBrowserSessionOptions,
  type CreateMachineSessionOptions,
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  createBrowserSession,
  createMachineSession,
  deriveCsrfToken,
  findActiveSession,
  MACHINE_SESSION_TTL_MS,
  parseCookieHeader,
  parseSessionCookie,
  revokeAllSessionsForIdentity,
  revokeSession,
  SESSION_COOKIE_NAME,
  type SessionWithCsrf,
  serializeCsrfCookie,
  serializeCsrfExpiryCookie,
  serializeSessionCookie,
  serializeSessionExpiryCookie,
  verifyCsrfToken,
} from "./sessions";
