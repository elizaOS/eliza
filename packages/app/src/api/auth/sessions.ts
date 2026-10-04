/**
 * Session lifecycle on top of `AuthRepository`.
 *
 * This module owns:
 *   - browser session creation + sliding-TTL / idle-timeout math
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
  isProtectedProfileSelected,
  protectedTeeEnvironment,
} from "@elizaos/agent/security/protected-profile-state";
import {
  CSRF_COOKIE_NAME,
  LAST_ACTIVITY_HEADER_NAME,
  SESSION_COOKIE_NAME,
} from "@elizaos/auth";
import { logger } from "@elizaos/core";
import { ElizaError, isLoopbackBindHost } from "@elizaos/core/protocol";
import {
  type RuntimeEnvRecord,
  resolveApiBindHost,
} from "@elizaos/host/protocol";
import type {
  AppendAuditEventInput,
  AuthRepository,
  AuthSessionRow,
} from "../../services/auth-repository";
import { appendAuditEvent } from "./audit.js";
import {
  closeIdentitySockets,
  closeSessionSockets,
} from "./session-sockets.js";
import { extractHeaderValue, tokenMatches } from "./tokens.js";

// A successful durable revoke invalidates live transports before the HTTP
// response. Other processes converge through their bounded session rechecks.
const sessionRevocationListeners = new Set<
  (sessionId: string | null) => void
>();
export function subscribeSessionRevocations(
  listener: (sessionId: string | null) => void,
): () => void {
  sessionRevocationListeners.add(listener);
  return () => {
    sessionRevocationListeners.delete(listener);
  };
}
function notifySessionRevocation(sessionId: string | null): void {
  for (const listener of sessionRevocationListeners) {
    try {
      listener(sessionId);
    } catch (error) {
      // error-policy:J7 a failed live-socket notification cannot undo the
      // durable revoke; the next session check still denies that bearer.
      logger.warn({ error }, "[Auth] live session revocation notice failed");
    }
  }
}
// ── TTLs (plan §1.3, §4.4) ───────────────────────────────────────────────────
/** Browser session sliding window: 12h. */
export const BROWSER_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
/** Browser session absolute cap when `rememberDevice=true`: 30 days. */
export const BROWSER_SESSION_REMEMBER_CAP_MS = 30 * 24 * 60 * 60 * 1000;
/** Machine session absolute TTL: 90 days. */
export const MACHINE_SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;
/**
 * Browser idle timeout under the protected profile: 30 minutes (automatic
 * logoff, HIPAA §164.312(a)(2)(iii)).
 */
export const PROTECTED_BROWSER_SESSION_IDLE_MS = 30 * 60 * 1000;
/** Operator override for the browser idle window, in whole minutes. */
export const SESSION_IDLE_MINUTES_ENV = "ELIZA_SESSION_IDLE_MINUTES";

/** Effective browser-session lifetime rules for this process. */
export interface BrowserSessionPolicy {
  /** Sliding inactivity window; a session idle this long is expired. */
  idleMs: number;
  /** Absolute lifetime from creation without "remember device". */
  absoluteCapMs: number;
  /** Absolute lifetime from creation with "remember device". */
  rememberCapMs: number;
  /**
   * True when an idle policy is active (protected profile or
   * `ELIZA_SESSION_IDLE_MINUTES`): the idle window then slides only on the
   * client-reported last user interaction (`x-eliza-last-activity`), never on
   * background polling or WebSocket traffic.
   */
  activityTracked: boolean;
}

function parseIdleMinutes(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const trimmed = raw.trim();
  const minutes = /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
  if (!Number.isSafeInteger(minutes) || minutes <= 0) {
    throw new ElizaError(
      `${SESSION_IDLE_MINUTES_ENV} must be a positive integer`,
      {
        code: "AUTH_SESSION_IDLE_MINUTES_INVALID",
        context: { env: SESSION_IDLE_MINUTES_ENV },
      },
    );
  }
  return minutes;
}

/**
 * Resolve the browser-session policy. Ordinary hosts slide 12h (up to 30 days
 * with "remember device"). The protected profile adds a 30-minute idle
 * timeout and a hard 12h cap that "remember device" cannot extend.
 * `ELIZA_SESSION_IDLE_MINUTES` sets the idle window in any profile; under the
 * protected profile it is read from the frozen entry environment. Machine
 * (device-bound) sessions are not governed by this policy.
 */
