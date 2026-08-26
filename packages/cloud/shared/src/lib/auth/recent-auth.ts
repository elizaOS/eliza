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
  const ageSeconds = input.nowSeconds - claims.issuedAt;
  const stagingSessionAllowed = input.allowStagingSession && Boolean(claims.stagingSessionBinding);
  return (
    claims.userId === input.expectedStewardUserId &&
    claims.bridged !== true &&
    claims.issuedAt > 0 &&
    ageSeconds >= -30 &&
    ageSeconds <= input.maxAgeSeconds &&
    (stagingSessionAllowed || Boolean(claims.authMethod))
  );
}
