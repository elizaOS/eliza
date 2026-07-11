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

const TOKEN_EXPIRED_PATTERN =
  /\b(?:token (?:has )?expired|expired[_ ]?token|oauth token (?:has )?expired|access token (?:has )?expired|token is expired|jwt expired|session expired)\b/i;

/** Returns true only for explicit access-token expiry language. */
export function isTokenExpiryText(text: string | null | undefined): boolean {
  return !!text && TOKEN_EXPIRED_PATTERN.test(text);
}

/** Refines an auth-shaped provider error without widening the auth classifier. */
export function classifyAuthFailureReason(
  text: string | null | undefined,
): CodingAuthFailureReason {
  if (!text) return "unknown";
  if (isTokenExpiryText(text)) return "token_expired";
  return "needs_reauth";
}
