/**
 * One-shot, same-bundle proof that a server endpoint already accepted a token.
 *
 * Browser CustomEvent detail is intentionally not authority: arbitrary
 * same-origin JavaScript can forge it. The successful explicit session-sync
 * path records the exact token and resolved endpoint here only after its POST
 * succeeds, and AuthTokenSync consumes the marker before deciding whether it
 * needs to mirror that token to its own resolved endpoint. Any mismatch
 * invalidates the marker so it can never become stale authority after a token
 * or endpoint change.
 */

type PendingServerCookieSync = {
  endpointUrl: string;
  token: string;
};

let pendingServerCookieSync: PendingServerCookieSync | null = null;

function canonicalEndpointUrl(endpoint: string): string {
  if (typeof window === "undefined") return endpoint;
  try {
    return new URL(endpoint, window.location.href).href;
  } catch {
    // An invalid endpoint cannot accidentally match a different valid target;
    // retaining the exact string keeps the marker fail-closed.
    return endpoint;
  }
}

export function markStewardServerCookieSynced(
  token: string,
  endpoint: string,
): void {
  pendingServerCookieSync = {
    token,
    endpointUrl: canonicalEndpointUrl(endpoint),
  };
}

export function consumeStewardServerCookieSynced(
  token: string,
  endpoint: string,
): boolean {
  const matches =
    pendingServerCookieSync?.token === token &&
    pendingServerCookieSync.endpointUrl === canonicalEndpointUrl(endpoint);
  pendingServerCookieSync = null;
  return matches;
}
