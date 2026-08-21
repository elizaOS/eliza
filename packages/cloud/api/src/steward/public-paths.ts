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
export function isThinStewardPublicPath(pathname: string): boolean {
  const normalized = pathname.replace(/\/+$/, "") || "/";
  return (
    normalized === "/steward/auth/providers" ||
    normalized === "/steward/tenants/config"
  );
}

/**
 * Login-critical pre-auth Steward email mutations (Magic Link) that must not
 * wait on full-app bootstrap either.
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
 *
 * All three are pre-auth by design: the full app applies no additional
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
  const normalized = pathname.replace(/\/+$/, "") || "/";
  return (
    normalized === "/steward/auth/email/send" ||
    normalized === "/steward/auth/email/code/verify" ||
    normalized === "/steward/auth/email/status"
  );
}

/**
 * Method-aware eligibility for the thin Steward shell: read-only for the
 * public discovery paths, POST (+ preflight) for the login email mutations.
 */
export function isThinStewardPath(method: string, pathname: string): boolean {
  const upper = method.toUpperCase();
  if (upper === "GET" || upper === "HEAD") {
    return isThinStewardPublicPath(pathname);
  }
  if (upper === "POST") {
    return isThinStewardEmailAuthPath(pathname);
  }
  if (upper === "OPTIONS") {
    return (
      isThinStewardPublicPath(pathname) || isThinStewardEmailAuthPath(pathname)
    );
  }
  return false;
}
