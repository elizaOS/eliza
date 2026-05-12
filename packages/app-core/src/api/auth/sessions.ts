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

import crypto from "node:crypto";
import type http from "node:http";
import {
  isLoopbackBindHost,
  type RuntimeEnvRecord,
  resolveApiBindHost,
} from "@elizaos/shared";
import type {
  AppendAuditEventInput,
  AuthSessionRow,
  AuthStore,
} from "../../services/auth-store";
import { appendAuditEvent } from "./audit";
import { tokenMatches } from "./tokens";

// ── TTLs (plan §1.3, §4.4) ───────────────────────────────────────────────────

/** Browser session sliding window: 12h. */
export const BROWSER_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
/** Browser session absolute cap when `rememberDevice=true`: 30 days. */
export const BROWSER_SESSION_REMEMBER_CAP_MS = 30 * 24 * 60 * 60 * 1000;
/** Machine session absolute TTL: 90 days. */
export const MACHINE_SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;

// ── Cookie constants ─────────────────────────────────────────────────────────

export const SESSION_COOKIE_NAME = "eliza_session";
export const CSRF_COOKIE_NAME = "eliza_csrf";
export const CSRF_HEADER_NAME = "x-eliza-csrf";

// ── Types ────────────────────────────────────────────────────────────────────

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

// ── ID + secret generation ───────────────────────────────────────────────────

/** 256-bit hex session id. Cookie value. */
function generateSessionId(): string {
  return crypto.randomBytes(32).toString("hex");
}

/** 256-bit hex CSRF secret. Per-session, never sent to clients raw. */
function generateCsrfSecret(): string {
  return crypto.randomBytes(32).toString("hex");
}

// ── Creation ─────────────────────────────────────────────────────────────────

/**
 * Mint a browser session. Uses sliding TTL (`BROWSER_SESSION_TTL_MS`) capped
 * at 30 days when `rememberDevice` is set; otherwise the cap equals the
 * sliding window.
 *
 * Returns the persisted session and a derived CSRF token suitable for the
 * `eliza_csrf` cookie.
 */
export async function createBrowserSession(
  store: AuthStore,
  options: CreateBrowserSessionOptions,
): Promise<SessionWithCsrf> {
  const now = options.now ?? Date.now();
  const id = generateSessionId();
  const csrfSecret = generateCsrfSecret();
  const expiresAt = now + BROWSER_SESSION_TTL_MS;
  const session = await store.createSession({
    id,
    identityId: options.identityId,
    kind: "browser",
    createdAt: now,
    lastSeenAt: now,
    expiresAt,
    rememberDevice: Boolean(options.rememberDevice),
    csrfSecret,
    ip: options.ip,
    userAgent: options.userAgent,
    scopes: [],
  });
  return { session, csrfToken: deriveCsrfToken(session) };
}

/**
 * Mint a machine session. Absolute TTL (`MACHINE_SESSION_TTL_MS`); no sliding
 * refresh on access. Scopes are persisted exactly as supplied — caller is
 * responsible for shaping them.
 */
export async function createMachineSession(
  store: AuthStore,
  options: CreateMachineSessionOptions,
): Promise<SessionWithCsrf> {
  const now = options.now ?? Date.now();
  const id = generateSessionId();
  const csrfSecret = generateCsrfSecret();
  const expiresAt = now + MACHINE_SESSION_TTL_MS;
  const session = await store.createSession({
    id,
    identityId: options.identityId,
    kind: "machine",
    createdAt: now,
    lastSeenAt: now,
    expiresAt,
    rememberDevice: false,
    csrfSecret,
    ip: options.ip ?? null,
    userAgent: options.label ?? null,
    scopes: [...options.scopes],
  });
  return { session, csrfToken: deriveCsrfToken(session) };
}

// ── Lookup with sliding refresh ──────────────────────────────────────────────

/**
 * Look up an active session by id and slide its expiry forward when it is a
 * browser session. Machine sessions get `lastSeenAt` updated but no expiry
 * extension (absolute TTL by spec).
 *
 * Returns `null` for missing / expired / revoked sessions. Errors propagate;
 * we do NOT silently treat a DB error as "session valid".
 */
