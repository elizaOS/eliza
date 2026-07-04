/**
 * API authentication helpers extracted from server.ts.
 *
 * Centralises token extraction from multiple header formats and
 * timing-safe comparison so route handlers don't reimplement it.
 */

import type http from "node:http";
import { type RoleGateRole, roleRank } from "@elizaos/core";
import { resolveApiToken } from "@elizaos/shared";
// AuthStore is statically imported elsewhere in the package; the dynamic
// import below was INEFFECTIVE_DYNAMIC_IMPORT.
import { type AuthIdentityRow, AuthStore } from "../services/auth-store.js";
import {
  type EmbedSessionClaims,
  type EmbedSessionSecretRuntime,
  readEmbedSessionSecretSetting,
  resolveEmbedSessionSecret,
  verifyEmbedSessionToken,
} from "./auth/embed-session-token.js";
import {
  CSRF_HEADER_NAME,
  denyOnAuthStoreError,
  findActiveSession,
  verifyCsrfToken,
} from "./auth/sessions.js";
import { tokenMatches } from "./auth/tokens.js";
import { isTrustedLocalRequest } from "./compat-route-shared.js";
import { sendJsonError } from "./response.js";

export {
  type AuthContextSource,
  type EnsureSessionOptions,
  ensureSessionForRequest,
  type ResolvedAuthContext,
} from "./auth/auth-context.js";
export { tokenMatches } from "./auth/tokens.js";

export interface CompatStateLike {
  current:
    | (EmbedSessionSecretRuntime & { adapter?: { db?: unknown } | null })
    | null;
}

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

/**
 * Resolve a request's embed session principal (#9947), or `null`.
 *
 * A cross-origin embedded surface (Telegram Mini App / Discord Activity iframe)
 * cannot present the first-party session cookie, so after `/api/embed/auth`
 * verifies its platform-signed launch it mints a scoped, HMAC-signed bearer.
 * This resolves + verifies that bearer against the same configured secret,
 * failing closed on a tampered/expired/malformed token or an unconfigured
 * secret. `read` defaults to `process.env`; the sync boundary-role path passes
 * its own env source.
 */
export function resolveEmbedPrincipal(
  req: Pick<http.IncomingMessage, "headers">,
  now?: number,
  read: (key: string) => unknown = (key) => process.env[key],
): EmbedSessionClaims | null {
  const secret = resolveEmbedSessionSecret(read);
  if (!secret) return null;
  const provided = getProvidedApiToken(req);
  if (!provided) return null;
  return verifyEmbedSessionToken(provided, secret, now);
}

/**
 * Map a verified embed principal to a boundary role. OWNER→OWNER; ADMIN→USER —
 * non-escalating, because the HTTP boundary has no ADMIN tier and ADMIN ranks
 * below OWNER. Returns `null` when there is no valid embed principal.
 */
