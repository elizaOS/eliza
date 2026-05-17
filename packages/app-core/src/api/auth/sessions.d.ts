/**
 * Session lifecycle on top of `AuthStore`.
 *
 * This module owns:
 *   - browser session creation + sliding-TTL math
 *   - machine session creation (absolute TTL)
 *   - session lookup with sliding-window refresh
 *   - revoke (single + all-but-current)
 *   - CSRF derive / verify (HMAC-SHA256 over `session.csrfSecret`)
 *   - cookie serialize / parse for the `eliza_session` cookie
 *
 * Hard rule: every helper fails closed. A malformed cookie returns null;
 * a CSRF mismatch returns false; a session lookup error propagates. We do
 * NOT pretend bad input is good input.
 */
import type http from "node:http";
import { type RuntimeEnvRecord } from "@elizaos/shared";
import type { AuthSessionRow, AuthStore } from "../../services/auth-store";
/** Browser session sliding window: 12h. */
export declare const BROWSER_SESSION_TTL_MS: number;
/** Browser session absolute cap when `rememberDevice=true`: 30 days. */
export declare const BROWSER_SESSION_REMEMBER_CAP_MS: number;
/** Machine session absolute TTL: 90 days. */
export declare const MACHINE_SESSION_TTL_MS: number;
export declare const SESSION_COOKIE_NAME = "eliza_session";
export declare const CSRF_COOKIE_NAME = "eliza_csrf";
export declare const CSRF_HEADER_NAME = "x-eliza-csrf";
export interface CreateBrowserSessionOptions {
    identityId: string;
    ip: string | null;
    userAgent: string | null;
    rememberDevice: boolean;
    /** Override `Date.now()` for tests. */
    now?: number;
}
export interface CreateMachineSessionOptions {
    identityId: string;
    scopes: string[];
    /** Optional human label, persisted into `userAgent` for the security UI. */
    label?: string | null;
    ip?: string | null;
    /** Override `Date.now()` for tests. */
    now?: number;
}
export interface SessionWithCsrf {
    session: AuthSessionRow;
    csrfToken: string;
}
export interface SerializeSessionCookieOptions {
    /** Loopback drop the `Secure` attribute. Detected via runtime-env helpers. */
    env?: RuntimeEnvRecord;
    /** Override absolute Max-Age (ms). Defaults to `expiresAt - now`. */
    maxAgeMs?: number;
}
/**
 * Mint a browser session. Uses sliding TTL (`BROWSER_SESSION_TTL_MS`) capped
 * at 30 days when `rememberDevice` is set; otherwise the cap equals the
 * sliding window.
 *
 * Returns the persisted session and a derived CSRF token suitable for the
 * `eliza_csrf` cookie.
 */
export declare function createBrowserSession(store: AuthStore, options: CreateBrowserSessionOptions): Promise<SessionWithCsrf>;
/**
 * Mint a machine session. Absolute TTL (`MACHINE_SESSION_TTL_MS`); no sliding
 * refresh on access. Scopes are persisted exactly as supplied — caller is
 * responsible for shaping them.
 */
export declare function createMachineSession(store: AuthStore, options: CreateMachineSessionOptions): Promise<SessionWithCsrf>;
/**
 * Look up an active session by id and slide its expiry forward when it is a
 * browser session. Machine sessions get `lastSeenAt` updated but no expiry
 * extension (absolute TTL by spec).
 *
 * Returns `null` for missing / expired / revoked sessions. Errors propagate;
 * we do NOT silently treat a DB error as "session valid".
 */
export declare function findActiveSession(store: AuthStore, sessionId: string, now?: number): Promise<AuthSessionRow | null>;
export interface RevokeSessionOptions {
    store: AuthStore;
    reason: string;
    actorIdentityId: string | null;
    ip: string | null;
    userAgent: string | null;
    now?: number;
}
export declare function revokeSession(sessionId: string, options: RevokeSessionOptions): Promise<boolean>;
export interface RevokeAllSessionsOptions {
    store: AuthStore;
    identityId: string;
    exceptSessionId?: string;
    reason: string;
    ip: string | null;
    userAgent: string | null;
    now?: number;
}
export declare function revokeAllSessionsForIdentity(options: RevokeAllSessionsOptions): Promise<number>;
/**
 * Derive the CSRF token for a session. HMAC-SHA256 over the literal
 * `csrf:<sessionId>` payload using the per-session `csrfSecret` as the key.
 * The derivation is stable, so repeated calls return the same token until
 * the session is rotated.
 */
export declare function deriveCsrfToken(session: {
    id: string;
    csrfSecret: string;
}): string;
/**
 * Timing-safe compare of an incoming CSRF header against the expected
 * derived token. Empty / missing headers fail closed.
 */
export declare function verifyCsrfToken(session: {
    id: string;
    csrfSecret: string;
}, provided: string | null | undefined): boolean;
/**
 * Serialize the `eliza_session` cookie. The value is the opaque session id;
 * attributes follow plan §4.1.
 *
 * Returns the full `Set-Cookie` header value (without the leading
 * `Set-Cookie:` token). Caller is responsible for `res.setHeader`.
 */
export declare function serializeSessionCookie(session: {
    id: string;
    expiresAt: number;
}, options?: SerializeSessionCookieOptions): string;
/**
 * Serialize the readable companion CSRF cookie. Same lifetime as the
 * session cookie. NOT `HttpOnly` so the SPA can mirror it into the
 * `x-eliza-csrf` header.
 */
export declare function serializeCsrfCookie(session: {
    id: string;
    csrfSecret: string;
    expiresAt: number;
}, options?: SerializeSessionCookieOptions): string;
/** Build the cookie that destroys the session client-side (logout). */
export declare function serializeSessionExpiryCookie(options?: SerializeSessionCookieOptions): string;
/** Companion expiry cookie for `eliza_csrf`. */
export declare function serializeCsrfExpiryCookie(options?: SerializeSessionCookieOptions): string;
/**
 * Parse a raw `Cookie:` header into a typed map. Returns `Map<string,string>`
 * — keys are cookie names, values are URL-decoded raw values. Invalid or
 * empty cookies are dropped silently (per RFC 6265 §5.2 step 1).
 */
export declare function parseCookieHeader(headerValue: string | null): Map<string, string>;
/**
 * Read the eliza session id from the request cookie header. Returns null
 * when the cookie is absent or empty.
 */
export declare function parseSessionCookie(req: Pick<http.IncomingMessage, "headers">): string | null;
//# sourceMappingURL=sessions.d.ts.map