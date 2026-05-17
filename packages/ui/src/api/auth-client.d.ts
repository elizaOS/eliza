/**
 * Typed client for P1 session auth endpoints.
 *
 * Calls go through `fetchWithCsrf` so cookie/session requests, bearer-token
 * requests, and desktop remote HTTP requests share one transport path.
 *
 * This module is UI-only. It deliberately does NOT import ElizaClient so it
 * can be used in auth-gated components before the main client is initialised.
 */
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
export type AuthSetupResult = {
    ok: true;
    identity: AuthIdentity;
    session: AuthSessionInfo;
    csrfToken: string;
} | {
    ok: false;
    status: 400 | 409 | 429 | 500 | 503;
    reason: "weak_password" | "invalid_display_name" | "already_initialized" | "rate_limited" | "server_error";
    message: string;
};
export type AuthLoginResult = {
    ok: true;
    identity: AuthIdentity;
    session: AuthSessionInfo;
    csrfToken: string;
} | {
    ok: false;
    status: 400 | 401 | 429 | 500;
    reason: "invalid_credentials" | "rate_limited" | "server_error";
    message: string;
};
export type AuthMeResult = {
    ok: true;
    identity: AuthIdentity;
    session: AuthSessionInfo;
    access: AuthAccessInfo;
} | {
    ok: false;
    status: 401 | 503;
    reason?: "remote_auth_required" | "remote_password_not_configured" | "server_error";
    access?: AuthAccessInfo;
};
export type AuthSessionsResult = {
    ok: true;
    sessions: AuthSessionListEntry[];
} | {
    ok: false;
    status: 401 | 503;
};
export type AuthRevokeResult = {
    ok: true;
} | {
    ok: false;
    status: 401 | 404 | 500;
};
export type AuthLogoutResult = {
    ok: true;
};
export type AuthChangePasswordResult = {
    ok: true;
} | {
    ok: false;
    status: 400 | 401 | 404 | 429 | 500;
    reason: "weak_password" | "invalid_credentials" | "owner_not_found" | "rate_limited" | "server_error";
    message: string;
};
/**
 * POST /api/auth/setup — first-run owner identity creation.
 * Returns 409 if an owner identity already exists.
 */
export declare function authSetup(params: {
    displayName: string;
    password: string;
}): Promise<AuthSetupResult>;
/**
 * POST /api/auth/login/password — password-based login.
 */
export declare function authLoginPassword(params: {
    displayName: string;
    password: string;
    rememberDevice?: boolean;
}): Promise<AuthLoginResult>;
/**
 * POST /api/auth/logout — destroys the current session.
 */
export declare function authLogout(): Promise<AuthLogoutResult>;
/**
 * GET /api/auth/me — returns the current identity + session, or 401.
 *
 * Fail closed: network errors are treated as 503 so the startup shell can
 * show a backend failure instead of a misleading credential prompt.
 */
export declare function authMe(): Promise<AuthMeResult>;
/**
 * GET /api/auth/sessions — lists active sessions for the current identity.
 */
export declare function authListSessions(): Promise<AuthSessionsResult>;
/**
 * POST /api/auth/sessions/:id/revoke — revokes one session.
 */
export declare function authRevokeSession(sessionId: string): Promise<AuthRevokeResult>;
export declare function authChangePassword(params: {
    currentPassword?: string;
    newPassword: string;
}): Promise<AuthChangePasswordResult>;
//# sourceMappingURL=auth-client.d.ts.map