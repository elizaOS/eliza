/**
 * One-shot, same-bundle proof that the server cookie already accepted a token.
 *
 * Browser CustomEvent detail is intentionally not authority: arbitrary
 * same-origin JavaScript can forge it. The successful explicit session-sync
 * path records the exact token here only after its POST succeeds, and
 * AuthTokenSync consumes the marker before deciding whether it needs to mirror
 * that token again. A mismatch invalidates the marker so it can never become
 * stale authority after a subsequent token change.
 */

let pendingServerCookieToken: string | null = null;

export function markStewardServerCookieSynced(token: string): void {
  pendingServerCookieToken = token;
}

export function consumeStewardServerCookieSynced(token: string): boolean {
  const matches = pendingServerCookieToken === token;
  pendingServerCookieToken = null;
  return matches;
}