export function embedBoundaryRole(
  claims: EmbedSessionClaims | null,
): RoleGateRole | null {
  if (!claims) return null;
  return claims.role === "OWNER" ? "OWNER" : "USER";
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

  const ip = req.socket.remoteAddress ?? null;
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
    readSetting?: (key: string) => unknown;
    /**
     * Skip CSRF enforcement for routes that ALWAYS handle CSRF themselves
     * (e.g. login routes that mint the cookie, where there is no prior
     * session to derive a token from). Default: false — enforce CSRF.
     */
    skipCsrf?: boolean;
  },
): Promise<boolean> {
  const resolved = await resolveAuthorizedRouteRole(req, {
    store: options.store,
    now: options.now,
    readSetting: options.readSetting,
    skipCsrf: options.skipCsrf,
  });
  if (!resolved.ok) {
    sendJsonError(res, resolved.status, resolved.reason);
    return false;
  }
  return true;
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
 * bearer eligible for exchange.
 *
 * The function does NOT exchange the bootstrap token — that's the job
 * of `POST /api/auth/bootstrap/exchange`, which is rate-limited and audited.
 * The exchange route is the single place that flips bootstrap → session.
 *
 * Fails closed on every error path. There is no path through this function
 * that returns "session" without a real session row id.
 */
export function ensureAuthSessionOrBootstrap(
  req: Pick<http.IncomingMessage, "headers" | "socket">,
): AuthSessionOrBootstrapResult {
  const ip = req.socket.remoteAddress ?? null;
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

// ── Role-aware boundary helpers ───────────────────────────────────────────────
//
// The HTTP boundary is binary today: `ensureCompatApiAuthorized` /
// `isTrustedLocalRequest` answer one yes/no question (FULL access or 401/403).
// These helpers layer a canonical role tier on top of those exact primitives —
// no new auth scheme — so callers can express a *minimum* role instead of just
// "authenticated". The role vocabulary + ranking is owned by `@elizaos/core`
// (`roleRank` over the canonical rank table); we never define ranks here.

/**
 * Classify the caller into a canonical boundary role using the existing trust
 * + token primitives in this module.
 *
 *   - trusted same-machine dashboard request → `"OWNER"`
 *   - request presenting the configured `ELIZA_API_TOKEN` → `"OWNER"`
 *     (that token grants full access today; there is no non-owner token tier
 *     at this synchronous boundary — session tiers are resolved on the async
 *     DB-backed path instead)
 *   - everything else → `"NONE"`
 *
 * Fails closed: any path that is not a recognised owner principal resolves to
 * `"NONE"` (rank 0).
 */
function resolveBoundaryRole(
  req: Pick<http.IncomingMessage, "headers" | "socket">,
  env: NodeJS.ProcessEnv = process.env,
): RoleGateRole {
  if (isTrustedLocalRequest(req)) {
    return "OWNER";
  }

  // #12087 Item 29: a presented API token only elevates a remote caller to OWNER
  // when ELIZA_REQUIRE_LOCAL_AUTH=1, matching the async ensureRouteMinRole DB
  // path. Without that flag the sync helper would grant OWNER for a bare token
  // while the async path would not — the two boundary paths now agree.
  if (env.ELIZA_REQUIRE_LOCAL_AUTH === "1") {
    const expectedToken = resolveApiToken(env);
    if (expectedToken) {
      const provided = getProvidedApiToken(req);
      if (provided && tokenMatches(expectedToken, provided)) {
        return "OWNER";
      }
    }
  }

  return "NONE";
}

/**
 * Returns `true` iff the caller's boundary role ranks at or above `minRole`.
 *
 * This is a pure predicate (no response side effects) so it composes with any
 * gating strategy. It fails closed: an unrecognised caller resolves to `"NONE"`
 * (rank 0), which only satisfies a `"NONE"` minimum.
 *
 * @internal #12087 Item 29: module-internal. Routes must use the async,
 * DB-aware {@link ensureRouteMinRole}; this coarse sync helper backs only the
 * tokenless branch of {@link ensureCompatSensitiveRouteAuthorized}.
 */
function ensureMinRole(
  req: Pick<http.IncomingMessage, "headers" | "socket">,
  minRole: RoleGateRole,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return roleRank(resolveBoundaryRole(req, env)) >= roleRank(minRole);
}

type RouteRoleResolution =
  | { ok: true; role: RoleGateRole }
  | { ok: false; status: 401 | 403 | 429; reason: string };

type AuthorizedRouteRoleOptions =
  | {
      state: CompatStateLike;
      store?: never;
      skipCsrf?: boolean;
      now?: number;
      readSetting?: never;
    }
  | {
      store: AuthStore;
      state?: never;
      skipCsrf?: boolean;
      now?: number;
      readSetting?: (key: string) => unknown;
    };

/**
 * #12087 Item 15: the single identity-kind → canonical role mapper. Both the
 * session-route response (auth-session-routes) and server-side route-role
 * resolution derive the caller's role from this one function, so the two cannot
 * drift. `owner` → OWNER, `machine` → USER, anything else (or no identity) → NONE.
 */
export function roleForIdentityKind(
  kind: AuthIdentityRow["kind"] | null | undefined,
): RoleGateRole {
  if (kind === "owner") return "OWNER";
  if (kind === "machine") return "USER";
  return "NONE";
}

async function resolveSessionRole(
  store: AuthStore,
  identityId: string,
): Promise<RoleGateRole> {
  const identity = await store
    .findIdentity(identityId)
    .catch(denyOnAuthStoreError("resolveSessionRole/findIdentity"));
  return roleForIdentityKind(identity?.kind);
}

async function resolveAuthorizedRouteRole(
  req: Pick<http.IncomingMessage, "headers" | "socket" | "method">,
  options: AuthorizedRouteRoleOptions,
): Promise<RouteRoleResolution> {
  const ip = req.socket.remoteAddress ?? null;
  if (isAuthRateLimited(ip)) {
    return {
      ok: false,
      status: 429,
      reason: "Too many authentication attempts",
    };
  }

  if (isTrustedLocalRequest(req)) return { ok: true, role: "OWNER" };

  const state = "state" in options ? options.state : undefined;
  const db = state?.current?.adapter?.db;
  const store =
    "store" in options && options.store
      ? options.store
      : db
        ? new AuthStore(db as ConstructorParameters<typeof AuthStore>[0])
        : null;

  if (!store) {
    const expectedToken = getCompatApiToken();
    if (!expectedToken) {
      recordFailedAuth(ip);
      return { ok: false, status: 401, reason: "Unauthorized" };
    }

    const providedToken = getProvidedApiToken(req);
    if (providedToken && tokenMatches(expectedToken, providedToken)) {
      return { ok: true, role: "OWNER" };
    }

    recordFailedAuth(ip);
    return { ok: false, status: 401, reason: "Unauthorized" };
  }

  const method = (req.method ?? "GET").toUpperCase();
  const csrfRequired = !options.skipCsrf && CSRF_REQUIRED_METHODS.has(method);

  const sessionCookie = readCookie(req, SESSION_COOKIE_NAME);
  if (sessionCookie) {
    const session = await findActiveSession(
      store,
      sessionCookie,
      options.now,
    ).catch(denyOnAuthStoreError("resolveAuthorizedRouteRole/cookieSession"));
    if (session) {
      if (csrfRequired) {
        const csrfHeader = extractHeaderValue(
          (req.headers as http.IncomingHttpHeaders)[CSRF_HEADER_NAME],
        );
        if (!verifyCsrfToken(session, csrfHeader)) {
          return { ok: false, status: 403, reason: "csrf_required" };
        }
      }
      return {
        ok: true,
        role: await resolveSessionRole(store, session.identityId),
      };
    }
  }

  const provided = getProvidedApiToken(req);
  if (provided) {
    const sessionFromBearer = await findActiveSession(
      store,
      provided,
      options.now,
    ).catch(denyOnAuthStoreError("resolveAuthorizedRouteRole/bearerSession"));
    if (sessionFromBearer) {
      return {
        ok: true,
        role: await resolveSessionRole(store, sessionFromBearer.identityId),
      };
    }

    const expectedToken = getCompatApiToken();
    if (
      process.env.ELIZA_REQUIRE_LOCAL_AUTH === "1" &&
      expectedToken &&
      tokenMatches(expectedToken, provided)
    ) {
      return { ok: true, role: "OWNER" };
    }

    // Embed session token → its verified boundary role (OWNER→OWNER,
    // ADMIN→USER). Fails closed on a tampered/expired token or no secret.
    const embedRole = embedBoundaryRole(
      resolveEmbedPrincipal(
        req,
        options.now,
        state
          ? (key) => readEmbedSessionSecretSetting(state.current, key)
          : options.readSetting,
      ),
    );
    if (embedRole) {
      return { ok: true, role: embedRole };
    }
  }

  recordFailedAuth(ip);
  return { ok: false, status: 401, reason: "Unauthorized" };
}

/**
 * Cookie/session-aware route guard with a canonical minimum role.
 *
 * This is the async counterpart to {@link ensureMinRole}: it preserves the
 * existing route auth semantics (trusted loopback, session cookie with CSRF,
 * session bearer, and Android's configured local-auth bearer) while letting
 * sensitive HTTP routes require OWNER instead of accepting any valid session.
 */
export async function ensureRouteMinRole(
  req: Pick<http.IncomingMessage, "headers" | "socket" | "method">,
  res: http.ServerResponse,
  state: CompatStateLike,
  minRole: RoleGateRole,
  options: { skipCsrf?: boolean; now?: number } = {},
): Promise<boolean> {
  const resolved = await resolveAuthorizedRouteRole(req, { ...options, state });
  if (!resolved.ok) {
    sendJsonError(res, resolved.status, resolved.reason);
    return false;
  }

  if (roleRank(resolved.role) < roleRank(minRole)) {
    sendJsonError(res, 403, "Insufficient role");
    return false;
  }

  return true;
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
    // No API token configured. The only principal we can name on a tokenless
    // boundary is the trusted same-machine OWNER — resolve the caller through
    // the role path and require OWNER rather than trusting the request
    // ambiently. Remote access must use a configured auth method.
    if (ensureMinRole(req, "OWNER")) {
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

/**
 * Canonical async route guard.
 *
 * Delegates to the same canonical role resolver used by
 * {@link ensureRouteMinRole}, requiring at least an authenticated USER.
 * During early boot before the DB is available, the resolver keeps the
 * existing configured-token OWNER fallback.
 *
 * Pass `skipCsrf: true` for routes that mint cookies / handle their own CSRF
 * (login, setup, bootstrap exchange) where the SPA cannot present a CSRF
 * token because the session doesn't exist yet.
 */
export async function ensureRouteAuthorized(
  req: Pick<http.IncomingMessage, "headers" | "socket" | "method">,
  res: http.ServerResponse,
  state: CompatStateLike,
  options: { skipCsrf?: boolean; now?: number } = {},
): Promise<boolean> {
  return ensureRouteMinRole(req, res, state, "USER", options);
}
