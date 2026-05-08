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

import crypto from "node:crypto";
import type http from "node:http";
import type { DrizzleDatabase } from "@elizaos/plugin-sql/types";
import { AuthStore } from "../services/auth-store";
import { extractHeaderValue, getProvidedApiToken } from "./auth";
import {
  appendAuditEvent,
  assertPasswordStrong,
  createBrowserSession,
  ensureSessionForRequest,
  hashPassword,
  parseSessionCookie,
  revokeSession,
  SESSION_COOKIE_NAME,
  serializeCsrfCookie,
  serializeCsrfExpiryCookie,
  serializeSessionCookie,
  serializeSessionExpiryCookie,
  verifyPassword,
  WeakPasswordError,
} from "./auth/index";
import { findActiveSession } from "./auth/sessions";
import {
  type CompatRuntimeState,
  isTrustedLocalRequest,
  readCompatJsonBody,
} from "./compat-route-shared";
import {
  sendJsonError as sendJsonErrorResponse,
  sendJson as sendJsonResponse,
} from "./response";

interface AdapterWithDb {
  db?: unknown;
}

function getDrizzleDb(state: CompatRuntimeState): DrizzleDatabase | null {
  const runtime = state.current;
  if (!runtime) return null;
  const adapter = runtime.adapter as AdapterWithDb | undefined;
  if (!adapter?.db) return null;
  return adapter.db as DrizzleDatabase;
}

const DISPLAY_NAME_RE = /^[A-Za-z0-9 _.\-@]{1,64}$/;

function isValidDisplayName(value: unknown): value is string {
  return typeof value === "string" && DISPLAY_NAME_RE.test(value.trim());
}

// ── In-process rate limiting (auth bucket — same 20/min as auth.ts) ─────────

interface AuthAttempt {
  count: number;
  resetAt: number;
}
const AUTH_ATTEMPT_WINDOW_MS = 60_000;
const AUTH_ATTEMPT_MAX = 20;
const sessionRouteAttempts = new Map<string, AuthAttempt>();

function consumeAuthBucket(
  ip: string | null,
  now: number = Date.now(),
): boolean {
  const key = ip ?? "unknown";
  const entry = sessionRouteAttempts.get(key);
  if (!entry || now > entry.resetAt) {
    sessionRouteAttempts.set(key, {
      count: 1,
      resetAt: now + AUTH_ATTEMPT_WINDOW_MS,
    });
    return true;
  }
  if (entry.count >= AUTH_ATTEMPT_MAX) return false;
  entry.count += 1;
  return true;
}

const sweepTimer = setInterval(
  () => {
    const now = Date.now();
    for (const [k, v] of sessionRouteAttempts) {
      if (now > v.resetAt) sessionRouteAttempts.delete(k);
    }
  },
  5 * 60 * 1000,
);
if (typeof sweepTimer === "object" && "unref" in sweepTimer) {
  sweepTimer.unref();
}

/** Test-only reset. */
export function _resetAuthSessionRoutesLimiter(): void {
  sessionRouteAttempts.clear();
}

// ── Cookie response wiring ──────────────────────────────────────────────────

function setSessionCookies(
  res: http.ServerResponse,
  session: { id: string; csrfSecret: string; expiresAt: number },
): void {
  res.setHeader("set-cookie", [
    serializeSessionCookie(session),
    serializeCsrfCookie(session),
  ]);
}

function clearSessionCookies(res: http.ServerResponse): void {
  res.setHeader("set-cookie", [
    serializeSessionExpiryCookie(),
    serializeCsrfExpiryCookie(),
  ]);
}

// ── Route handler ───────────────────────────────────────────────────────────

/**
 * Dispatch table for the session routes. Returns true when a route
 * matched and the response was sent; false to fall through to the rest of
 * the API surface.
 */
