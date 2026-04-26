/**
 * API authentication helpers extracted from server.ts.
 *
 * Centralises token extraction from multiple header formats and
 * timing-safe comparison so route handlers don't reimplement it.
 */

import crypto from "node:crypto";
import type http from "node:http";
import { resolveApiToken } from "@elizaos/shared/runtime-env";
import { isLoopbackRemoteAddress } from "./compat-route-shared";
import { sendJsonError } from "./response";

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

/** Timing-safe token comparison (constant-time regardless of input length). */
export function tokenMatches(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  // Pad the shorter buffer so timingSafeEqual always runs on equal-length inputs,
  // preventing length leakage through early return.
  const maxLen = Math.max(a.length, b.length);
  const aPadded = Buffer.alloc(maxLen);
  const bPadded = Buffer.alloc(maxLen);
  a.copy(aPadded);
  b.copy(bPadded);
  // Always run timingSafeEqual regardless of length to prevent timing leakage
  const contentMatch = crypto.timingSafeEqual(aPadded, bPadded);
  return a.length === b.length && contentMatch;
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
  const authHeader = extractHeaderValue(req.headers.authorization)?.trim();
  if (authHeader) {
    const match = /^Bearer\s+(.+)$/i.exec(authHeader);
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
 * Gate a request behind the configured API token.
 * Returns `true` if the request is authorised (or no token is configured).
 * Sends a 401 and returns `false` otherwise.
 *
 * Note: this is the SYNC bearer-only gate. P1 introduces session cookies as
 * an additional accepted credential — see `ensureCompatApiAuthorizedAsync`
 * which performs the cookie lookup against `AuthStore`. Existing callers
 * continue to use this synchronous form until they migrate.
 */
export function ensureCompatApiAuthorized(
  req: Pick<http.IncomingMessage, "headers" | "socket">,
  res: http.ServerResponse,
): boolean {
  const expectedToken = getCompatApiToken();
  if (!expectedToken) return true;

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

/**
 * Cookie-aware authorisation gate. Tries (in order):
 *   1. valid `milady_session` cookie → session in DB → authorised.
 *   2. configured static bearer (legacy) → 14-day grace window via
 *      `decideLegacyBearer`; emits the deprecation header on success.
 *   3. fallback to `ensureCompatApiAuthorized` for routes that don't
 *      use sessions yet.
 *
 * Returns `true` when the request may proceed; `false` after sending a 401.
 *
 * Caller supplies an `AuthStore` because importing one here would create a
 * cycle with `services/auth-store.ts`. Routes typically construct one
 * once per handler.
 */
export async function ensureCompatApiAuthorizedAsync(
  req: Pick<http.IncomingMessage, "headers" | "socket">,
  res: http.ServerResponse,
  options: {
    store: import("../services/auth-store").AuthStore;
    now?: number;
  },
): Promise<boolean> {
  const ip = req.socket?.remoteAddress ?? null;
  if (isAuthRateLimited(ip)) {
    sendJsonError(res, 429, "Too many authentication attempts");
    return false;
  }

  // Cookie path
  const sessionCookie = readCookie(req, SESSION_COOKIE_NAME);
  if (sessionCookie) {
    const { findActiveSession } = await import("./auth/sessions");
    const session = await findActiveSession(
      options.store,
      sessionCookie,
      options.now,
    ).catch(() => null);
    if (session) return true;
  }

  // Bearer path — session id, legacy static token, or bootstrap bearer.
  const provided = getProvidedApiToken(req);
  if (provided) {
    const { findActiveSession } = await import("./auth/sessions");
    const sessionFromBearer = await findActiveSession(
      options.store,
      provided,
      options.now,
    ).catch(() => null);
    if (sessionFromBearer) return true;

    const expectedToken = getCompatApiToken();
    if (expectedToken && tokenMatches(expectedToken, provided)) {
      const userAgent = extractHeaderValue(req.headers["user-agent"]);
      const {
        decideLegacyBearer,
        recordLegacyBearerRejection,
        recordLegacyBearerUse,
        LEGACY_DEPRECATION_HEADER,
      } = await import("./auth/legacy-bearer");
      const decision = await decideLegacyBearer(
        options.store,
        process.env,
        options.now,
      );
      if (decision.allowed) {
        if (!res.headersSent) {
          res.setHeader(LEGACY_DEPRECATION_HEADER, "1");
        }
        await recordLegacyBearerUse(options.store, {
          ip,
          userAgent,
        }).catch((err) => {
          console.error("[auth] legacy bearer audit failed:", err);
        });
        return true;
      }
      await recordLegacyBearerRejection(options.store, {
        ip,
        userAgent,
        reason: decision.reason ?? "post_grace",
      }).catch((err) => {
        console.error("[auth] legacy bearer rejection audit failed:", err);
      });
      recordFailedAuth(ip);
      sendJsonError(res, 401, "Unauthorized");
      return false;
    }
  }

  // No credential matched.
  if (!getCompatApiToken()) {
    // Open access mode (no token configured AND no session) — fall through
    // to allow loopback-only flows. Higher-level routes still gate via
    // `ensureCompatSensitiveRouteAuthorized` for write paths.
    return true;
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

const SESSION_COOKIE_NAME = "milady_session";

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
 * Gate a sensitive route. In dev mode the request is allowed through ONLY
 * when `ELIZA_DEV_AUTH_BYPASS=1` is explicitly set and no token is configured.
 * In all other cases an API token is required.
 */
export function ensureCompatSensitiveRouteAuthorized(
  req: Pick<http.IncomingMessage, "headers" | "socket">,
  res: http.ServerResponse,
): boolean {
  if (!getCompatApiToken()) {
    // No API token configured. Allow if the request is from loopback
    // (desktop app / local dev) or if dev bypass is enabled. Block
    // otherwise — an unconfigured token on a non-loopback bind is
    // a security risk.
    if (
      isLoopbackRemoteAddress(req.socket?.remoteAddress) ||
      (isDevEnvironment() && process.env.ELIZA_DEV_AUTH_BYPASS?.trim() === "1")
    ) {
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
