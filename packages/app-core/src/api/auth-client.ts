/**
 * Typed client for P1 session auth endpoints.
 *
 * All state-changing calls go through `fetchWithCsrf` so the CSRF header is
 * attached automatically. GET requests use plain `fetch` with
 * `credentials: "include"`.
 *
 * This module is UI-only. It deliberately does NOT import ElizaClient so it
 * can be used in auth-gated components before the main client is initialised.
 */

import { getBootConfig } from "../config/boot-config";
import { fetchWithCsrf } from "./csrf-client";

// ── Shared response shapes ────────────────────────────────────────────────────

export interface AuthIdentity {
  id: string;
  displayName: string;
  kind: "owner" | "machine";
}

export interface AuthSessionInfo {
  id: string;
  kind: "browser" | "machine" | "local";
  expiresAt: number | null;
}

export interface AuthSessionListEntry {
  id: string;
  kind: "browser" | "machine" | "local";
  ip: string | null;
  userAgent: string | null;
  lastSeenAt: number;
  expiresAt: number | null;
  current: boolean;
}

export interface AuthAccessInfo {
  mode: "local" | "session" | "remote" | "bearer";
  passwordConfigured: boolean;
  ownerConfigured: boolean;
}

// ── Success / failure discriminated unions ────────────────────────────────────

export type AuthSetupResult =
  | {
      ok: true;
      identity: AuthIdentity;
      session: AuthSessionInfo;
      csrfToken: string;
    }
  | {
      ok: false;
      status: 400 | 409 | 429 | 500 | 503;
      reason:
        | "weak_password"
        | "invalid_display_name"
        | "already_initialized"
        | "rate_limited"
        | "server_error";
      message: string;
    };

export type AuthLoginResult =
  | {
      ok: true;
      identity: AuthIdentity;
      session: AuthSessionInfo;
      csrfToken: string;
    }
  | {
      ok: false;
      status: 400 | 401 | 429 | 500;
      reason: "invalid_credentials" | "rate_limited" | "server_error";
      message: string;
    };

export type AuthMeResult =
  | {
      ok: true;
      identity: AuthIdentity;
      session: AuthSessionInfo;
      access: AuthAccessInfo;
    }
  | {
      ok: false;
      status: 401 | 503;
      reason?:
        | "remote_auth_required"
        | "remote_password_not_configured"
        | "server_error";
      access?: AuthAccessInfo;
    };

export type AuthSessionsResult =
  | { ok: true; sessions: AuthSessionListEntry[] }
  | { ok: false; status: 401 | 503 };

export type AuthRevokeResult =
  | { ok: true }
  | { ok: false; status: 401 | 404 | 500 };

export type AuthLogoutResult = { ok: true };

export type AuthChangePasswordResult =
  | { ok: true }
  | {
      ok: false;
      status: 400 | 401 | 404 | 429 | 500;
      reason:
        | "weak_password"
        | "invalid_credentials"
        | "owner_not_found"
        | "rate_limited"
        | "server_error";
      message: string;
    };

// ── API base helper ───────────────────────────────────────────────────────────

/**
 * Resolves the base URL for auth calls. Reads from the same source as the
 * main ElizaClient so they stay in sync.
 */
function authBase(): string {
  if (typeof window === "undefined") return "";
  const apiBase = getBootConfig().apiBase;
  return apiBase ? apiBase.replace(/\/$/, "") : window.location.origin;
}

// ── Endpoint callers ──────────────────────────────────────────────────────────

/**
 * POST /api/auth/setup — first-run owner identity creation.
 * Returns 409 if an owner identity already exists.
 */
