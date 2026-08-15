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
