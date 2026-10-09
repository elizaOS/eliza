/** Fields of the affiliate claim response that decide the anonymous token's fate. */
export interface AffiliateClaimResult {
  success?: boolean;
  claimed?: unknown[];
  sessionRetryable?: boolean;
}

/**
 * The anonymous session token is the only way back to characters a failed
 * claim left behind, so it is released only after a claim succeeded and the
 * server explicitly finished the session. Missing metadata retains the token.
 */
export function shouldReleaseAnonSessionToken(
  result: AffiliateClaimResult,
): boolean {
  return (
    result.success === true &&
    (result.claimed?.length ?? 0) > 0 &&
    result.sessionRetryable === false
  );
}
