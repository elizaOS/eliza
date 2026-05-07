/**
 * API authentication helpers extracted from server.ts.
 *
 * Centralises token extraction from multiple header formats and
 * timing-safe comparison so route handlers don't reimplement it.
 */

import type http from "node:http";
import { logger } from "@elizaos/core";
import { resolveApiToken } from "@elizaos/shared";
import {
  CSRF_HEADER_NAME,
  findActiveSession,
  verifyCsrfToken,
} from "./auth/sessions";
import { tokenMatches } from "./auth/tokens";
import { isTrustedLocalRequest } from "./compat-route-shared";
import { sendJsonError } from "./response";

export { tokenMatches } from "./auth/tokens";

/**
 * Normalise a potentially multi-valued HTTP header into a single string.
 * Returns `null` when the header is absent or empty.
 */
export function extractHeaderValue(
  value: string | string[] | undefined,
): string | null {
  if (typeof value === "string") return value;
  return Array.isArray(value) && typeof value[0] === "string" ? value[0] : null;
}

/**
 * Read the configured API token from env (`ELIZA_API_TOKEN` / `ELIZA_API_TOKEN`).
 * Returns `null` when no token is configured (open access).
 */
export function getCompatApiToken(): string | null {
  return resolveApiToken(process.env);
}

/**
 * Extract the API token from an incoming request.
 *
 * Checks (in order):
 *   1. `Authorization: Bearer <token>`
 *   2. `x-eliza-token`
 *   3. `x-elizaos-token`
 *   4. `x-api-key` / `x-api-token`
 */
export function getProvidedApiToken(
  req: Pick<http.IncomingMessage, "headers">,
): string | null {
  const authHeader = extractHeaderValue(req.headers.authorization)
    ?.slice(0, 1024)
    ?.trim();
  if (authHeader) {
    const match = /^Bearer\s{1,8}(.+)$/i.exec(authHeader);
    if (match?.[1]) return match[1].trim();
  }

  const headerToken =
    extractHeaderValue(req.headers["x-eliza-token"]) ??
    extractHeaderValue(req.headers["x-elizaos-token"]) ??
    extractHeaderValue(req.headers["x-api-key"]) ??
    extractHeaderValue(req.headers["x-api-token"]);

  return headerToken?.trim() || null;
}

// ── Auth attempt rate limiter ─────────────────────────────────────────────────
const AUTH_RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const AUTH_RATE_LIMIT_MAX = 20; // max failed attempts per window per IP
const authAttempts = new Map<string, { count: number; resetAt: number }>();

/** Clear all auth rate limit state. Exported for test use only. */
export function _resetAuthRateLimiter(): void {
  authAttempts.clear();
}

const authSweepTimer = setInterval(
  () => {
    const now = Date.now();
    for (const [key, entry] of authAttempts) {
      if (now > entry.resetAt) authAttempts.delete(key);
    }
  },
  5 * 60 * 1000,
);
if (typeof authSweepTimer === "object" && "unref" in authSweepTimer) {
  authSweepTimer.unref();
}

function isAuthRateLimited(ip: string | null): boolean {
  const key = ip ?? "unknown";
  const now = Date.now();
  const entry = authAttempts.get(key);
  if (!entry || now > entry.resetAt) return false;
  return entry.count >= AUTH_RATE_LIMIT_MAX;
}

function recordFailedAuth(ip: string | null): void {
  const key = ip ?? "unknown";
  const now = Date.now();
  const entry = authAttempts.get(key);
  if (!entry || now > entry.resetAt) {
    authAttempts.set(key, {
      count: 1,
      resetAt: now + AUTH_RATE_LIMIT_WINDOW_MS,
    });
  } else {
    entry.count += 1;
  }
}

/**
 * Gate a request behind the configured API token (sync, bearer-only).
 *
 * Use this only on cold paths where no `AuthStore` exists yet (boot
 * sequence, or before plugin-sql has attached its adapter). Every route
 * that runs after the runtime is up should use
 * {@link ensureCompatApiAuthorizedAsync} instead, which understands
 * session cookies + CSRF.
 */
