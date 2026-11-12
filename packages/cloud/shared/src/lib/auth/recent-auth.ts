/** Pure recent-auth policy for destructive account and ownership operations. */

import type { StewardTokenClaims } from "./steward-client";

export function isRecentDestructiveAuth(input: {
  claims: StewardTokenClaims | null;
  expectedStewardUserId: string | null;
  nowSeconds: number;
  maxAgeSeconds: number;
  allowStagingSession: boolean;
}): boolean {
  const { claims } = input;
  if (!claims || !input.expectedStewardUserId) return false;
  // auth_time survives re-mints and refresh rotation; iat does not. Sessions
  // signed before auth_time existed fall back to iat until they expire.
  const authenticatedAt = claims.authTime ?? claims.issuedAt;
  const ageSeconds = input.nowSeconds - authenticatedAt;
  const stagingSessionAllowed = input.allowStagingSession && Boolean(claims.stagingSessionBinding);
  return (
    claims.userId === input.expectedStewardUserId &&
    claims.bridged !== true &&
    authenticatedAt > 0 &&
    ageSeconds >= -30 &&
    ageSeconds <= input.maxAgeSeconds &&
    (stagingSessionAllowed || Boolean(claims.authMethod))
  );
}