export async function handleAuthSessionRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  state: CompatRuntimeState,
): Promise<boolean> {
  const method = (req.method ?? "GET").toUpperCase();
  const url = new URL(req.url ?? "/", "http://localhost");
  if (!url.pathname.startsWith("/api/auth/")) return false;

  const db = getDrizzleDb(state);
  if (!db) {
    // Routes here all need the DB — return service unavailable rather than
    // routing further. The bootstrap-token endpoint behaves the same way.
    if (
      url.pathname === "/api/auth/setup" ||
      url.pathname === "/api/auth/login/password" ||
      url.pathname === "/api/auth/password/change" ||
      url.pathname === "/api/auth/logout" ||
      url.pathname === "/api/auth/me" ||
      url.pathname === "/api/auth/sessions" ||
      url.pathname.startsWith("/api/auth/sessions/")
    ) {
      sendJsonResponse(res, 503, {
        error: "db_unavailable",
        reason: "db_unavailable",
      });
      return true;
    }
    return false;
  }
  const store = new AuthStore(db);
  const ip = req.socket?.remoteAddress ?? null;
  const userAgent = extractHeaderValue(req.headers["user-agent"]);

  // POST /api/auth/setup — first-run owner identity creation
  if (method === "POST" && url.pathname === "/api/auth/setup") {
    return await handleSetup(req, res, store, { ip, userAgent });
  }

  // POST /api/auth/login/password
  if (method === "POST" && url.pathname === "/api/auth/login/password") {
    return await handleLoginPassword(req, res, store, { ip, userAgent });
  }

  // POST /api/auth/password/change
  if (method === "POST" && url.pathname === "/api/auth/password/change") {
    return await handleChangePassword(req, res, store, { ip, userAgent });
  }

  // POST /api/auth/logout
  if (method === "POST" && url.pathname === "/api/auth/logout") {
    return await handleLogout(req, res, store, { ip, userAgent });
  }

  // GET /api/auth/me
  if (method === "GET" && url.pathname === "/api/auth/me") {
    return await handleMe(req, res, store);
  }

  // GET /api/auth/sessions
  if (method === "GET" && url.pathname === "/api/auth/sessions") {
    return await handleListSessions(req, res, store);
  }

  // POST /api/auth/sessions/:id/revoke
  const revokeMatch =
    method === "POST"
      ? /^\/api\/auth\/sessions\/([^/]+)\/revoke$/.exec(url.pathname)
      : null;
  if (revokeMatch) {
    return await handleRevoke(req, res, store, revokeMatch[1], {
      ip,
      userAgent,
    });
  }

  return false;
}

// ── /api/auth/setup ─────────────────────────────────────────────────────────

async function handleSetup(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  store: AuthStore,
  meta: { ip: string | null; userAgent: string | null },
): Promise<boolean> {
  if (!consumeAuthBucket(meta.ip)) {
    sendJsonErrorResponse(res, 429, "Too many requests");
    return true;
  }

  if (await store.hasOwnerIdentity()) {
    sendJsonResponse(res, 409, {
      error: "already_initialized",
      reason: "already_initialized",
    });
    return true;
  }

  const body = await readCompatJsonBody(req, res);
  if (body == null) return true;
  const password = typeof body.password === "string" ? body.password : "";
  const displayNameRaw =
    typeof body.displayName === "string" ? body.displayName.trim() : "";
  if (!isValidDisplayName(displayNameRaw)) {
    sendJsonErrorResponse(res, 400, "invalid_display_name");
    return true;
  }
  try {
    assertPasswordStrong(password);
  } catch (err) {
    if (err instanceof WeakPasswordError) {
      sendJsonResponse(res, 400, {
        error: "weak_password",
        reason: err.reason,
      });
      return true;
    }
    throw err;
  }

  const passwordHash = await hashPassword(password);
  const identityId = crypto.randomUUID();
  const now = Date.now();
  await store.createIdentity({
    id: identityId,
    kind: "owner",
    displayName: displayNameRaw,
    createdAt: now,
    passwordHash,
    cloudUserId: null,
  });

  const { session, csrfToken } = await createBrowserSession(store, {
    identityId,
    ip: meta.ip,
    userAgent: meta.userAgent,
    rememberDevice: false,
    now,
  });
  setSessionCookies(res, session);

  await appendAuditEvent(
    {
      actorIdentityId: identityId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      action: "auth.setup",
      outcome: "success",
      metadata: { method: "password" },
    },
    { store },
  );

  sendJsonResponse(res, 200, {
    identity: {
      id: identityId,
      displayName: displayNameRaw,
      kind: "owner" as const,
    },
    session: {
      id: session.id,
      kind: session.kind,
      expiresAt: session.expiresAt,
    },
    csrfToken,
  });
  return true;
}