export async function findActiveSession(
  store: AuthStore,
  sessionId: string,
  now: number = Date.now(),
): Promise<AuthSessionRow | null> {
  const found = await store.findSession(sessionId, now);
  if (!found) return null;

  if (found.kind === "browser") {
    const cap = found.rememberDevice
      ? found.createdAt + BROWSER_SESSION_REMEMBER_CAP_MS
      : found.createdAt + BROWSER_SESSION_TTL_MS;
    const proposed = now + BROWSER_SESSION_TTL_MS;
    const nextExpiresAt = Math.min(proposed, cap);
    if (nextExpiresAt <= now) return null;
    if (nextExpiresAt !== found.expiresAt || now !== found.lastSeenAt) {
      await store.touchSession(found.id, now, nextExpiresAt);
    }
    return { ...found, lastSeenAt: now, expiresAt: nextExpiresAt };
  }

  if (found.kind === "machine") {
    if (now !== found.lastSeenAt) {
      await store.touchSession(found.id, now, found.expiresAt);
    }
    return { ...found, lastSeenAt: now };
  }

  return found;
}

// ── Revocation ───────────────────────────────────────────────────────────────

export interface RevokeSessionOptions {
  store: AuthStore;
  reason: string;
  actorIdentityId: string | null;
  ip: string | null;
  userAgent: string | null;
  now?: number;
}

export async function revokeSession(
  sessionId: string,
  options: RevokeSessionOptions,
): Promise<boolean> {
  const now = options.now ?? Date.now();
  const ok = await options.store.revokeSession(sessionId, now);
  const audit: AppendAuditEventInput = {
    id: crypto.randomUUID(),
    ts: now,
    actorIdentityId: options.actorIdentityId,
    ip: options.ip,
    userAgent: options.userAgent,
    action: "auth.session.revoke",
    outcome: ok ? "success" : "failure",
    metadata: { sessionId, reason: options.reason },
  };
  await appendAuditEvent(audit, { store: options.store });
  return ok;
}

export interface RevokeAllSessionsOptions {
  store: AuthStore;
  identityId: string;
  exceptSessionId?: string;
  reason: string;
  ip: string | null;
  userAgent: string | null;
  now?: number;
}

export async function revokeAllSessionsForIdentity(
  options: RevokeAllSessionsOptions,
): Promise<number> {
  const now = options.now ?? Date.now();
  const count = await options.store.revokeAllSessionsForIdentity(
    options.identityId,
    now,
    options.exceptSessionId,
  );
  await appendAuditEvent(
    {
      actorIdentityId: options.identityId,
      ip: options.ip,
      userAgent: options.userAgent,
      action: "auth.session.revoke_all",
      outcome: "success",
      metadata: {
        identityId: options.identityId,
        reason: options.reason,
        revoked: count,
      },
    },
    { store: options.store },
  );
  return count;
}

// ── CSRF (double-submit) ─────────────────────────────────────────────────────

/**
 * Derive the CSRF token for a session. HMAC-SHA256 over the literal
 * `csrf:<sessionId>` payload using the per-session `csrfSecret` as the key.
 * The derivation is stable, so repeated calls return the same token until
 * the session is rotated.
 */
export function deriveCsrfToken(session: {
  id: string;
  csrfSecret: string;
}): string {
  return crypto
    .createHmac("sha256", session.csrfSecret)
    .update(`csrf:${session.id}`)
    .digest("hex");
}

/**
 * Timing-safe compare of an incoming CSRF header against the expected
 * derived token. Empty / missing headers fail closed.
 */
export function verifyCsrfToken(
  session: { id: string; csrfSecret: string },
  provided: string | null | undefined,
): boolean {
  if (typeof provided !== "string" || provided.length === 0) return false;
  const expected = deriveCsrfToken(session);
  return tokenMatches(expected, provided);
}

// ── Cookie serialize / parse ─────────────────────────────────────────────────

