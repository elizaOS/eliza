/**
 * Session lifecycle routes for password and cookie auth.
 *
 *   POST /api/auth/setup            — first-run owner identity + password
 *   POST /api/auth/login/password   — password login → session cookie
 *   POST /api/auth/logout           — destroy current session
 *   GET  /api/auth/me               — current identity + session
 *   GET  /api/auth/sessions         — list active sessions for identity
 *   POST /api/auth/sessions/:id/revoke — revoke one session
 *
 * Hard rules:
 *   - Every write path is rate-limited via the auth bucket in `auth.ts`.
 *   - Every write path emits an audit event (success or failure) before
 *     returning.
 *   - Setup is one-shot — once an owner identity exists, /setup returns 409.
 *   - Logout uses the auth context to find the session id; we do NOT trust
 *     the body.
 */
import type http from "node:http";
import { SESSION_COOKIE_NAME } from "./auth/index";
import { type CompatRuntimeState } from "./compat-route-shared";
/** Test-only reset. */
export declare function _resetAuthSessionRoutesLimiter(): void;
/**
 * Dispatch table for the session routes. Returns true when a route
 * matched and the response was sent; false to fall through to the rest of
 * the API surface.
 */
export declare function handleAuthSessionRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  state: CompatRuntimeState,
): Promise<boolean>;
export { SESSION_COOKIE_NAME };
//# sourceMappingURL=auth-session-routes.d.ts.map
