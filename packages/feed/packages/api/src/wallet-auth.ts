/**
 * Wallet-specific auth utilities.
 *
 * - Token freshness check: verifies the Steward JWT was issued recently
 *   (prevents using stale tokens for sensitive wallet operations).
 */

function safeDecodeJwtPayload(token: string): Record<string, number> | null {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    const payload = parts[1];
    if (!payload) return null;
    const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
    return JSON.parse(atob(padded)) as Record<string, number>;
  } catch {
    return null;
  }
}

const MAX_TOKEN_AGE_SECONDS = 300; // 5 minutes

export interface TokenFreshnessResult {
  fresh: boolean;
  ageSeconds: number;
}

/**
 * Check if a Steward JWT token was issued within the acceptable freshness window.
 * Used for wallet mutation endpoints to ensure the user recently authenticated.
 *
 * @param token - The raw Steward JWT string
 * @param maxAgeSeconds - Maximum allowed token age (default: 300 = 5 minutes)
 * @returns Object with `fresh` boolean and `ageSeconds`
 */
export function requireFreshToken(
  token: string,
  maxAgeSeconds = MAX_TOKEN_AGE_SECONDS,
): TokenFreshnessResult {
  const payload = safeDecodeJwtPayload(token);
  if (!payload?.iat) {
    return { fresh: false, ageSeconds: Infinity };
  }
  const age = Math.floor(Date.now() / 1000) - payload.iat;
  return { fresh: age <= maxAgeSeconds, ageSeconds: age };
}