// ── /api/auth/login/password ────────────────────────────────────────────────

async function handleLoginPassword(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  store: AuthStore,
  meta: { ip: string | null; userAgent: string | null },
): Promise<boolean> {
  if (!consumeAuthBucket(meta.ip)) {
    sendJsonErrorResponse(res, 429, "Too many requests");
    return true;
  }
  const body = await readCompatJsonBody(req, res);
  if (body == null) return true;
  const displayName =
    typeof body.displayName === "string" ? body.displayName.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const rememberDevice = body.rememberDevice === true;
  if (!isValidDisplayName(displayName) || password.length === 0) {
    await appendAuditEvent(
      {
        actorIdentityId: null,
        ip: meta.ip,
        userAgent: meta.userAgent,
        action: "auth.login.password",
        outcome: "failure",
        metadata: { reason: "invalid_input" },
      },
      { store },
    );
    sendJsonErrorResponse(res, 400, "invalid_credentials");
    return true;
  }

  const identity = await store.findIdentityByDisplayName(displayName);
  if (!identity?.passwordHash) {
    await appendAuditEvent(
      {
        actorIdentityId: identity?.id ?? null,
        ip: meta.ip,
        userAgent: meta.userAgent,
        action: "auth.login.password",
        outcome: "failure",
        metadata: { reason: "unknown_identity" },
      },
      { store },
    );
    sendJsonErrorResponse(res, 401, "invalid_credentials");
    return true;
  }

  let ok = false;
  try {
    ok = await verifyPassword(password, identity.passwordHash);
  } catch {
    ok = false;
  }
  if (!ok) {
    await appendAuditEvent(
      {
        actorIdentityId: identity.id,
        ip: meta.ip,
        userAgent: meta.userAgent,
        action: "auth.login.password",
        outcome: "failure",
        metadata: { reason: "bad_password" },
      },
      { store },
    );
    sendJsonErrorResponse(res, 401, "invalid_credentials");
    return true;
  }

  const now = Date.now();
  const { session, csrfToken } = await createBrowserSession(store, {
    identityId: identity.id,
    ip: meta.ip,
    userAgent: meta.userAgent,
    rememberDevice,
    now,
  });
  setSessionCookies(res, session);

  await appendAuditEvent(
    {
      actorIdentityId: identity.id,
      ip: meta.ip,
      userAgent: meta.userAgent,
      action: "auth.login.password",
      outcome: "success",
      metadata: { method: "password" },
    },
    { store },
  );

  sendJsonResponse(res, 200, {
    identity: {
      id: identity.id,
      displayName: identity.displayName,
      kind: identity.kind,
    },
    session: {
      id: session.id,
      kind: session.kind,
      expiresAt: session.expiresAt,
    },
    csrfToken,
  });
  return true;
}

// ── /api/auth/logout ────────────────────────────────────────────────────────