export function ensureCompatApiAuthorized(
  req: Pick<http.IncomingMessage, "headers" | "socket">,
  res: http.ServerResponse,
): boolean {
  if (isTrustedLocalRequest(req)) return true;

  const expectedToken = getCompatApiToken();
  if (!expectedToken) {
    sendJsonError(res, 401, "Unauthorized");
    return false;
  }

  const ip = req.socket?.remoteAddress ?? null;
  if (isAuthRateLimited(ip)) {
    sendJsonError(res, 429, "Too many authentication attempts");
    return false;
  }

  const providedToken = getProvidedApiToken(req);
  if (providedToken && tokenMatches(expectedToken, providedToken)) return true;

  recordFailedAuth(ip);
  sendJsonError(res, 401, "Unauthorized");
  return false;
}

/** State-changing HTTP verbs that require CSRF enforcement on cookie auth. */
const CSRF_REQUIRED_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

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
export async function ensureCompatApiAuthorizedAsync(
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
): Promise<boolean> {
  const ip = req.socket?.remoteAddress ?? null;
  if (isAuthRateLimited(ip)) {
    sendJsonError(res, 429, "Too many authentication attempts");
    return false;
  }

  if (isTrustedLocalRequest(req)) return true;

  const method = (req.method ?? "GET").toUpperCase();
  const csrfRequired = !options.skipCsrf && CSRF_REQUIRED_METHODS.has(method);

  // Cookie path
  const sessionCookie = readCookie(req, SESSION_COOKIE_NAME);
  if (sessionCookie) {
    const session = await findActiveSession(
      options.store,
      sessionCookie,
      options.now,
    ).catch(() => null);
    if (session) {
      if (csrfRequired) {
        const csrfHeader = extractHeaderValue(
          (req.headers as http.IncomingHttpHeaders)[CSRF_HEADER_NAME],
        );
        if (!verifyCsrfToken(session, csrfHeader)) {
          sendJsonError(res, 403, "csrf_required");
          return false;
        }
      }
      return true;
    }
  }

  // Bearer path — session id only.
  // Bearer-auth requests are exempt from CSRF (they're not cookie-bound).
  const provided = getProvidedApiToken(req);
  if (provided) {
    const sessionFromBearer = await findActiveSession(
      options.store,
      provided,
      options.now,
    ).catch(() => null);
    if (sessionFromBearer) return true;
  }

  recordFailedAuth(ip);
  sendJsonError(res, 401, "Unauthorized");
  return false;
}

/** Returns true when NODE_ENV indicates a local development environment. */
export function isDevEnvironment(): boolean {
  const env = process.env.NODE_ENV?.trim().toLowerCase();
  return env === "development" || env === "dev";
}

// ── Cookie / session helpers ──────────────────────────────────────────────────

const SESSION_COOKIE_NAME = "eliza_session";

/** Cookie name used by the session model. Exported for tests + UI client. */
export function getSessionCookieName(): string {
  return SESSION_COOKIE_NAME;
}

/**
 * Read the named cookie from the `cookie` header. Returns `null` when the
 * header is missing or the cookie is not set.
 *
 * Pulled out here so route handlers don't reimplement parsing — the existing
 * `compat-route-shared.ts` predates the cookie-based session model.
 */
export function readCookie(
  req: Pick<http.IncomingMessage, "headers">,
  name: string,
): string | null {
  const raw = extractHeaderValue(req.headers.cookie);
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (k !== name) continue;
    const v = part.slice(eq + 1).trim();
    return v.length > 0 ? decodeURIComponent(v) : null;
  }
  return null;
}

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
  | { kind: "session"; sessionId: string }
  | { kind: "bootstrap"; token: string; bearer: string }
  | { kind: "denied"; status: 401 | 403 | 429; reason: string };