export async function authSetup(params: {
  displayName: string;
  password: string;
}): Promise<AuthSetupResult> {
  let res: Response;
  try {
    res = await fetchWithCsrf(`${authBase()}/api/auth/setup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });
  } catch (err) {
    return {
      ok: false,
      status: 500,
      reason: "server_error",
      message: err instanceof Error ? err.message : "Network error",
    };
  }

  if (res.ok) {
    const body = (await res.json()) as {
      identity: AuthIdentity;
      session: AuthSessionInfo;
      csrfToken: string;
    };
    return { ok: true, ...body };
  }

  const body = (await res.json().catch(() => ({}))) as {
    error?: string;
    reason?: string;
  };
  const reason = body.reason ?? body.error ?? "";
  if (res.status === 409) {
    return {
      ok: false,
      status: 409,
      reason: "already_initialized",
      message: "An owner account already exists.",
    };
  }
  if (res.status === 429) {
    return {
      ok: false,
      status: 429,
      reason: "rate_limited",
      message: "Too many attempts — wait a moment and try again.",
    };
  }
  if (res.status === 400 && reason === "weak_password") {
    return {
      ok: false,
      status: 400,
      reason: "weak_password",
      message:
        "Password too weak. Use at least 12 characters with a mix of letters, numbers, and symbols.",
    };
  }
  if (res.status === 400) {
    return {
      ok: false,
      status: 400,
      reason: "invalid_display_name",
      message:
        "Display name must be 1–64 characters (letters, numbers, spaces, _ . - @).",
    };
  }
  return {
    ok: false,
    status: 500,
    reason: "server_error",
    message: `Unexpected error (${res.status})`,
  };
}

/**
 * POST /api/auth/login/password — password-based login.
 */
export async function authLoginPassword(params: {
  displayName: string;
  password: string;
  rememberDevice?: boolean;
}): Promise<AuthLoginResult> {
  let res: Response;
  try {
    res = await fetchWithCsrf(`${authBase()}/api/auth/login/password`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });
  } catch (err) {
    return {
      ok: false,
      status: 500,
      reason: "server_error",
      message: err instanceof Error ? err.message : "Network error",
    };
  }

  if (res.ok) {
    const body = (await res.json()) as {
      identity: AuthIdentity;
      session: AuthSessionInfo;
      csrfToken: string;
    };
    return { ok: true, ...body };
  }

  if (res.status === 429) {
    return {
      ok: false,
      status: 429,
      reason: "rate_limited",
      message: "Too many attempts — wait a moment and try again.",
    };
  }
  return {
    ok: false,
    status: res.status === 401 ? 401 : 500,
    reason:
      res.status === 401 || res.status === 400
        ? "invalid_credentials"
        : "server_error",
    message:
      res.status === 401 || res.status === 400
        ? "Invalid display name or password."
        : `Unexpected error (${res.status})`,
  };
}

/**
 * POST /api/auth/logout — destroys the current session.
 */
export async function authLogout(): Promise<AuthLogoutResult> {
  try {
    await fetchWithCsrf(`${authBase()}/api/auth/logout`, { method: "POST" });
  } catch {
    // Logout is best-effort; treat network errors as success from the
    // client's perspective — the cookie may still clear on reconnect.
  }
  return { ok: true };
}

/**
 * GET /api/auth/me — returns the current identity + session, or 401.
 *
 * Fail closed: network errors are treated as 503 so the startup shell can
 * show a backend failure instead of a misleading credential prompt.
 */
export async function authMe(): Promise<AuthMeResult> {
  let res: Response;
  try {
    res = await fetchWithCsrf(`${authBase()}/api/auth/me`);
  } catch {
    return { ok: false, status: 503 };
  }

  if (res.ok) {
    const body = (await res.json()) as {
      identity: AuthIdentity;
      session: AuthSessionInfo;
      access?: AuthAccessInfo;
    };
    return {
      ok: true,
      identity: body.identity,
      session: body.session,
      access: body.access ?? {
        mode: "session",
        passwordConfigured: true,
        ownerConfigured: true,
      },
    };
  }

  if (res.status === 401) {
    const body = (await res.json().catch(() => ({}))) as {
      reason?: string;
      access?: AuthAccessInfo;
    };
    return {
      ok: false,
      status: 401,
      reason:
        body.reason === "remote_password_not_configured"
          ? "remote_password_not_configured"
          : body.reason === "remote_auth_required"
            ? "remote_auth_required"
            : "server_error",
      access: body.access,
    };
  }

  return { ok: false, status: 503 };
}

/**
 * GET /api/auth/sessions — lists active sessions for the current identity.
 */
export async function authListSessions(): Promise<AuthSessionsResult> {
  let res: Response;
  try {
    res = await fetchWithCsrf(`${authBase()}/api/auth/sessions`, {
      credentials: "include",
    });
  } catch {
    return { ok: false, status: 401 };
  }

  if (res.ok) {
    const body = (await res.json()) as { sessions: AuthSessionListEntry[] };
    return { ok: true, sessions: body.sessions };
  }
  return {
    ok: false,
    status: res.status === 503 ? 503 : 401,
  };
}

/**
 * POST /api/auth/sessions/:id/revoke — revokes one session.
 */
export async function authRevokeSession(
  sessionId: string,
): Promise<AuthRevokeResult> {
  let res: Response;
  try {
    res = await fetchWithCsrf(
      `${authBase()}/api/auth/sessions/${encodeURIComponent(sessionId)}/revoke`,
      { method: "POST" },
    );
  } catch {
    return { ok: false, status: 500 };
  }

  if (res.ok) return { ok: true };
  if (res.status === 404) return { ok: false, status: 404 };
  if (res.status === 401) return { ok: false, status: 401 };
  return { ok: false, status: 500 };
}

export async function authChangePassword(params: {
  currentPassword?: string;
  newPassword: string;
}): Promise<AuthChangePasswordResult> {
  let res: Response;
  try {
    res = await fetchWithCsrf(`${authBase()}/api/auth/password/change`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });
  } catch (err) {
    return {
      ok: false,
      status: 500,
      reason: "server_error",
      message: err instanceof Error ? err.message : "Network error",
    };
  }

  if (res.ok) return { ok: true };

  const body = (await res.json().catch(() => ({}))) as {
    error?: string;
    reason?: string;
  };
  const reason = body.reason ?? body.error ?? "";

  if (res.status === 400 && reason === "weak_password") {
    return {
      ok: false,
      status: 400,
      reason: "weak_password",
      message:
        "Password too weak. Use at least 12 characters with a mix of letters, numbers, and symbols.",
    };
  }
  if (res.status === 401) {
    return {
      ok: false,
      status: 401,
      reason: "invalid_credentials",
      message: "Current password is incorrect.",
    };
  }
  if (res.status === 404) {
    return {
      ok: false,
      status: 404,
      reason: "owner_not_found",
      message: "No owner account exists yet.",
    };
  }
  if (res.status === 429) {
    return {
      ok: false,
      status: 429,
      reason: "rate_limited",
      message: "Too many attempts — wait a moment and try again.",
    };
  }
  return {
    ok: false,
    status: 500,
    reason: "server_error",
    message: `Unexpected error (${res.status})`,
  };
}
