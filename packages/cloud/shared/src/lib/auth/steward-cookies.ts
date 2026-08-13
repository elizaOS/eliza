/**
 * Environment-scoped Steward auth cookie names.
 *
 * Steward sessions are host-only (see `cookie-domain.ts`) and transferred
 * between public and managed-app hosts only through the one-time SSO bridge.
 * Environment suffixes remain for compatibility with existing deployments and
 * to keep preview/staging cookie state unambiguous.
 */

import { getCookieValueFromHeader } from "../http/cookie-header";

export interface StewardCookieNames {
  token: string;
  refreshToken: string;
  authed: string;
}

const BASE_TOKEN = "steward-token";
const BASE_REFRESH = "steward-refresh-token";
const BASE_AUTHED = "steward-authed";

/**
 * The historical unsuffixed names. Production keeps them for compatibility.
 * Non-production uses suffixed names so previews and older deployments cannot
 * accidentally interpret a different environment's browser state.
 */
export const LEGACY_STEWARD_COOKIES: StewardCookieNames = {
  token: BASE_TOKEN,
  refreshToken: BASE_REFRESH,
  authed: BASE_AUTHED,
};

/**
 * Whether this Worker may mutate the historical unsuffixed cookie names.
 * Production owns those names and clears/rotates them; non-production must not
 * mutate them. Host-only cookies now isolate canonical deployments, while this
 * rule preserves compatibility with older and preview host layouts.
 */
export function canMutateLegacyStewardCookies(environment: string | undefined): boolean {
  return !environment || environment === "production";
}

/** Resolve the cookie names for a Worker environment (`c.env.ENVIRONMENT`).
 * Unset (local dev / tests) behaves as production: localhost cookies are
 * host-scoped (no shared parent zone), so there is nothing to collide with. */
export function stewardCookieNames(environment: string | undefined): StewardCookieNames {
  if (!environment || environment === "production") {
    return LEGACY_STEWARD_COOKIES;
  }
  return {
    token: `${BASE_TOKEN}-${environment}`,
    refreshToken: `${BASE_REFRESH}-${environment}`,
    authed: `${BASE_AUTHED}-${environment}`,
  };
}

/**
 * Read this environment's Steward access cookie. Each environment reads only
 * its own scoped cookie — non-production never reads the historical unsuffixed
 * cookie. The bounded read-only migration window that allowed non-production
 * environments to fall back to the historical unsuffixed access cookie is
 * closed; callers verify the access JWT but do not rotate or clear legacy
 * cookies in non-production.
 */
export function readStewardAccessCookieFromHeader(
  cookieHeader: string | null,
  environment: string | undefined,
): string | undefined {
  const names = stewardCookieNames(environment);
  return getCookieValueFromHeader(cookieHeader, names.token);
}