/**
 * Should the cookie carry the `Secure` attribute? Plan §4.1: drop `Secure`
 * only when bound on loopback (the Electrobun shell). Detect via the same
 * env helpers as the rest of the runtime.
 */
function shouldEmitSecureFlag(env: RuntimeEnvRecord): boolean {
  const bind = resolveApiBindHost(env);
  return !isLoopbackBindHost(bind);
}

/**
 * Serialize the `eliza_session` cookie. The value is the opaque session id;
 * attributes follow plan §4.1.
 *
 * Returns the full `Set-Cookie` header value (without the leading
 * `Set-Cookie:` token). Caller is responsible for `res.setHeader`.
 */
export function serializeSessionCookie(
  session: { id: string; expiresAt: number },
  options: SerializeSessionCookieOptions = {},
): string {
  const env = options.env ?? process.env;
  const now = Date.now();
  const ageMs = options.maxAgeMs ?? Math.max(0, session.expiresAt - now);
  const ageSec = Math.floor(ageMs / 1000);
  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(session.id)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${ageSec}`,
  ];
  if (shouldEmitSecureFlag(env)) parts.push("Secure");
  return parts.join("; ");
}

/**
 * Serialize the readable companion CSRF cookie. Same lifetime as the
 * session cookie. NOT `HttpOnly` so the SPA can mirror it into the
 * `x-eliza-csrf` header.
 */
export function serializeCsrfCookie(
  session: { id: string; csrfSecret: string; expiresAt: number },
  options: SerializeSessionCookieOptions = {},
): string {
  const env = options.env ?? process.env;
  const now = Date.now();
  const ageMs = options.maxAgeMs ?? Math.max(0, session.expiresAt - now);
  const ageSec = Math.floor(ageMs / 1000);
  const csrfToken = deriveCsrfToken(session);
  const parts = [
    `${CSRF_COOKIE_NAME}=${encodeURIComponent(csrfToken)}`,
    "Path=/",
    "SameSite=Lax",
    `Max-Age=${ageSec}`,
  ];
  if (shouldEmitSecureFlag(env)) parts.push("Secure");
  return parts.join("; ");
}

/** Build the cookie that destroys the session client-side (logout). */
export function serializeSessionExpiryCookie(
  options: SerializeSessionCookieOptions = {},
): string {
  const env = options.env ?? process.env;
  const parts = [
    `${SESSION_COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
  ];
  if (shouldEmitSecureFlag(env)) parts.push("Secure");
  return parts.join("; ");
}

/** Companion expiry cookie for `eliza_csrf`. */
export function serializeCsrfExpiryCookie(
  options: SerializeSessionCookieOptions = {},
): string {
  const env = options.env ?? process.env;
  const parts = [`${CSRF_COOKIE_NAME}=`, "Path=/", "SameSite=Lax", "Max-Age=0"];
  if (shouldEmitSecureFlag(env)) parts.push("Secure");
  return parts.join("; ");
}

/**
 * Parse a raw `Cookie:` header into a typed map. Returns `Map<string,string>`
 * — keys are cookie names, values are URL-decoded raw values. Invalid or
 * empty cookies are dropped silently (per RFC 6265 §5.2 step 1).
 */
export function parseCookieHeader(
  headerValue: string | null,
): Map<string, string> {
  const out = new Map<string, string>();
  if (!headerValue) return out;
  for (const part of headerValue.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (!k) continue;
    const v = part.slice(eq + 1).trim();
    if (v.length === 0) continue;
    try {
      out.set(k, decodeURIComponent(v));
    } catch {
      out.set(k, v);
    }
  }
  return out;
}

/**
 * Read the eliza session id from the request cookie header. Returns null
 * when the cookie is absent or empty.
 */
export function parseSessionCookie(
  req: Pick<http.IncomingMessage, "headers">,
): string | null {
  const raw = req.headers.cookie;
  const headerValue = Array.isArray(raw) ? raw[0] : raw;
  const cookies = parseCookieHeader(headerValue ?? null);
  const value = cookies.get(SESSION_COOKIE_NAME);
  return value && value.length > 0 ? value : null;
}