export function resolveBrowserSessionPolicy(): BrowserSessionPolicy {
  const protectedProfile = isProtectedProfileSelected();
  const idleMinutes = parseIdleMinutes(
    protectedTeeEnvironment()[SESSION_IDLE_MINUTES_ENV],
  );
  const defaultIdleMs = protectedProfile
    ? PROTECTED_BROWSER_SESSION_IDLE_MS
    : BROWSER_SESSION_TTL_MS;
  return {
    idleMs: idleMinutes === undefined ? defaultIdleMs : idleMinutes * 60 * 1000,
    absoluteCapMs: BROWSER_SESSION_TTL_MS,
    rememberCapMs: protectedProfile
      ? BROWSER_SESSION_TTL_MS
      : BROWSER_SESSION_REMEMBER_CAP_MS,
    activityTracked: protectedProfile || idleMinutes !== undefined,
  };
}

/**
 * Allowance for a client clock running ahead of the server. A claimed
 * activity time beyond it is a forgery or a broken clock and is ignored;
 * within it the claim is clamped to the server's `now`.
 */
export const LAST_ACTIVITY_CLOCK_SKEW_MS = 60 * 1000;

/**
 * Parse the client-reported last user interaction (epoch ms). Returns null
 * when absent or not a plain non-negative integer; plausibility against the
 * session and the clock is checked in `findActiveSession`.
 */