async function handleLogout(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  store: AuthStore,
  meta: { ip: string | null; userAgent: string | null },
): Promise<boolean> {
  const sessionId = parseSessionCookie(req) ?? getProvidedApiToken(req) ?? null;
  if (!sessionId) {
    clearSessionCookies(res);
    sendJsonResponse(res, 200, { ok: true });
    return true;
  }
  const session = await findActiveSession(store, sessionId).catch(() => null);
  if (session) {
    await revokeSession(session.id, {
      store,
      reason: "user_logout",
      actorIdentityId: session.identityId,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
  }
  clearSessionCookies(res);
  sendJsonResponse(res, 200, { ok: true });
  return true;
}

// ── /api/auth/me ────────────────────────────────────────────────────────────

async function handleMe(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  store: AuthStore,
): Promise<boolean> {
  if (isTrustedLocalRequest(req)) {
    const owner = (await store.listIdentitiesByKind("owner"))[0] ?? null;
    sendJsonResponse(res, 200, {
      identity: owner
        ? {
            id: owner.id,
            displayName: owner.displayName,
            kind: owner.kind,
          }
        : {
            id: "local-loopback",
            displayName: "Local",
            kind: "owner" as const,
          },
      session: {
        id: "local-loopback",
        kind: "local" as const,
        expiresAt: null,
      },
      access: {
        mode: "local" as const,
        passwordConfigured: Boolean(owner?.passwordHash),
        ownerConfigured: Boolean(owner),
      },
    });
    return true;
  }

  const ctx = await ensureSessionForRequest(req, res, {
    store,
    allowBootstrapBearer: false,
  });
  if (!ctx?.session || !ctx.identity) {
    const owner = (await store.listIdentitiesByKind("owner"))[0] ?? null;
    sendJsonResponse(res, 401, {
      error: "Unauthorized",
      reason: owner?.passwordHash
        ? "remote_auth_required"
        : "remote_password_not_configured",
      access: {
        mode: "remote" as const,
        passwordConfigured: Boolean(owner?.passwordHash),
        ownerConfigured: Boolean(owner),
      },
    });
    return true;
  }
  sendJsonResponse(res, 200, {
    identity: {
      id: ctx.identity.id,
      displayName: ctx.identity.displayName,
      kind: ctx.identity.kind,
    },
    session: {
      id: ctx.session.id,
      kind: ctx.session.kind,
      expiresAt: ctx.session.expiresAt,
    },
    access: {
      mode: "session" as const,
      passwordConfigured: Boolean(ctx.identity.passwordHash),
      ownerConfigured: true,
    },
  });
  return true;
}

// ── /api/auth/password/change ───────────────────────────────────────────────

async function handleChangePassword(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  store: AuthStore,
  meta: { ip: string | null; userAgent: string | null },
): Promise<boolean> {
  if (!consumeAuthBucket(meta.ip)) {
    sendJsonErrorResponse(res, 429, "Too many requests");
    return true;
  }

  const body = await readCompatJsonBody(req, res);
  if (body == null) return true;

  const currentPassword =
    typeof body.currentPassword === "string" ? body.currentPassword : "";
  const newPassword =
    typeof body.newPassword === "string" ? body.newPassword : "";

  try {
    assertPasswordStrong(newPassword);
  } catch (err) {
    if (err instanceof WeakPasswordError) {
      sendJsonResponse(res, 400, {
        error: "weak_password",
        reason: err.reason,
      });
      return true;
    }
    throw err;
  }

  const localAccess = isTrustedLocalRequest(req);
  const ctx = localAccess
    ? null
    : await ensureSessionForRequest(req, res, {
        store,
        allowBootstrapBearer: false,
      });

  const identity = localAccess
    ? ((await store.listIdentitiesByKind("owner"))[0] ?? null)
    : (ctx?.identity ?? null);

  if (!identity) {
    sendJsonErrorResponse(res, 404, "owner_not_found");
    return true;
  }

  if (!localAccess) {
    if (!identity.passwordHash || currentPassword.length === 0) {
      sendJsonErrorResponse(res, 401, "invalid_credentials");
      return true;
    }
    const ok = await verifyPassword(currentPassword, identity.passwordHash);
    if (!ok) {
      await appendAuditEvent(
        {
          actorIdentityId: identity.id,
          ip: meta.ip,
          userAgent: meta.userAgent,
          action: "auth.password.change",
          outcome: "failure",
          metadata: { reason: "bad_current_password" },
        },
        { store },
      );
      sendJsonErrorResponse(res, 401, "invalid_credentials");
      return true;
    }
  }

  const passwordHash = await hashPassword(newPassword);
  await store.updateIdentityPassword(identity.id, passwordHash);
  await appendAuditEvent(
    {
      actorIdentityId: identity.id,
      ip: meta.ip,
      userAgent: meta.userAgent,
      action: "auth.password.change",
      outcome: "success",
      metadata: { localAccess },
    },
    { store },
  );

  sendJsonResponse(res, 200, { ok: true });
  return true;
}

// ── /api/auth/sessions (GET) ────────────────────────────────────────────────

async function handleListSessions(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  store: AuthStore,
): Promise<boolean> {
  if (isTrustedLocalRequest(req)) {
    const owner = (await store.listIdentitiesByKind("owner"))[0] ?? null;
    const sessions = owner ? await store.listSessionsForIdentity(owner.id) : [];
    sendJsonResponse(res, 200, {
      sessions: [
        {
          id: "local-loopback",
          kind: "local" as const,
          ip: req.socket?.remoteAddress ?? "127.0.0.1",
          userAgent: extractHeaderValue(req.headers["user-agent"]),
          lastSeenAt: Date.now(),
          expiresAt: null,
          current: true,
        },
        ...sessions.map((s) => ({
          id: s.id,
          kind: s.kind,
          ip: s.ip,
          userAgent: s.userAgent,
          lastSeenAt: s.lastSeenAt,
          expiresAt: s.expiresAt,
          current: false,
        })),
      ],
    });
    return true;
  }

  const ctx = await ensureSessionForRequest(req, res, {
    store,
    allowBootstrapBearer: false,
  });
  if (!ctx?.identity) {
    sendJsonErrorResponse(res, 401, "Unauthorized");
    return true;
  }
  const sessions = await store.listSessionsForIdentity(ctx.identity.id);
  const currentId = ctx.session?.id ?? null;
  sendJsonResponse(res, 200, {
    sessions: sessions.map((s) => ({
      id: s.id,
      kind: s.kind,
      ip: s.ip,
      userAgent: s.userAgent,
      lastSeenAt: s.lastSeenAt,
      expiresAt: s.expiresAt,
      current: s.id === currentId,
    })),
  });
  return true;
}

// ── /api/auth/sessions/:id/revoke (POST) ────────────────────────────────────

async function handleRevoke(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  store: AuthStore,
  targetSessionId: string,
  meta: { ip: string | null; userAgent: string | null },
): Promise<boolean> {
  const ctx = await ensureSessionForRequest(req, res, {
    store,
    allowBootstrapBearer: false,
  });
  if (!ctx?.identity) {
    sendJsonErrorResponse(res, 401, "Unauthorized");
    return true;
  }
  // Look up the target session and confirm it belongs to the caller.
  const target = await store.findSession(targetSessionId).catch(() => null);
  if (!target || target.identityId !== ctx.identity.id) {
    sendJsonErrorResponse(res, 404, "session_not_found");
    return true;
  }
  await revokeSession(targetSessionId, {
    store,
    reason: "user_revoke",
    actorIdentityId: ctx.identity.id,
    ip: meta.ip,
    userAgent: meta.userAgent,
  });
  // If the user revoked their own session, also clear cookies.
  if (ctx.session && ctx.session.id === targetSessionId) {
    clearSessionCookies(res);
  }
  sendJsonResponse(res, 200, { ok: true });
  return true;
}

// Re-export for the SESSION cookie helpers that bootstrap-routes uses.
export { SESSION_COOKIE_NAME };
