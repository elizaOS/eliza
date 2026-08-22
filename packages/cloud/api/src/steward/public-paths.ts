/**
 * Path matchers for login-critical Steward reads (#18049).
 *
 * Kept dependency-free so the Worker entry can classify requests without
 * evaluating the embedded Steward proxy or the full Hono bootstrap graph.
 */

/**
 * Login-critical Steward reads that must not wait on full-app bootstrap.
 *
 * - GET /steward/auth/providers — gates sign-in buttons (#18049)
 * - GET /steward/tenants/config — pure local JSON (no upstream)
 *
 * OPTIONS preflight for these paths is also eligible for the thin shell.
 */
function removeTrailingSlashes(pathname: string): string {
  let end = pathname.length;
  while (end > 0 && pathname.charCodeAt(end - 1) === 47) end--;
  return end === 0 ? "/" : pathname.slice(0, end);
}

export function isThinStewardPublicPath(pathname: string): boolean {
  const normalized = removeTrailingSlashes(pathname);
  return (
    normalized === "/steward/auth/providers" ||
    normalized === "/steward/tenants/config"
  );
}

/**
 * Login-critical pre-auth Steward email mutations (Magic Link and passkey
 * fallback) that must not wait on full-app bootstrap either.
 *
 * Every one of these is a serial, user-blocking leg of the email sign-in
 * flow, and each was paying the monolithic bootstrap as multi-second cold
 * dispatch (measured 2.5–4.4s `full_app_dispatch` per request against the
 * production Worker while the Steward upstream itself answered in 0.2–0.5s —
 * a ~10s "Magic Link" click for the user):
 *
 * - POST /steward/auth/email/send — fires on the "Magic Link" click; gates
 *   the "Check your email" screen transition.
 * - POST /steward/auth/email/code/verify — fires on six-digit-code submit;
 *   gates login completion.
 * - POST /steward/auth/email/status — the companion-code 3s status poll.
 * - POST /steward/auth/email/otp/send — sends the six-digit fallback code
 *   when the typed account has no passkey.
 * - POST /steward/auth/email/otp/verify — verifies that code before passkey
 *   enrollment begins.
 *
 * All five are pre-auth by design: the full app applies no additional
 * protection to them — `authMiddleware` and the cookie-mutation CSRF guard
 * both pass every non-`/api/` path straight through — so the thin shell's
 * replicated stack (CORS, secure headers, Redis fail-closed guard, global IP
 * limiter) is the exact same effective protection. Request signing and tenant
 * pinning live in `embeddedStewardHandler`, which both shells share.
 *
 * OPTIONS preflight for these paths is also eligible: cross-origin cloud
 * hosts POST `application/json`, so the preflight is a second serial
 * full-bootstrap leg without this.
 *
 * Deliberately narrow: other mutating `/steward/*` paths (vault, agents,
 * payments) stay on the full app.
 */
export function isThinStewardEmailAuthPath(pathname: string): boolean {
  const normalized = removeTrailingSlashes(pathname);
  return (
    normalized === "/steward/auth/email/send" ||
    normalized === "/steward/auth/email/code/verify" ||
    normalized === "/steward/auth/email/status" ||
    normalized === "/steward/auth/email/otp/send" ||
    normalized === "/steward/auth/email/otp/verify"
  );
}

/**
 * The one pre-auth passkey mutation needed before WebAuthn starts.
 *
 * Login options decides whether the typed account has a credential. Unknown
 * or no-passkey accounts receive Steward's generic 404 and immediately fall
 * back to the email OTP paths above. Registration options and both WebAuthn
 * verification endpoints deliberately stay on the full app.
 */
export function isThinStewardPasskeyLoginOptionsPath(
  pathname: string,
): boolean {
  return (
    removeTrailingSlashes(pathname) === "/steward/auth/passkey/login/options"
  );
}

/**
 * Method-aware eligibility for the thin Steward shell: read-only for the
 * public discovery paths, POST (+ preflight) for the exact pre-auth login
 * mutations.
 */
export function isThinStewardPath(method: string, pathname: string): boolean {
  const upper = method.toUpperCase();
  if (upper === "GET" || upper === "HEAD") {
    return isThinStewardPublicPath(pathname);
  }
  if (upper === "POST") {
    return (
      isThinStewardEmailAuthPath(pathname) ||
      isThinStewardPasskeyLoginOptionsPath(pathname)
    );
  }
  if (upper === "OPTIONS") {
    return (
      isThinStewardPublicPath(pathname) ||
      isThinStewardEmailAuthPath(pathname) ||
      isThinStewardPasskeyLoginOptionsPath(pathname)
    );
  }
  return false;
}
