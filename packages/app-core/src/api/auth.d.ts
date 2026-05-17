/**
 * API authentication helpers extracted from server.ts.
 *
 * Centralises token extraction from multiple header formats and
 * timing-safe comparison so route handlers don't reimplement it.
 */
import type http from "node:http";

export { tokenMatches } from "./auth/tokens.js";
/**
 * Normalise a potentially multi-valued HTTP header into a single string.
 * Returns `null` when the header is absent or empty.
 */
export declare function extractHeaderValue(
  value: string | string[] | undefined,
): string | null;
/**
 * Read the configured API token from env (`ELIZA_API_TOKEN` / `MILADY_API_TOKEN`).
 * Returns `null` when no token is configured (open access).
 */
export declare function getCompatApiToken(): string | null;
/**
 * Extract the API token from an incoming request.
 *
 * Checks (in order):
 *   1. `Authorization: Bearer <token>`
 *   2. `x-eliza-token`
 *   3. `x-elizaos-token`
 *   4. `x-api-key` / `x-api-token`
 */
export declare function getProvidedApiToken(
  req: Pick<http.IncomingMessage, "headers">,
): string | null;
/** Clear all auth rate limit state. Exported for test use only. */
export declare function _resetAuthRateLimiter(): void;
/**
 * Gate a request behind the configured API token (sync, bearer-only).
 *
 * Use this only on cold paths where no `AuthStore` exists yet (boot
 * sequence, or before plugin-sql has attached its adapter). Every route
 * that runs after the runtime is up should use
 * {@link ensureCompatApiAuthorizedAsync} instead, which understands
 * session cookies + CSRF.
 */
export declare function ensureCompatApiAuthorized(
  req: Pick<http.IncomingMessage, "headers" | "socket">,
  res: http.ServerResponse,
): boolean;
/**
 * Cookie-aware authorisation gate. Tries (in order):
 *   1. valid `eliza_session` cookie → session in DB → authorised.
 *   2. session-id bearer header.
 *
 * For cookie-bound sessions, state-changing methods (POST/PUT/PATCH/DELETE)
 * MUST present a valid `x-eliza-csrf` header that matches the per-session
 * `csrfSecret` derivation. Reject 403 otherwise. Bearer-auth requests are
 * exempt (not cookie-bound, so no CSRF risk).
 *
 * Returns `true` when the request may proceed; `false` after sending a
 * 401/403/429.
 *
 * Caller supplies an `AuthStore` because importing one here would create a
 * cycle with `services/auth-store.ts`. Routes typically construct one
 * once per handler.
 */
export declare function ensureCompatApiAuthorizedAsync(
  req: Pick<http.IncomingMessage, "headers" | "socket" | "method">,
  res: http.ServerResponse,
  options: {
    store: import("../services/auth-store").AuthStore;
    now?: number;
    /**
     * Skip CSRF enforcement for routes that ALWAYS handle CSRF themselves
     * (e.g. login routes that mint the cookie, where there is no prior
     * session to derive a token from). Default: false — enforce CSRF.
     */
    skipCsrf?: boolean;
  },
): Promise<boolean>;
/** Returns true when NODE_ENV indicates a local development environment. */
export declare function isDevEnvironment(): boolean;
/** Cookie name used by the session model. Exported for tests + UI client. */
export declare function getSessionCookieName(): string;
/**
 * Read the named cookie from the `cookie` header. Returns `null` when the
 * header is missing or the cookie is not set.
 *
 * Pulled out here so route handlers don't reimplement parsing — the existing
 * `compat-route-shared.ts` predates the cookie-based session model.
 */
export declare function readCookie(
  req: Pick<http.IncomingMessage, "headers">,
  name: string,
): string | null;
/**
 * Resolved auth context for a sensitive request.
 *
 * `kind === "session"` — request carries a valid session cookie / bearer that
 * resolves to an unrevoked, unexpired session row.
 *
 * `kind === "bootstrap"` — request carries a one-shot bootstrap token. The
 * token has been verified and its `jti` consumed; the caller is expected to
 * mint a session row for the identity in `claims.sub` and reply with the
 * session id.
 *
 * `kind === "denied"` — request is rejected. The handler must send 401/403/429
 * per `status` and not proceed.
 */
export type AuthSessionOrBootstrapResult =
  | {
      kind: "session";
      sessionId: string;
    }
  | {
      kind: "bootstrap";
      token: string;
      bearer: string;
    }
  | {
      kind: "denied";
      status: 401 | 403 | 429;
      reason: string;
    };
/**
 * Decide whether a request carries a valid session cookie or a bootstrap
 * bearer eligible for exchange.
 *
 * The function does NOT exchange the bootstrap token — that's the job
 * of `POST /api/auth/bootstrap/exchange`, which is rate-limited and audited.
 * The exchange route is the single place that flips bootstrap → session.
 *
 * Fails closed on every error path. There is no path through this function
 * that returns "session" without a real session row id.
 */
export declare function ensureAuthSessionOrBootstrap(
  req: Pick<http.IncomingMessage, "headers" | "socket">,
): AuthSessionOrBootstrapResult;
/**
 * Gate a sensitive route. Without a configured token, only trusted same-machine
 * dashboard requests are allowed. Remote callers need a real auth method.
 */
export declare function ensureCompatSensitiveRouteAuthorized(
  req: Pick<http.IncomingMessage, "headers" | "socket">,
  res: http.ServerResponse,
): boolean;
interface CompatStateLike {
  current: {
    adapter?: {
      db?: unknown;
    } | null;
  } | null;
}
/**
 * Canonical async route guard.
 *
 * When the runtime DB is up, delegates to {@link ensureCompatApiAuthorizedAsync}
 * so cookie + CSRF + machine-session paths work. When the DB is not yet
 * available (early boot), falls back to {@link ensureCompatApiAuthorized}
 * (bearer-only).
 *
 * Pass `skipCsrf: true` for routes that mint cookies / handle their own CSRF
 * (login, setup, bootstrap exchange) where the SPA cannot present a CSRF
 * token because the session doesn't exist yet.
 */
export declare function ensureRouteAuthorized(
  req: Pick<http.IncomingMessage, "headers" | "socket" | "method">,
  res: http.ServerResponse,
  state: CompatStateLike,
  options?: {
    skipCsrf?: boolean;
    now?: number;
  },
): Promise<boolean>;
//# sourceMappingURL=auth.d.ts.map
