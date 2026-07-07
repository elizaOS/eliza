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
 * The historical unsuffixed names. Production owns them; non-production may use
 * the legacy access cookie only as a bounded read fallback. Legacy refresh
 * cookies are not read in non-production, so pre-rename refresh-only sessions
 * re-authenticate instead of mutating production's cookie namespace.
 */
export const LEGACY_STEWARD_COOKIES: StewardCookieNames = {
  token: BASE_TOKEN,
  refreshToken: BASE_REFRESH,
  authed: BASE_AUTHED,
};

/**
 * Whether this Worker may mutate the historical unsuffixed cookie names.
 * Production owns those names on the shared parent domain; non-production may
 * read the legacy access cookie during the bounded migration window, but must
 * never clear or rotate the unsuffixed names because doing so logs out a live
 * production tab.
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
 * Bounded read-only migration window for non-production environments to accept
 * the historical unsuffixed access cookie. This closes on 2026-08-04, one
 * 30-day refresh-cookie Max-Age after the 2026-07-05 scoped-cookie rollout.
 */
export const LEGACY_STEWARD_COOKIE_FALLBACK_EXPIRES_AT_MS = Date.UTC(2026, 7, 4);

/**
 * Read this environment's Steward access cookie, then the historical unsuffixed
 * cookie only during the bounded migration window. The fallback is read-only:
 * callers verify the access JWT but must not rotate or clear legacy cookies in
 * non-production.
 */
export function readStewardAccessCookieFromHeader(
  cookieHeader: string | null,
  environment: string | undefined,
  nowMs = Date.now(),
): string | undefined {
  const names = stewardCookieNames(environment);
  const ownCookie = getCookieValueFromHeader(cookieHeader, names.token);
  if (ownCookie) return ownCookie;

  if (
    names.token === LEGACY_STEWARD_COOKIES.token ||
    nowMs >= LEGACY_STEWARD_COOKIE_FALLBACK_EXPIRES_AT_MS
  ) {
    return undefined;
  }

  return getCookieValueFromHeader(cookieHeader, LEGACY_STEWARD_COOKIES.token);
}
