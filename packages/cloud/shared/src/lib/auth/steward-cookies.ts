/**
 * Environment-scoped Steward auth cookie names.
 *
 * Every elizacloud.ai environment shares the parent-zone cookie domain (see
 * `cookie-domain.ts`) so sibling subdomains (staging. + api-staging., apex +
 * api.) can ride one session — which also meant production and staging fought
 * over a SINGLE `steward-refresh-token` slot. Refresh tokens rotate on every
 * refresh, so whichever environment refreshed last overwrote the other's live
 * refresh token; the loser's next refresh 401'd and force-signed the user out
 * (#13728 — anyone with prod + staging tabs in one browser). Non-production
 * environments therefore suffix their cookie names with the environment;
 * production keeps the historical unsuffixed names so live sessions are
 * untouched by the rename.
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
 * The historical unsuffixed names. Production owns them and still clears them on
 * logout/session teardown. Non-production no longer reads them at all: the
 * bounded read-only migration fallback closed on 2026-08-04 (#14130), so
 * pre-rename sessions in non-production re-authenticate instead of touching
 * production's cookie namespace.
 */
export const LEGACY_STEWARD_COOKIES: StewardCookieNames = {
  token: BASE_TOKEN,
  refreshToken: BASE_REFRESH,
  authed: BASE_AUTHED,
};

/**
 * Whether this Worker may mutate the historical unsuffixed cookie names.
 * Production owns those names on the shared parent domain and clears/rotates
 * them; non-production must never clear or rotate the unsuffixed names because
 * doing so logs out a live production tab. (Non-production also no longer reads
 * them — the bounded read-only migration window closed on 2026-08-04, #14130.)
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
 * environments to fall back to the historical unsuffixed access cookie closed
 * on 2026-08-04 (#14130); callers verify the access JWT but must not rotate or
 * clear legacy cookies in non-production.
 */
export function readStewardAccessCookieFromHeader(
  cookieHeader: string | null,
  environment: string | undefined,
): string | undefined {
  const names = stewardCookieNames(environment);
  return getCookieValueFromHeader(cookieHeader, names.token);
}