/**
 * Decide whether a request carries a valid session cookie or a bootstrap
 * bearer eligible for exchange. This is the single chokepoint that replaces
 * the deleted "cloud-provisioned bypass" branches.
 *
 * The function does NOT exchange the bootstrap token here — that's the job
 * of `POST /api/auth/bootstrap/exchange`, which is rate-limited and audited.
 * On the legacy onboarding routes we treat a valid session OR an unconsumed
 * bootstrap bearer as authorisation to read; the exchange route is the
 * single place that flips bootstrap → session.
 *
 * Fails closed on every error path. There is no path through this function
 * that returns "session" without a real session row id.
 */
export function ensureAuthSessionOrBootstrap(
  req: Pick<http.IncomingMessage, "headers" | "socket">,
): AuthSessionOrBootstrapResult {
  const ip = req.socket?.remoteAddress ?? null;
  if (isAuthRateLimited(ip)) {
    return { kind: "denied", status: 429, reason: "rate_limited" };
  }

  const cookie = readCookie(req, SESSION_COOKIE_NAME);
  if (cookie) {
    // Caller is expected to look up the session by id and confirm it is
    // valid. We don't hit the DB here to keep the helper synchronous; the
    // DB lookup happens in the route handler with `AuthStore.findSession`.
    return { kind: "session", sessionId: cookie };
  }

  const bearer = getProvidedApiToken(req);
  if (bearer) {
    return { kind: "bootstrap", token: bearer, bearer };
  }

  recordFailedAuth(ip);
  return { kind: "denied", status: 401, reason: "auth_required" };
}

/**
 * Gate a sensitive route. Without a configured token, only trusted same-machine
 * dashboard requests are allowed. Remote callers need a real auth method.
 */
export function ensureCompatSensitiveRouteAuthorized(
  req: Pick<http.IncomingMessage, "headers" | "socket">,
  res: http.ServerResponse,
): boolean {
  if (!getCompatApiToken()) {
    // No API token configured. Allow only the same-machine dashboard path.
    // Remote access must use a configured auth method.
    if (isTrustedLocalRequest(req)) {
      return true;
    }
    sendJsonError(
      res,
      403,
      "Sensitive endpoint requires API token authentication",
    );
    return false;
  }
  return ensureCompatApiAuthorized(req, res);
}

interface CompatStateLike {
  current: { adapter?: { db?: unknown } | null } | null;
}

/**
 * Canonical async route guard. Replaces every call site of
 * {@link ensureCompatApiAuthorized}. Behaviour:
 *
 *   - When the runtime DB is up, delegate to
 *     {@link ensureCompatApiAuthorizedAsync} so cookie + CSRF +
 *     machine-session paths all work.
 *   - When the runtime DB is not yet available (early boot), fall back
 *     to {@link ensureCompatApiAuthorized} (bearer-only). This preserves
 *     the existing behaviour for cold boot probes that ran before the
 *     auth subsystem was available.
 *
 * Pass `skipCsrf: true` for routes that mint cookies / handle their own
 * CSRF (login, setup, bootstrap exchange) where the SPA cannot present a
 * CSRF token because the session doesn't exist yet.
 */
export async function ensureRouteAuthorized(
  req: Pick<http.IncomingMessage, "headers" | "socket" | "method">,
  res: http.ServerResponse,
  state: CompatStateLike,
  options: { skipCsrf?: boolean; now?: number } = {},
): Promise<boolean> {
  const adapter = state.current?.adapter;
  const db = adapter?.db;
  if (!db) {
    return ensureCompatApiAuthorized(req, res);
  }
  const { AuthStore } = await import("../services/auth-store");
  const store = new AuthStore(db as ConstructorParameters<typeof AuthStore>[0]);
  return ensureCompatApiAuthorizedAsync(req, res, {
    store,
    now: options.now,
    skipCsrf: options.skipCsrf,
  });
}
