/**
 * Cookie-mutation CSRF guard: decides when a mutating request relies on the
 * ambient Steward session cookie and, for exactly those requests, enforces the
 * canonical browser-origin + non-simple-marker policy.
 *
 * A request authenticated by a programmatic credential — X-API-Key,
 * X-Service-Key, or any Bearer token (API key or Steward JWT) — carries nothing
 * ambient: a cross-origin browser page cannot attach those headers without a
 * CORS preflight that the first-party-only CORS layer fails, so the request is
 * not CSRF-able and the gate does not apply. A request with no session cookie
 * at all has no ambient credential to protect; the route's own auth decides.
 *
 * The gate exists because the hosted-frontend surface serves user content
 * same-site with the API: without it, a cross-origin "simple" POST from that
 * content would carry the victim's session cookie and mutate (org invites,
 * pooled credentials, …) with their identity.
 */

import { getCookieValueFromHeader } from "../http/cookie-header";
import {
  type BrowserOriginCheck,
  checkElizaMutatingRequestOrigin,
  hasElizaNonSimpleRequestMarker,
  type RequestHeaderReader,
} from "./browser-origin-policy";
import { PLAYWRIGHT_TEST_SESSION_COOKIE_NAME } from "./playwright-test-session";
import { readStewardAccessCookieFromHeader } from "./steward-cookies";

export type CookieMutationGuardVerdict =
  | { ok: true }
  | {
      ok: false;
      code: "forbidden_origin" | "csrf_marker_required";
      reason: string;
    };

/**
 * True when the request presents a non-ambient credential. Mirrors the
 * programmatic-auth classification in the global auth middleware: per-route
 * handlers still validate the credential; this only selects the guard lane.
 */
export function hasNonAmbientCredential(req: RequestHeaderReader): boolean {
  if (req.header("x-api-key")?.trim()) return true;
  if (req.header("x-service-key")?.trim()) return true;
  const authorization = req.header("authorization");
  return typeof authorization === "string" && /^Bearer\s+\S+/i.test(authorization);
}

/** True when the request presents this environment's Steward session cookie. */
export function hasAmbientSessionCookie(
  req: RequestHeaderReader,
  environment: string | undefined,
): boolean {
  const cookieHeader = req.header("cookie") ?? null;
  if (!cookieHeader) return false;
  if (readStewardAccessCookieFromHeader(cookieHeader, environment)) {
    return true;
  }
  // The Playwright e2e session cookie authenticates exactly like a Steward
  // cookie and only exists when PLAYWRIGHT_TEST_AUTH is armed (never in
  // production), so it takes the same guard lane.
  return Boolean(getCookieValueFromHeader(cookieHeader, PLAYWRIGHT_TEST_SESSION_COOKIE_NAME));
}

/**
 * Verdict for a mutating request. `{ ok: true }` means the request is not
 * cookie-authenticated and the guard has nothing to say — it is NOT an
 * authorization decision. `{ ok: false }` carries the response `code` the
 * session routes already use for the same failure.
 */
export function checkCookieMutationGuard(
  req: RequestHeaderReader,
  environment: string | undefined,
  isProduction: boolean,
): CookieMutationGuardVerdict {
  if (hasNonAmbientCredential(req)) return { ok: true };
  if (!hasAmbientSessionCookie(req, environment)) return { ok: true };
  const origin: BrowserOriginCheck = checkElizaMutatingRequestOrigin(req, isProduction);
  if (!origin.ok) {
    return { ok: false, code: "forbidden_origin", reason: origin.reason };
  }
  if (!hasElizaNonSimpleRequestMarker(req)) {
    return {
      ok: false,
      code: "csrf_marker_required",
      reason: "missing_non_simple_marker",
    };
  }
  return { ok: true };
}
