/**
 * Shared classifier for access-token expiry phrases emitted by provider and
 * coding-agent auth failures. It only recognizes explicit expiry language; a
 * bare 401 or unauthorized response can be revoked credentials and must be
 * handled by the caller's broader auth classifier.
 */

/** UI-facing reason derived after a failure is already known to be auth-shaped. */
export type CodingAuthFailureReason =
  | "token_expired"
  | "needs_reauth"
  | "rate_limited"
  | "unknown";

const REFRESH_TOKEN_EXPIRED_PATTERN =
  /\brefresh[_ ]token[_ ](?:(?:has|is)[_ ])?expired\b/i;

/**
 * True for explicit REFRESH-token expiry language. A refresh-token expiry is a
 * genuinely dead credential (the holder can no longer self-refresh), so it is
 * auth-shaped but must NOT be treated as the benign injected-access-token
 * "token_expired" recovery — callers use this to keep the failure typed as
 * needs-reauth instead of dropping it entirely.
 */
export function isRefreshTokenExpiryText(
  text: string | null | undefined,
): boolean {
  return !!text && REFRESH_TOKEN_EXPIRED_PATTERN.test(text);
}
const TOKEN_EXPIRED_PATTERN =
  /\b(?:token[_ ](?:(?:has|is)[_ ])?expired|expired[_ ]?token|(?:oauth|access)[_ ]token[_ ](?:(?:has|is)[_ ])?expired|jwt[_ ]expired|session[_ ]expired)\b/i;

/** Returns true only for explicit access-token expiry language. */
export function isTokenExpiryText(text: string | null | undefined): boolean {
  return (
    !!text &&
    !REFRESH_TOKEN_EXPIRED_PATTERN.test(text) &&
    TOKEN_EXPIRED_PATTERN.test(text)
  );
}

/** Refines an auth-shaped provider error without widening the auth classifier. */
export function classifyAuthFailureReason(
  text: string | null | undefined,
): CodingAuthFailureReason {
  if (!text || text.trim().length === 0) return "unknown";
  if (isTokenExpiryText(text)) return "token_expired";
  return "needs_reauth";
}