export function readLastActivityHeader(
  req: Pick<http.IncomingMessage, "headers">,
): number | null {
  const raw = extractHeaderValue(
    req.headers[LAST_ACTIVITY_HEADER_NAME],
  )?.trim();
  if (!raw || !/^\d{1,16}$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

function browserSessionHardExpiry(
  session: { createdAt: number; rememberDevice: boolean },
  policy: BrowserSessionPolicy,
): number {
  return (
    session.createdAt +
    (session.rememberDevice ? policy.rememberCapMs : policy.absoluteCapMs)
  );
}

// ── Cookie constants ─────────────────────────────────────────────────────────
// Single source shared with the browser client so the names cannot drift.
export {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  LAST_ACTIVITY_HEADER_NAME,
  SESSION_COOKIE_NAME,
} from "@elizaos/auth";
// ── Types ────────────────────────────────────────────────────────────────────
export interface CreateBrowserSessionOptions {
  identityId: string;
  ip: string | null;
  userAgent: string | null;
  rememberDevice: boolean;
  /** Capability restrictions enforced by the canonical request resolver. */
  scopes?: string[];
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
/**
 * Session fields the cookie serializers read. Browser rows (`kind`,
 * `createdAt`, `rememberDevice`) get a cookie that outlives the sliding idle
 * expiry, because the cookie is only set at login: the server enforces the
 * idle window, the cookie only bounds the absolute lifetime.
 */
export interface SessionCookieSource {
  id: string;
  expiresAt: number;
  kind?: AuthSessionRow["kind"];
  createdAt?: number;
  rememberDevice?: boolean;
}
export interface SerializeSessionCookieOptions {
  /** Loopback drop the `Secure` attribute. Detected via runtime-env helpers. */
  env?: RuntimeEnvRecord;
  /** Override absolute Max-Age (ms). Defaults to `expiresAt - now`. */
  maxAgeMs?: number;
  /**
   * Expiry cookies only: target a `Domain=` variant. The desktop bridge
   * installs domain cookies, which a host-only expiry cannot clear.
   */
  domain?: string;
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
 * Mint a browser session. Its expiry slides by the policy idle window
 * (`resolveBrowserSessionPolicy`) up to the policy's absolute cap.
 *
 * Returns the persisted session and a derived CSRF token suitable for the
 * `eliza_csrf` cookie.
 */
export async function createBrowserSession(
  store: AuthRepository,
  options: CreateBrowserSessionOptions,
): Promise<SessionWithCsrf> {
  const now = options.now ?? Date.now();
  const id = generateSessionId();
  const csrfSecret = generateCsrfSecret();
  const rememberDevice = Boolean(options.rememberDevice);
  const policy = resolveBrowserSessionPolicy();
  const expiresAt = Math.min(
    now + policy.idleMs,
    browserSessionHardExpiry({ createdAt: now, rememberDevice }, policy),
  );
  const session = await store.createSession({
    id,
    identityId: options.identityId,
    kind: "browser",
    createdAt: now,
    lastSeenAt: now,
    expiresAt,
    rememberDevice,
    csrfSecret,
    ip: options.ip,
    userAgent: options.userAgent,
    scopes: [...(options.scopes ?? [])],
  });
  return { session, csrfToken: deriveCsrfToken(session) };
}
/**
 * Mint a machine session. Absolute TTL (`MACHINE_SESSION_TTL_MS`); no sliding
 * refresh on access. Scopes are persisted exactly as supplied — caller is
 * responsible for shaping them.
 */
export async function createMachineSession(
  store: AuthRepository,
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
 * Route-layer wrapper for the fail-closed handling of an auth-store read
 * rejection. `findActiveSession` / `findIdentity` resolve `null` for a genuine
 * miss and reject only on real infrastructure failure, so a rejection must not
 * be silently collapsed into "unauthenticated": that hides a broken auth DB
 * behind a stream of 401s. Deny (return `null`, fail closed) but surface the
 * failure through the structured logger so the outage is observable.
 *
 * @param scope the auth-store operation, used in the `[Auth]` log prefix.
 */
// error-policy:J4 auth-store read failed → fail-closed deny; failure surfaced via logger
export function denyOnAuthStoreError(scope: string): (error: unknown) => null {
  return (error) => {
    logger.error(
      {
        scope,
        // cause FIRST: the pretty transport truncates long fields, and the
        // multi-line SQL in `error` swallowed everything after it — the cause
        // chain is the only place the real PG failure lives (live 2026-08-28:
        // hours of continuous auth denies undiagnosable from this log line).
        cause:
          error instanceof Error && error.cause
            ? String(
                error.cause instanceof Error
                  ? error.cause.message
                  : error.cause,
              ).slice(0, 240)
            : "(no cause)",
        error: (error instanceof Error ? error.message : String(error)).slice(
          0,
          120,
        ),
        stack: error instanceof Error ? error.stack : undefined,
      },
      `[Auth] ${scope} failed; failing closed (deny)`,
    );
    return null;
  };
}
export interface FindActiveSessionOptions {
  /**
   * Client-reported last user interaction (epoch ms, from
   * `readLastActivityHeader`). Only HTTP requests from the dashboard carry it;
   * WebSocket and other lookups omit it.
   */
  lastActivityAt?: number | null;
}
/**
 * Look up an active session by id and slide its expiry forward when it is a
 * browser session. A browser session idle for the policy window is expired
 * even when its stored expiry is later (sessions minted elsewhere). Under an
 * idle policy (`activityTracked`) the window slides only to a plausible
 * client-reported interaction time — not in the future beyond clock skew,
 * not before the session existed — so background polling and WebSocket
 * traffic authenticate until the idle expiry without extending it. Machine
 * sessions get `lastSeenAt` updated but no expiry extension (absolute TTL by
 * spec).
 *
 * Returns `null` for missing / expired / revoked sessions. Errors propagate;
 * we do NOT silently treat a DB error as "session valid".
 */
export async function findActiveSession(
  store: AuthRepository,
  sessionId: string,
  now: number = Date.now(),
  options: FindActiveSessionOptions = {},
): Promise<AuthSessionRow | null> {
  const found = await store.findSession(sessionId, now);
  if (!found) return null;
  if (found.kind === "browser") {
    const policy = resolveBrowserSessionPolicy();
    if (now - found.lastSeenAt >= policy.idleMs) return null;
    const cap = browserSessionHardExpiry(found, policy);
    if (cap <= now) return null;
    let activityAt = now;
    if (policy.activityTracked) {
      const claimed = options.lastActivityAt;
      if (
        typeof claimed !== "number" ||
        claimed < found.createdAt ||
        claimed > now + LAST_ACTIVITY_CLOCK_SKEW_MS
      ) {
        return found;
      }
      activityAt = Math.min(now, claimed);
      if (activityAt <= found.lastSeenAt) return found;
    }
    const nextExpiresAt = Math.min(activityAt + policy.idleMs, cap);
    if (nextExpiresAt <= now) return null;
    if (nextExpiresAt !== found.expiresAt || activityAt !== found.lastSeenAt) {
      await store.touchSession(found.id, activityAt, nextExpiresAt);
    }
    return { ...found, lastSeenAt: activityAt, expiresAt: nextExpiresAt };
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
  store: AuthRepository;
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
  // Open WebSockets admitted by this session end now, not at next handshake.
  closeSessionSockets(sessionId);
  if (ok) notifySessionRevocation(sessionId);
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
  store: AuthRepository;
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
  closeIdentitySockets(options.identityId, options.exceptSessionId);
  if (count > 0) notifySessionRevocation(null);
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
  session: {
    id: string;
    csrfSecret: string;
  },
  provided: string | null | undefined,
): boolean {
  if (typeof provided !== "string" || provided.length === 0) return false;
  const expected = deriveCsrfToken(session);
  return tokenMatches(expected, provided);
}
// ── Cookie serialize / parse ─────────────────────────────────────────────────
/**
 * Cookie deadline: the stored expiry, extended for browser sessions to the
 * absolute cap (bounded by the 12h sliding window it replaced, so ordinary
 * hosts keep their historical cookie lifetime).
 */
function sessionCookieExpiresAt(session: SessionCookieSource): number {
  if (session.kind !== "browser" || typeof session.createdAt !== "number") {
    return session.expiresAt;
  }
  const hardExpiry = browserSessionHardExpiry(
    {
      createdAt: session.createdAt,
      rememberDevice: Boolean(session.rememberDevice),
    },
    resolveBrowserSessionPolicy(),
  );
  return Math.max(
    session.expiresAt,
    Math.min(hardExpiry, session.createdAt + BROWSER_SESSION_TTL_MS),
  );
}
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
  session: SessionCookieSource,
  options: SerializeSessionCookieOptions = {},
): string {
  const env = options.env ?? process.env;
  const now = Date.now();
  const ageMs =
    options.maxAgeMs ?? Math.max(0, sessionCookieExpiresAt(session) - now);
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
  session: SessionCookieSource & { csrfSecret: string },
  options: SerializeSessionCookieOptions = {},
): string {
  const env = options.env ?? process.env;
  const now = Date.now();
  const ageMs =
    options.maxAgeMs ?? Math.max(0, sessionCookieExpiresAt(session) - now);
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
  if (options.domain) parts.push(`Domain=${options.domain}`);
  if (shouldEmitSecureFlag(env)) parts.push("Secure");
  return parts.join("; ");
}
/** Companion expiry cookie for `eliza_csrf`. */
export function serializeCsrfExpiryCookie(
  options: SerializeSessionCookieOptions = {},
): string {
  const env = options.env ?? process.env;
  const parts = [`${CSRF_COOKIE_NAME}=`, "Path=/", "SameSite=Lax", "Max-Age=0"];
  if (options.domain) parts.push(`Domain=${options.domain}`);
  if (shouldEmitSecureFlag(env)) parts.push("Secure");
  return parts.join("; ");
}
/**
 * Parse a raw `Cookie:` header into a typed map. Keys are cookie names, values
 * are URL-decoded values. Fails closed on ambiguity: a name that appears more
 * than once with differing values (e.g. a sibling-subdomain cookie shadowing
 * ours) and a value with a malformed percent-escape are both omitted, so callers see no cookie rather
 * than an attacker-chosen one. Empty values are dropped (RFC 6265 §5.2).
 */
export function parseCookieHeader(
  headerValue: string | null,
): Map<string, string> {
  const out = new Map<string, string>();
  const rejected = new Set<string>();
  if (!headerValue) return out;
  for (const part of headerValue.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (!k || rejected.has(k)) continue;
    const v = part.slice(eq + 1).trim();
    let decoded: string;
    try {
      decoded = decodeURIComponent(v);
    } catch {
      // error-policy:J3 untrusted cookie values — a malformed percent-escape
      // is an absent cookie, never a raw pass-through.
      out.delete(k);
      rejected.add(k);
      continue;
    }
    const existing = out.get(k);
    // Identical copies (host-only and domain variants of one session) are
    // unambiguous; differing copies are not.
    if (
      decoded.length === 0 ||
      (existing !== undefined && existing !== decoded)
    ) {
      out.delete(k);
      rejected.add(k);
      continue;
    }
    out.set(k, decoded);
  }
  return out;
}
/**
 * Read one cookie from a request. Returns null when the cookie is absent,
 * empty, malformed, or present more than once.
 */
export function readCookie(
  req: Pick<http.IncomingMessage, "headers">,
  name: string,
): string | null {
  return (
    parseCookieHeader(extractHeaderValue(req.headers.cookie)).get(name) ?? null
  );
}
/**
 * Every distinct, well-formed value of one cookie, including conflicting
 * duplicates that `readCookie` rejects. Only for paths that must act on every
 * credential the browser presents (logout revokes each); never use it to
 * choose an authenticating value.
 */
export function readAllCookieValues(
  req: Pick<http.IncomingMessage, "headers">,
  name: string,
): string[] {
  const headerValue = extractHeaderValue(req.headers.cookie);
  if (!headerValue) return [];
  const values = new Set<string>();
  for (const part of headerValue.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0 || part.slice(0, eq).trim() !== name) continue;
    try {
      const decoded = decodeURIComponent(part.slice(eq + 1).trim());
      if (decoded.length > 0) values.add(decoded);
    } catch {
      // error-policy:J3 a malformed percent-escape is not a credential.
    }
  }
  return [...values];
}
/**
 * Read the eliza session id from the request cookie header. Returns null
 * when the cookie is absent, empty, malformed, or duplicated.
 */
export function parseSessionCookie(
  req: Pick<http.IncomingMessage, "headers">,
): string | null {
  return readCookie(req, SESSION_COOKIE_NAME);
}
