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

const TOKEN_EXPIRED_PATTERN =
  /\b(?:token[_ ](?:(?:has|is)[_ ])?expired|expired[_ ]?token|(?:oauth|access)[_ ]token[_ ](?:(?:has|is)[_ ])?expired|jwt[_ ]expired|session[_ ]expired)\b/i;

const RATE_LIMITED_PATTERN =
  /\b(?:rate[_ -]?limits?(?:[_ -]?(?:exceeded|reached|violation))?|rate[_ -]?limited|rate[_ -]?limiting|too[_ -]?many[_ -]?requests|429\b|quota[_ -]?(?:exceeded|reached)|resource[_ -]?exhausted|usage[_ -]?(?:limit|exceeded|reached)|credit[_ -]?(?:limit|exceeded|exhausted))\b/i;

/** Returns true for explicit REFRESH-token expiry language — a genuinely
 * dead credential (the holder can no longer self-refresh), distinct from a
 * recoverable access-token expiry. */
export function isRefreshTokenExpiryText(
  text: string | null | undefined,
): boolean {
  return !!text && REFRESH_TOKEN_EXPIRED_PATTERN.test(text);
}

/** Returns true only for explicit access-token expiry language. */
export function isTokenExpiryText(text: string | null | undefined): boolean {
  return (
    !!text &&
    !REFRESH_TOKEN_EXPIRED_PATTERN.test(text) &&
    TOKEN_EXPIRED_PATTERN.test(text)
  );
}

/** Returns true for explicit rate-limiting language. */
export function isRateLimitText(text: string | null | undefined): boolean {
  return !!text && RATE_LIMITED_PATTERN.test(text);
}

/** Refines an auth-shaped provider error without widening the auth classifier. */
export function classifyAuthFailureReason(
  text: string | null | undefined,
): CodingAuthFailureReason {
  if (!text || text.trim().length === 0) return "unknown";
  if (isTokenExpiryText(text)) return "token_expired";
  if (isRateLimitText(text)) return "rate_limited";
  return "needs_reauth";
}
