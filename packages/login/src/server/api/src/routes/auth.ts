/**
 * Serves identity login, account enrollment, MFA and session lifecycle endpoints.
 * Tenant policy gates every login method; one-time challenges and refresh tokens
 * use atomic storage operations so concurrent requests cannot replay credentials.
 */

import {
  createPublicKey,
  randomBytes,
  verify as verifySignature,
} from "node:crypto";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { logger } from "@elizaos/logger";
import bs58 from "bs58";
import { and, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { errors as joseErrors } from "jose";
import { generateNonce, SiweMessage } from "siwe";
import { getAddress, verifyMessage as viemVerifyMessage } from "viem";
import {
  ACCESS_TOKEN_EXPIRY,
  ACCESS_TOKEN_EXPIRY_SECONDS,
  assertPinnedDnsTransportSupported,
  assertPublicHttpsEndpoint,
  buildBackend,
  buildOtpauthUri,
  buildSamlAuthorizeUrl,
  ChallengeStore,
  createPublicInternetLookup,
  EmailAuth,
  type EmailAuthConfig,
  EmailDeliveryError,
  EmailDeliveryNotConfiguredError,
  evaluateSiwePolicy,
  type FarcasterLoginPayload,
  generateApiKey,
  generateRecoveryCodes,
  generateTotpSecret,
  getEnabledProviders,
  getIdentityJwtIssuer,
  getProviderConfig,
  hashSha256Hex,
  IdentityJwtConfigurationError,
  InMemoryRecoveryCodeStore,
  isBuiltInProvider,
  isDevSecretAllowed,
  isValidE164,
  type MagicLinkTemplateData,
  type ManagedSmsOtpProvider,
  MockEmailInbox,
  MockEmailProvider,
  MockSmsInbox,
  MockSmsProvider,
  magicLinkTemplateValues,
  OAuthClient,
  type OtpTemplateData,
  otpTemplateValues,
  PasskeyAuth,
  PhoneAuth,
  type RecoveryCodeStore,
  ResendProvider,
  renderCustomTemplate,
  revocationStore,
  SmsChallengeInProgressError,
  type SmsProvider,
  SmsVerificationNotAttemptedError,
  type StoreBackend,
  type StoredRecoveryCode,
  signAccessToken,
  signIdentityJwtPayload,
  type TelegramLoginPayload,
  TokenStore,
  TwilioSmsProvider,
  TwilioVerifyProvider,
  uint8ArrayToBase64url,
  unusedRecoveryCodeCount,
  verifyFarcasterLogin,
  verifyOidcJwt,
  verifyRecoveryCode,
  verifySamlAcsResponse,
  verifyTelegramLogin,
  verifyToken,
  verifyTotp,
} from "../../../auth/src/index.ts";
import {
  accounts,
  authenticators,
  getDatabaseDriver,
  getDb,
  hasTenantTransactionDatabase,
  refreshTokens,
  type TenantEmailConfig,
  tenantContextFromAuthenticatedPrincipal,
  tenantSamlAssertionReplays,
  tenantSamlAuthnRequests,
  tenantSamlSsoConfigs,
  tenants,
  users,
  userTenants,
  withTenantRlsTransaction,
  withTenantTransactionDatabase,
} from "../../../db/src/index.ts";
import {
  type ApiResponse,
  redactedThrownDiagnostics,
  type SsoDiscoveryResult,
  type TenantAuthAbuseConfig,
  type TenantOidcProviderConfig,
  type TenantSamlSsoConfig,
  type TenantTestAccountConfig,
} from "../../../shared/src/index.ts";
import { runtimeEnvironmentValue } from "../../../shared/src/runtime-env.ts";
import {
  KeyStore,
  provisionUserWallet,
  type Vault,
} from "../../../vault/src/index.ts";
import { formatRateLimitHeaders } from "../middleware/redis-enforcement";
import {
  type AuditEventInput,
  writeAuditEvent as appendAuthAuditEvent,
} from "../services/audit";
import {
  publicAuthAbuseConfig,
  validateEmailAbusePolicy,
  validatePhoneAbusePolicy,
  validateWalletAbusePolicy,
  verifyCaptchaToken,
} from "../services/auth-abuse";
import { verifySessionToken } from "../services/context";
import { defaultAuthTenantId } from "../services/default-auth-tenant";
import { verifyEip1271 } from "../services/eip1271";
import {
  isAllowedOidcClientSecretEnvForTenant,
  normalizeOidcProviders,
} from "../services/oidc-provider-config";
import { socketPeerFromEnv } from "../services/runtime-gate";
import { buildSamlServiceProviderUrls } from "../services/saml-sso-config";
import { lockUserSession } from "../services/session-lock";
import { testAccountOtpMatches } from "../services/test-account-credentials";
import { getConfiguredVault } from "../services/vault-factory";
import { dispatchWebhook } from "../services/webhook-dispatch";

// ─── Constants ────────────────────────────────────────────────────────────────

async function withVerifiedAuthTenant<T>(
  tenantId: string,
  subject: string,
  callback: () => Promise<T>,
): Promise<T> {
  if (hasTenantTransactionDatabase({ tenantId, userId: subject }))
    return callback();
  const context = tenantContextFromAuthenticatedPrincipal({
    tenantId,
    method: "verified-auth-flow",
    subject,
    userId: subject,
  });
  const driver =
    process.env.STEWARD_DB_MODE === "pglite" ||
    process.env.STEWARD_PGLITE_MEMORY === "true"
      ? "pglite"
      : getDatabaseDriver();
  return withTenantRlsTransaction(
    getDb() as never,
    driver,
    context,
    async (tx) =>
      withTenantTransactionDatabase(
        tx as never,
        { tenantId, userId: subject },
        callback,
      ),
  );
}

async function withPreAuthTenant<T>(
  tenantId: string,
  method: string,
  callback: () => Promise<T>,
): Promise<T> {
  if (hasTenantTransactionDatabase({ tenantId })) return callback();
  const context = tenantContextFromAuthenticatedPrincipal({
    tenantId,
    method,
    subject: "public-auth-flow",
  });
  const driver =
    process.env.STEWARD_DB_MODE === "pglite" ||
    process.env.STEWARD_PGLITE_MEMORY === "true"
      ? "pglite"
      : getDatabaseDriver();
  return withTenantRlsTransaction(
    getDb() as never,
    driver,
    context,
    async (tx) =>
      withTenantTransactionDatabase(tx as never, { tenantId }, callback),
  );
}

/** Keeps login audit writes within their tenant's transaction-local policy context. */
async function writeAuditEvent(event: AuditEventInput): Promise<void> {
  return withPreAuthTenant(event.tenantId, "auth-audit", () =>
    appendAuthAuditEvent(event),
  );
}

function isValidTenantId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_\-.:]{1,64}$/.test(value);
}

function isReservedTenantId(value: string): boolean {
  const normalized = value.toLowerCase();
  return (
    normalized === "personal" ||
    normalized.startsWith("personal-") ||
    normalized.startsWith("eth:") ||
    normalized.startsWith("t-") ||
    normalized.startsWith("solana:")
  );
}

function normalizeEmailDomain(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  const at = email.lastIndexOf("@");
  if (at <= 0 || at >= email.length - 1) return null;
  const domain = email.slice(at + 1);
  if (
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(
      domain,
    )
  ) {
    return null;
  }
  return domain;
}

// ─── Trusted client IP + auth rate limiting ──────────────────────────────────

/**
 * Number of trusted reverse proxies that APPEND to x-forwarded-for before
 * requests reach this process. The client IP is the entry that many hops from
 * the RIGHT; anything a client prepends (further left) is ignored. On bare
 * Railway this is 2: x-forwarded-for arrives as "<client>, <railway-edge>" and
 * the right-most edge entry ROTATES between Railway's proxy nodes, so hops=1
 * scatters one client across buckets while hops=2 locks onto the stable client
 * entry (verified against prod). Set it to the EXACT number of appending
 * proxies; overestimating re-opens spoofing. Unset, empty, or invalid values mean no forwarded header
 * is trusted (safe default — a typo can never widen trust). The deprecated
 * STEWARD_TRUST_PROXY_HEADERS=true is honored as hops=1 with right-most
 * semantics; the old left-most read was client-spoofable and is deliberately
 * not preserved.
 */
function trustedProxyHops(): number {
  const raw = process.env.STEWARD_TRUSTED_PROXY_HOPS?.trim();
  if (raw === undefined || raw === "") {
    return process.env.STEWARD_TRUST_PROXY_HEADERS === "true" ? 1 : 0;
  }
  // Canonical non-negative integer only: "1.5" must not truncate into trust.
  if (!/^\d+$/.test(raw)) return 0;
  const parsed = Number.parseInt(raw, 10);
  return parsed > 0 && parsed <= 10 ? parsed : 0;
}

/**
 * Normalize one forwarded-address candidate to a bare IP, or undefined.
 * Proxies (Railway's Envoy edge included) sometimes forward `ip:port` or
 * `[ipv6]:port`, both of which node's isIP rejects, so the port is stripped
 * first — but only where it is unambiguous: brackets always delimit an IPv6
 * address, and a single colon can only be IPv4:port (bare IPv6 always
 * contains at least two colons and is never truncated).
 */
function normalizeIpCandidate(value: string | undefined): string | undefined {
  let candidate = value?.trim();
  if (!candidate) return undefined;
  const bracketed = /^\[([^\]]+)\](?::\d{1,5})?$/.exec(candidate);
  if (bracketed?.[1]) {
    candidate = bracketed[1];
  } else {
    const ipv4Port = /^([^:]+):\d{1,5}$/.exec(candidate);
    if (ipv4Port?.[1]) candidate = ipv4Port[1];
  }
  return isIP(candidate) ? candidate : undefined;
}

let clientIpDiagLoggedAt = 0;

/**
 * TEMPORARY diagnostics — remove once Railway's forwarded-header shape is
 * confirmed in production logs. Fires (throttled) only when trust IS
 * configured yet no candidate validated. Never log raw forwarded headers:
 * they are attacker-controlled and may contain credential-shaped content.
 */
function logNoTrustedClientIpDiag(c: Context, hops: number): void {
  const now = Date.now();
  if (now - clientIpDiagLoggedAt < 60_000) return;
  clientIpDiagLoggedAt = now;
  logger.warn(
    {
      details: [
        "[AuthRateLimit][diag] trust configured but no client IP derived; falling back to coarse subject",
        JSON.stringify({
          hops,
          forwardedForPresent: Boolean(c.req.header("x-forwarded-for")),
          envoyAddressPresent: Boolean(
            c.req.header("x-envoy-external-address"),
          ),
          cloudflareAddressPresent: Boolean(c.req.header("cf-connecting-ip")),
        }),
      ],
    },
    "[Login:auth] warn",
  );
}

/**
 * Best-effort trustworthy client IP, or undefined when none can be derived.
 *
 * - cf-connecting-ip is honored only when STEWARD_TRUST_CLOUDFLARE=true AND
 *   origin ingress is locked to Cloudflare. This service is served directly
 *   by Railway today (no cf-ray), so the flag stays unset and the header is
 *   ignored as client-forgeable.
 * - x-envoy-external-address: Railway's Envoy edge sets this to the single
 *   external client address it observed (possibly with a :port). It is only
 *   consulted once the operator has configured trusted proxy hops — on a bare
 *   deployment a client could set it — and it
 *   identifies the CLIENT only when that edge is the outermost trusted hop,
 *   so with hops >= 2 the positional x-forwarded-for read stays authoritative
 *   and Envoy's value is never used as a fallback.
 * - x-forwarded-for: each trusted proxy APPENDS the peer it observed, so with
 *   N trusted hops the trustworthy entry is the N-th from the RIGHT. The
 *   left-most entry is client-supplied and is never read.
 * - x-real-ip is deliberately not consulted: no proxy in this topology sets
 *   it authoritatively, so a client-set value would pass through verbatim.
 *
 * Every candidate is validated with isIP (after unambiguous :port stripping)
 * so header garbage can never become a rate-limit key or a captcha remoteip.
 * Callers seeing undefined must degrade to a partitioned coarse subject —
 * never a shared "global" bucket, never open.
 */
export function trustedClientIp(c: Context): string | undefined {
  const trustCloudflare = process.env.STEWARD_TRUST_CLOUDFLARE === "true";
  if (trustCloudflare) {
    const cf = c.req.header("cf-connecting-ip")?.trim();
    if (cf && isIP(cf)) return cf;
    // Cloudflare mode is an exclusive trust contract. If the authoritative
    // header is absent or malformed, do not fall through to other forwarded
    // headers: those may be supplied by the client when the request bypasses
    // the configured edge.
    logNoTrustedClientIpDiag(c, 0);
    return undefined;
  }
  const hops = trustedProxyHops();
  if (hops === 0) return undefined;

  const fromEnvoy = () =>
    normalizeIpCandidate(c.req.header("x-envoy-external-address"));
  const fromForwardedFor = () => {
    if (hops === 0) return undefined;
    const entries = (c.req.header("x-forwarded-for") ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    return normalizeIpCandidate(entries[entries.length - hops]);
  };

  // In a multi-hop topology Envoy observes the adjacent proxy, not the
  // external client. Falling back to that header when XFF is missing or too
  // short would turn a topology/configuration failure into false attribution.
  const ip =
    hops >= 2 ? fromForwardedFor() : (fromEnvoy() ?? fromForwardedFor());
  if (ip) return ip;
  logNoTrustedClientIpDiag(c, hops);
  return undefined;
}

/**
 * Coarsen an IP for rate-limit keying. IPv4 keys as itself; IPv4-mapped IPv6
 * unwraps to the embedded IPv4 in BOTH spellings (::ffff:a.b.c.d and the hex
 * form ::ffff:aabb:ccdd) so mapped clients share one bucket instead of all
 * collapsing into 0::/64 or splitting across spellings; native IPv6 keys by
 * /64 — providers delegate whole /64s, so full-address buckets would let one
 * host mint 2^64 independent budgets while distinct subscribers almost never
 * share a /64.
 */
export function clientIpBucket(ip: string): string {
  const lower = ip.toLowerCase();
  if (lower.startsWith("::ffff:") && isIP(lower.slice(7)) === 4) {
    return lower.slice(7);
  }
  if (isIP(lower) !== 6) return lower;
  const [head = "", tail = ""] = lower.split("::");
  const headParts = head ? head.split(":") : [];
  const tailParts = tail ? tail.split(":") : [];
  const missing = Math.max(8 - headParts.length - tailParts.length, 0);
  // Parse each hextet numerically so full-form and ::-compressed spellings of
  // the same address always land in the same bucket.
  const full = [...headParts, ...Array(missing).fill("0"), ...tailParts].map(
    (part) => Number.parseInt(part || "0", 16),
  );
  // IPv4-mapped spelled in hex (::ffff:0102:0304): unwrap to the embedded
  // IPv4 so it shares the dotted-quad spelling's bucket.
  if (
    full.length === 8 &&
    full.slice(0, 5).every((part) => part === 0) &&
    full[5] === 0xffff
  ) {
    const hi = full[6] ?? 0;
    const lo = full[7] ?? 0;
    return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  }
  return `${full
    .slice(0, 4)
    .map((part) => part.toString(16))
    .join(":")}::/64`;
}

/** Coarse fallback buckets are shared by many clients; widen their budget. */
const AUTH_RATE_LIMIT_FALLBACK_HEADROOM = 5;

let coarseSubjectWarnedAt = 0;

/**
 * Rate-limit subject for auth endpoints. With a trusted client IP every
 * client gets an independent budget (IPv6 at /64). Without one, the socket
 * peer injected by the server entry point (SOCKET_PEER_ENV_KEY — set by the
 * runtime, never client-influenceable) provides the same per-client budget.
 * Only when neither exists (e.g. Workers, which has no socket) do requests
 * shard per Host — the edge only routes configured domains here, so Host
 * cannot be rotated to mint unbounded buckets the way client-controlled
 * headers or user-agents can; note this last-resort fallback does rely on
 * that edge invariant, so deployments should prefer STEWARD_TRUSTED_PROXY_HOPS
 * or a socket-bearing entry. checkAuthRateLimit widens the coarse budget by
 * AUTH_RATE_LIMIT_FALLBACK_HEADROOM because many clients share each bucket.
 * No configuration yields the old literal "global" chokepoint (#268), and no
 * client-controlled free text ever reaches Redis unhashed.
 */
function authRateLimitSubject(c: Context): {
  subject: string;
  coarse: boolean;
} {
  const ip = trustedClientIp(c);
  if (ip) return { subject: `ip:${clientIpBucket(ip)}`, coarse: false };
  const peer = socketPeerFromEnv(c.env);
  if (peer && isIP(peer))
    return { subject: `ip:${clientIpBucket(peer)}`, coarse: false };
  const now = Date.now();
  if (
    process.env.NODE_ENV === "production" &&
    now - coarseSubjectWarnedAt >= 60_000
  ) {
    coarseSubjectWarnedAt = now;
    logger.warn(
      {
        details: [
          "[AuthRateLimit] No trusted client IP (set STEWARD_TRUSTED_PROXY_HOPS=2 on Railway); auth rate limits fall back to coarse per-host buckets instead of per-client budgets",
        ],
      },
      "[Login:auth] warn",
    );
  }
  return {
    subject: `host:${c.req.header("host")?.toLowerCase().trim() || "unknown"}`,
    coarse: true,
  };
}

function allowAuthRateLimitSoftFail(): boolean {
  return (
    process.env.NODE_ENV !== "production" ||
    process.env.STEWARD_ALLOW_AUTH_RATE_LIMIT_SOFT_FAIL === "true"
  );
}

/**
 * Bounded, observable fallback for the window where Redis is CONFIGURED but
 * unreachable (blip, restart, failover): admit up to
 * STEWARD_AUTH_RATE_LIMIT_OUTAGE_VALVE_MAX requests per minute per instance
 * across all auth endpoints, then deny. 0 restores strict fail-closed.
 * Redis NEVER configured in production remains a hard deny — misconfiguration
 * must stay loud. This is not a per-client limiter and does not violate the
 * no-in-memory-fallback-Map rule in checkAuthRateLimit's doc: it is a single
 * O(1) circuit-breaker counter bounding blast radius per instance (per
 * isolate on Workers, which only tightens it).
 */
function authRateLimitOutageValveMax(): number {
  const raw = process.env.STEWARD_AUTH_RATE_LIMIT_OUTAGE_VALVE_MAX;
  if (raw === undefined || raw === "") return 300;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 300;
}

let outageValveWindowStartMs = 0;
let outageValveCount = 0;
let outageValveLoggedAt = 0;

function authRateLimitOutageAllow(endpoint: string, err?: unknown): boolean {
  const valveMax = authRateLimitOutageValveMax();
  if (valveMax === 0) return false;
  const now = Date.now();
  if (now - outageValveWindowStartMs >= 60_000) {
    outageValveWindowStartMs = now;
    outageValveCount = 0;
  }
  if (now - outageValveLoggedAt >= 30_000) {
    outageValveLoggedAt = now;
    logger.error(
      {
        details: [
          `[AuthRateLimit] Redis unavailable; bounded per-instance outage valve engaged (endpoint "${endpoint}", max ${valveMax}/min)`,
          err ?? "",
        ],
      },
      "[Login:auth] error",
    );
  }
  outageValveCount += 1;
  return outageValveCount <= valveMax;
}

/**
 * Check a client rate limit for auth endpoints, backed by the Redis sliding
 * window. Subjects come from authRateLimitSubject (trusted client IP, or a
 * coarse per-host fallback whose budget is widened by
 * AUTH_RATE_LIMIT_FALLBACK_HEADROOM) unless subjectOverride is given. The
 * subject is always hashed into the Redis key, so neither PII (destination
 * emails/phones) nor header-controlled bytes ever reach Redis. In production,
 * Redis must be available unless STEWARD_ALLOW_AUTH_RATE_LIMIT_SOFT_FAIL=true
 * (full soft-fail, break-glass only) or the bounded outage valve admits the
 * request (Redis configured but unreachable only). We deliberately do not
 * keep an in-memory fallback Map as a limiter: it is incorrect across
 * multiple instances and impossible on Cloudflare Workers (no shared state
 * across isolates); the outage valve is a single bounded counter, not a
 * per-client map.
 *
 * @param c        - Hono context (used to derive the client subject)
 * @param endpoint - Short name used as part of the Redis key
 * @param windowMs - Window length in milliseconds
 * @param max      - Max requests in the window (×5 for coarse fallback subjects)
 * @param subjectOverride - Per-target subject (e.g. destination email); hashed at key build
 */
type EmbeddedRateLimiter = (
  key: string,
  windowMs: number,
  maximum: number,
) => Promise<{ allowed: boolean; retryAfterSecs: number }>;
let embeddedRateLimiter: EmbeddedRateLimiter | undefined;

/** Binds login attempt budgets to the database owned by the embedded entry. */
export function setDatabaseAuthRateLimiter(
  limiter: EmbeddedRateLimiter | undefined,
): void {
  embeddedRateLimiter = limiter;
}

export async function checkAuthRateLimit(
  c: Context,
  endpoint: string,
  windowMs: number,
  max: number,
  subjectOverride?: string,
): Promise<{ allowed: boolean; retryAfterSecs?: number }> {
  const resolved =
    subjectOverride !== undefined
      ? { subject: subjectOverride, coarse: false }
      : authRateLimitSubject(c);
  const effectiveMax = resolved.coarse
    ? max * AUTH_RATE_LIMIT_FALLBACK_HEADROOM
    : max;
  const key = `ratelimit:auth:${endpoint}:${hashSha256Hex(resolved.subject)}:${windowMs}`;

  const deny = (retryAfterSecs: number) => {
    const headers = formatRateLimitHeaders({
      limit: effectiveMax,
      remaining: 0,
      resetMs: retryAfterSecs * 1000,
      retryAfterMs: retryAfterSecs * 1000,
    });
    headers["RateLimit-Policy"] =
      `${effectiveMax};w=${Math.ceil(windowMs / 1000)}`;
    for (const [name, value] of Object.entries(headers)) c.header(name, value);
    return { allowed: false, retryAfterSecs };
  };

  if (embeddedRateLimiter) {
    const result = await embeddedRateLimiter(key, windowMs, effectiveMax);
    return result.allowed ? { allowed: true } : deny(result.retryAfterSecs);
  }

  try {
    const redisMw = await import("../middleware/redis.js");
    if (!redisMw.isRedisAvailable()) {
      if (allowAuthRateLimitSoftFail()) return { allowed: true };
      if (redisMw.isRedisConfigured() && authRateLimitOutageAllow(endpoint)) {
        return { allowed: true };
      }
      return deny(60);
    }

    const { checkRateLimit } = await import("../../../redis/src/index.ts");
    const result = await checkRateLimit(key, windowMs, effectiveMax);
    if (!result.allowed) {
      return deny(Math.ceil(result.resetMs / 1000));
    }
    return { allowed: true };
  } catch (err) {
    if (allowAuthRateLimitSoftFail()) return { allowed: true };
    // Any step above can throw — the dynamic imports, the availability probe,
    // or checkRateLimit itself — so a throw is NOT proof Redis was seen
    // available. Treat it as an outage and let the bounded valve decide; the
    // deliberate hard deny for never-configured Redis in production is the
    // non-throwing isRedisAvailable() branch above, which returns instead.
    if (authRateLimitOutageAllow(endpoint, err)) return { allowed: true };
    return deny(60);
  }
}

export const SMS_VERIFY_MAX_FAILED_ATTEMPTS = 5;
const SMS_VERIFY_FAILED_ATTEMPT_TTL_MS = 10 * 60 * 1000;
const TOTP_VERIFY_MAX_FAILED_ATTEMPTS = 5;
const TOTP_VERIFY_FAILED_ATTEMPT_TTL_MS = 10 * 60 * 1000;
const FACTOR_ENROLLMENT_STEP_UP_MAX_AGE_MS = 5 * 60 * 1000;

function smsVerifyAttemptKey(phone: string, purpose: string): string {
  return `sms-verify-attempts:${hashSha256Hex(`${purpose}:${phone}`)}`;
}

function smsVerifyAttemptSlotKey(
  phone: string,
  purpose: string,
  slot: number,
): string {
  return `${smsVerifyAttemptKey(phone, purpose)}:${slot}`;
}

export async function getSmsVerifyFailedAttempts(
  phone: string,
  purpose: string,
): Promise<number> {
  const attempts = await Promise.all(
    Array.from({ length: SMS_VERIFY_MAX_FAILED_ATTEMPTS }, (_, index) =>
      getMfaBackend().get(smsVerifyAttemptSlotKey(phone, purpose, index + 1)),
    ),
  );
  return attempts.filter((value) => value !== null).length;
}

export type SmsVerifyAttemptClaim = {
  key: string;
  token: string;
};

/**
 * Atomically reserve one of the five verification-attempt slots. Using
 * set-if-absent slots keeps the limit correct under concurrent requests on
 * every shipped backend without relying on a read-then-write counter.
 */
export async function claimSmsVerifyAttempt(
  phone: string,
  purpose: string,
): Promise<SmsVerifyAttemptClaim | null> {
  for (let slot = 1; slot <= SMS_VERIFY_MAX_FAILED_ATTEMPTS; slot++) {
    const key = smsVerifyAttemptSlotKey(phone, purpose, slot);
    const token = `sms-verify-attempt:${randomBytes(16).toString("hex")}`;
    if (
      await getMfaBackend().setIfNotExists(
        key,
        token,
        SMS_VERIFY_FAILED_ATTEMPT_TTL_MS,
      )
    ) {
      return { key, token };
    }
  }
  return null;
}

/** Release only the exact slot generation claimed by this request. */
export async function releaseSmsVerifyAttempt(
  claim: SmsVerifyAttemptClaim,
): Promise<boolean> {
  try {
    return await getMfaBackend().compareDelete(claim.key, claim.token);
  } catch {
    // Rollback is best-effort and generation-exact. A storage outage keeps the
    // slot consumed (fail closed) without replacing the original provider error.
    return false;
  }
}

/**
 * Roll back claim-first accounting only when no provider check could have run.
 * Timeout/5xx/malformed outcomes retain the slot because the remote service may
 * already have evaluated the guess.
 */
export async function releaseUnattemptedSmsVerifyClaim(
  claim: SmsVerifyAttemptClaim,
  error: unknown,
): Promise<boolean> {
  if (
    !(error instanceof SmsChallengeInProgressError) &&
    !(error instanceof SmsVerificationNotAttemptedError)
  ) {
    return false;
  }
  return releaseSmsVerifyAttempt(claim);
}

export async function recordSmsVerifyFailure(
  phone: string,
  purpose: string,
): Promise<void> {
  await claimSmsVerifyAttempt(phone, purpose);
}

export async function clearSmsVerifyFailures(
  phone: string,
  purpose: string,
): Promise<void> {
  await Promise.all(
    Array.from({ length: SMS_VERIFY_MAX_FAILED_ATTEMPTS }, (_, index) =>
      getMfaBackend().delete(
        smsVerifyAttemptSlotKey(phone, purpose, index + 1),
      ),
    ),
  );
}

function totpVerifyAttemptKey(scope: string): string {
  return `totp-verify-attempts:${hashSha256Hex(scope)}`;
}

async function getTotpVerifyFailedAttempts(scope: string): Promise<number> {
  const raw = await getMfaBackend().get(totpVerifyAttemptKey(scope));
  if (!raw) return 0;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

async function recordTotpVerifyFailure(scope: string): Promise<number> {
  const next = (await getTotpVerifyFailedAttempts(scope)) + 1;
  await getMfaBackend().set(
    totpVerifyAttemptKey(scope),
    String(next),
    TOTP_VERIFY_FAILED_ATTEMPT_TTL_MS,
  );
  return next;
}

async function clearTotpVerifyFailures(scope: string): Promise<void> {
  await getMfaBackend().delete(totpVerifyAttemptKey(scope));
}

async function getTenantAuthAbuseConfig(tenantId: string) {
  return (await authTenantConfigSubject(tenantId))?.auth_abuse_config ?? {};
}

function validateUserAuthAbusePolicy(
  userId: string,
  config: TenantAuthAbuseConfig & {
    user?: { allowedUserIds?: string[]; blockedUserIds?: string[] };
  },
): string | null {
  const userConfig = config.user;
  if (!userConfig) return null;
  if (userConfig.blockedUserIds?.includes(userId)) return "user id is blocked";
  if (
    userConfig.allowedUserIds?.length &&
    !userConfig.allowedUserIds.includes(userId)
  ) {
    return "user id is not allowed";
  }
  return null;
}

async function getTenantAppClientLoginMethods(
  tenantId: string,
  clientId: string | undefined,
): Promise<TenantAuthAbuseConfig["loginMethods"] | undefined> {
  const normalizedClientId = normalizePublicClientId(clientId);
  if (!normalizedClientId) return undefined;
  const row = (await authAppClientSubjects(tenantId)).find(
    (client) => client.id === normalizedClientId,
  );
  return (
    (row?.login_methods as TenantAuthAbuseConfig["loginMethods"] | undefined) ??
    undefined
  );
}

type LoginMethodName =
  | "passkey"
  | "email"
  | "sms"
  | "whatsapp"
  | "totp"
  | "siwe"
  | "siws"
  | "telegram"
  | "farcaster"
  | "oauth"
  | "oidc";

function loginMethodProviderKey(providerId: string | undefined): string {
  return providerId?.trim().toLowerCase() ?? "";
}

async function requireTenantLoginMethodAllowed(
  c: Context,
  tenantId: string | undefined,
  method: LoginMethodName,
  providerId?: string,
  clientId?: string,
): Promise<Response | null> {
  if (!tenantId) return null;
  const loginMethods =
    (await getTenantAppClientLoginMethods(tenantId, clientId)) ??
    (await getTenantAuthAbuseConfig(tenantId)).loginMethods;
  if (!loginMethods) return null;
  if (
    method !== "oauth" &&
    method !== "oidc" &&
    loginMethods[method] === false
  ) {
    return c.json<ApiResponse>(
      { ok: false, error: `${method} login is disabled for this tenant` },
      403,
    );
  }
  const normalizedProviderId = loginMethodProviderKey(providerId);
  if (
    method === "oauth" &&
    loginMethods.oauth?.[normalizedProviderId] === false
  ) {
    return c.json<ApiResponse>(
      { ok: false, error: "OAuth login is disabled for this tenant" },
      403,
    );
  }
  if (
    method === "oidc" &&
    loginMethods.oidc?.[normalizedProviderId] === false
  ) {
    return c.json<ApiResponse>(
      { ok: false, error: "OIDC login is disabled for this tenant" },
      403,
    );
  }
  return null;
}

async function isSsoRequiredForEmailDomain(
  tenantId: string,
  email: string,
): Promise<boolean> {
  const domain = normalizeEmailDomain(email);
  if (!domain) return false;
  const result = await getDb().execute(
    sql`SELECT * FROM steward_bootstrap.auth_sso_domain_subject(${tenantId}, ${domain})`,
  );
  const [row] = bootstrapRows<{ sso_required: boolean }>(result);
  return row?.sso_required === true;
}

async function requireNonSsoEmailLoginAllowed(
  c: Context,
  tenantId: string,
  email: string,
  methodLabel: string,
): Promise<Response | null> {
  if (!(await isSsoRequiredForEmailDomain(tenantId, email))) return null;
  return c.json<ApiResponse>(
    {
      ok: false,
      error: `${methodLabel} login is disabled because this email domain requires SSO`,
    },
    403,
  );
}

async function isVerifiedSsoEmailDomainForTenant(
  tenantId: string,
  email: string,
): Promise<boolean> {
  const domain = normalizeEmailDomain(email);
  if (!domain) return false;
  const result = await getDb().execute(
    sql`SELECT * FROM steward_bootstrap.auth_sso_domain_subject(${tenantId}, ${domain})`,
  );
  const [row] = bootstrapRows<{ tenant_id: string }>(result);
  return Boolean(row);
}

function bootstrapRows<T>(result: unknown): T[] {
  return (
    Array.isArray(result)
      ? result
      : ((result as { rows?: unknown[] } | null)?.rows ?? [])
  ) as T[];
}

type AuthTenantSubject = {
  tenant_id: string;
  membership_role: string | null;
  join_mode: string | null;
};

type AuthTenantConfigSubject = {
  auth_abuse_config: TenantAuthAbuseConfig;
  allowed_origins: string[];
  email_config: TenantEmailConfig | null;
  oidc_providers: unknown;
  test_account: TenantTestAccountConfig;
  allowed_redirect_urls: string[];
};

type AuthAppClientSubject = {
  id: string;
  allowed_redirect_urls: string[];
  login_methods: TenantAuthAbuseConfig["loginMethods"] | null;
  allowed_bundle_ids: string[];
  allowed_package_names: string[];
};

async function authTenantConfigSubject(
  tenantId: string,
): Promise<AuthTenantConfigSubject | null> {
  const result = await getDb().execute(
    sql`SELECT * FROM steward_bootstrap.auth_tenant_config_subject(${tenantId})`,
  );
  return bootstrapRows<AuthTenantConfigSubject>(result)[0] ?? null;
}

async function authAppClientSubjects(
  tenantId: string,
): Promise<AuthAppClientSubject[]> {
  const result = await getDb().execute(
    sql`SELECT * FROM steward_bootstrap.auth_app_clients_subject(${tenantId})`,
  );
  return bootstrapRows<AuthAppClientSubject>(result);
}

async function authTenantSubject(
  tenantId: string,
  userId?: string | null,
): Promise<AuthTenantSubject | null> {
  const result = await getDb().execute(
    sql`SELECT * FROM steward_bootstrap.auth_tenant_subject(${tenantId}, ${userId ?? null}::uuid)`,
  );
  return bootstrapRows<AuthTenantSubject>(result)[0] ?? null;
}

async function tenantExists(tenantId: string): Promise<boolean> {
  return Boolean(await authTenantSubject(tenantId));
}

async function validateExplicitAuthTenantHint(
  tenantId: string,
  explicitHint: boolean,
): Promise<string | null> {
  if (!explicitHint) return null;
  if (!(await tenantExists(tenantId))) return `Tenant '${tenantId}' not found`;
  return null;
}

function authTenantHint(c: Context, bodyTenantId?: string): string {
  return (
    c.req.header("X-Steward-Tenant")?.trim() ||
    bodyTenantId?.trim() ||
    defaultAuthTenantId()
  );
}

function smsLoginPurpose(tenantId: string): string {
  return `login:${tenantId}`;
}

function whatsappLoginPurpose(tenantId: string): string {
  return `whatsapp-login:${tenantId}`;
}

// ─── JWT helpers ──────────────────────────────────────────────────────────────

/** Refresh token lifetime: 30 days */
const REFRESH_TOKEN_EXPIRY_DAYS = 30;

export async function createSessionToken(
  address: string,
  tenantId: string,
  extra?: Record<string, unknown>,
  expiresIn: string = ACCESS_TOKEN_EXPIRY,
): Promise<string> {
  return signAccessToken({ address, tenantId, ...extra }, expiresIn);
}

async function isActiveTenantMember(
  userId: string,
  tenantId: string,
): Promise<boolean> {
  return withVerifiedAuthTenant(tenantId, userId, async () => {
    const [row] = await getDb()
      .select({ userId: users.id })
      .from(users)
      .innerJoin(
        userTenants,
        and(
          eq(userTenants.userId, users.id),
          eq(userTenants.tenantId, tenantId),
        ),
      )
      .where(and(eq(users.id, userId), sql`${users.deactivatedAt} is null`));
    return Boolean(row);
  });
}

async function buildIdentityClaims(
  userId: string,
  tenantId: string,
): Promise<{
  sub: string;
  userId: string;
  tenantId: string;
  email: string | null;
  emailVerified: boolean | null;
  name: string | null;
  image: string | null;
  walletAddress: string | null;
  walletChain: string | null;
  customMetadata: Record<string, unknown>;
}> {
  return withVerifiedAuthTenant(tenantId, userId, async () => {
    const db = getDb();
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    if (!user) throw new Error("User not found");

    const [tenantMembership] = await db
      .select({ customMetadata: userTenants.customMetadata })
      .from(userTenants)
      .where(
        and(eq(userTenants.userId, userId), eq(userTenants.tenantId, tenantId)),
      );
    if (!tenantMembership) throw new Error("Not a member of this tenant");

    return {
      sub: user.id,
      userId: user.id,
      tenantId,
      email: user.email,
      emailVerified: user.emailVerified,
      name: user.name,
      image: user.image,
      walletAddress: user.walletAddress,
      walletChain: user.walletChain,
      customMetadata: tenantMembership.customMetadata ?? {},
    };
  });
}

function tenantIdentityJwtIssuer(tenantId: string): string {
  return `${getIdentityJwtIssuer()}/tenants/${encodeURIComponent(tenantId)}`;
}

async function createIdentityToken(
  claims: Awaited<ReturnType<typeof buildIdentityClaims>>,
): Promise<string> {
  return signIdentityJwtPayload(
    {
      typ: "identity",
      sub: claims.sub,
      address: claims.walletAddress ?? "",
      userId: claims.userId,
      tenantId: claims.tenantId,
      email: claims.email ?? undefined,
      emailVerified: claims.emailVerified ?? undefined,
      name: claims.name ?? undefined,
      image: claims.image ?? undefined,
      walletAddress: claims.walletAddress ?? undefined,
      walletChain: claims.walletChain ?? undefined,
      customMetadata: claims.customMetadata,
    },
    ACCESS_TOKEN_EXPIRY,
    tenantIdentityJwtIssuer(claims.tenantId),
  );
}

// ─── Refresh token helpers ────────────────────────────────────────────────────

function hashToken(raw: string): string {
  return hashSha256Hex(raw);
}

/**
 * Generate a random refresh token, persist its hash in DB, return the raw value.
 * The raw token is sent to the client; only the hash is stored server-side.
 */
async function createRefreshToken(
  userId: string,
  tenantId: string,
  sessionClaims?: Record<string, unknown>,
): Promise<string> {
  return withVerifiedAuthTenant(tenantId, userId, async () => {
    const db = getDb();
    const raw = randomBytes(40).toString("hex");
    const id = randomBytes(16).toString("hex");
    const tokenHash = hashToken(raw);
    const expiresAt = new Date(
      Date.now() + REFRESH_TOKEN_EXPIRY_DAYS * 86400 * 1000,
    );
    await db
      .insert(refreshTokens)
      .values({ id, userId, tenantId, tokenHash, expiresAt });
    if (sessionClaims && Object.keys(sessionClaims).length > 0) {
      await writeMfaJson(
        `refresh:claims:${tokenHash}`,
        sessionClaims,
        REFRESH_TOKEN_EXPIRY_DAYS * 86400 * 1000,
      );
    }
    return raw;
  });
}

type RefreshRotationResult =
  | {
      status: "valid";
      record: typeof refreshTokens.$inferSelect;
      newAccessToken: string;
      newRefreshToken: string;
    }
  | { status: "reused"; userId: string; tenantId: string }
  | { status: "invalid" }
  | { status: "deactivated"; userId: string; tenantId: string }
  | { status: "not_member"; userId: string; tenantId: string }
  | { status: "revoked"; userId: string; tenantId: string };

type UsedRefreshTokenRecord = {
  userId?: string;
  tenantId?: string;
  successorTokenHash?: string;
};

function refreshTokenIssuedAtSeconds(
  record: typeof refreshTokens.$inferSelect,
): number {
  return Math.floor(new Date(record.createdAt).getTime() / 1000);
}

async function revokeUserRefreshSessions(userId: string) {
  return getDb().transaction(async (tx) => {
    await lockUserSession(tx, userId);
    const revoked = await tx
      .delete(refreshTokens)
      .where(eq(refreshTokens.userId, userId))
      .returning();
    const issuedBefore = await revocationStore.revokeUserTokens(userId);
    return { revoked, issuedBefore };
  });
}

async function rotateRefreshTokenForUserSession(
  raw: string,
  requestedTenantId?: string,
): Promise<RefreshRotationResult> {
  const subject = await resolveRefreshTokenSubject(hashToken(raw));
  if (!subject) return { status: "invalid" };
  return withVerifiedAuthTenant(subject.tenantId, subject.userId, () =>
    rotateRefreshTokenInsideTenant(raw, requestedTenantId),
  );
}

async function resolveRefreshTokenSubject(tokenHash: string) {
  const result = await getDb().execute(sql`
    SELECT user_id, tenant_id
    FROM steward_bootstrap.auth_refresh_subject(${tokenHash})
  `);
  const [subject] = (
    Array.isArray(result)
      ? result
      : ((result as { rows?: unknown[] }).rows ?? [])
  ) as Array<{ user_id: string; tenant_id: string }> | [];
  const used = subject
    ? null
    : await readMfaJson<UsedRefreshTokenRecord>(`refresh:used:${tokenHash}`);
  const tenantId = subject?.tenant_id ?? used?.tenantId;
  const userId = subject?.user_id ?? used?.userId;
  if (!tenantId || !userId) return null;
  return { tenantId, userId };
}

async function rotateRefreshTokenInsideTenant(
  raw: string,
  requestedTenantId?: string,
): Promise<RefreshRotationResult> {
  const db = getDb();
  const now = new Date();
  const tokenHash = hashToken(raw);
  return db.transaction(async (tx): Promise<RefreshRotationResult> => {
    const [refreshCandidate] = await tx
      .select({ userId: refreshTokens.userId })
      .from(refreshTokens)
      .where(
        and(
          eq(refreshTokens.tokenHash, tokenHash),
          gte(refreshTokens.expiresAt, now),
        ),
      );

    if (!refreshCandidate) {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`refresh_token_${tokenHash}`}, 0))`,
      );
      const used = await readMfaJson<UsedRefreshTokenRecord>(
        `refresh:used:${tokenHash}`,
      );
      if (used?.userId && used?.tenantId) {
        await tx
          .delete(refreshTokens)
          .where(
            and(
              eq(refreshTokens.userId, used.userId),
              eq(refreshTokens.tenantId, used.tenantId),
            ),
          );
        return {
          status: "reused",
          userId: used.userId,
          tenantId: used.tenantId,
        };
      }
      await tx
        .delete(refreshTokens)
        .where(
          and(
            eq(refreshTokens.tokenHash, tokenHash),
            lt(refreshTokens.expiresAt, now),
          ),
        );
      return { status: "invalid" };
    }

    await lockUserSession(tx, refreshCandidate.userId);
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`refresh_token_${tokenHash}`}, 0))`,
    );
    const [record] = await tx
      .select()
      .from(refreshTokens)
      .where(
        and(
          eq(refreshTokens.tokenHash, tokenHash),
          eq(refreshTokens.userId, refreshCandidate.userId),
          gte(refreshTokens.expiresAt, now),
        ),
      )
      .for("update");

    if (!record) {
      const used = await readMfaJson<UsedRefreshTokenRecord>(
        `refresh:used:${tokenHash}`,
      );
      if (used?.userId && used?.tenantId) {
        await tx
          .delete(refreshTokens)
          .where(
            and(
              eq(refreshTokens.userId, used.userId),
              eq(refreshTokens.tenantId, used.tenantId),
            ),
          );
        return {
          status: "reused",
          userId: used.userId,
          tenantId: used.tenantId,
        };
      }
      await tx
        .delete(refreshTokens)
        .where(
          and(
            eq(refreshTokens.tokenHash, tokenHash),
            lt(refreshTokens.expiresAt, now),
          ),
        );
      return { status: "invalid" };
    }

    const [user] = await tx
      .select()
      .from(users)
      .where(eq(users.id, record.userId))
      .for("update");
    if (user?.deactivatedAt) {
      await tx
        .delete(refreshTokens)
        .where(eq(refreshTokens.userId, record.userId));
      return {
        status: "deactivated",
        userId: record.userId,
        tenantId: record.tenantId,
      };
    }

    const targetTenantId = requestedTenantId ?? record.tenantId;
    const membership = await authTenantSubject(targetTenantId, record.userId);
    if (!membership?.membership_role) {
      await tx
        .delete(refreshTokens)
        .where(
          and(
            eq(refreshTokens.userId, record.userId),
            eq(refreshTokens.tenantId, record.tenantId),
          ),
        );
      return {
        status: "not_member",
        userId: record.userId,
        tenantId: record.tenantId,
      };
    }

    const revokedBefore = await revocationStore.getUserRevokedBefore(
      record.userId,
    );
    if (
      revokedBefore !== null &&
      revokedBefore >= refreshTokenIssuedAtSeconds(record)
    ) {
      await tx
        .delete(refreshTokens)
        .where(eq(refreshTokens.userId, record.userId));
      return {
        status: "revoked",
        userId: record.userId,
        tenantId: record.tenantId,
      };
    }

    const walletAddress = user?.walletAddress ?? "";
    const email = user?.email ?? undefined;
    const sessionClaims =
      (await readMfaJson<Record<string, unknown>>(
        `refresh:claims:${record.tokenHash}`,
      )) ?? {};
    await getMfaBackend().delete(`refresh:claims:${record.tokenHash}`);

    const newAccessToken = await createSessionToken(
      walletAddress,
      targetTenantId,
      {
        userId: record.userId,
        ...(email ? { email } : {}),
        ...sessionClaims,
      },
    );

    const newRefreshToken = randomBytes(40).toString("hex");
    const newRefreshTokenHash = hashToken(newRefreshToken);
    const successorId = randomBytes(16).toString("hex");
    // Raw SQL parameters do not receive Drizzle's timestamp column encoder.
    // Keep the driver boundary primitive-only: Neon WebSocket rejects a Date
    // object before PostgreSQL can execute the rotation function.
    const successorExpiresAt = new Date(
      Date.now() + REFRESH_TOKEN_EXPIRY_DAYS * 86400 * 1000,
    ).toISOString();
    const rotated = bootstrapRows<{ id: string }>(
      await tx.execute(sql`
        SELECT * FROM steward_bootstrap.auth_rotate_refresh_token(
          ${tokenHash}, ${targetTenantId}, ${successorId},
          ${newRefreshTokenHash}, ${successorExpiresAt}::timestamptz
        )
      `),
    );
    if (rotated.length !== 1) return { status: "invalid" };
    // Keep a bounded predecessor link so a concurrent single-session revoke
    // that started with the just-spent token can delete its rotated successor
    // after acquiring the same user/advisory locks. Otherwise refresh can win
    // the race and leave a live replacement token after sign-out.
    await writeMfaJson(
      `refresh:used:${tokenHash}`,
      {
        userId: record.userId,
        tenantId: record.tenantId,
        successorTokenHash: newRefreshTokenHash,
      },
      REFRESH_TOKEN_EXPIRY_DAYS * 86400 * 1000,
    );
    if (Object.keys(sessionClaims).length > 0) {
      await writeMfaJson(
        `refresh:claims:${newRefreshTokenHash}`,
        sessionClaims,
        REFRESH_TOKEN_EXPIRY_DAYS * 86400 * 1000,
      );
    }

    return {
      status: "valid",
      record: { ...record, tenantId: targetTenantId },
      newAccessToken,
      newRefreshToken,
    };
  });
}

/** Build the standard dual-token auth response. */
function buildAuthResponse(
  token: string,
  refreshToken: string,
  user: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ok: true,
    token,
    refreshToken,
    expiresIn: ACCESS_TOKEN_EXPIRY_SECONDS,
    user,
  };
}

export { verifySessionToken } from "../services/context";

// ─── Nonce store (SIWE / SIWS) ───────────────────────────────────────────────
//
// Backed by the same StoreBackend abstraction the challenge/token stores use,
// so nonces persist across instances on Workers (Upstash) and across restarts
// in production (Postgres `auth_kv_store`). The default is in-memory for
// dev/test — initAuthStores() upgrades it once Redis/Postgres availability
// is known.
//
// TTL matches the previous Map GC interval (5 minutes), enforced by the
// backend itself so no setInterval cleanup is needed.

const SIWE_NONCE_TTL_MS = 5 * 60 * 1000;
let _nonceBackend: import("../../../auth/src/index.ts").StoreBackend | null =
  null;

type SiweNonceRecord = {
  allowedDomains: string[];
  originHost?: string;
  tenantId?: string;
};

function getNonceBackend(): import("../../../auth/src/index.ts").StoreBackend {
  if (_nonceBackend) return _nonceBackend;
  // Lazily fall back to a fresh in-memory backend if initAuthStores() hasn't
  // been called yet (e.g. tests or Workers cold-boot before middleware runs).
  // initAuthStores() will replace this with a Redis or Postgres-backed one.
  // Imported via require to avoid a circular dep with @stwd/auth at module init.
  const { MemoryBackend } =
    require("../../../auth/src/index.ts") as typeof import("../../../auth/src/index.ts");
  _nonceBackend = new MemoryBackend();
  return _nonceBackend;
}

function originHostFromRequest(c: Context): string | undefined {
  const origin = c.req.header("origin") ?? c.req.header("referer");
  if (!origin) return undefined;
  try {
    return new URL(origin).host.toLowerCase();
  } catch {
    return undefined;
  }
}

function requiredOriginHostFromRequest(c: Context): string | null {
  const originHost = originHostFromRequest(c);
  if (!originHost) return null;
  return getAllowedSiweDomains().includes(originHost) ? originHost : null;
}

async function setSiweNonce(
  nonce: string,
  record: SiweNonceRecord,
): Promise<void> {
  await getNonceBackend().set(nonce, JSON.stringify(record), SIWE_NONCE_TTL_MS);
}

/**
 * Atomically consume a SIWE nonce record if the nonce was present and unexpired
 * (and is now deleted).
 *
 * Store backends implement consume atomically where supported, so parallel
 * requests cannot reuse the same signed nonce.
 */
async function consumeSiweNonce(
  nonce: string,
): Promise<SiweNonceRecord | null> {
  const raw = await getNonceBackend().consume(nonce);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as SiweNonceRecord;
    return {
      allowedDomains: Array.isArray(parsed.allowedDomains)
        ? parsed.allowedDomains
        : [],
      originHost:
        typeof parsed.originHost === "string" ? parsed.originHost : undefined,
      tenantId:
        typeof parsed.tenantId === "string" ? parsed.tenantId : undefined,
    };
  } catch {
    return { allowedDomains: [] };
  }
}

function validateConsumedSiweNonce(
  record: SiweNonceRecord | null,
  input: { domain: string; tenantId?: string },
): string | null {
  if (!record) return "Invalid or expired nonce";
  const domain = input.domain.toLowerCase();
  if (
    record.allowedDomains.length > 0 &&
    !record.allowedDomains.includes(domain)
  ) {
    return "Nonce was not issued for this SIWE domain";
  }
  if (!record.originHost) {
    return "Nonce was not bound to an origin";
  }
  if (record.originHost !== domain) {
    return "Nonce origin does not match signed domain";
  }
  if (record.tenantId && record.tenantId !== input.tenantId) {
    return "Nonce tenant does not match verification tenant";
  }
  return null;
}

// ─── PasskeyAuth singleton ────────────────────────────────────────────────────

// ─── Store backend initialization ────────────────────────────────────────────

let _challengeStore: ChallengeStore | null = null;
let _tokenStore: TokenStore | null = null;
let _oauthCodeStore: ChallengeStore | null = null;
let _mfaBackend: StoreBackend | null = null;
let _importSessionBackend: StoreBackend | null = null;
let _authStoreSources: AuthStoreSources = {
  challenge: "memory",
  token: "memory",
  siweNonce: "memory",
  mfa: "memory",
  importSession: "memory",
};
let _phoneAuth: PhoneAuth | null = null;

export type AuthStoreSource = "redis" | "postgres" | "pglite" | "memory";
export type AuthStoreSources = {
  challenge: AuthStoreSource;
  token: AuthStoreSource;
  siweNonce: AuthStoreSource;
  mfa: AuthStoreSource;
  importSession: AuthStoreSource;
};

/**
 * One-time OAuth nonce-exchange codes (response_type=code) live for 60s —
 * long enough for the user's browser to redirect back and the caller's
 * backend to POST the code to /oauth/exchange, short enough that a captured
 * code in an access log or Referer leak is useless by the time anyone reads
 * it. Codes are single-use (consume() deletes on first read).
 */
const OAUTH_CODE_TTL_MS = 60 * 1000;

/**
 * Initialize auth token/challenge stores with the best available backend.
 * Call this during server startup AFTER initRedis() has been called.
 *
 * @param usePostgres  Pass true if the DB connection is known to be available.
 */
export async function initAuthStores(usePostgres = false): Promise<void> {
  const { getRedisClient } = await import("../middleware/redis.js");
  const redisClient = getRedisClient();

  const [
    { backend: challengeBackend, source: challengeSource },
    { backend: tokenBackend, source: tokenSource },
    { backend: nonceBackend, source: nonceSource },
    { backend: mfaBackend, source: mfaSource },
    { backend: importSessionBackend, source: importSessionSource },
  ] = await Promise.all([
    buildBackend("challenge", redisClient, usePostgres),
    buildBackend("token", redisClient, usePostgres),
    buildBackend("siwe-nonce", redisClient, usePostgres),
    buildBackend("mfa", redisClient, usePostgres),
    buildBackend("import-session", redisClient, usePostgres),
  ]);

  logger.info(
    {
      details: [
        `[steward:auth] challenge store: ${challengeSource}, token store: ${tokenSource}, ` +
          `siwe-nonce store: ${nonceSource}, mfa store: ${mfaSource}, ` +
          `import-session store: ${importSessionSource}`,
      ],
    },
    "[Login:auth] info",
  );

  _challengeStore = new ChallengeStore({ backend: challengeBackend });
  _tokenStore = new TokenStore({ backend: tokenBackend });
  _nonceBackend = nonceBackend;
  _mfaBackend = mfaBackend;
  _authStoreSources = {
    challenge: challengeSource,
    token: tokenSource,
    siweNonce: nonceSource,
    mfa: mfaSource,
    importSession: importSessionSource,
  };
  // Reuse the challenge backend (Redis when available) for OAuth nonce codes
  // so they survive worker restarts and round-robin between isolates. The
  // 60s TTL is enforced at write time by ChallengeStore.
  _oauthCodeStore = new ChallengeStore({
    backend: challengeBackend,
    ttlMs: OAUTH_CODE_TTL_MS,
  });
  // Verified-email grants share the challenge backend (Redis-backed in prod)
  // so an OTP verified on one worker can register a passkey on another.
  _emailGrantStore = new ChallengeStore({
    backend: challengeBackend,
    ttlMs: EMAIL_GRANT_TTL_MS,
  });
  _importSessionBackend = importSessionBackend;

  const { initUserLinkChallengeStores } = await import("./user.js");
  initUserLinkChallengeStores(challengeBackend);

  // Reset singletons so they pick up the new stores on next use
  _passkeyAuth = null;
  _phoneAuth = null;
  _passkeyAuthByOrigin.clear();
  _emailAuthByTenant.clear();
}

function getChallengeStore(): ChallengeStore {
  _challengeStore ??= new ChallengeStore();
  return _challengeStore;
}

/**
 * Exported for the public agent-enroll routes: enrollment challenges must
 * share this initialized (Redis/Postgres in production) store instead of the
 * auth package's process-local memory singleton (SEC-052).
 */
export { getChallengeStore as getAuthChallengeStore };

function getOAuthCodeStore(): ChallengeStore {
  _oauthCodeStore ??= new ChallengeStore({ ttlMs: OAUTH_CODE_TTL_MS });
  return _oauthCodeStore;
}

// ── Verified-email grants (Privy-style OTP signup) ──────────────────────────
//
// POST /email/otp/verify exchanges a correct 6-digit code for a short-lived,
// single-use grant proving ownership of {email, tenantId}. The passkey
// register endpoints accept this grant in place of a session so a BRAND-NEW
// user can go email -> code -> Touch ID without ever holding a session,
// while keeping unverified registration (account pre-hijack) impossible.

const EMAIL_GRANT_TTL_MS = 5 * 60 * 1000;
let _emailGrantStore: ChallengeStore | null = null;

function getEmailGrantStore(): ChallengeStore {
  _emailGrantStore ??= new ChallengeStore({ ttlMs: EMAIL_GRANT_TTL_MS });
  return _emailGrantStore;
}

function emailGrantKey(grant: string): string {
  return `email-otp-grant:${hashSha256Hex(grant)}`;
}

type EmailGrantScope = "personal" | "tenant";

async function issueEmailGrant(
  email: string,
  tenantId: string,
  scope: EmailGrantScope,
): Promise<string> {
  const grantBytes = new Uint8Array(32);
  crypto.getRandomValues(grantBytes);
  const grant = uint8ArrayToBase64url(grantBytes);
  await getEmailGrantStore().set(
    emailGrantKey(grant),
    JSON.stringify({ email, tenantId, scope }),
  );
  return grant;
}

/** Consume (single-use) a grant and return its bound identity, or null. */
async function consumeEmailGrant(
  grant: string,
  email: string,
  tenantId: string,
): Promise<boolean> {
  if (!grant || grant.length > 256) return false;
  const stored = await getEmailGrantStore().consume(emailGrantKey(grant));
  if (!stored) return false;
  try {
    const payload = JSON.parse(stored) as { email?: string; tenantId?: string };
    return payload.email === email && payload.tenantId === tenantId;
  } catch {
    return false;
  }
}

/**
 * Peek (non-consuming) at a grant for the options phase. The grant is only
 * CONSUMED at register/verify so a failed/cancelled WebAuthn ceremony does
 * not burn the user's verification.
 */
async function peekEmailGrant(
  grant: string,
  email: string,
  tenantId: string,
): Promise<EmailGrantScope | null> {
  if (!grant || grant.length > 256) return null;
  const stored = await getEmailGrantStore().get(emailGrantKey(grant));
  if (!stored) return null;
  try {
    const payload: { email?: string; tenantId?: string; scope?: string } =
      JSON.parse(stored);
    if (payload.email !== email || payload.tenantId !== tenantId) return null;
    if (payload.scope === "personal") return "personal";
    // Previously issued grants retain their explicit tenant binding.
    return payload.scope === undefined || payload.scope === "tenant"
      ? "tenant"
      : null;
  } catch {
    // error-policy:J3 malformed persisted grants are invalid authentication input.
    return null;
  }
}

/**
 * Test-only seam for exercising verified-email enrollment routes without
 * sending or scraping an OTP. Production grants are still issued exclusively
 * by /email/otp/verify.
 */
export async function _seedEmailGrantForTests(
  grant: string,
  email: string,
  tenantId: string,
  scope: EmailGrantScope = "tenant",
): Promise<void> {
  await getEmailGrantStore().set(
    emailGrantKey(grant),
    JSON.stringify({ email: email.toLowerCase().trim(), tenantId, scope }),
  );
}

const OAUTH_CODE_REDEEM_LOCK_TTL_MS = 10 * 1000;
const OAUTH_CODE_REDEEM_LOCK_CLEANUP_TIMEOUT_MS = 250;

async function lockOAuthCodeRedemption(code: string): Promise<boolean> {
  return getOAuthCodeStore().setIfNotExists(
    `oauth-code-lock:${code}`,
    "1",
    OAUTH_CODE_REDEEM_LOCK_TTL_MS,
  );
}

async function releaseOAuthCodeRedemptionLock(code: string): Promise<void> {
  let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      getOAuthCodeStore().delete(`oauth-code-lock:${code}`),
      new Promise<never>((_, reject) => {
        cleanupTimer = setTimeout(
          () => reject(new Error("OAuth redemption lock cleanup timed out")),
          OAUTH_CODE_REDEEM_LOCK_CLEANUP_TIMEOUT_MS,
        );
      }),
    ]);
  } catch (error) {
    // Atomic consume is the single-use security boundary. Lock cleanup is
    // advisory because its bounded TTL preserves liveness when deletion is
    // unavailable or does not settle after a terminal consume result.
    logger.warn(
      {
        details: [
          "[OAuthAuth] Redemption lock cleanup failed",
          redactedThrownDiagnostics(error),
        ],
      },
      "[Login:auth] warn",
    );
  } finally {
    if (cleanupTimer !== undefined) clearTimeout(cleanupTimer);
  }
}

async function markOidcIdTokenUsedOnce(
  tenantId: string,
  providerId: string,
  token: string,
  exp: unknown,
): Promise<
  { ok: true } | { ok: false; response: "expired" | "replayed" | "missing-exp" }
> {
  if (typeof exp !== "number" || !Number.isFinite(exp)) {
    return { ok: false, response: "missing-exp" };
  }
  const ttlMs = Math.floor(exp * 1000 - Date.now());
  if (ttlMs <= 0) {
    return { ok: false, response: "expired" };
  }
  const tokenHash = hashSha256Hex(token);
  const inserted = await getOAuthCodeStore().setIfNotExists(
    `oidc-id-token:${tenantId}:${providerId}:${tokenHash}`,
    "1",
    ttlMs,
  );
  return inserted ? { ok: true } : { ok: false, response: "replayed" };
}

function isUnsafeUnboundOAuthProviderCodeExchangeAllowed(): boolean {
  return (
    process.env.STEWARD_ALLOW_UNBOUND_OAUTH_PROVIDER_CODE_EXCHANGE === "true"
  );
}

function isValidPkceCodeVerifier(value: string): boolean {
  return /^[A-Za-z0-9._~-]{43,128}$/.test(value);
}

async function pkceChallengeForVerifier(
  verifier: string,
  method: string,
): Promise<string | null> {
  if (method === "plain") return verifier;
  if (method !== "S256") return null;
  const bytes = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return uint8ArrayToBase64url(new Uint8Array(digest));
}

function getTokenStore(): TokenStore {
  _tokenStore ??= new TokenStore();
  return _tokenStore;
}

function getMfaBackend(): StoreBackend {
  if (_mfaBackend) return _mfaBackend;
  const { MemoryBackend } =
    require("../../../auth/src/index.ts") as typeof import("../../../auth/src/index.ts");
  _mfaBackend = new MemoryBackend();
  return _mfaBackend;
}

export function getImportSessionBackend(): StoreBackend {
  if (_importSessionBackend) return _importSessionBackend;
  const { MemoryBackend } =
    require("../../../auth/src/index.ts") as typeof import("../../../auth/src/index.ts");
  _importSessionBackend = new MemoryBackend();
  return _importSessionBackend;
}

export function getAuthStoreSources(): AuthStoreSources {
  return { ..._authStoreSources };
}

/**
 * Refuse ephemeral auth state in production and Workers deployments. Losing or
 * partitioning challenge, token, nonce, MFA, or import-session state across
 * processes can break single-use guarantees. A single-instance deployment may
 * explicitly acknowledge that trade-off, but it must never happen silently.
 */
export function assertAuthStoresAreSafe(
  sources: AuthStoreSources = getAuthStoreSources(),
): void {
  const requiresDurableStores =
    process.env.NODE_ENV === "production" ||
    process.env.STEWARD_RUNTIME === "workers";
  if (
    !requiresDurableStores ||
    process.env.STEWARD_ALLOW_MEMORY_AUTH_STORES === "true"
  )
    return;

  const memoryStores = Object.entries(sources)
    .filter(([, source]) => source === "memory")
    .map(([name]) => name);
  if (memoryStores.length > 0) {
    throw new Error(
      `Durable auth storage is required; memory-backed stores: ${memoryStores.join(", ")}. ` +
        "Configure Redis/Postgres or explicitly set STEWARD_ALLOW_MEMORY_AUTH_STORES=true " +
        "for a single-instance deployment.",
    );
  }
}

export function encryptImportSessionJson(value: unknown): string {
  return JSON.stringify(getOAuthKeyStore().encrypt(JSON.stringify(value)));
}

export function decryptImportSessionJson<T>(value: string): T {
  const encrypted = JSON.parse(value) as {
    ciphertext: string;
    iv: string;
    tag: string;
    salt: string;
  };
  return JSON.parse(getOAuthKeyStore().decrypt(encrypted)) as T;
}

let _passkeyAuth: PasskeyAuth | null = null;
const _passkeyAuthByOrigin = new Map<string, PasskeyAuth>();

/**
 * Get PasskeyAuth for a specific origin (multi-tenant passkey support).
 * Derives rpID from the Origin header so passkeys work on waifu.fun,
 * elizacloud.ai, or any other tenant domain.
 *
 * Allowed origins: PASSKEY_ALLOWED_ORIGINS env (comma-separated),
 * defaults to PASSKEY_ORIGIN.
 *
 * rpID resolution rule (apex-folding):
 *   When the request hostname is a strict subdomain of an allowed origin's
 *   hostname (e.g. request `www.waifu.fun`, allowed `https://waifu.fun`),
 *   we use the SHORTER allowed hostname as rpID. This keeps a single
 *   credential valid across apex + www and avoids breaking users who
 *   registered under one form when their canonical host changes (e.g.
 *   apex 307s to www, or vice versa).
 *
 *   WebAuthn allows rpID to be any registrable suffix of the request
 *   origin hostname, and the resulting credential is then scoped to
 *   apex + all subdomains.
 */
function resolveRpID(
  requestHostname: string,
  allowedOrigins: string[],
  fallback: string,
): string {
  let best = requestHostname;
  for (const o of allowedOrigins) {
    let host: string;
    try {
      host = new URL(o).hostname;
    } catch {
      continue;
    }
    if (host === requestHostname) {
      // Exact match. Prefer shortest match seen so far so apex wins over www.
      if (host.length < best.length || best === requestHostname) best = host;
    } else if (
      requestHostname.endsWith(`.${host}`) &&
      // shortest match wins
      (best === requestHostname || host.length < best.length)
    ) {
      best = host;
    }
  }
  if (!best) return fallback;
  return best;
}

function getPasskeyAuth(requestOrigin?: string): PasskeyAuth {
  const defaultRpID = process.env.PASSKEY_RP_ID || "eliza.app";
  const defaultOrigin = process.env.PASSKEY_ORIGIN || "https://eliza.app";
  const rpName = process.env.PASSKEY_RP_NAME || "elizaOS";

  // If no origin provided, use the default singleton
  if (!requestOrigin) {
    if (!_passkeyAuth) {
      const origins = (process.env.PASSKEY_ALLOWED_ORIGINS || defaultOrigin)
        .split(",")
        .map((o) => o.trim())
        .filter(Boolean);
      _passkeyAuth = new PasskeyAuth({
        rpName,
        rpID: defaultRpID,
        origin: origins.length > 1 ? origins : defaultOrigin,
        challengeStore: getChallengeStore(),
      });
    }
    return _passkeyAuth;
  }

  // Parse origin to get hostname
  let requestHostname: string;
  try {
    requestHostname = new URL(requestOrigin).hostname;
  } catch {
    return getPasskeyAuth(); // invalid origin, fall back to default
  }

  // Validate against allowed origins
  const allowed = (process.env.PASSKEY_ALLOWED_ORIGINS || defaultOrigin)
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  if (!allowed.includes(requestOrigin) && requestHostname !== defaultRpID) {
    return getPasskeyAuth(); // not in allowed list, use default
  }

  // Apex-fold: if the request hostname is a subdomain of any allowed origin,
  // use the allowed origin's apex hostname as rpID so the credential is
  // shared across apex + all subdomains.
  const rpID = resolveRpID(requestHostname, allowed, defaultRpID);

  // Cache per rpID
  const cached = _passkeyAuthByOrigin.get(rpID);
  if (cached) return cached;

  // Origin list passed to PasskeyAuth covers all variants the browser may
  // present (apex + www) so SimpleWebAuthn accepts assertions from either.
  const acceptedOrigins = allowed.length > 0 ? allowed : [requestOrigin];

  const auth = new PasskeyAuth({
    rpName,
    rpID,
    origin: acceptedOrigins,
    challengeStore: getChallengeStore(),
  });
  _passkeyAuthByOrigin.set(rpID, auth);
  return auth;
}

// ─── EmailAuth cache ──────────────────────────────────────────────────────────

const _emailAuthByTenant = new Map<string, Promise<EmailAuth>>();
let _emailKeyStore: KeyStore | null = null;
let _oauthKeyStore: KeyStore | null = null;

function getEmailKeyStore(): KeyStore {
  if (_emailKeyStore) return _emailKeyStore;

  const masterPassword = process.env.STEWARD_MASTER_PASSWORD;
  if (!masterPassword) {
    if (!isDevSecretAllowed()) {
      throw new Error(
        "STEWARD_MASTER_PASSWORD is required. For local development only, set STEWARD_ALLOW_DEV_SECRETS=true to use the insecure dev key.",
      );
    }
    _emailKeyStore = new KeyStore("dev-secret");
    return _emailKeyStore;
  }

  _emailKeyStore = new KeyStore(masterPassword);
  return _emailKeyStore;
}

function getOAuthKeyStore(): KeyStore {
  if (_oauthKeyStore) return _oauthKeyStore;

  const masterPassword = process.env.STEWARD_MASTER_PASSWORD;
  if (!masterPassword) {
    if (!isDevSecretAllowed()) {
      throw new Error(
        "STEWARD_MASTER_PASSWORD is required to encrypt OAuth provider tokens. For local development only, set STEWARD_ALLOW_DEV_SECRETS=true to use the insecure dev key.",
      );
    }
    _oauthKeyStore = new KeyStore("dev-secret");
    return _oauthKeyStore;
  }

  _oauthKeyStore = new KeyStore(masterPassword);
  return _oauthKeyStore;
}

type OAuthEncryptedTokenFields = Pick<
  typeof accounts.$inferInsert,
  | "accessTokenEncrypted"
  | "accessTokenIv"
  | "accessTokenTag"
  | "accessTokenSalt"
  | "refreshTokenEncrypted"
  | "refreshTokenIv"
  | "refreshTokenTag"
  | "refreshTokenSalt"
>;

export function encryptOAuthProviderTokens(
  accessToken: string,
  refreshToken?: string | null,
): OAuthEncryptedTokenFields {
  const keyStore = getOAuthKeyStore();
  const encryptedAccessToken = keyStore.encrypt(accessToken);
  const encryptedRefreshToken = refreshToken
    ? keyStore.encrypt(refreshToken)
    : null;

  return {
    accessTokenEncrypted: encryptedAccessToken.ciphertext,
    accessTokenIv: encryptedAccessToken.iv,
    accessTokenTag: encryptedAccessToken.tag,
    accessTokenSalt: encryptedAccessToken.salt,
    refreshTokenEncrypted: encryptedRefreshToken?.ciphertext ?? null,
    refreshTokenIv: encryptedRefreshToken?.iv ?? null,
    refreshTokenTag: encryptedRefreshToken?.tag ?? null,
    refreshTokenSalt: encryptedRefreshToken?.salt ?? null,
  };
}

export function decryptOAuthProviderToken(encrypted: {
  ciphertext: string | null;
  iv: string | null;
  tag: string | null;
  salt: string | null;
}): string | null {
  if (!encrypted.ciphertext) return null;
  if (!encrypted.iv || !encrypted.tag || !encrypted.salt) {
    throw new Error(
      "OAuth provider token is not encrypted or is missing encryption metadata",
    );
  }

  try {
    return getOAuthKeyStore().decrypt({
      ciphertext: encrypted.ciphertext,
      iv: encrypted.iv,
      tag: encrypted.tag,
      salt: encrypted.salt,
    });
  } catch (err) {
    throw new Error(
      `Failed to decrypt OAuth provider token: check STEWARD_MASTER_PASSWORD${
        err instanceof Error ? ` (${err.message})` : ""
      }`,
    );
  }
}

function isMockEmailEnabled(): boolean {
  if (
    process.env.EMAIL_PROVIDER === "mock" &&
    process.env.NODE_ENV === "production"
  ) {
    throw new Error(
      "EMAIL_PROVIDER=mock is forbidden in production. Unset EMAIL_PROVIDER or set RESEND_API_KEY.",
    );
  }
  return (
    process.env.EMAIL_PROVIDER === "mock" &&
    process.env.NODE_ENV !== "production"
  );
}

function authTestInboxEnabled(): boolean {
  return process.env.NODE_ENV === "test";
}

function isEnabledTestAccount(
  value: TenantTestAccountConfig | undefined,
): value is Required<
  Pick<TenantTestAccountConfig, "enabled" | "email" | "phone">
> &
  TenantTestAccountConfig {
  const testAccount = value as
    | (TenantTestAccountConfig & { otpHash?: string })
    | undefined;
  return (
    testAccount?.enabled === true &&
    typeof testAccount.email === "string" &&
    typeof testAccount.phone === "string" &&
    ((typeof testAccount.otpHash === "string" &&
      testAccount.otpHash.length > 0) ||
      (typeof testAccount.otp === "string" && testAccount.otp.length > 0))
  );
}

function testCredentialMatches(
  actual: string | undefined,
  expected: string | undefined,
): boolean {
  if (!actual || !expected) return false;
  return (
    hashSha256Hex(actual.trim().toLowerCase()) ===
    hashSha256Hex(expected.trim().toLowerCase())
  );
}

function invalidTestAccountCredentials() {
  return {
    ok: false,
    error: "Invalid test account credentials",
  } satisfies ApiResponse;
}

/**
 * Map typed email-delivery failures to fail-closed HTTP responses
 * (elizaOS/eliza#18452): 503 when no delivery-capable provider is configured
 * (challenge never issued), 502 when the provider rejected the send (the
 * challenge was already invalidated by EmailAuth). Returns null for any other
 * error so it propagates unchanged. Response bodies are generic — no
 * recipient, token, or provider detail.
 */
function emailDeliveryFailureResponse(
  c: Context,
  err: unknown,
): Response | null {
  if (err instanceof EmailDeliveryNotConfiguredError) {
    return c.json<ApiResponse>(
      { ok: false, error: "Email delivery is not configured" },
      503,
    );
  }
  if (err instanceof EmailDeliveryError) {
    return c.json<ApiResponse>(
      { ok: false, error: "Email could not be sent. Please try again later." },
      502,
    );
  }
  return null;
}

function emailMagicLinkVerifySubject(
  token: string,
  email: string,
  tenantId: string,
): string {
  return hashSha256Hex(
    [
      tenantId.trim().toLowerCase(),
      email.trim().toLowerCase(),
      token.trim(),
    ].join(":"),
  );
}

/**
 * Build EmailAuth renderer overrides from deployer-supplied raw templates
 * (tenant_configs.email_config.templates). Branded markup is instance CONFIG,
 * not repo code: when a tenant carries its own subject/text/html we render it
 * with {{placeholder}} substitution; otherwise fall through to the built-in
 * templateId resolution.
 */
function buildTemplateRenderers(templates: TenantEmailConfig["templates"]): {
  templateRenderer?: EmailAuthConfig["templateRenderer"];
  otpTemplateRenderer?: EmailAuthConfig["otpTemplateRenderer"];
} {
  if (!templates) return {};
  const magicLink = templates.magicLink;
  const otp = templates.otp;
  return {
    ...(magicLink
      ? {
          templateRenderer: (
            _templateId: string | undefined,
            data: MagicLinkTemplateData,
          ) => renderCustomTemplate(magicLink, magicLinkTemplateValues(data)),
        }
      : {}),
    ...(otp
      ? {
          otpTemplateRenderer: (
            _templateId: string | undefined,
            data: OtpTemplateData,
          ) => renderCustomTemplate(otp, otpTemplateValues(data)),
        }
      : {}),
  };
}

function globalEmailMagicLinkBaseUrl(): string {
  const emailBaseUrl = runtimeEnvironmentValue(
    "EMAIL_MAGIC_LINK_BASE_URL",
  )?.trim();
  if (emailBaseUrl) {
    const parsed = new URL(emailBaseUrl);
    const normalized = emailBaseUrl.replace(/\/$/, "");
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      parsed.origin !== normalized
    ) {
      throw new Error(
        "EMAIL_MAGIC_LINK_BASE_URL must be a credential-free HTTP(S) origin",
      );
    }
    return parsed.origin;
  }

  return (
    runtimeEnvironmentValue("APP_URL")?.trim().replace(/\/$/, "") ||
    "https://eliza.app"
  );
}

function globalEmailMagicLinkCallbackPath(): string | undefined {
  const callbackPath = runtimeEnvironmentValue(
    "EMAIL_MAGIC_LINK_CALLBACK_PATH",
  )?.trim();
  if (!callbackPath) return undefined;
  if (!callbackPath.startsWith("/") || callbackPath.startsWith("//")) {
    throw new Error(
      "EMAIL_MAGIC_LINK_CALLBACK_PATH must be a root-relative path",
    );
  }
  return callbackPath;
}

function globalEmailBrandName(): string | undefined {
  const brandName = runtimeEnvironmentValue("EMAIL_BRAND_NAME")?.trim();
  if (!brandName) return undefined;
  if (brandName.length > 100 || /[\r\n]/.test(brandName)) {
    throw new Error(
      "EMAIL_BRAND_NAME must be a single-line string of at most 100 characters",
    );
  }
  return brandName;
}

function buildGlobalEmailAuth(overrides?: {
  baseUrl?: string;
  callbackPath?: string;
  templateId?: string;
  brandName?: string;
  subjectOverride?: string;
  replyTo?: string;
  templates?: TenantEmailConfig["templates"];
}): EmailAuth {
  const resendKey = process.env.RESEND_API_KEY;
  // Mock takes precedence in non-production for deterministic e2e testing.
  const provider = isMockEmailEnabled()
    ? new MockEmailProvider()
    : resendKey
      ? new ResendProvider({
          apiKey: resendKey,
          from: process.env.EMAIL_FROM || "login@eliza.app",
        })
      : undefined;

  return new EmailAuth({
    from: process.env.EMAIL_FROM || "login@eliza.app",
    baseUrl:
      overrides?.baseUrl?.replace(/\/$/, "") || globalEmailMagicLinkBaseUrl(),
    callbackPath: overrides?.callbackPath || globalEmailMagicLinkCallbackPath(),
    provider,
    tokenStore: getTokenStore(),
    templateId: overrides?.templateId,
    brandName: overrides?.brandName || globalEmailBrandName(),
    subjectOverride: overrides?.subjectOverride,
    replyTo: overrides?.replyTo,
    ...buildTemplateRenderers(overrides?.templates),
  });
}

function parseEncryptedEmailApiKey(value: string): {
  ciphertext: string;
  iv: string;
  tag: string;
  salt: string;
} {
  const parsed = JSON.parse(value) as Partial<{
    ciphertext: string;
    iv: string;
    tag: string;
    salt: string;
  }>;

  if (!parsed.ciphertext || !parsed.iv || !parsed.tag || !parsed.salt) {
    throw new Error("Invalid tenant email config encryption payload");
  }

  return {
    ciphertext: parsed.ciphertext,
    iv: parsed.iv,
    tag: parsed.tag,
    salt: parsed.salt,
  };
}

async function loadTenantEmailConfig(
  tenantId: string,
): Promise<TenantEmailConfig | null> {
  return (await authTenantConfigSubject(tenantId))?.email_config ?? null;
}

async function createEmailAuthForTenant(tenantId: string): Promise<EmailAuth> {
  const emailConfig = await loadTenantEmailConfig(tenantId);

  // Per-tenant magic-link override: when a tenant supplies its own
  // `magicLinkBaseUrl` we build the link against that origin so the click
  // lands on the tenant's app (e.g. https://waifu.fun/auth/email/verify)
  // instead of Steward's built-in callback (which redirects to
  // EMAIL_AUTH_REDIRECT_BASE_URL and is hard-defaulted to elizacloud.ai).
  const magicLinkBaseUrl = emailConfig?.magicLinkBaseUrl;
  const callbackPath = magicLinkBaseUrl
    ? emailConfig?.magicLinkCallbackPath || "/auth/email/verify"
    : undefined; // let EmailAuth fall through to its DEFAULT_CALLBACK

  if (!emailConfig || !emailConfig.apiKeyEncrypted) {
    // No per-tenant Resend config (or only magic-link override) — use the
    // global env-backed provider but still honor the per-tenant magic-link
    // AND template overrides if present. Without the template pass-through a
    // tenant that sets only `templateId` (no own Resend key) silently got the
    // Steward-branded default email instead of its configured branding.
    return buildGlobalEmailAuth({
      baseUrl: magicLinkBaseUrl,
      callbackPath,
      templateId: emailConfig?.templateId,
      brandName: emailConfig?.brandName,
      subjectOverride: emailConfig?.subjectOverride,
      replyTo: emailConfig?.replyTo,
      templates: emailConfig?.templates,
    });
  }

  // We've already returned via buildGlobalEmailAuth above when apiKeyEncrypted
  // is missing, so it's safe to assume `emailConfig.from + apiKeyEncrypted`
  // are both present here.
  const from = emailConfig.from || process.env.EMAIL_FROM || "login@eliza.app";
  const provider =
    emailConfig.provider === "resend" && emailConfig.apiKeyEncrypted
      ? new ResendProvider({
          apiKey: getEmailKeyStore().decrypt(
            parseEncryptedEmailApiKey(emailConfig.apiKeyEncrypted),
          ),
          from,
          replyTo: emailConfig.replyTo,
        })
      : undefined;

  const baseUrl =
    magicLinkBaseUrl?.replace(/\/$/, "") || globalEmailMagicLinkBaseUrl();

  return new EmailAuth({
    from,
    baseUrl,
    callbackPath: callbackPath || globalEmailMagicLinkCallbackPath(),
    provider,
    tokenStore: getTokenStore(),
    templateId: emailConfig.templateId,
    brandName: emailConfig.brandName || globalEmailBrandName(),
    subjectOverride: emailConfig.subjectOverride,
    replyTo: emailConfig.replyTo,
    ...buildTemplateRenderers(emailConfig.templates),
  });
}

export async function getEmailAuthForTenant(
  tenantId: string,
): Promise<EmailAuth> {
  const cached = _emailAuthByTenant.get(tenantId);
  if (cached) return cached;

  const pending = createEmailAuthForTenant(tenantId).catch((error) => {
    _emailAuthByTenant.delete(tenantId);
    throw error;
  });
  _emailAuthByTenant.set(tenantId, pending);
  return pending;
}

export function invalidateEmailAuthForTenant(tenantId: string): void {
  _emailAuthByTenant.delete(tenantId);
}

export function clearEmailAuthTenantCacheForTests(): void {
  _emailAuthByTenant.clear();
}

export function clearOAuthTokenKeyStoreForTests(): void {
  _oauthKeyStore = null;
}

/**
 * Test-only seam: write a fully-formed OAuth nonce payload into the code
 * store so the /oauth/exchange route can be exercised end-to-end without
 * running a real provider callback. Production callers should never use
 * this — the only writer of the code store is the `/oauth/<provider>/callback`
 * handler.
 */
export function _seedOAuthExchangeCodeForTests(
  code: string,
  payload: {
    token: string;
    refreshToken: string;
    redirectUri: string;
    tenantId: string | null;
    providerName?: string;
    codeChallenge?: string;
    codeChallengeMethod?: string;
    expiresAt?: number;
    expiresIn?: number;
  },
): void {
  const fullPayload = {
    token: payload.token,
    refreshToken: payload.refreshToken,
    redirectUri: payload.redirectUri,
    tenantId: payload.tenantId,
    ...(payload.providerName ? { providerName: payload.providerName } : {}),
    ...(payload.codeChallenge ? { codeChallenge: payload.codeChallenge } : {}),
    ...(payload.codeChallengeMethod
      ? { codeChallengeMethod: payload.codeChallengeMethod }
      : {}),
    expiresAt: payload.expiresAt ?? Date.now() + OAUTH_CODE_TTL_MS,
    expiresIn: payload.expiresIn ?? ACCESS_TOKEN_EXPIRY_SECONDS,
  };
  getOAuthCodeStore().set(`oauth-code:${code}`, JSON.stringify(fullPayload));
}

export function _clearOAuthCodeStoreForTests(): void {
  _oauthCodeStore?.destroy();
  _oauthCodeStore = null;
}

// ─── Vault helper ─────────────────────────────────────────────────────────────

function getVault(): Vault {
  return getConfiguredVault();
}

// ─── Tenant resolution ────────────────────────────────────────────────────────

/**
 * Resolve the tenant the user is signing into.
 * Priority: X-Steward-Tenant header > body.tenantId > personal-<userId> fallback.
 * Returns null if the resolved tenant doesn't exist in the DB (caller should 404).
 */
type TenantResolutionOk = { ok: true; tenantId: string; isPersonal: boolean };
type TenantResolutionErr = {
  ok: false;
  status: 400 | 403 | 404;
  error: string;
};
type TenantResolutionResult = TenantResolutionOk | TenantResolutionErr;

/**
 * Resolve and validate the tenant a user is authenticating into.
 *
 * Priority: X-Steward-Tenant header > body.tenantId > personal-<userId> fallback.
 *
 * When an explicit tenantId is requested:
 *   1. Verify the tenant exists in the `tenants` table (404 if not)
 *   2. Check if user already has a user_tenants link (always allowed if so)
 *   3. Look up join_mode from tenant_configs
 *   4. If join_mode is 'open', auto-link is allowed
 *   5. If join_mode is missing, 'invite', or 'closed', 403
 */
async function resolveAndValidateTenant(
  c: Context,
  userId: string,
  bodyTenantId?: string,
): Promise<TenantResolutionResult> {
  const headerTenant = c.req.header("X-Steward-Tenant")?.trim();
  const requested = headerTenant || bodyTenantId?.trim() || undefined;

  if (!requested) {
    return { ok: true, tenantId: `personal-${userId}`, isPersonal: true };
  }
  if (!isValidTenantId(requested)) {
    return { ok: false, status: 400, error: "Invalid tenant id format" };
  }
  if (isReservedTenantId(requested) && requested !== `personal-${userId}`) {
    return {
      ok: false,
      status: 403,
      error: "Personal tenants cannot be self-joined",
    };
  }

  const subject = await authTenantSubject(requested, userId);
  if (!subject) {
    return { ok: false, status: 404, error: `Tenant '${requested}' not found` };
  }

  // 2. Check if user already has a link (always allowed regardless of join_mode)
  if (subject.membership_role) {
    return { ok: true, tenantId: requested, isPersonal: false };
  }

  // 3. No existing link; check join_mode from tenant_configs
  const joinMode = subject.join_mode;

  if (joinMode === "open") {
    return { ok: true, tenantId: requested, isPersonal: false };
  }

  if (!joinMode) {
    return {
      ok: false,
      status: 403,
      error: `Tenant '${requested}' is not configured for self-join`,
    };
  }

  if (joinMode === "invite") {
    return {
      ok: false,
      status: 403,
      error: `Tenant '${requested}' requires an invitation to join`,
    };
  }

  // joinMode === "closed"
  return {
    ok: false,
    status: 403,
    error: `Tenant '${requested}' is not accepting new members`,
  };
}

// ─── User / tenant provisioning helpers ──────────────────────────────────────

type UserProvisionResult = {
  user: typeof users.$inferSelect;
  isNew: boolean;
};

async function findOrCreateUserWithStatus(
  email: string,
): Promise<UserProvisionResult> {
  const db = getDb();
  const [existing] = await db
    .select()
    .from(users)
    .where(eq(users.email, email));
  if (existing) return { user: existing, isNew: false };
  const [newUser] = await db
    .insert(users)
    .values({ email, emailVerified: false })
    .returning();
  return { user: newUser, isNew: true };
}

async function findUserByEmail(
  email: string,
): Promise<typeof users.$inferSelect | null> {
  const [existing] = await getDb()
    .select()
    .from(users)
    .where(eq(users.email, email));
  return existing ?? null;
}

async function resolveEmailTenantBeforeMutation(
  c: Context,
  requestedTenantId: string | undefined,
  existingUserId: string | null,
): Promise<TenantResolutionResult | null> {
  if (!requestedTenantId) return null;
  if (existingUserId)
    return resolveAndValidateTenant(c, existingUserId, requestedTenantId);
  if (!isValidTenantId(requestedTenantId)) {
    return { ok: false, status: 400, error: "Invalid tenant id format" };
  }
  if (isReservedTenantId(requestedTenantId)) {
    return {
      ok: false,
      status: 403,
      error: "Personal tenants cannot be self-joined",
    };
  }

  const subject = await authTenantSubject(requestedTenantId);
  if (!subject) {
    return {
      ok: false,
      status: 404,
      error: `Tenant '${requestedTenantId}' not found`,
    };
  }
  if (subject.join_mode === "open") {
    return { ok: true, tenantId: requestedTenantId, isPersonal: false };
  }
  return {
    ok: false,
    status: 403,
    error:
      subject.join_mode === "closed"
        ? `Tenant '${requestedTenantId}' is not accepting new members`
        : subject.join_mode === "invite"
          ? `Tenant '${requestedTenantId}' requires an invitation to join`
          : `Tenant '${requestedTenantId}' is not configured for self-join`,
  };
}

async function findOrCreateWalletUserWithStatus(
  walletAddress: string,
  walletChain: "ethereum" | "solana",
): Promise<UserProvisionResult> {
  const db = getDb();
  const [existing] = await db
    .select()
    .from(users)
    .where(
      and(
        eq(users.walletAddress, walletAddress),
        eq(users.walletChain, walletChain),
      ),
    );
  if (existing) return { user: existing, isNew: false };

  try {
    const [created] = await db
      .insert(users)
      .values({
        walletAddress,
        walletChain,
        email: null,
        emailVerified: false,
      })
      .returning();
    return { user: created, isNew: true };
  } catch (error) {
    const [concurrent] = await db
      .select()
      .from(users)
      .where(
        and(
          eq(users.walletAddress, walletAddress),
          eq(users.walletChain, walletChain),
        ),
      );
    if (concurrent) return { user: concurrent, isNew: false };
    throw error;
  }
}

async function findOrCreatePhoneUserWithStatus(
  phone: string,
): Promise<UserProvisionResult> {
  const phoneSubject = `phone:${hashSha256Hex(phone)}`;
  const db = getDb();
  const [existing] = await db
    .select()
    .from(users)
    .where(eq(users.walletAddress, phoneSubject));
  if (existing) return { user: existing, isNew: false };

  const [created] = await db
    .insert(users)
    .values({
      email: null,
      emailVerified: false,
      walletAddress: phoneSubject,
      walletChain: "ethereum",
    })
    .returning();
  return { user: created, isNew: true };
}

async function findOrCreateExternalAccountUserWithStatus(input: {
  provider: string;
  providerAccountId: string;
  name?: string;
  image?: string;
}): Promise<UserProvisionResult> {
  const db = getDb();
  const [existingAccount] = await db
    .select({ user: users })
    .from(accounts)
    .innerJoin(users, eq(accounts.userId, users.id))
    .where(
      and(
        eq(accounts.provider, input.provider),
        eq(accounts.providerAccountId, input.providerAccountId),
      ),
    );
  if (existingAccount) return { user: existingAccount.user, isNew: false };

  try {
    return await db.transaction(async (tx) => {
      const [raceWinner] = await tx
        .select({ user: users })
        .from(accounts)
        .innerJoin(users, eq(accounts.userId, users.id))
        .where(
          and(
            eq(accounts.provider, input.provider),
            eq(accounts.providerAccountId, input.providerAccountId),
          ),
        );
      if (raceWinner) return { user: raceWinner.user, isNew: false };

      const [created] = await tx
        .insert(users)
        .values({
          email: null,
          emailVerified: false,
          name: input.name,
          image: input.image,
        })
        .returning();
      await tx.insert(accounts).values({
        userId: created.id,
        provider: input.provider,
        providerAccountId: input.providerAccountId,
      });
      return { user: created, isNew: true };
    });
  } catch (error) {
    const [winner] = await db
      .select({ user: users })
      .from(accounts)
      .innerJoin(users, eq(accounts.userId, users.id))
      .where(
        and(
          eq(accounts.provider, input.provider),
          eq(accounts.providerAccountId, input.providerAccountId),
        ),
      );
    if (winner) return { user: winner.user, isNew: false };
    throw error;
  }
}

function dispatchUserCreated(
  tenantId: string,
  userId: string,
  source: string,
  extra: Record<string, unknown> = {},
): void {
  dispatchWebhook(tenantId, userId, "user.created", {
    userId,
    source,
    ...extra,
  });
}

function dispatchUserAuthenticated(
  tenantId: string,
  userId: string,
  authMethod?: string,
): void {
  dispatchWebhook(tenantId, userId, "user.authenticated", {
    userId,
    ...(authMethod ? { authMethod } : {}),
  });
}

async function writeAuthLoginAudit(
  c: Context,
  tenantId: string,
  userId: string,
  claims: Record<string, unknown> | undefined,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await withVerifiedAuthTenant(tenantId, userId, () =>
    writeAuditEvent({
      tenantId,
      actorType: "user",
      actorId: userId,
      action: "auth.login",
      resourceType: "session",
      metadata: {
        method:
          typeof claims?.authMethod === "string"
            ? claims.authMethod
            : "unknown",
        ...metadata,
      },
      ipAddress: c.req.header("x-forwarded-for") ?? null,
      userAgent: c.req.header("user-agent") ?? null,
      requestId: c.get("requestId") ?? c.req.header("x-request-id") ?? null,
    }),
  );
}

type WalletTenantResult = {
  tenant: typeof tenants.$inferSelect;
  isNewTenant: boolean;
  rawApiKey?: string;
};

async function findOrCreateWalletTenant(opts: {
  ownerAddress: string;
  tenantId: string;
  tenantName: string;
}): Promise<WalletTenantResult> {
  // The caller has verified the signature before deriving this wallet tenant.
  return withPreAuthTenant(opts.tenantId, "verified-wallet", async () => {
    const db = getDb();
    const [existingTenant] = await db
      .select()
      .from(tenants)
      .where(eq(tenants.ownerAddress, opts.ownerAddress));
    if (existingTenant) {
      return { tenant: existingTenant, isNewTenant: false };
    }

    const apiKeyPair = generateApiKey();
    const [newTenant] = await db
      .insert(tenants)
      .values({
        id: opts.tenantId,
        name: opts.tenantName,
        apiKeyHash: apiKeyPair.hash,
        ownerAddress: opts.ownerAddress,
      })
      .onConflictDoNothing()
      .returning();

    if (newTenant) {
      return {
        tenant: newTenant,
        isNewTenant: true,
        rawApiKey: apiKeyPair.key,
      };
    }

    const [retryTenant] = await db
      .select()
      .from(tenants)
      .where(eq(tenants.ownerAddress, opts.ownerAddress));
    if (retryTenant) {
      return { tenant: retryTenant, isNewTenant: false };
    }

    const [conflictingTenant] = await db
      .select()
      .from(tenants)
      .where(eq(tenants.id, opts.tenantId));
    if (conflictingTenant) {
      throw new Error(
        "Wallet tenant id is already reserved for a different owner",
      );
    }

    throw new Error("Failed to create tenant");
  });
}

function ethereumWalletTenantId(address: string): string {
  return `eth:${address.toLowerCase()}`;
}

function getAllowedSiweDomains(): string[] {
  const raw = process.env.SIWE_ALLOWED_DOMAINS?.trim();
  if (raw) {
    const domains = raw
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean);
    if (domains.length > 0) return domains;
  }

  const appUrl = process.env.APP_URL?.trim() || "https://eliza.app";
  try {
    return [new URL(appUrl).host.toLowerCase()];
  } catch {
    // SEC-144: fail closed. Never derive allowed SIWE domains from the
    // request Host header — a missing or invalid APP_URL must not silently
    // disable domain binding. Set SIWE_ALLOWED_DOMAINS (or a valid APP_URL)
    // explicitly.
    return [];
  }
}

type ParsedSiwsMessage = {
  domain: string;
  publicKey: string;
  nonce: string;
  issuedAt?: string;
  expirationTime?: string;
  notBefore?: string;
  uri?: string;
  version?: string;
  chainId?: string;
  statement?: string;
};

const ALLOWED_SOLANA_CHAIN_IDS = new Set(["solana", "mainnet", "devnet"]);

function isAllowedSiwsUri(uri: string | undefined, domain: string): boolean {
  if (!uri) return false;
  try {
    const parsedUri = new URL(uri);
    if (parsedUri.host !== domain) return false;
    if (parsedUri.protocol === "https:") return true;
    // http:// is only acceptable for loopback hosts. Production deployments
    // never see localhost here, so the relaxation is naturally scoped to
    // dev / e2e — no env flag needed.
    if (parsedUri.protocol === "http:") {
      const host = parsedUri.hostname;
      return host === "localhost" || host === "127.0.0.1" || host === "::1";
    }
    return false;
  } catch {
    return false;
  }
}

function isAllowedSiwsChainId(chainId: string | undefined): boolean {
  if (!chainId) return true;
  return ALLOWED_SOLANA_CHAIN_IDS.has(chainId.trim().toLowerCase());
}

function parseSiwsMessage(message: string): ParsedSiwsMessage | null {
  const lines = message.split(/\r?\n/);
  if (lines.length < 2) return null;

  const firstLine = lines[0]?.trim();
  const publicKey = lines[1]?.trim();
  const match = firstLine?.match(
    /^(.*) wants you to sign in with your Solana account:$/,
  );
  if (!match || !publicKey) return null;

  const statementLines: string[] = [];
  const fields = new Map<string, string>();
  let inFields = false;

  for (const rawLine of lines.slice(2)) {
    const line = rawLine.trim();
    if (!line) continue;

    const fieldMatch = line.match(/^([A-Za-z ]+):\s*(.+)$/);
    if (fieldMatch) {
      inFields = true;
      fields.set(
        fieldMatch[1].toLowerCase().replace(/\s+/g, ""),
        fieldMatch[2],
      );
      continue;
    }

    if (!inFields) {
      statementLines.push(line);
    }
  }

  const nonce = fields.get("nonce");
  if (!nonce) return null;

  return {
    domain: match[1].trim(),
    publicKey,
    nonce,
    issuedAt: fields.get("issuedat"),
    expirationTime: fields.get("expirationtime"),
    notBefore: fields.get("notbefore"),
    uri: fields.get("uri"),
    version: fields.get("version"),
    chainId: fields.get("chainid"),
    statement:
      statementLines.length > 0 ? statementLines.join("\n") : undefined,
  };
}

function verifySolanaMessageSignature(
  message: string,
  signature: string,
  publicKey: string,
): boolean {
  try {
    const publicKeyBytes = bs58.decode(publicKey);
    const signatureBytes = bs58.decode(signature);
    if (publicKeyBytes.length !== 32) return false;

    const keyObject = createPublicKey({
      key: {
        kty: "OKP",
        crv: "Ed25519",
        x: uint8ArrayToBase64url(publicKeyBytes),
      },
      format: "jwk",
    });

    return verifySignature(
      null,
      Buffer.from(message, "utf8"),
      keyObject,
      signatureBytes,
    );
  } catch {
    return false;
  }
}

/**
 * Ensure the user's personal tenant exists.
 * Used as a fallback when no explicit tenant is requested AND as the home for
 * the user's provisioned wallet agent (wallet always lives under personal tenant).
 */
async function ensurePersonalTenant(
  userId: string,
  displayName: string,
): Promise<string> {
  const tenantId = `personal-${userId}`;
  return withVerifiedAuthTenant(tenantId, userId, async () => {
    const { hash } = generateApiKey();
    await getDb()
      .insert(tenants)
      .values({ id: tenantId, name: displayName, apiKeyHash: hash })
      .onConflictDoNothing();
    return tenantId;
  });
}

/**
 * Link a user to a tenant in the user_tenants junction table (idempotent).
 * If the tenant doesn't exist yet, silently skips — caller must ensure the
 * tenant exists before calling this.
 */
async function ensureUserTenantLink(
  userId: string,
  tenantId: string,
  role: string = "member",
): Promise<void> {
  await withVerifiedAuthTenant(tenantId, userId, async () => {
    await getDb()
      .insert(userTenants)
      .values({ userId, tenantId, role })
      .onConflictDoNothing();
  });
}

/**
 * Provision the user's personal wallet (idempotent).
 * The wallet agent always lives under `personal-<userId>` regardless of which
 * tenant the user authenticated through — the JWT tenantId is the requesting
 * tenant, but the wallet itself stays in the personal namespace.
 */
async function provisionWalletForUser(
  userId: string,
  email: string,
): Promise<{ walletAddress: string; personalTenantId: string }> {
  const personalTenantId = `personal-${userId}`;
  return withVerifiedAuthTenant(personalTenantId, userId, async () => {
    await ensurePersonalTenant(userId, email);
    const vault = getVault();
    const result = await provisionUserWallet(
      vault,
      userId,
      email,
      personalTenantId,
    );
    await getDb()
      .update(users)
      .set({
        walletAddress: result.walletAddress,
        stewardWalletId: result.agentId,
      })
      .where(eq(users.id, userId));
    await ensureUserTenantLink(userId, personalTenantId, "owner");
    return { walletAddress: result.walletAddress, personalTenantId };
  });
}

// ─── Request body helper ──────────────────────────────────────────────────────

async function safeJsonParse<T>(c: Context): Promise<T | null> {
  try {
    return await c.req.json<T>();
  } catch {
    return null;
  }
}

async function requireSession(c: Context): Promise<
  | {
      ok: true;
      token: string;
      payload: {
        address: string;
        tenantId: string;
        userId: string;
        email?: string;
        iat?: number;
        authMethod?: string;
        factorEnrollmentVerifiedAt?: number;
        mfaVerifiedAt?: number;
        mfaMethod?: string;
      };
    }
  | { ok: false; response: Response }
> {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return {
      ok: false,
      response: c.json<ApiResponse>(
        { ok: false, error: "Authorization header required" },
        401,
      ),
    };
  }

  const token = authHeader.slice(7);
  const payload = await verifySessionToken(token);
  if (!payload) {
    return {
      ok: false,
      response: c.json<ApiResponse>(
        { ok: false, error: "Invalid or expired token" },
        401,
      ),
    };
  }
  if (!payload.userId) {
    return {
      ok: false,
      response: c.json<ApiResponse>(
        { ok: false, error: "Token does not contain userId" },
        400,
      ),
    };
  }

  return { ok: true, token, payload: { ...payload, userId: payload.userId } };
}

async function hasAnyDurableFactor(userId: string): Promise<boolean> {
  if (await hasTotpEnabled(userId)) return true;
  if (await getSmsMfa(userId)) return true;

  const [passkey] = await getDb()
    .select({ id: authenticators.id })
    .from(authenticators)
    .where(eq(authenticators.userId, userId))
    .limit(1);
  return Boolean(passkey);
}

function sessionHasRecentFactorEnrollmentStepUp(
  session: Extract<Awaited<ReturnType<typeof requireSession>>, { ok: true }>,
  existingDurableFactor: boolean,
): boolean {
  const now = Date.now();
  if (
    typeof session.payload.mfaVerifiedAt === "number" &&
    now - session.payload.mfaVerifiedAt >= 0 &&
    now - session.payload.mfaVerifiedAt <= FACTOR_ENROLLMENT_STEP_UP_MAX_AGE_MS
  ) {
    return true;
  }
  if (existingDurableFactor && session.payload.authMethod !== "passkey") {
    return false;
  }
  if (
    typeof session.payload.factorEnrollmentVerifiedAt === "number" &&
    Number.isFinite(session.payload.factorEnrollmentVerifiedAt) &&
    now - session.payload.factorEnrollmentVerifiedAt >= 0 &&
    now - session.payload.factorEnrollmentVerifiedAt <=
      FACTOR_ENROLLMENT_STEP_UP_MAX_AGE_MS
  ) {
    return true;
  }
  return false;
}

async function requireRecentFactorEnrollmentStepUp(
  c: Context,
  session: Extract<Awaited<ReturnType<typeof requireSession>>, { ok: true }>,
): Promise<Response | null> {
  const existingDurableFactor = await hasAnyDurableFactor(
    session.payload.userId,
  );
  if (sessionHasRecentFactorEnrollmentStepUp(session, existingDurableFactor))
    return null;
  return c.json<ApiResponse>(
    {
      ok: false,
      error: "Recent sign-in, MFA, or passkey re-authentication is required",
    },
    403,
  );
}

export function getPhoneAuth(): PhoneAuth {
  if (_phoneAuth) return _phoneAuth;

  let provider: SmsProvider | undefined;
  let managedProvider: ManagedSmsOtpProvider | undefined;
  if (
    process.env.SMS_PROVIDER === "mock" &&
    process.env.NODE_ENV !== "production"
  ) {
    provider = new MockSmsProvider();
  } else {
    managedProvider = buildTwilioVerifyProviderFromEnvironment();
    if (
      !managedProvider &&
      process.env.TWILIO_ACCOUNT_SID &&
      process.env.TWILIO_AUTH_TOKEN &&
      process.env.TWILIO_FROM
    ) {
      provider = new TwilioSmsProvider({
        accountSid: process.env.TWILIO_ACCOUNT_SID,
        authToken: process.env.TWILIO_AUTH_TOKEN,
        from: process.env.TWILIO_FROM,
      });
    } else if (!managedProvider && process.env.NODE_ENV === "production") {
      throw new Error("SMS provider not configured");
    }
  }

  _phoneAuth = new PhoneAuth({
    provider,
    managedProvider,
    tokenStore: new TokenStore({ backend: getMfaBackend() }),
  });
  return _phoneAuth;
}

function buildTwilioVerifyProviderFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): TwilioVerifyProvider | undefined {
  const verifyConfigured =
    env.TWILIO_VERIFY_SERVICE_SID !== undefined ||
    env.TWILIO_VERIFY_TOKEN_TTL_SECONDS !== undefined;
  if (!verifyConfigured) return undefined;
  return new TwilioVerifyProvider({
    accountSid: env.TWILIO_ACCOUNT_SID ?? "",
    authToken: env.TWILIO_AUTH_TOKEN ?? "",
    serviceSid: env.TWILIO_VERIFY_SERVICE_SID ?? "",
    tokenTtlSeconds: Number(env.TWILIO_VERIFY_TOKEN_TTL_SECONDS),
  });
}

/** Fail app construction before health/readiness can accept malformed Verify config. */
export function validatePhoneAuthProviderEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (env.SMS_PROVIDER === "mock" && env.NODE_ENV !== "production") return;
  buildTwilioVerifyProviderFromEnvironment(env);
}

function isWhatsAppOtpEnabled(): boolean {
  return process.env.WHATSAPP_OTP_ENABLED === "true";
}

function isFarcasterLoginEnabled(): boolean {
  return process.env.FARCASTER_LOGIN_ENABLED === "true";
}

const TELEGRAM_LOGIN_MAX_AGE_SEC = 24 * 60 * 60;
const TELEGRAM_LOGIN_CHALLENGE_TTL_MS = 5 * 60 * 1000;

type TelegramLoginChallengeRecord = {
  tenantId?: string;
  originHost?: string;
  issuedAt: number;
};

async function requiredTelegramOriginHostFromRequest(
  c: Context,
  tenantId?: string,
): Promise<string | null> {
  const originHost = originHostFromRequest(c);
  if (!originHost) return null;

  if (!tenantId) {
    return getAllowedSiweDomains().includes(originHost) ? originHost : null;
  }

  const config = await authTenantConfigSubject(tenantId);
  for (const allowedOrigin of config?.allowed_origins ?? []) {
    if (allowedOrigin.trim() === "*") continue;
    try {
      if (new URL(allowedOrigin).host.toLowerCase() === originHost)
        return originHost;
    } catch {}
  }

  return null;
}

function telegramLoginChallengeKey(challengeId: string): string {
  return `telegram-login-challenge:${hashSha256Hex(challengeId)}`;
}

async function createTelegramLoginChallenge(
  record: Omit<TelegramLoginChallengeRecord, "issuedAt">,
): Promise<{ challengeId: string; expiresAt: number }> {
  const challengeId = uint8ArrayToBase64url(randomBytes(32));
  const expiresAt = Date.now() + TELEGRAM_LOGIN_CHALLENGE_TTL_MS;
  await getNonceBackend().set(
    telegramLoginChallengeKey(challengeId),
    JSON.stringify({ ...record, issuedAt: Date.now() }),
    TELEGRAM_LOGIN_CHALLENGE_TTL_MS,
  );
  return { challengeId, expiresAt };
}

async function consumeTelegramLoginChallenge(
  challengeId: string,
): Promise<TelegramLoginChallengeRecord | null> {
  const raw = await getNonceBackend().consume(
    telegramLoginChallengeKey(challengeId),
  );
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as TelegramLoginChallengeRecord;
    return {
      tenantId:
        typeof parsed.tenantId === "string" ? parsed.tenantId : undefined,
      originHost:
        typeof parsed.originHost === "string" ? parsed.originHost : undefined,
      issuedAt: typeof parsed.issuedAt === "number" ? parsed.issuedAt : 0,
    };
  } catch {
    return null;
  }
}

function validateConsumedTelegramLoginChallenge(
  record: TelegramLoginChallengeRecord | null,
  input: { tenantId?: string; originHost?: string },
): string | null {
  if (!record) return "Invalid or expired Telegram login challenge";
  if (record.tenantId !== input.tenantId) {
    return "Telegram login challenge tenant does not match verification tenant";
  }
  if (!record.originHost) {
    return "Telegram login challenge was not bound to an origin";
  }
  if (record.originHost !== input.originHost) {
    return "Telegram login challenge origin does not match verification origin";
  }
  return null;
}

async function consumeTelegramLoginHashOnce(
  hash: string,
  authDate: number,
): Promise<boolean> {
  const expiresAtMs = (authDate + TELEGRAM_LOGIN_MAX_AGE_SEC) * 1000;
  const ttlMs = Math.max(1_000, expiresAtMs - Date.now());
  return getMfaBackend().setIfNotExists(
    `telegram-login:${hashSha256Hex(hash.toLowerCase())}`,
    "1",
    ttlMs,
  );
}

const TOTP_PENDING_TTL_MS = 10 * 60 * 1000;
const TOTP_ENABLED_TTL_MS = 10 * 365 * 24 * 60 * 60 * 1000;
const MFA_AUTH_CHALLENGE_TTL_MS = 5 * 60 * 1000;
const MFA_TOTP_STEP_CLAIM_TTL_MS = 10 * 60 * 1000;
const TOTP_STEP_SEC = 30;

type StoredTotp = {
  secret: string;
  enabledAt: string;
  lastAcceptedStep: number | null;
};

type StoredSmsMfa = {
  phone: string;
  enabledAt: string;
};

function mfaKey(
  kind:
    | "totp:pending"
    | "totp:enabled"
    | "sms:pending"
    | "sms:enabled"
    | "recovery",
  userId: string,
): string {
  return `${kind}:${userId}`;
}

function recoveryCodeConsumeKey(codeId: string): string {
  return `recovery:code:${codeId}`;
}

function totpStepClaimKey(userId: string, step: number): string {
  return `totp:step:${userId}:${step}`;
}

function smsMfaEnrollPurpose(userId: string): string {
  return `mfa:sms:enroll:${userId}`;
}

function smsMfaManagePurpose(userId: string): string {
  return `mfa:sms:manage:${userId}`;
}

function smsMfaChallengePurpose(challengeId: string): string {
  return `mfa:sms:challenge:${challengeId}`;
}

function encryptMfaJson(value: unknown): string {
  return JSON.stringify(getOAuthKeyStore().encrypt(JSON.stringify(value)));
}

function decryptMfaJson<T>(value: string): T {
  const encrypted = JSON.parse(value) as {
    ciphertext: string;
    iv: string;
    tag: string;
    salt: string;
  };
  return JSON.parse(getOAuthKeyStore().decrypt(encrypted)) as T;
}

async function readMfaJson<T>(key: string): Promise<T | null> {
  const raw = await getMfaBackend().get(key);
  if (!raw) return null;
  try {
    return decryptMfaJson<T>(raw);
  } catch {
    await getMfaBackend().delete(key);
    return null;
  }
}

async function writeMfaJson(
  key: string,
  value: unknown,
  ttlMs = TOTP_ENABLED_TTL_MS,
): Promise<void> {
  await getMfaBackend().set(key, encryptMfaJson(value), ttlMs);
}

function totpStepForDrift(drift: number): number {
  return Math.floor(Date.now() / 1000 / TOTP_STEP_SEC) + drift;
}

async function verifyStoredTotp(
  userId: string,
  code: string,
): Promise<{ valid: boolean; stored?: StoredTotp; acceptedStep?: number }> {
  const stored = await readMfaJson<StoredTotp>(mfaKey("totp:enabled", userId));
  if (!stored) return { valid: false };

  const result = await verifyTotp(stored.secret, code, {
    stepSec: TOTP_STEP_SEC,
  });
  if (!result.valid || typeof result.drift !== "number")
    return { valid: false };

  const acceptedStep = totpStepForDrift(result.drift);
  if (
    stored.lastAcceptedStep !== null &&
    acceptedStep <= stored.lastAcceptedStep
  ) {
    return { valid: false };
  }
  const claimed = await getMfaBackend().setIfNotExists(
    totpStepClaimKey(userId, acceptedStep),
    "claimed",
    MFA_TOTP_STEP_CLAIM_TTL_MS,
  );
  if (!claimed) return { valid: false };
  return { valid: true, stored, acceptedStep };
}

class MfaRecoveryCodeStore implements RecoveryCodeStore {
  async replaceForUser(
    userId: string,
    codes: Array<{ hash: string; salt: string }>,
  ): Promise<void> {
    const issuedAt = Date.now();
    const rows = codes.map((code, idx) => ({
      id: `${userId}:${issuedAt}:${idx}`,
      hash: code.hash,
      salt: code.salt,
      usedAt: null,
    }));
    await writeMfaJson(mfaKey("recovery", userId), rows);
    await Promise.all(
      rows.map((row) =>
        getMfaBackend().set(
          recoveryCodeConsumeKey(row.id),
          "unused",
          TOTP_ENABLED_TTL_MS,
        ),
      ),
    );
  }

  async listForUser(userId: string): Promise<StoredRecoveryCode[]> {
    const rows = await readMfaJson<
      Array<Omit<StoredRecoveryCode, "usedAt"> & { usedAt: string | null }>
    >(mfaKey("recovery", userId));
    return (rows ?? []).map((row) => ({
      ...row,
      usedAt: row.usedAt ? new Date(row.usedAt) : null,
    }));
  }

  async markUsed(id: string, usedAt: Date): Promise<boolean> {
    const consumed = await getMfaBackend().consume(recoveryCodeConsumeKey(id));
    if (!consumed) return false;

    const userId = id.split(":")[0];
    if (!userId) return false;
    const rows =
      (await readMfaJson<
        Array<Omit<StoredRecoveryCode, "usedAt"> & { usedAt: string | null }>
      >(mfaKey("recovery", userId))) ?? [];
    const next = rows.map((row) =>
      row.id === id ? { ...row, usedAt: usedAt.toISOString() } : row,
    );
    await writeMfaJson(mfaKey("recovery", userId), next);
    return true;
  }
}

const recoveryCodeStore: RecoveryCodeStore =
  process.env.NODE_ENV === "test"
    ? new InMemoryRecoveryCodeStore()
    : new MfaRecoveryCodeStore();

type PendingMfaAuth = {
  mfaType: "totp" | "sms";
  userId: string;
  tenantId: string;
  address: string;
  claims?: Record<string, unknown>;
  user: Record<string, unknown>;
  expiresAt: number;
};

function passkeyMfaChallengeKey(userId: string, challengeId: string): string {
  return `mfa:passkey:${userId}:${challengeId}`;
}

async function hasTotpEnabled(userId: string): Promise<boolean> {
  return Boolean(await readMfaJson<StoredTotp>(mfaKey("totp:enabled", userId)));
}

async function getSmsMfa(userId: string): Promise<StoredSmsMfa | null> {
  return readMfaJson<StoredSmsMfa>(mfaKey("sms:enabled", userId));
}

async function currentSessionMfaStepUpResponse(
  c: Context,
  session: Extract<Awaited<ReturnType<typeof requireSession>>, { ok: true }>,
  method: "totp" | "sms" | "passkey" | "recovery_code",
) {
  if (
    !(await isActiveTenantMember(
      session.payload.userId,
      session.payload.tenantId,
    ))
  ) {
    return c.json<ApiResponse>(
      { ok: false, error: "User is not a member of this tenant" },
      403,
    );
  }

  const [user] = await getDb()
    .select({
      id: users.id,
      email: users.email,
      walletAddress: users.walletAddress,
      walletChain: users.walletChain,
    })
    .from(users)
    .where(eq(users.id, session.payload.userId));

  const mfaClaims = {
    mfaVerifiedAt: Date.now(),
    mfaMethod: method,
    factorEnrollmentVerifiedAt: Date.now(),
  };
  const token = await createSessionToken(
    session.payload.address,
    session.payload.tenantId,
    {
      userId: session.payload.userId,
      email: session.payload.email,
      authMethod: session.payload.authMethod,
      ...mfaClaims,
    },
  );
  const refreshToken = await createRefreshToken(
    session.payload.userId,
    session.payload.tenantId,
    mfaClaims,
  );

  return c.json(
    buildAuthResponse(token, refreshToken, {
      id: user?.id ?? session.payload.userId,
      email: user?.email ?? session.payload.email ?? "",
      walletAddress: user?.walletAddress ?? session.payload.address,
      walletChain: user?.walletChain ?? undefined,
    }),
  );
}

async function createMfaAuthChallenge(
  payload: Omit<PendingMfaAuth, "expiresAt">,
): Promise<{
  challengeId: string;
  expiresAt: number;
}> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const challengeId = uint8ArrayToBase64url(bytes);
  const expiresAt = Date.now() + MFA_AUTH_CHALLENGE_TTL_MS;
  await writeMfaJson(
    `auth:challenge:${challengeId}`,
    { ...payload, expiresAt },
    MFA_AUTH_CHALLENGE_TTL_MS,
  );
  return { challengeId, expiresAt };
}

async function buildAuthOrMfaResponse(
  userId: string,
  tenantId: string,
  address: string,
  claims: Record<string, unknown>,
  user: Record<string, unknown>,
  c?: Context,
): Promise<Record<string, unknown>> {
  const sessionClaims = {
    ...claims,
    factorEnrollmentVerifiedAt: Date.now(),
  };
  const [activeUser] = await getDb()
    .select({ deactivatedAt: users.deactivatedAt })
    .from(users)
    .where(eq(users.id, userId));
  if (activeUser?.deactivatedAt) {
    return { ok: false, status: 403, error: "User is deactivated" };
  }

  if (await hasTotpEnabled(userId)) {
    const challenge = await createMfaAuthChallenge({
      mfaType: "totp",
      userId,
      tenantId,
      address,
      claims: sessionClaims,
      user,
    });
    return {
      ok: true,
      mfaRequired: true,
      mfa: {
        type: "totp",
        challengeId: challenge.challengeId,
        expiresAt: new Date(challenge.expiresAt).toISOString(),
      },
      user,
    };
  }

  const smsMfa = await getSmsMfa(userId);
  if (smsMfa) {
    const challenge = await createMfaAuthChallenge({
      mfaType: "sms",
      userId,
      tenantId,
      address,
      claims: sessionClaims,
      user,
    });
    const { expiresAt } = await getPhoneAuth().sendOtp(
      smsMfa.phone,
      smsMfaChallengePurpose(challenge.challengeId),
      "sms",
    );
    return {
      ok: true,
      mfaRequired: true,
      mfa: {
        type: "sms",
        challengeId: challenge.challengeId,
        expiresAt: expiresAt.toISOString(),
      },
      user,
    };
  }

  if (c) {
    await writeAuthLoginAudit(c, tenantId, userId, claims);
  }
  const token = await createSessionToken(address, tenantId, sessionClaims);
  const refreshToken = await createRefreshToken(
    userId,
    tenantId,
    sessionClaims,
  );
  dispatchUserAuthenticated(
    tenantId,
    userId,
    typeof claims.authMethod === "string" ? claims.authMethod : undefined,
  );
  return buildAuthResponse(token, refreshToken, user);
}

function authExchangeJson(c: Context, response: Record<string, unknown>) {
  if (response.ok === false && typeof response.error === "string") {
    const status =
      typeof response.status === "number" &&
      response.status >= 400 &&
      response.status < 600
        ? response.status
        : 400;
    return c.json<ApiResponse>(
      { ok: false, error: response.error },
      status as 400 | 403 | 500,
    );
  }
  return c.json(response);
}

function setAuthNoStoreHeaders(c: Pick<Context, "header">): void {
  c.header("Cache-Control", "no-store, max-age=0");
  c.header("Pragma", "no-cache");
  c.header("Expires", "0");
}

const DEVICE_AUTH_TTL_MS = 10 * 60 * 1000;
const DEVICE_AUTH_DEFAULT_INTERVAL_SECONDS = 5;
const DEVICE_AUTH_MAX_SLOW_DOWNS = 3;

type DeviceAuthorizationRecord = {
  tenantId: string;
  clientId?: string;
  nativeBundleId?: string;
  nativePackageName?: string;
  userCode: string;
  scope?: string;
  status: "pending" | "approved" | "denied";
  issuedAt: number;
  expiresAt: number;
  intervalSeconds: number;
  lastPollAt?: number;
  slowDownCount: number;
  approvedUserId?: string;
  approvedAt?: number;
  deniedAt?: number;
};

function normalizeDeviceUserCode(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toUpperCase().replace(/[\s-]/g, "");
  return /^[A-Z0-9]{8}$/.test(normalized) ? normalized : undefined;
}

function displayDeviceUserCode(value: string): string {
  return `${value.slice(0, 4)}-${value.slice(4)}`;
}

function generateDeviceUserCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

function deviceCodeKey(deviceCode: string): string {
  return `device-auth:device:${hashSha256Hex(deviceCode)}`;
}

function deviceUserCodeKey(userCode: string): string {
  return `device-auth:user:${hashSha256Hex(userCode)}`;
}

async function getEnabledTenantAppClient(tenantId: string, clientId: string) {
  const client = (await authAppClientSubjects(tenantId)).find(
    (row) => row.id === clientId,
  );
  return client
    ? {
        id: client.id,
        allowedBundleIds: client.allowed_bundle_ids,
        allowedPackageNames: client.allowed_package_names,
      }
    : null;
}

function normalizeNativeBundleId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const bundleId = value.trim();
  if (
    bundleId.length === 0 ||
    bundleId === "*" ||
    bundleId.length > 255 ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?)+$/.test(
      bundleId,
    )
  ) {
    return null;
  }
  return bundleId;
}

function normalizeNativePackageName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const packageName = value.trim().toLowerCase();
  if (
    packageName.length === 0 ||
    packageName === "*" ||
    packageName.length > 255 ||
    !/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/.test(packageName)
  ) {
    return null;
  }
  return packageName;
}

function readNativeClientAssertion(
  c: Context,
  body: Record<string, unknown> | undefined | null,
): { rawBundleId?: unknown; rawPackageName?: unknown } {
  return {
    rawBundleId:
      body?.native_bundle_id ??
      body?.nativeBundleId ??
      body?.bundle_id ??
      body?.bundleId ??
      c.req.header("X-Steward-Native-Bundle-Id"),
    rawPackageName:
      body?.native_package_name ??
      body?.nativePackageName ??
      body?.package_name ??
      body?.packageName ??
      c.req.header("X-Steward-Native-Package-Name"),
  };
}

async function assertDeviceAuthTenantAndClient(
  tenantId: string,
  rawClientId: unknown,
  nativeAssertion?: { rawBundleId?: unknown; rawPackageName?: unknown },
): Promise<
  | {
      ok: true;
      clientId?: string;
      nativeBundleId?: string;
      nativePackageName?: string;
    }
  | { ok: false; status: 400 | 404; error: string }
> {
  if (!isValidTenantId(tenantId)) {
    return { ok: false, status: 400, error: "Invalid tenant id" };
  }
  if (!(await tenantExists(tenantId))) {
    return { ok: false, status: 404, error: `Tenant '${tenantId}' not found` };
  }

  if (rawClientId === undefined || rawClientId === null || rawClientId === "") {
    return { ok: true };
  }
  const clientId = normalizePublicClientId(rawClientId);
  if (!clientId)
    return { ok: false, status: 400, error: "client_id is invalid" };
  const client = await getEnabledTenantAppClient(tenantId, clientId);
  if (!client) {
    return {
      ok: false,
      status: 404,
      error: "App client not found or disabled",
    };
  }
  const nativeBundleId =
    nativeAssertion?.rawBundleId === undefined
      ? undefined
      : normalizeNativeBundleId(nativeAssertion.rawBundleId);
  if (nativeAssertion?.rawBundleId !== undefined && !nativeBundleId) {
    return { ok: false, status: 400, error: "native bundle id is invalid" };
  }
  const nativePackageName =
    nativeAssertion?.rawPackageName === undefined
      ? undefined
      : normalizeNativePackageName(nativeAssertion.rawPackageName);
  if (nativeAssertion?.rawPackageName !== undefined && !nativePackageName) {
    return { ok: false, status: 400, error: "native package name is invalid" };
  }
  if (
    nativeBundleId &&
    !((client.allowedBundleIds ?? []) as string[]).includes(nativeBundleId)
  ) {
    return {
      ok: false,
      status: 400,
      error: "native bundle id is not allowed for this app client",
    };
  }
  if (
    nativePackageName &&
    !((client.allowedPackageNames ?? []) as string[]).includes(
      nativePackageName,
    )
  ) {
    return {
      ok: false,
      status: 400,
      error: "native package name is not allowed for this app client",
    };
  }
  return {
    ok: true,
    clientId,
    ...(nativeBundleId ? { nativeBundleId } : {}),
    ...(nativePackageName ? { nativePackageName } : {}),
  };
}

async function saveDeviceAuthorizationRecord(
  deviceCode: string,
  record: DeviceAuthorizationRecord,
): Promise<void> {
  await saveDeviceAuthorizationRecordByHash(hashSha256Hex(deviceCode), record);
}

async function saveDeviceAuthorizationRecordByHash(
  deviceCodeHash: string,
  record: DeviceAuthorizationRecord,
): Promise<void> {
  const ttlMs = Math.max(1_000, record.expiresAt - Date.now());
  await writeMfaJson(`device-auth:device:${deviceCodeHash}`, record, ttlMs);
  await getMfaBackend().set(
    deviceUserCodeKey(record.userCode),
    deviceCodeHash,
    ttlMs,
  );
}

async function readDeviceAuthorizationRecord(
  deviceCode: string,
): Promise<DeviceAuthorizationRecord | null> {
  const record = await readMfaJson<DeviceAuthorizationRecord>(
    deviceCodeKey(deviceCode),
  );
  if (!record) return null;
  if (record.expiresAt <= Date.now()) {
    await getMfaBackend().delete(deviceCodeKey(deviceCode));
    await getMfaBackend().delete(deviceUserCodeKey(record.userCode));
    return null;
  }
  return record;
}

async function consumeDeviceAuthorizationRecord(
  deviceCode: string,
): Promise<DeviceAuthorizationRecord | null> {
  const raw = await getMfaBackend().consume(deviceCodeKey(deviceCode));
  if (!raw) return null;
  try {
    const record = decryptMfaJson<DeviceAuthorizationRecord>(raw);
    await getMfaBackend().delete(deviceUserCodeKey(record.userCode));
    if (record.expiresAt <= Date.now()) return null;
    return record;
  } catch {
    return null;
  }
}

async function readDeviceAuthorizationRecordByUserCode(
  userCode: string,
): Promise<{
  deviceCodeHash: string;
  record: DeviceAuthorizationRecord;
} | null> {
  const deviceCodeHash = await getMfaBackend().get(deviceUserCodeKey(userCode));
  if (!deviceCodeHash) return null;
  const record = await readMfaJson<DeviceAuthorizationRecord>(
    `device-auth:device:${deviceCodeHash}`,
  );
  if (!record) {
    await getMfaBackend().delete(deviceUserCodeKey(userCode));
    return null;
  }
  if (record.expiresAt <= Date.now()) {
    await getMfaBackend().delete(`device-auth:device:${deviceCodeHash}`);
    await getMfaBackend().delete(deviceUserCodeKey(userCode));
    return null;
  }
  return { deviceCodeHash, record };
}

async function getTenantOidcProviders(
  tenantId: string,
): Promise<TenantOidcProviderConfig[]> {
  const config = await authTenantConfigSubject(tenantId);
  // Revalidate persisted JSON on every trust-boundary read. Older rows can
  // predate write-time validation; treating their TypeScript cast as trusted
  // would re-enable unsafe algorithms or malformed endpoint configuration.
  const normalized = normalizeOidcProviders(
    config?.oidc_providers ?? [],
    tenantId,
  );
  return typeof normalized === "string" ? [] : normalized;
}

function selectOidcProvider(
  providers: TenantOidcProviderConfig[],
  providerId?: string,
): TenantOidcProviderConfig | null {
  const enabled = providers.filter((provider) => provider.enabled !== false);
  if (providerId)
    return enabled.find((provider) => provider.id === providerId) ?? null;
  return enabled.length === 1 ? enabled[0] : null;
}

async function validateOidcJitTenant(tenantId: string): Promise<
  | {
      ok: true;
    }
  | { ok: false; status: 403 | 404; error: string }
> {
  if (!isValidTenantId(tenantId)) {
    return { ok: false, status: 403, error: "Invalid tenant id format" };
  }
  if (isReservedTenantId(tenantId)) {
    return {
      ok: false,
      status: 403,
      error: "Personal tenants cannot be self-joined",
    };
  }
  const subject = await authTenantSubject(tenantId);
  if (!subject)
    return { ok: false, status: 404, error: `Tenant '${tenantId}' not found` };
  if (subject.join_mode === "open") return { ok: true };
  if (!subject.join_mode) {
    return {
      ok: false,
      status: 403,
      error: `Tenant '${tenantId}' is not configured for self-join`,
    };
  }
  if (subject.join_mode === "invite") {
    return {
      ok: false,
      status: 403,
      error: `Tenant '${tenantId}' requires an invitation to join`,
    };
  }
  return {
    ok: false,
    status: 403,
    error: `Tenant '${tenantId}' is not accepting new members`,
  };
}

async function provisionOidcUser(opts: {
  c: Context;
  tenantId: string;
  provider: TenantOidcProviderConfig;
  subject: string;
  email?: string;
  emailVerified?: boolean;
  name?: string;
  picture?: string;
  tenantRole?: string;
}): Promise<
  | {
      ok: true;
      userId: string;
      response: Record<string, unknown>;
    }
  | { ok: false; status?: 400 | 403 | 404 | 409 | 500; error: string }
> {
  const {
    c,
    tenantId,
    provider,
    subject,
    email,
    emailVerified,
    name,
    picture,
    tenantRole,
  } = opts;
  const db = getDb();
  const providerAccountId = hashSha256Hex(
    `${tenantId}:${provider.id}:${provider.issuer}:${subject}`,
  );
  const providerName = "oidc";

  try {
    if (emailVerified === true && email) {
      const authAbuseConfig = await getTenantAuthAbuseConfig(tenantId);
      const emailPolicyError = validateEmailAbusePolicy(email, authAbuseConfig);
      if (emailPolicyError) {
        return { ok: false, status: 400, error: emailPolicyError };
      }
    }

    const [existingAccount] = await db
      .select({ userId: accounts.userId })
      .from(accounts)
      .where(
        and(
          eq(accounts.provider, providerName),
          eq(accounts.providerAccountId, providerAccountId),
        ),
      );

    let user: typeof users.$inferSelect;
    let createdUser = false;
    if (existingAccount) {
      const [existingUser] = await db
        .select()
        .from(users)
        .where(eq(users.id, existingAccount.userId));
      if (!existingUser)
        return { ok: false, status: 500, error: "OIDC account user missing" };
      user = existingUser;
    } else {
      if (provider.allowJitProvisioning === false) {
        return {
          ok: false,
          status: 403,
          error: "OIDC JIT provisioning is disabled",
        };
      }
      const jitTenant = await validateOidcJitTenant(tenantId);
      if (!jitTenant.ok) return jitTenant;
      const [created] = await db
        .insert(users)
        .values({
          email: null,
          emailVerified: false,
          name,
          image: picture,
        })
        .returning();
      user = created;
      await db
        .insert(accounts)
        .values({ userId: user.id, provider: providerName, providerAccountId });
      createdUser = true;
    }

    const updates: Partial<typeof users.$inferInsert> = {};
    if (!user.name && name) updates.name = name;
    if (!user.image && picture) updates.image = picture;
    if (Object.keys(updates).length > 0) {
      await db.update(users).set(updates).where(eq(users.id, user.id));
      user = { ...user, ...updates };
    }

    const tenantResult = await resolveAndValidateTenant(c, user.id, tenantId);
    if (!tenantResult.ok) {
      return {
        ok: false,
        status: tenantResult.status,
        error: tenantResult.error,
      };
    }
    await ensureUserTenantLink(
      user.id,
      tenantResult.tenantId,
      tenantRole ?? "member",
    );

    let walletAddress = user.walletAddress;
    const syntheticEmail = `oidc.${provider.id}.${providerAccountId}@id.steward.internal`;
    try {
      const wallet = await provisionWalletForUser(user.id, syntheticEmail);
      walletAddress = wallet.walletAddress;
    } catch (err) {
      logger.error(
        {
          details: [
            `[OidcAuth:${provider.id}] Wallet provision failed`,
            redactedThrownDiagnostics(err),
          ],
        },
        "[Login:auth] error",
      );
      return { ok: false, status: 500, error: "Wallet provisioning failed" };
    }
    const verifiedEmail = emailVerified === true ? email : undefined;
    const claims: Record<string, unknown> = {
      userId: user.id,
      oidcProviderId: provider.id,
      oidcSubject: subject,
      emailVerified: emailVerified === true,
      authMethod: "oidc",
    };
    if (verifiedEmail) claims.email = verifiedEmail;

    await withVerifiedAuthTenant(tenantResult.tenantId, user.id, async () => {
      if (createdUser) {
        dispatchUserCreated(tenantResult.tenantId, user.id, "auth.oidc", {
          provider: provider.id,
          hasEmail: Boolean(verifiedEmail),
        });
      }
      await writeAuditEvent({
        tenantId: tenantResult.tenantId,
        actorType: "user",
        actorId: user.id,
        action: "auth.oidc.login",
        resourceType: "user",
        metadata: {
          providerId: provider.id,
          issuer: provider.issuer,
          oidcSubject: subject,
        },
        ipAddress: c.req.header("x-forwarded-for") ?? null,
        userAgent: c.req.header("user-agent") ?? null,
        requestId: c.get("requestId") ?? null,
      });
    });

    return {
      ok: true,
      userId: user.id,
      response: await buildAuthOrMfaResponse(
        user.id,
        tenantResult.tenantId,
        walletAddress ?? "",
        claims,
        {
          id: user.id,
          email: verifiedEmail ?? syntheticEmail,
          emailVerified: emailVerified === true,
          walletAddress,
          oidcProviderId: provider.id,
        },
      ),
    };
  } catch (err) {
    logger.error(
      {
        details: [
          `[OidcAuth:${provider.id}] provisionOidcUser failed`,
          redactedThrownDiagnostics(err),
        ],
      },
      "[Login:auth] error",
    );
    return {
      ok: false,
      error: "Internal server error",
    };
  }
}

async function provisionSamlUser(opts: {
  c: Context;
  tenantId: string;
  config: TenantSamlSsoConfig;
  subject: string;
  email: string;
  groups?: string[];
  tenantRole?: string;
}): Promise<
  | {
      ok: true;
      userId: string;
      response: Record<string, unknown>;
    }
  | { ok: false; status?: 400 | 403 | 404 | 409 | 500; error: string }
> {
  const { c, tenantId, config, subject, email, groups = [], tenantRole } = opts;
  const db = getDb();
  const providerAccountId = hashSha256Hex(
    `${tenantId}:${config.idpEntityId}:${subject}`,
  );
  const providerName = "saml";

  try {
    const authAbuseConfig = await getTenantAuthAbuseConfig(tenantId);
    const emailPolicyError = validateEmailAbusePolicy(email, authAbuseConfig);
    if (emailPolicyError)
      return { ok: false, status: 400, error: emailPolicyError };

    const [existingAccount] = await db
      .select({ userId: accounts.userId })
      .from(accounts)
      .where(
        and(
          eq(accounts.provider, providerName),
          eq(accounts.providerAccountId, providerAccountId),
        ),
      );

    let user: typeof users.$inferSelect;
    let createdUser = false;
    if (existingAccount) {
      const [existingUser] = await db
        .select()
        .from(users)
        .where(eq(users.id, existingAccount.userId));
      if (!existingUser)
        return { ok: false, status: 500, error: "SAML account user missing" };
      user = existingUser;
    } else {
      if (!config.allowJitProvisioning) {
        return {
          ok: false,
          status: 403,
          error: "SAML JIT provisioning is disabled",
        };
      }
      const jitTenant = await validateOidcJitTenant(tenantId);
      if (!jitTenant.ok) return jitTenant;
      const [existingEmailUser] = await db
        .select()
        .from(users)
        .where(eq(users.email, email));
      if (existingEmailUser) {
        user = existingEmailUser;
      } else {
        const [created] = await db
          .insert(users)
          .values({ email, emailVerified: true })
          .returning();
        user = created;
        createdUser = true;
      }
      await db
        .insert(accounts)
        .values({ userId: user.id, provider: providerName, providerAccountId })
        .onConflictDoNothing();
    }

    if (user.email !== email || user.emailVerified !== true) {
      await db
        .update(users)
        .set({ email, emailVerified: true })
        .where(eq(users.id, user.id));
      user = { ...user, email, emailVerified: true };
    }

    const tenantResult = await resolveAndValidateTenant(c, user.id, tenantId);
    if (!tenantResult.ok) {
      return {
        ok: false,
        status: tenantResult.status,
        error: tenantResult.error,
      };
    }
    await ensureUserTenantLink(
      user.id,
      tenantResult.tenantId,
      tenantRole ?? resolveSamlMappedRole(config, groups),
    );

    let walletAddress = user.walletAddress;
    try {
      const wallet = await provisionWalletForUser(user.id, email);
      walletAddress = wallet.walletAddress;
    } catch (err) {
      logger.error(
        {
          details: [
            "[SamlAuth] Wallet provision failed",
            redactedThrownDiagnostics(err),
          ],
        },
        "[Login:auth] error",
      );
      return { ok: false, status: 500, error: "Wallet provisioning failed" };
    }

    await withVerifiedAuthTenant(tenantResult.tenantId, user.id, async () => {
      if (createdUser) {
        dispatchUserCreated(tenantResult.tenantId, user.id, "auth.saml", {
          idpEntityId: config.idpEntityId,
        });
      }
      await writeAuditEvent({
        tenantId: tenantResult.tenantId,
        actorType: "user",
        actorId: user.id,
        action: "auth.saml.login",
        resourceType: "user",
        metadata: { idpEntityId: config.idpEntityId },
        ipAddress: c.req.header("x-forwarded-for") ?? null,
        userAgent: c.req.header("user-agent") ?? null,
        requestId: c.get("requestId") ?? null,
      });
    });

    return {
      ok: true,
      userId: user.id,
      response: await buildAuthOrMfaResponse(
        user.id,
        tenantResult.tenantId,
        walletAddress ?? "",
        {
          userId: user.id,
          samlSubject: subject,
          authMethod: "saml",
          email,
          emailVerified: true,
        },
        { id: user.id, email, emailVerified: true, walletAddress },
      ),
    };
  } catch (err) {
    logger.error(
      {
        details: [
          "[SamlAuth] provisionSamlUser failed",
          redactedThrownDiagnostics(err),
        ],
      },
      "[Login:auth] error",
    );
    return { ok: false, error: "Internal server error" };
  }
}

type CompletedEmailAuthResult =
  | {
      ok: true;
      response: Record<string, unknown>;
    }
  | { ok: false; status: 400 | 403 | 404; error: string };

async function completeEmailAuth(
  c: Context,
  email: string,
  tenantId?: string,
  opts: { allowTenantJoin?: boolean } = {},
): Promise<CompletedEmailAuthResult> {
  const hintedTenantId =
    c.req.header("X-Steward-Tenant") || tenantId || defaultAuthTenantId();
  const hintedAuthAbuseConfig = await getTenantAuthAbuseConfig(hintedTenantId);
  const hintedEmailPolicyError = validateEmailAbusePolicy(
    email,
    hintedAuthAbuseConfig,
  );
  if (hintedEmailPolicyError) {
    return { ok: false, status: 403, error: hintedEmailPolicyError };
  }

  const requestedTenantId =
    c.req.header("X-Steward-Tenant")?.trim() || tenantId?.trim() || undefined;
  const existingUser = await findUserByEmail(email);
  const preResolvedTenant =
    opts.allowTenantJoin && tenantId
      ? null
      : await resolveEmailTenantBeforeMutation(
          c,
          requestedTenantId,
          existingUser?.id ?? null,
        );
  if (preResolvedTenant && !preResolvedTenant.ok) {
    return {
      ok: false,
      status: preResolvedTenant.status,
      error: preResolvedTenant.error,
    };
  }
  if (preResolvedTenant?.ok) {
    const ssoRequiredResponse = await requireNonSsoEmailLoginAllowed(
      c,
      preResolvedTenant.tenantId,
      email,
      "Email",
    );
    if (ssoRequiredResponse) {
      return {
        ok: false,
        status: 403,
        error: "Email login is disabled because this email domain requires SSO",
      };
    }
  }

  const { user, isNew } = await findOrCreateUserWithStatus(email);
  const db = getDb();
  await db
    .update(users)
    .set({ emailVerified: true })
    .where(eq(users.id, user.id));

  // Provision wallet (idempotent, always under personal tenant)
  let walletAddress = user.walletAddress;
  try {
    const w = await provisionWalletForUser(user.id, email);
    walletAddress = w.walletAddress;
  } catch (err) {
    logger.error(
      {
        details: [
          "[EmailAuth] Wallet provision failed",
          redactedThrownDiagnostics(err),
        ],
      },
      "[Login:auth] error",
    );
  }

  // Resolve requesting tenant and link user.
  let resolvedTenantId: string;
  if (opts.allowTenantJoin && tenantId) {
    if (!isValidTenantId(tenantId)) {
      return { ok: false, status: 400, error: "Invalid tenant id format" };
    }
    if (!(await tenantExists(tenantId))) {
      return {
        ok: false,
        status: 404,
        error: `Tenant '${tenantId}' not found`,
      };
    }
    resolvedTenantId = tenantId;
  } else {
    const tenantResult =
      preResolvedTenant ??
      (await resolveAndValidateTenant(c, user.id, tenantId));
    if (!tenantResult.ok) {
      return {
        ok: false,
        status: tenantResult.status,
        error: tenantResult.error,
      };
    }
    resolvedTenantId = tenantResult.tenantId;
  }
  const authAbuseConfig = await getTenantAuthAbuseConfig(resolvedTenantId);
  const emailPolicyError = validateEmailAbusePolicy(email, authAbuseConfig);
  if (emailPolicyError) {
    return { ok: false, status: 403, error: emailPolicyError };
  }
  const userPolicyError = validateUserAuthAbusePolicy(user.id, authAbuseConfig);
  if (userPolicyError) {
    return { ok: false, status: 403, error: userPolicyError };
  }
  const ssoRequiredResponse = await requireNonSsoEmailLoginAllowed(
    c,
    resolvedTenantId,
    email,
    "Email",
  );
  if (ssoRequiredResponse) {
    return {
      ok: false,
      status: 403,
      error: "Email login is disabled because this email domain requires SSO",
    };
  }
  await ensureUserTenantLink(user.id, resolvedTenantId);
  if (isNew) {
    dispatchUserCreated(resolvedTenantId, user.id, "auth.email", {
      hasEmail: true,
    });
  }

  const response = await buildAuthOrMfaResponse(
    user.id,
    resolvedTenantId,
    walletAddress ?? "",
    {
      userId: user.id,
      email,
      authMethod: "email",
    },
    { id: user.id, email, walletAddress },
    c,
  );
  if (response.ok === false) {
    return {
      ok: false,
      status:
        typeof response.status === "number"
          ? (response.status as 400 | 403 | 404)
          : 403,
      error:
        typeof response.error === "string"
          ? response.error
          : "Authentication failed",
    };
  }

  return {
    ok: true,
    response,
  };
}

function resolveSamlMappedRole(
  config: TenantSamlSsoConfig,
  groups: string[],
): string {
  const precedence = [
    "admin",
    "developer",
    "billing",
    "viewer",
    "member",
  ] as const;
  const normalizedGroups = new Set(
    groups.map((group) => group.trim()).filter(Boolean),
  );
  for (const role of precedence) {
    if (
      config.groupRoleMappings.some(
        (mapping) =>
          mapping.role === role && normalizedGroups.has(mapping.group),
      )
    ) {
      return role;
    }
  }
  return "viewer";
}

function getEmailAuthRedirectBaseUrl(): string {
  return (
    process.env.EMAIL_AUTH_REDIRECT_BASE_URL || "https://www.elizacloud.ai"
  ).replace(/\/$/, "");
}

function buildEmailAuthRedirectUrl(
  params?: Record<string, string | undefined>,
): string {
  const redirectUrl = new URL("/login", `${getEmailAuthRedirectBaseUrl()}/`);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value) redirectUrl.searchParams.set(key, value);
  }
  return redirectUrl.toString();
}

function setRedirectFragment(
  url: URL,
  params: Record<string, string | undefined>,
): void {
  const fragment = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) fragment.set(key, value);
  }
  url.hash = fragment.toString();
}

function redirectEmailAuthFailure(c: Context, reason: string): Response {
  return c.redirect(
    buildEmailAuthRedirectUrl({
      error: "email_auth_failed",
      reason,
    }),
    302,
  );
}

type OAuthCallbackFailureStatus = 400 | 401 | 403 | 404 | 409 | 500 | 502 | 503;

interface OAuthCallbackFailureOptions {
  code: string;
  message: string;
  status: OAuthCallbackFailureStatus;
  redirectUrl?: URL;
  appState?: string;
}

function escapeOAuthCallbackHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function oauthCallbackPrefersHtml(c: Context): boolean {
  const accept = c.req.header("accept")?.toLowerCase() ?? "";
  const qualityFor = (
    target: "application/json" | "text/html",
  ): number | undefined => {
    const [targetType] = target.split("/");
    let bestMatch: { specificity: number; quality: number } | undefined;
    for (const range of accept.split(",")) {
      const [mediaType, ...parameters] = range
        .split(";")
        .map((part) => part.trim());
      const qualityParameter = parameters.find((parameter) =>
        parameter.startsWith("q="),
      );
      const quality = qualityParameter ? Number(qualityParameter.slice(2)) : 1;
      const normalizedQuality =
        Number.isFinite(quality) && quality >= 0 && quality <= 1 ? quality : 0;
      const specificity =
        mediaType === target
          ? 2
          : mediaType === `${targetType}/*`
            ? 1
            : mediaType === "*/*"
              ? 0
              : -1;
      if (
        specificity >= 0 &&
        (!bestMatch ||
          specificity > bestMatch.specificity ||
          (specificity === bestMatch.specificity &&
            normalizedQuality > bestMatch.quality))
      ) {
        bestMatch = { specificity, quality: normalizedQuality };
      }
    }
    return bestMatch?.quality;
  };

  const htmlQuality = qualityFor("text/html") ?? 0;
  const jsonQuality = qualityFor("application/json") ?? 0;
  if (htmlQuality <= 0) return false;
  if (htmlQuality !== jsonQuality) return htmlQuality > jsonQuality;
  return c.req.header("sec-fetch-mode")?.toLowerCase() === "navigate";
}

async function oauthCallbackRecoveryFromStoredState(
  kind: "oauth" | "oidc",
  state: string | undefined,
  providerName: string,
): Promise<{ redirectUrl: URL; appState?: string } | undefined> {
  if (!state || state.length > 256) return undefined;
  try {
    const rawPayload = await getChallengeStore().get(`${kind}:${state}`);
    if (!rawPayload) return undefined;
    const stateData = JSON.parse(rawPayload) as Record<string, unknown>;
    const storedProvider =
      kind === "oauth" ? stateData.provider : stateData.providerId;
    if (
      storedProvider !== providerName ||
      typeof stateData.redirectUri !== "string"
    ) {
      return undefined;
    }
    const tenantId =
      typeof stateData.tenantId === "string" ? stateData.tenantId : undefined;
    const clientId =
      typeof stateData.clientId === "string" ? stateData.clientId : undefined;
    const redirectUrl = await assertAllowedOAuthRedirectUri(
      stateData.redirectUri,
      tenantId,
      clientId,
    );
    return {
      redirectUrl,
      appState:
        typeof stateData.appState === "string" ? stateData.appState : undefined,
    };
  } catch {
    // Recovery is optional. Invalid, stale, or unavailable state must never
    // replace the original callback failure or create an unvalidated link.
    return undefined;
  }
}

function oauthCallbackFailure(
  c: Context,
  options: OAuthCallbackFailureOptions,
): Response {
  if (!oauthCallbackPrefersHtml(c)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: options.message,
        code: options.code,
      } as ApiResponse & { code: string },
      options.status,
    );
  }

  let recoveryLink = "";
  if (options.redirectUrl) {
    const recoveryUrl = new URL(options.redirectUrl);
    recoveryUrl.searchParams.set("error", options.code);
    if (options.appState)
      recoveryUrl.searchParams.set("state", options.appState);
    recoveryLink = `<a class="stwd-oauth-error__action" href="${escapeOAuthCallbackHtml(
      recoveryUrl.toString(),
    )}">Return and try again</a>`;
  }

  const escapedMessage = escapeOAuthCallbackHtml(options.message);
  const escapedCode = escapeOAuthCallbackHtml(options.code);
  const recoveryInstruction = recoveryLink
    ? recoveryLink
    : '<p class="stwd-oauth-error__hint">Close this window and restart sign-in from the application.</p>';
  const body = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Sign-in could not be completed | Steward</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
    * { box-sizing: border-box; }
    body { min-height: 100vh; margin: 0; display: grid; place-items: center; padding: 24px; background: #090b10; color: #f6f7fb; }
    .stwd-oauth-error { width: min(100%, 520px); padding: 32px; border: 1px solid #2a3040; border-radius: 18px; background: #121621; box-shadow: 0 24px 70px rgb(0 0 0 / 35%); }
    .stwd-oauth-error__eyebrow { margin: 0 0 10px; color: #98a2b8; font-size: 13px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
    h1 { margin: 0; font-size: clamp(24px, 6vw, 34px); line-height: 1.15; }
    .stwd-oauth-error__message { margin: 18px 0; color: #cbd1de; line-height: 1.6; }
    .stwd-oauth-error__code { display: inline-block; margin-bottom: 24px; padding: 6px 9px; border-radius: 7px; background: #080a0f; color: #aab4ca; font-size: 12px; }
    .stwd-oauth-error__action { display: inline-block; padding: 12px 18px; border-radius: 9px; background: #f6f7fb; color: #11141c; font-weight: 750; text-decoration: none; }
    .stwd-oauth-error__action:focus-visible { outline: 3px solid #7aa2ff; outline-offset: 3px; }
    .stwd-oauth-error__hint { margin: 0; color: #98a2b8; line-height: 1.5; }
  </style>
</head>
<body>
  <main class="stwd-oauth-error" data-error-code="${escapedCode}">
    <p class="stwd-oauth-error__eyebrow">Steward authentication</p>
    <h1>Sign-in could not be completed</h1>
    <p class="stwd-oauth-error__message">${escapedMessage}</p>
    <code class="stwd-oauth-error__code">${escapedCode}</code>
    <div>${recoveryInstruction}</div>
  </main>
</body>
</html>`;

  return c.html(body, options.status, {
    "Cache-Control": "no-store",
    "Content-Security-Policy":
      "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
}

// ─── Route group ──────────────────────────────────────────────────────────────

const auth = new Hono();

auth.use("*", async (c, next) => {
  setAuthNoStoreHeaders(c);
  await next();
});

// ── Discovery ─────────────────────────────────────────────────────────────────

/**
 * POST /sso/discover
 * Public discovery endpoint for Privy-style dashboard/team SSO routing.
 * Returns a tenant only after the email domain has been verified by a tenant
 * admin, so unverified drafts cannot hijack login.
 */
auth.post("/sso/discover", async (c) => {
  const body = await c.req.json().catch(() => null);
  const domain = normalizeEmailDomain(
    body && typeof body === "object"
      ? (body as { email?: unknown }).email
      : null,
  );
  if (!domain) {
    return c.json<ApiResponse>(
      { ok: false, error: "Valid email is required" },
      400,
    );
  }

  const result = await getDb().execute(
    sql`SELECT * FROM steward_bootstrap.auth_sso_discovery_subject(${domain})`,
  );
  const rows = bootstrapRows<{
    tenant_id: string;
    domain: string;
    sso_required: boolean;
  }>(result);

  const data: SsoDiscoveryResult =
    rows.length === 1
      ? {
          domain,
          tenantId: rows[0].tenant_id,
          ssoRequired: rows[0].sso_required,
          available: true,
        }
      : { domain, tenantId: null, ssoRequired: false, available: false };
  return c.json<ApiResponse<SsoDiscoveryResult>>({ ok: true, data });
});

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function samlMetadataXml(config: TenantSamlSsoConfig): string {
  const entityId = escapeXml(config.spEntityId);
  const acsUrl = escapeXml(config.acsUrl);
  const nameIdFormat = escapeXml(
    config.nameIdFormat ??
      "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
  );
  return `<?xml version="1.0" encoding="UTF-8"?>
<EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${entityId}">
  <SPSSODescriptor AuthnRequestsSigned="false" WantAssertionsSigned="true" protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <NameIDFormat>${nameIdFormat}</NameIDFormat>
    <AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${acsUrl}" index="0" isDefault="true"/>
  </SPSSODescriptor>
</EntityDescriptor>`;
}

async function getActiveSamlSsoConfig(
  tenantId: string,
): Promise<TenantSamlSsoConfig | null> {
  const row = await withPreAuthTenant(
    tenantId,
    "saml-config-read",
    async () => {
      const [candidate] = await getDb()
        .select()
        .from(tenantSamlSsoConfigs)
        .where(
          and(
            eq(tenantSamlSsoConfigs.tenantId, tenantId),
            eq(tenantSamlSsoConfigs.enabled, true),
            eq(tenantSamlSsoConfigs.status, "active"),
          ),
        );
      return candidate;
    },
  );
  if (!row) return null;
  const urls = buildSamlServiceProviderUrls(tenantId);
  if (row.spEntityId !== urls.spEntityId || row.acsUrl !== urls.acsUrl)
    return null;
  return {
    tenantId: row.tenantId,
    enabled: row.enabled,
    status: row.status as TenantSamlSsoConfig["status"],
    idpEntityId: row.idpEntityId,
    idpSsoUrl: row.idpSsoUrl,
    idpCertPems: row.idpCertPems,
    spEntityId: row.spEntityId,
    acsUrl: row.acsUrl,
    nameIdFormat: row.nameIdFormat ?? undefined,
    emailAttribute: row.emailAttribute,
    groupsAttribute: row.groupsAttribute ?? undefined,
    groupRoleMappings:
      row.groupRoleMappings as TenantSamlSsoConfig["groupRoleMappings"],
    allowJitProvisioning: row.allowJitProvisioning,
    jitDefaultRole: "viewer",
    lastTestedAt: row.lastTestedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function loadSamlAuthnRequest(tenantId: string, relayState: string) {
  const request = await withPreAuthTenant(
    tenantId,
    "saml-request-read",
    async () => {
      const [candidate] = await getDb()
        .select()
        .from(tenantSamlAuthnRequests)
        .where(
          and(
            eq(tenantSamlAuthnRequests.tenantId, tenantId),
            eq(tenantSamlAuthnRequests.relayState, relayState),
            isNull(tenantSamlAuthnRequests.consumedAt),
            gte(tenantSamlAuthnRequests.expiresAt, new Date()),
          ),
        );
      return candidate;
    },
  );
  if (!request) throw new Error("Invalid or expired SAML RelayState");
  return request;
}

async function consumeSamlAuthnRequest(tenantId: string, relayState: string) {
  const request = await withPreAuthTenant(
    tenantId,
    "saml-request-consume",
    async () => {
      const [candidate] = await getDb()
        .update(tenantSamlAuthnRequests)
        .set({ consumedAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(tenantSamlAuthnRequests.tenantId, tenantId),
            eq(tenantSamlAuthnRequests.relayState, relayState),
            isNull(tenantSamlAuthnRequests.consumedAt),
            gte(tenantSamlAuthnRequests.expiresAt, new Date()),
          ),
        )
        .returning();
      return candidate;
    },
  );
  if (!request) throw new Error("Invalid or expired SAML RelayState");
  return request;
}

async function recordSamlAssertionReplay(
  tenantId: string,
  assertionId: string,
  responseId: string | undefined,
): Promise<void> {
  await withPreAuthTenant(tenantId, "saml-replay-record", async () => {
    await getDb()
      .insert(tenantSamlAssertionReplays)
      .values({
        tenantId,
        assertionId,
        responseId,
        expiresAt: new Date(Date.now() + 10 * 60_000),
      });
  });
}

/**
 * GET /saml/:tenantId/login
 * SP-initiated dashboard/team SSO. Stores an app-bound PKCE exchange request
 * and redirects to the tenant IdP with opaque RelayState.
 */
auth.get("/saml/:tenantId/login", async (c) => {
  const tenantId = c.req.param("tenantId") as string;
  if (!isValidTenantId(tenantId)) {
    return c.json<ApiResponse>({ ok: false, error: "Invalid tenant id" }, 400);
  }
  const redirectUri =
    c.req.query("redirect_uri")?.trim() || c.req.query("redirectUri")?.trim();
  const appState = c.req.query("state")?.trim() || undefined;
  const rawClientId =
    c.req.query("app_client_id") ?? c.req.query("appClientId");
  const clientId = rawClientId
    ? normalizePublicClientId(rawClientId)
    : undefined;
  const responseType = c.req.query("response_type")?.trim() || "code";
  const codeChallenge = c.req.query("code_challenge")?.trim() || undefined;
  const codeChallengeMethod =
    c.req.query("code_challenge_method")?.trim() || "S256";

  if (!redirectUri) {
    return c.json<ApiResponse>(
      { ok: false, error: "redirect_uri is required" },
      400,
    );
  }
  if (rawClientId && !clientId) {
    return c.json<ApiResponse>(
      { ok: false, error: "app_client_id is invalid" },
      400,
    );
  }
  if (responseType !== "code") {
    return c.json<ApiResponse>(
      { ok: false, error: "response_type must be 'code'" },
      400,
    );
  }
  if (!codeChallenge) {
    return c.json<ApiResponse>(
      { ok: false, error: "code_challenge is required for response_type=code" },
      400,
    );
  }
  if (codeChallengeMethod !== "S256") {
    return c.json<ApiResponse>(
      { ok: false, error: "code_challenge_method must be 'S256'" },
      400,
    );
  }

  const config = await getActiveSamlSsoConfig(tenantId);
  if (!config)
    return c.json<ApiResponse>(
      { ok: false, error: "SAML SSO is not configured" },
      404,
    );
  try {
    await assertAllowedOAuthRedirectUri(redirectUri, tenantId, clientId);
  } catch (err) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: err instanceof Error ? err.message : "Invalid redirect_uri",
      },
      400,
    );
  }

  const relayState = randomBase64Url(32);
  const requestId = `_${randomBase64Url(32)}`;
  const built = await buildSamlAuthorizeUrl({
    relayState,
    requestId,
    idpSsoUrl: config.idpSsoUrl,
    idpEntityId: config.idpEntityId,
    idpCertPems: config.idpCertPems,
    spEntityId: config.spEntityId,
    acsUrl: config.acsUrl,
  });
  await withPreAuthTenant(tenantId, "saml-request-create", async () => {
    await getDb()
      .insert(tenantSamlAuthnRequests)
      .values({
        tenantId,
        requestId: built.requestId,
        relayState,
        redirectUri,
        appClientId: clientId,
        codeChallenge,
        codeChallengeMethod: "S256",
        expiresAt: new Date(Date.now() + 5 * 60_000),
      });
  });

  if (appState) {
    await getChallengeStore().set(`saml-app-state:${relayState}`, appState);
  }
  return c.redirect(built.url, 302);
});

/**
 * GET /saml/:tenantId/metadata
 * Public SAML SP metadata for dashboard/team SSO IdP setup.
 */
auth.get("/saml/:tenantId/metadata", async (c) => {
  const tenantId = c.req.param("tenantId") as string;
  if (!isValidTenantId(tenantId)) {
    return c.json<ApiResponse>({ ok: false, error: "Invalid tenant id" }, 400);
  }
  const config = await getActiveSamlSsoConfig(tenantId);
  if (!config)
    return c.json<ApiResponse>(
      { ok: false, error: "SAML SSO is not configured" },
      404,
    );
  return c.text(samlMetadataXml(config), 200, {
    "Content-Type": "application/samlmetadata+xml",
  });
});

auth.post("/saml/:tenantId/acs", async (c) => {
  const tenantId = c.req.param("tenantId") as string;
  if (!isValidTenantId(tenantId)) {
    return c.json<ApiResponse>({ ok: false, error: "Invalid tenant id" }, 400);
  }
  const config = await getActiveSamlSsoConfig(tenantId);
  if (!config)
    return c.json<ApiResponse>(
      { ok: false, error: "SAML SSO is not configured" },
      404,
    );

  const body = await c.req.parseBody().catch(() => null);
  const samlResponse =
    typeof body?.SAMLResponse === "string" ? body.SAMLResponse : "";
  const relayState =
    typeof body?.RelayState === "string" ? body.RelayState : "";
  if (!samlResponse || !relayState) {
    return c.json<ApiResponse>(
      { ok: false, error: "SAMLResponse and RelayState are required" },
      400,
    );
  }

  let request: Awaited<ReturnType<typeof loadSamlAuthnRequest>>;
  let redirectUrl: URL;
  try {
    request = await loadSamlAuthnRequest(tenantId, relayState);
    redirectUrl = await assertAllowedOAuthRedirectUri(
      request.redirectUri,
      tenantId,
      request.appClientId ?? undefined,
    );
  } catch (err) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: err instanceof Error ? err.message : "Invalid SAML RelayState",
      },
      401,
    );
  }

  try {
    const verified = await verifySamlAcsResponse({
      samlResponse,
      expectedRequestId: request.requestId,
      tenantId,
      idpEntityId: config.idpEntityId,
      idpSsoUrl: config.idpSsoUrl,
      idpCertPems: config.idpCertPems,
      spEntityId: config.spEntityId,
      acsUrl: config.acsUrl,
      emailAttribute: config.emailAttribute,
      groupsAttribute: config.groupsAttribute,
    });
    if (!(await isVerifiedSsoEmailDomainForTenant(tenantId, verified.email))) {
      redirectUrl.searchParams.set("error", "saml_email_domain_not_verified");
      return c.redirect(redirectUrl.toString(), 302);
    }
    try {
      await consumeSamlAuthnRequest(tenantId, relayState);
    } catch {
      redirectUrl.searchParams.set("error", "saml_relay_state_replay");
      return c.redirect(redirectUrl.toString(), 302);
    }
    try {
      await recordSamlAssertionReplay(
        tenantId,
        verified.assertionId,
        undefined,
      );
    } catch {
      redirectUrl.searchParams.set("error", "saml_assertion_replay");
      return c.redirect(redirectUrl.toString(), 302);
    }

    const result = await provisionSamlUser({
      c,
      tenantId,
      config,
      subject: verified.nameId || verified.assertionId,
      email: verified.email,
      groups: verified.groups,
    });
    if (!result.ok) {
      redirectUrl.searchParams.set("error", result.error);
      return c.redirect(redirectUrl.toString(), 302);
    }
    if (result.response.ok === false || result.response.mfaRequired) {
      redirectUrl.searchParams.set("error", "auth_failed");
      return c.redirect(redirectUrl.toString(), 302);
    }

    const exchangeCode = randomBase64Url(32);
    const issuedAt = Date.now();
    const expiresAt = issuedAt + OAUTH_CODE_TTL_MS;
    await getOAuthCodeStore().set(
      `oauth-code:${exchangeCode}`,
      JSON.stringify({
        providerName: "saml",
        token: result.response.token,
        refreshToken: result.response.refreshToken,
        redirectUri: request.redirectUri,
        tenantId,
        codeChallenge: request.codeChallenge,
        codeChallengeMethod: request.codeChallengeMethod,
        expiresAt,
        expiresIn: ACCESS_TOKEN_EXPIRY_SECONDS,
      }),
    );
    const appState = await getChallengeStore().consume(
      `saml-app-state:${relayState}`,
    );
    setRedirectFragment(redirectUrl, {
      code: exchangeCode,
      state: appState ?? undefined,
    });
    return c.redirect(redirectUrl.toString(), 302);
  } catch (err) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: err instanceof Error ? err.message : "SAML verification failed",
      },
      401,
    );
  }
});

/**
 * GET /providers
 * Public endpoint. Returns which authentication methods are enabled on this
 * server so a client SDK (e.g. @elizaos/login) can render the right sign-in UI.
 *
 * Passkey/email/SIWE/SIWS are always wired in this build. OAuth providers are
 * advertised when their credentials are configured.
 *
 * Env var resolution mirrors `getProviderConfig` in @stwd/auth/oauth.ts: the
 * canonical names are `<PROVIDER>_CLIENT_ID` / `<PROVIDER>_CLIENT_SECRET`.
 * `STEWARD_OAUTH_<PROVIDER>_CLIENT_ID` is also accepted for backwards-compat
 * with older deployments. Reading only the prefixed form caused production
 * to advertise OAuth as disabled even though the underlying authorize
 * endpoints had working credentials.
 */
auth.get("/providers", async (c) => {
  const oauth = getEnabledProviders();
  const tenantId =
    c.req.query("tenantId")?.trim() || c.req.header("X-Steward-Tenant")?.trim();
  const authAbuseConfig = tenantId
    ? await getTenantAuthAbuseConfig(tenantId)
    : {};
  const loginMethods = authAbuseConfig.loginMethods ?? {};
  const methodEnabled = (
    method: keyof NonNullable<typeof authAbuseConfig.loginMethods>,
  ) => loginMethods[method] !== false;
  const enabledOauth = oauth.filter(
    (provider) => loginMethods.oauth?.[provider] !== false,
  );
  const oidc = tenantId
    ? (await getTenantOidcProviders(tenantId))
        .filter((provider) => provider.enabled !== false)
        .filter(
          (provider) =>
            loginMethods.oidc?.[loginMethodProviderKey(provider.id)] !== false,
        )
        .map((provider) => provider.id)
    : [];

  // Returns the providers payload at the top level, NOT wrapped in { ok, data }.
  // The @elizaos/login authRequest helper returns the full parsed body as `res.data`,
  // so callers like `getProviders()` then read `res.data` and expect the
  // StewardProviders shape directly. Wrapping here in ApiResponse caused the
  // SDK to receive `{ok:true, data: {...providers}}` and treat the wrapper as
  // the provider object: every provider field became undefined and SPAs hid
  // the OAuth buttons even when the credentials were configured.
  // The `ok: true` field is preserved at the top level so older clients that
  // were checking for it keep working.
  return c.json({
    ok: true,
    passkey: methodEnabled("passkey"),
    email: methodEnabled("email"),
    sms: methodEnabled("sms"),
    whatsapp: methodEnabled("whatsapp") && isWhatsAppOtpEnabled(),
    totp: methodEnabled("totp"),
    siwe: methodEnabled("siwe"),
    siws: methodEnabled("siws"),
    google: enabledOauth.includes("google"),
    discord: enabledOauth.includes("discord"),
    github: enabledOauth.includes("github"),
    twitter: enabledOauth.includes("twitter"),
    telegram:
      methodEnabled("telegram") &&
      Boolean(process.env.TELEGRAM_BOT_TOKEN?.trim()),
    farcaster: methodEnabled("farcaster") && isFarcasterLoginEnabled(),
    linkedin: enabledOauth.includes("linkedin"),
    spotify: enabledOauth.includes("spotify"),
    twitch: enabledOauth.includes("twitch"),
    instagram: enabledOauth.includes("instagram"),
    line: enabledOauth.includes("line"),
    oauth: enabledOauth,
    jwt: oidc.length > 0,
    oidc,
    captcha: publicAuthAbuseConfig(authAbuseConfig).captcha,
  });
});

auth.post("/telegram/challenge", async (c) => {
  const rl = await checkAuthRateLimit(c, "telegram-challenge", 60_000, 30);
  if (!rl.allowed) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Too many Telegram login attempts. Try again later.",
      },
      429,
      { "Retry-After": String(rl.retryAfterSecs ?? 60) },
    );
  }

  const body = await safeJsonParse<{ tenantId?: unknown }>(c);
  if (body === null) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid JSON in request body" },
      400,
    );
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!botToken) {
    return c.json<ApiResponse>(
      { ok: false, error: "Telegram login is not configured" },
      503,
    );
  }

  const requestedTenantId =
    typeof body?.tenantId === "string" && body.tenantId.trim()
      ? body.tenantId.trim()
      : c.req.header("X-Steward-Tenant")?.trim() || undefined;
  const methodResponse = await requireTenantLoginMethodAllowed(
    c,
    requestedTenantId,
    "telegram",
  );
  if (methodResponse) return methodResponse;
  const originHost = await requiredTelegramOriginHostFromRequest(
    c,
    requestedTenantId,
  );
  if (!originHost) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Telegram login challenges require an allowed Origin or Referer",
      },
      400,
    );
  }
  const challenge = await createTelegramLoginChallenge({
    tenantId: requestedTenantId,
    originHost,
  });
  return c.json({
    challengeId: challenge.challengeId,
    expiresAt: new Date(challenge.expiresAt).toISOString(),
  });
});

auth.post("/telegram/verify", async (c) => {
  const rl = await checkAuthRateLimit(c, "telegram-verify", 60_000, 20);
  if (!rl.allowed) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Too many Telegram login attempts. Try again later.",
      },
      429,
      { "Retry-After": String(rl.retryAfterSecs ?? 60) },
    );
  }

  const body = await safeJsonParse<
    TelegramLoginPayload & { tenantId?: unknown; challengeId?: unknown }
  >(c);
  if (!body)
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid JSON in request body" },
      400,
    );

  const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!botToken) {
    return c.json<ApiResponse>(
      { ok: false, error: "Telegram login is not configured" },
      503,
    );
  }

  const {
    tenantId: requestedBodyTenantId,
    challengeId,
    ...telegramPayload
  } = body;
  if (typeof challengeId !== "string" || !challengeId.trim()) {
    return c.json<ApiResponse>(
      { ok: false, error: "challengeId is required" },
      400,
    );
  }
  const bodyTenantId =
    typeof requestedBodyTenantId === "string" && requestedBodyTenantId.trim()
      ? requestedBodyTenantId.trim()
      : undefined;
  const headerTenantId = c.req.header("X-Steward-Tenant")?.trim() || undefined;
  if (bodyTenantId && headerTenantId && bodyTenantId !== headerTenantId) {
    return c.json<ApiResponse>(
      { ok: false, error: "tenantId and X-Steward-Tenant must match" },
      400,
    );
  }
  const requestedTenantId = bodyTenantId || headerTenantId;
  const methodResponse = await requireTenantLoginMethodAllowed(
    c,
    requestedTenantId,
    "telegram",
  );
  if (methodResponse) return methodResponse;
  const challengeError = validateConsumedTelegramLoginChallenge(
    await consumeTelegramLoginChallenge(challengeId.trim()),
    {
      tenantId: requestedTenantId,
      originHost: originHostFromRequest(c),
    },
  );
  if (challengeError) {
    return c.json<ApiResponse>({ ok: false, error: challengeError }, 401);
  }

  let telegramUser: ReturnType<typeof verifyTelegramLogin>;
  try {
    telegramUser = verifyTelegramLogin(telegramPayload, botToken, {
      maxAgeSec: TELEGRAM_LOGIN_MAX_AGE_SEC,
    });
  } catch (error) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error:
          error instanceof Error ? error.message : "Invalid Telegram login",
      },
      401,
    );
  }

  const displayName =
    [telegramUser.firstName, telegramUser.lastName]
      .filter(Boolean)
      .join(" ")
      .trim() ||
    telegramUser.username ||
    `telegram:${telegramUser.id}`;
  const [existingTelegramAccount] = await getDb()
    .select({ userId: accounts.userId })
    .from(accounts)
    .where(
      and(
        eq(accounts.provider, "telegram"),
        eq(accounts.providerAccountId, telegramUser.id),
      ),
    );
  if (!existingTelegramAccount && requestedTenantId) {
    const jitTenant = await validateOidcJitTenant(requestedTenantId);
    if (!jitTenant.ok) {
      return c.json<ApiResponse>(
        { ok: false, error: jitTenant.error },
        jitTenant.status,
      );
    }
  }
  const telegramHash =
    typeof telegramPayload.hash === "string"
      ? telegramPayload.hash
      : String(telegramPayload.hash);
  if (
    !(await consumeTelegramLoginHashOnce(telegramHash, telegramUser.authDate))
  ) {
    return c.json<ApiResponse>(
      { ok: false, error: "Telegram login payload was already used" },
      401,
    );
  }
  const { user, isNew } = await findOrCreateExternalAccountUserWithStatus({
    provider: "telegram",
    providerAccountId: telegramUser.id,
    name: displayName,
    image: telegramUser.photoUrl,
  });

  try {
    const updates: Partial<typeof users.$inferInsert> = {};
    if (!user.name && displayName) updates.name = displayName;
    if (!user.image && telegramUser.photoUrl)
      updates.image = telegramUser.photoUrl;
    if (Object.keys(updates).length > 0) {
      await getDb().update(users).set(updates).where(eq(users.id, user.id));
    }

    let walletAddress = user.walletAddress;
    try {
      const wallet = await provisionWalletForUser(
        user.id,
        `telegram:${telegramUser.id}`,
      );
      walletAddress = wallet.walletAddress;
    } catch (err) {
      logger.error(
        {
          details: [
            "[TelegramAuth] Wallet provision failed",
            redactedThrownDiagnostics(err),
          ],
        },
        "[Login:auth] error",
      );
    }

    const tenantResult = await resolveAndValidateTenant(
      c,
      user.id,
      requestedTenantId,
    );
    if (!tenantResult.ok) {
      return c.json<ApiResponse>(
        { ok: false, error: tenantResult.error },
        tenantResult.status,
      );
    }
    const resolvedMethodResponse = await requireTenantLoginMethodAllowed(
      c,
      tenantResult.tenantId,
      "telegram",
    );
    if (resolvedMethodResponse) return resolvedMethodResponse;
    await ensureUserTenantLink(user.id, tenantResult.tenantId);
    if (isNew) {
      dispatchUserCreated(tenantResult.tenantId, user.id, "auth.telegram", {
        provider: "telegram",
        hasEmail: false,
      });
    }

    const response = await buildAuthOrMfaResponse(
      user.id,
      tenantResult.tenantId,
      walletAddress ?? "",
      {
        userId: user.id,
        authMethod: "telegram",
        telegramId: telegramUser.id,
      },
      {
        id: user.id,
        email: null,
        name: displayName,
        image: telegramUser.photoUrl,
        walletAddress,
        telegramId: telegramUser.id,
        telegramUsername: telegramUser.username,
      },
      c,
    );
    return authExchangeJson(c, response);
  } catch (error) {
    logger.error(
      {
        details: [
          "[TelegramAuth] verify failed",
          redactedThrownDiagnostics(error),
        ],
      },
      "[Login:auth] error",
    );
    return c.json<ApiResponse>(
      { ok: false, error: "Telegram login failed" },
      500,
    );
  }
});

auth.post("/farcaster/verify", async (c) => {
  if (!isFarcasterLoginEnabled()) {
    return c.json<ApiResponse>(
      { ok: false, error: "Farcaster login is not configured" },
      503,
    );
  }

  const rl = await checkAuthRateLimit(c, "farcaster-verify", 60_000, 20);
  if (!rl.allowed) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Too many Farcaster login attempts. Try again later.",
      },
      429,
      { "Retry-After": String(rl.retryAfterSecs ?? 60) },
    );
  }

  const body = await safeJsonParse<
    FarcasterLoginPayload & { tenantId?: unknown }
  >(c);
  if (!body)
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid JSON in request body" },
      400,
    );

  const { tenantId: requestedBodyTenantId, ...farcasterPayload } = body;
  let farcasterUser: Awaited<ReturnType<typeof verifyFarcasterLogin>>;
  try {
    farcasterUser = await verifyFarcasterLogin(farcasterPayload, {
      expectedDomain: getAllowedSiweDomains(),
      maxMessageAgeMs: 10 * 60 * 1000,
    });
  } catch (error) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error:
          error instanceof Error ? error.message : "Invalid Farcaster login",
      },
      401,
    );
  }

  const bodyTenantId =
    typeof requestedBodyTenantId === "string" && requestedBodyTenantId.trim()
      ? requestedBodyTenantId.trim()
      : undefined;
  const headerTenantId = c.req.header("X-Steward-Tenant")?.trim() || undefined;
  if (bodyTenantId && headerTenantId && bodyTenantId !== headerTenantId) {
    return c.json<ApiResponse>(
      { ok: false, error: "tenantId and X-Steward-Tenant must match" },
      400,
    );
  }
  const requestedTenantId = bodyTenantId || headerTenantId;
  const methodResponse = await requireTenantLoginMethodAllowed(
    c,
    requestedTenantId,
    "farcaster",
  );
  if (methodResponse) return methodResponse;
  const nonceError = validateConsumedSiweNonce(
    await consumeSiweNonce(farcasterUser.message.nonce),
    {
      domain: farcasterUser.message.domain,
      tenantId: requestedTenantId,
    },
  );
  if (nonceError) {
    return c.json<ApiResponse>({ ok: false, error: nonceError }, 401);
  }

  const displayName = `farcaster:${farcasterUser.custodyAddress}`;
  const providerAccountId = `address:${farcasterUser.custodyAddress.toLowerCase()}`;

  const [existingFarcasterAccount] = await getDb()
    .select({ userId: accounts.userId })
    .from(accounts)
    .where(
      and(
        eq(accounts.provider, "farcaster"),
        eq(accounts.providerAccountId, providerAccountId),
      ),
    );
  if (!existingFarcasterAccount && requestedTenantId) {
    const jitTenant = await validateOidcJitTenant(requestedTenantId);
    if (!jitTenant.ok) {
      return c.json<ApiResponse>(
        { ok: false, error: jitTenant.error },
        jitTenant.status,
      );
    }
  }

  const { user, isNew } = await findOrCreateExternalAccountUserWithStatus({
    provider: "farcaster",
    providerAccountId,
    name: displayName,
  });

  try {
    const updates: Partial<typeof users.$inferInsert> = {};
    if (!user.name && displayName) updates.name = displayName;
    if (!user.walletAddress) {
      updates.walletAddress = farcasterUser.custodyAddress;
      updates.walletChain = "ethereum";
    }
    if (Object.keys(updates).length > 0) {
      await getDb().update(users).set(updates).where(eq(users.id, user.id));
    }

    let walletAddress = user.walletAddress ?? farcasterUser.custodyAddress;
    try {
      const wallet = await provisionWalletForUser(
        user.id,
        `farcaster:${providerAccountId}`,
      );
      walletAddress = wallet.walletAddress;
    } catch (err) {
      logger.error(
        {
          details: [
            "[FarcasterAuth] Wallet provision failed",
            redactedThrownDiagnostics(err),
          ],
        },
        "[Login:auth] error",
      );
    }

    const tenantResult = await resolveAndValidateTenant(
      c,
      user.id,
      requestedTenantId,
    );
    if (!tenantResult.ok) {
      return c.json<ApiResponse>(
        { ok: false, error: tenantResult.error },
        tenantResult.status,
      );
    }
    const resolvedMethodResponse = await requireTenantLoginMethodAllowed(
      c,
      tenantResult.tenantId,
      "farcaster",
    );
    if (resolvedMethodResponse) return resolvedMethodResponse;
    await ensureUserTenantLink(user.id, tenantResult.tenantId);
    if (isNew) {
      dispatchUserCreated(tenantResult.tenantId, user.id, "auth.farcaster", {
        provider: "farcaster",
        custodyAddress: farcasterUser.custodyAddress,
        authoritativeCustody: false,
      });
    }

    const response = await buildAuthOrMfaResponse(
      user.id,
      tenantResult.tenantId,
      walletAddress ?? "",
      {
        userId: user.id,
        authMethod: "farcaster",
        custodyAddress: farcasterUser.custodyAddress,
      },
      {
        id: user.id,
        email: null,
        name: displayName,
        walletAddress,
        custodyAddress: farcasterUser.custodyAddress,
      },
      c,
    );
    return authExchangeJson(c, response);
  } catch (error) {
    logger.error(
      {
        details: [
          "[FarcasterAuth] verify failed",
          redactedThrownDiagnostics(error),
        ],
      },
      "[Login:auth] error",
    );
    return c.json<ApiResponse>(
      { ok: false, error: "Farcaster login failed" },
      500,
    );
  }
});

/**
 * POST /jwt/login (direct OIDC id_token login)
 *
 * Accepts an id_token the client already obtained from the IdP and exchanges it
 * for a Steward session. Signature, issuer, audience, azp (OIDC §3.1.3.7), and
 * exp are verified first, then the id_token hash is marked one-time-use until
 * exp so a captured token cannot mint multiple Steward sessions.
 */
auth.post("/jwt/login", async (c) => {
  const rl = await checkAuthRateLimit(c, "jwt", 60_000, 20);
  if (!rl.allowed) {
    return c.json<ApiResponse>(
      { ok: false, error: "Too many JWT login attempts. Try again later." },
      429,
      { "Retry-After": String(rl.retryAfterSecs ?? 60) },
    );
  }

  const body = await safeJsonParse<{
    tenantId?: unknown;
    providerId?: unknown;
    token?: unknown;
  }>(c);
  if (!body)
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid JSON in request body" },
      400,
    );
  if (
    typeof body.tenantId !== "string" ||
    body.tenantId.trim() === "" ||
    typeof body.token !== "string" ||
    body.token.trim() === ""
  ) {
    return c.json<ApiResponse>(
      { ok: false, error: "tenantId and token are required" },
      400,
    );
  }

  const tenantId = body.tenantId.trim();
  const headerTenant = c.req.header("X-Steward-Tenant")?.trim();
  if (headerTenant && headerTenant !== tenantId) {
    return c.json<ApiResponse>(
      { ok: false, error: "tenantId does not match X-Steward-Tenant" },
      400,
    );
  }

  const providerId =
    typeof body.providerId === "string" && body.providerId.trim() !== ""
      ? body.providerId.trim()
      : undefined;
  const provider = selectOidcProvider(
    await getTenantOidcProviders(tenantId),
    providerId,
  );
  if (!provider) {
    return c.json<ApiResponse>(
      { ok: false, error: "OIDC provider not found or disabled" },
      404,
    );
  }
  if (provider.authorizationUrl || provider.tokenUrl) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error:
          "Direct JWT login is disabled for authorization-code OIDC providers",
      },
      403,
    );
  }
  const methodResponse = await requireTenantLoginMethodAllowed(
    c,
    tenantId,
    "oidc",
    provider.id,
  );
  if (methodResponse) return methodResponse;

  try {
    const rawToken = body.token.trim();
    const verified = await verifyOidcJwt(tenantId, provider, rawToken);
    const replay = await markOidcIdTokenUsedOnce(
      tenantId,
      provider.id,
      rawToken,
      verified.claims.exp,
    );
    if (!replay.ok) {
      const error =
        replay.response === "replayed"
          ? "OIDC id_token has already been used"
          : replay.response === "missing-exp"
            ? "OIDC id_token exp claim is required"
            : "OIDC id_token is expired";
      return c.json<ApiResponse>({ ok: false, error }, 401);
    }
    await withPreAuthTenant(tenantId, "oidc-login-authorization-audit", () =>
      writeAuditEvent({
        tenantId,
        actorType: "user",
        actorId: null,
        action: "auth.oidc.login.authorized",
        resourceType: "session",
        metadata: {
          providerId: provider.id,
          issuer: provider.issuer,
          oidcSubject: verified.subject,
        },
        ipAddress: c.req.header("x-forwarded-for") ?? null,
        userAgent: c.req.header("user-agent") ?? null,
        requestId: c.get("requestId") ?? null,
      }),
    );
    if (!verified.email || verified.emailVerified !== true) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error: "Enterprise OIDC SSO requires a verified email claim",
        },
        403,
      );
    }
    if (!(await isVerifiedSsoEmailDomainForTenant(tenantId, verified.email))) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error:
            "Enterprise OIDC SSO email domain is not verified for this tenant",
        },
        403,
      );
    }
    const result = await provisionOidcUser({
      c,
      tenantId,
      provider,
      subject: verified.subject,
      email: verified.email,
      emailVerified: verified.emailVerified,
      name: verified.name,
      picture: verified.picture,
    });
    if (!result.ok) {
      return c.json<ApiResponse>(
        { ok: false, error: result.error },
        result.status ?? 500,
      );
    }
    return authExchangeJson(c, result.response);
  } catch (err) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error:
          err instanceof Error ? err.message : "OIDC token verification failed",
      },
      401,
    );
  }
});

/**
 * GET /oidc/:provider/authorize
 *
 * Enterprise OIDC authorization-code SSO. This mirrors the built-in OAuth
 * nonce-exchange flow: Steward owns the provider callback, validates the
 * ID token, then redirects the app with a one-time code that must be redeemed
 * through /auth/oauth/exchange.
 */
auth.get("/oidc/:provider/authorize", async (c) => {
  const providerId = c.req.param("provider");
  const rl = await checkAuthRateLimit(
    c,
    `oidc-authorize:${providerId}`,
    60_000,
    30,
  );
  if (!rl.allowed) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Too many OIDC authorization requests. Please try again later.",
      },
      429,
    );
  }

  const tenantId =
    c.req.query("tenant_id")?.trim() || c.req.query("tenantId")?.trim() || "";
  const redirectUri =
    c.req.query("redirect_uri")?.trim() || c.req.query("redirectUri")?.trim();
  const appState = c.req.query("state")?.trim() || undefined;
  const rawClientId =
    c.req.query("app_client_id") ?? c.req.query("appClientId");
  const clientId = rawClientId
    ? normalizePublicClientId(rawClientId)
    : undefined;
  const responseType = c.req.query("response_type")?.trim() || "code";
  const codeChallenge = c.req.query("code_challenge")?.trim() || undefined;
  const codeChallengeMethod =
    c.req.query("code_challenge_method")?.trim() || "S256";

  if (!tenantId)
    return c.json<ApiResponse>(
      { ok: false, error: "tenant_id is required" },
      400,
    );
  if (!redirectUri) {
    return c.json<ApiResponse>(
      { ok: false, error: "redirect_uri is required" },
      400,
    );
  }
  if (rawClientId && !clientId) {
    return c.json<ApiResponse>(
      { ok: false, error: "app_client_id is invalid" },
      400,
    );
  }
  if (responseType !== "code") {
    return c.json<ApiResponse>(
      { ok: false, error: "response_type must be 'code'" },
      400,
    );
  }
  if (!codeChallenge) {
    return c.json<ApiResponse>(
      { ok: false, error: "code_challenge is required for response_type=code" },
      400,
    );
  }
  if (codeChallengeMethod !== "S256") {
    return c.json<ApiResponse>(
      { ok: false, error: "code_challenge_method must be 'S256'" },
      400,
    );
  }

  const provider = selectOidcProvider(
    await getTenantOidcProviders(tenantId),
    providerId,
  );
  if (!provider) {
    return c.json<ApiResponse>(
      { ok: false, error: "OIDC provider not found or disabled" },
      404,
    );
  }
  if (!provider.clientId || !provider.authorizationUrl || !provider.tokenUrl) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "OIDC provider is not configured for authorization-code login",
      },
      400,
    );
  }

  const methodResponse = await requireTenantLoginMethodAllowed(
    c,
    tenantId,
    "oidc",
    provider.id,
    clientId,
  );
  if (methodResponse) return methodResponse;

  try {
    await assertAllowedOAuthRedirectUri(redirectUri, tenantId, clientId);
  } catch (err) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: err instanceof Error ? err.message : "Invalid redirect_uri",
      },
      400,
    );
  }

  const state = randomBase64Url(24);
  const nonce = randomBase64Url(24);
  const codeVerifier = randomBase64Url(48);
  const providerCodeChallenge = await pkceChallengeForVerifier(
    codeVerifier,
    "S256",
  );
  if (!providerCodeChallenge) {
    return c.json<ApiResponse>(
      { ok: false, error: "Failed to generate PKCE challenge" },
      500,
    );
  }

  const callbackUrl = buildOidcCallbackUrl(c, provider.id);
  const scopes = provider.scopes?.length
    ? provider.scopes
    : ["openid", "email", "profile"];
  let authUrl: URL;
  try {
    // Revalidate persisted rows at the action boundary before issuing a browser
    // redirect; configuration-time validation is not an execution-time trust check.
    authUrl = assertPublicHttpsEndpoint(
      provider.authorizationUrl,
      "OIDC authorization endpoint",
    );
  } catch (err) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error:
          err instanceof Error
            ? err.message
            : "Invalid OIDC authorization endpoint",
      },
      400,
    );
  }
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", provider.clientId);
  authUrl.searchParams.set("redirect_uri", callbackUrl);
  authUrl.searchParams.set(
    "scope",
    Array.from(new Set(["openid", ...scopes])).join(" "),
  );
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("nonce", nonce);
  authUrl.searchParams.set("code_challenge", providerCodeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");

  await getChallengeStore().set(
    `oidc:${state}`,
    JSON.stringify({
      providerId: provider.id,
      tenantId,
      clientId,
      redirectUri,
      appState,
      codeChallenge,
      codeChallengeMethod,
      nonce,
      codeVerifier,
    }),
  );

  return c.redirect(authUrl.toString(), 302);
});

auth.get("/oidc/:provider/callback", async (c) => {
  const providerId = c.req.param("provider");
  const code = c.req.query("code");
  const state = c.req.query("state");
  const errorParam = c.req.query("error");

  if (errorParam) {
    // Provider-supplied query text is untrusted and may contain diagnostics or
    // attacker-controlled markup. Do not reflect it to the browser.
    const recovery = await oauthCallbackRecoveryFromStoredState(
      "oidc",
      state,
      providerId,
    );
    return oauthCallbackFailure(c, {
      code: "oidc_authorization_failed",
      message: "The identity provider did not authorize this sign-in.",
      status: 400,
      ...recovery,
    });
  }
  if (!code || !state) {
    const recovery = await oauthCallbackRecoveryFromStoredState(
      "oidc",
      state,
      providerId,
    );
    return oauthCallbackFailure(c, {
      code: "oidc_callback_incomplete",
      message: "The identity provider returned an incomplete sign-in response.",
      status: 400,
      ...recovery,
    });
  }
  if (code.length > 4_096 || state.length > 256) {
    const recovery = await oauthCallbackRecoveryFromStoredState(
      "oidc",
      state,
      providerId,
    );
    return oauthCallbackFailure(c, {
      code: "oidc_callback_invalid",
      message: "The identity provider returned an invalid sign-in response.",
      status: 400,
      ...recovery,
    });
  }

  const stateKey = `oidc:${state}`;
  const rawPayload = await getChallengeStore().get(stateKey);
  if (!rawPayload) {
    return oauthCallbackFailure(c, {
      code: "oidc_state_expired",
      message: "This sign-in attempt is invalid or has expired.",
      status: 401,
    });
  }

  let stateData: {
    providerId: string;
    tenantId: string;
    clientId?: string;
    redirectUri: string;
    appState?: string;
    codeChallenge?: string;
    codeChallengeMethod?: string;
    nonce: string;
    codeVerifier: string;
  };
  try {
    stateData = JSON.parse(rawPayload) as typeof stateData;
  } catch {
    return oauthCallbackFailure(c, {
      code: "oidc_state_invalid",
      message: "This sign-in attempt could not be validated.",
      status: 400,
    });
  }
  if (stateData.providerId !== providerId) {
    return oauthCallbackFailure(c, {
      code: "oidc_provider_mismatch",
      message: "The identity provider does not match this sign-in attempt.",
      status: 400,
    });
  }

  const provider = selectOidcProvider(
    await getTenantOidcProviders(stateData.tenantId),
    providerId,
  );
  if (!provider?.clientId || !provider.tokenUrl) {
    return oauthCallbackFailure(c, {
      code: "oidc_provider_unavailable",
      message: "This identity provider is not available.",
      status: 404,
    });
  }

  const methodResponse = await requireTenantLoginMethodAllowed(
    c,
    stateData.tenantId,
    "oidc",
    provider.id,
    stateData.clientId,
  );
  if (methodResponse) {
    return oauthCallbackFailure(c, {
      code: "oidc_login_disabled",
      message: "OIDC sign-in is disabled for this application.",
      status: 403,
    });
  }

  let redirectUrl: URL;
  try {
    redirectUrl = await assertAllowedOAuthRedirectUri(
      stateData.redirectUri,
      stateData.tenantId,
      stateData.clientId,
    );
  } catch (err) {
    logger.error(
      {
        details: [
          "[OidcAuth] Callback redirect validation failed",
          redactedThrownDiagnostics(err),
        ],
      },
      "[Login:auth] error",
    );
    return oauthCallbackFailure(c, {
      code: "oidc_redirect_invalid",
      message: "The application return address is not allowed.",
      status: 400,
    });
  }

  let idToken: string;
  try {
    idToken = await exchangeOidcAuthorizationCode({
      provider,
      tenantId: stateData.tenantId,
      code,
      redirectUri: buildOidcCallbackUrl(c, provider.id),
      codeVerifier: stateData.codeVerifier,
    });
  } catch (err) {
    logger.error(
      {
        details: [
          "[OidcAuth] Callback token exchange failed",
          redactedThrownDiagnostics(err),
        ],
      },
      "[Login:auth] error",
    );
    return oauthCallbackFailure(c, {
      code: "oidc_token_exchange_failed",
      message:
        "The identity provider could not complete sign-in. Please try again.",
      status: 502,
      redirectUrl,
      appState: stateData.appState,
    });
  }

  try {
    const verified = await verifyOidcJwt(stateData.tenantId, provider, idToken);
    if (verified.claims.nonce !== stateData.nonce) {
      return oauthCallbackFailure(c, {
        code: "oidc_nonce_mismatch",
        message: "This sign-in response could not be matched to your browser.",
        status: 401,
        redirectUrl,
        appState: stateData.appState,
      });
    }
    if (!verified.email || verified.emailVerified !== true) {
      return oauthCallbackFailure(c, {
        code: "oidc_verified_email_required",
        message: "Enterprise OIDC sign-in requires a verified email address.",
        status: 403,
        redirectUrl,
        appState: stateData.appState,
      });
    }
    if (
      !(await isVerifiedSsoEmailDomainForTenant(
        stateData.tenantId,
        verified.email,
      ))
    ) {
      return oauthCallbackFailure(c, {
        code: "oidc_email_domain_unverified",
        message: "Your email domain is not approved for this organization.",
        status: 403,
        redirectUrl,
        appState: stateData.appState,
      });
    }
    const consumedPayload = await getChallengeStore().consume(stateKey);
    if (consumedPayload !== rawPayload) {
      return oauthCallbackFailure(c, {
        code: "oidc_state_consumed",
        message: "This sign-in attempt is invalid or has already been used.",
        status: 401,
        redirectUrl,
        appState: stateData.appState,
      });
    }
    await withPreAuthTenant(
      stateData.tenantId,
      "oidc-callback-authorization-audit",
      () =>
        writeAuditEvent({
          tenantId: stateData.tenantId,
          actorType: "user",
          actorId: null,
          action: "auth.oidc.login.authorized",
          resourceType: "session",
          metadata: {
            providerId: provider.id,
            issuer: provider.issuer,
            oidcSubject: verified.subject,
            flow: "authorization_code",
          },
          ipAddress: c.req.header("x-forwarded-for") ?? null,
          userAgent: c.req.header("user-agent") ?? null,
          requestId: c.get("requestId") ?? null,
        }),
    );
    const result = await provisionOidcUser({
      c,
      tenantId: stateData.tenantId,
      provider,
      subject: verified.subject,
      email: verified.email,
      emailVerified: verified.emailVerified,
      name: verified.name,
      picture: verified.picture,
      tenantRole: "viewer",
    });
    if (!result.ok) {
      return oauthCallbackFailure(c, {
        code: "oidc_account_provisioning_failed",
        message: "Your account could not be prepared for sign-in.",
        status: result.status ?? 500,
        redirectUrl,
        appState: stateData.appState,
      });
    }
    if (result.response.ok === false) {
      return oauthCallbackFailure(c, {
        code: "oidc_authentication_failed",
        message: "Sign-in could not be completed.",
        status: 403,
        redirectUrl,
        appState: stateData.appState,
      });
    }
    if (result.response.mfaRequired) {
      return oauthCallbackFailure(c, {
        code: "mfa_required",
        message: "Additional verification is required to complete sign-in.",
        status: 403,
        redirectUrl,
        appState: stateData.appState,
      });
    }

    const exchangeCode = randomBase64Url(32);
    const issuedAt = Date.now();
    const expiresAt = issuedAt + OAUTH_CODE_TTL_MS;
    await getOAuthCodeStore().set(
      `oauth-code:${exchangeCode}`,
      JSON.stringify({
        providerName: `oidc:${provider.id}`,
        token: result.response.token,
        refreshToken: result.response.refreshToken,
        redirectUri: stateData.redirectUri,
        tenantId: stateData.tenantId,
        codeChallenge: stateData.codeChallenge,
        codeChallengeMethod: stateData.codeChallengeMethod ?? "S256",
        expiresAt,
        expiresIn: ACCESS_TOKEN_EXPIRY_SECONDS,
      }),
    );
    setRedirectFragment(redirectUrl, {
      code: exchangeCode,
      state: stateData.appState,
    });
    return c.redirect(redirectUrl.toString(), 302);
  } catch (err) {
    logger.error(
      {
        details: [
          "[OidcAuth] Callback verification failed",
          redactedThrownDiagnostics(err),
        ],
      },
      "[Login:auth] error",
    );
    return oauthCallbackFailure(c, {
      code: "oidc_token_verification_failed",
      message: "The identity provider response could not be verified.",
      status: 401,
      redirectUrl,
      appState: stateData.appState,
    });
  }
});

/**
 * GET /test/inbox/:email
 *
 * Test-only endpoint. Returns the most recent magic-link email captured by
 * the in-memory MockEmailProvider. Gated by EMAIL_PROVIDER=mock + non-production
 * — returns 404 in any other configuration so it cannot leak in prod.
 */
auth.get("/test/inbox/:email", (c) => {
  if (!isMockEmailEnabled() || !authTestInboxEnabled()) {
    return c.json<ApiResponse>({ ok: false, error: "Not found" }, 404);
  }
  const email = decodeURIComponent(c.req.param("email"));
  const msg = MockEmailInbox.last(email);
  if (!msg) {
    return c.json<ApiResponse>({ ok: false, error: "No message" }, 404);
  }
  return c.json({
    ok: true,
    to: msg.to,
    subject: msg.subject,
    text: msg.text,
    token: msg.token,
    magicLink: msg.magicLink,
    sentAt: msg.sentAt.toISOString(),
  });
});

auth.get("/test/sms-inbox/:phone", (c) => {
  if (
    process.env.SMS_PROVIDER !== "mock" ||
    process.env.NODE_ENV === "production" ||
    !authTestInboxEnabled()
  ) {
    return c.json<ApiResponse>({ ok: false, error: "Not found" }, 404);
  }
  const phone = decodeURIComponent(c.req.param("phone"));
  const msg = MockSmsInbox.last(phone);
  if (!msg) {
    return c.json<ApiResponse>({ ok: false, error: "No message" }, 404);
  }
  return c.json({
    ok: true,
    to: msg.to,
    body: msg.body,
    code: msg.code,
    sentAt: msg.sentAt.toISOString(),
  });
});

/**
 * POST /test/token
 *
 * Exchanges a tenant's explicitly enabled test-account credentials for a
 * normal short-lived session token. This mirrors Privy-style app-review and
 * automation credentials without exposing mock inboxes or bypassing tenant
 * membership for arbitrary users.
 */
auth.post("/test/token", async (c) => {
  // ⚠️ SECURITY WARNING — STEWARD_ENABLE_PROD_TEST_ACCOUNT_TOKEN ⚠️
  // This endpoint mints a real, fully-privileged session token for a tenant's
  // test-account credentials. It is hard-disabled in production by default.
  // Setting STEWARD_ENABLE_PROD_TEST_ACCOUNT_TOKEN=true in a production
  // environment is DANGEROUS: anyone who learns the (often static) test-account
  // email/phone/OTP can obtain a valid session. Only enable it for short,
  // supervised app-review / automation windows and disable it immediately
  // afterward. Never leave it enabled on an internet-reachable prod deploy.
  if (
    process.env.NODE_ENV === "production" &&
    process.env.STEWARD_ENABLE_PROD_TEST_ACCOUNT_TOKEN !== "true"
  ) {
    return c.json<ApiResponse>(
      { ok: false, error: "Test account token exchange is disabled" },
      404,
    );
  }

  const rl = await checkAuthRateLimit(c, "test-account-token", 10_000, 10);
  if (!rl.allowed) {
    return c.json<ApiResponse>(
      { ok: false, error: "Too many test account attempts. Try again later." },
      429,
    );
  }

  const body = await safeJsonParse<{
    tenantId?: string;
    email?: string;
    phone?: string;
    otp?: string;
  }>(c);
  const tenantId =
    c.req.header("X-Steward-Tenant")?.trim() || body?.tenantId?.trim();
  if (!tenantId) {
    return c.json<ApiResponse>(
      { ok: false, error: "tenantId is required" },
      400,
    );
  }

  const testAccount = (await authTenantConfigSubject(tenantId))?.test_account;
  if (!isEnabledTestAccount(testAccount)) {
    return c.json<ApiResponse>(invalidTestAccountCredentials(), 401);
  }

  const emailMatches = testCredentialMatches(body?.email, testAccount.email);
  const phoneMatches = testCredentialMatches(body?.phone, testAccount.phone);
  if (!emailMatches && !phoneMatches) {
    return c.json<ApiResponse>(invalidTestAccountCredentials(), 401);
  }

  const credentialSubject = hashSha256Hex(
    [
      tenantId.toLowerCase(),
      emailMatches ? `email:${testAccount.email.trim().toLowerCase()}` : "",
      phoneMatches ? `phone:${testAccount.phone.trim()}` : "",
    ].join(":"),
  );
  const credentialRl = await checkAuthRateLimit(
    c,
    "test-account-token-credential",
    10 * 60_000,
    5,
    credentialSubject,
  );
  if (!credentialRl.allowed) {
    return c.json<ApiResponse>(
      { ok: false, error: "Too many test account attempts. Try again later." },
      429,
    );
  }

  if (!testAccountOtpMatches(body?.otp, testAccount)) {
    return c.json<ApiResponse>(invalidTestAccountCredentials(), 401);
  }

  if (emailMatches) {
    const methodResponse = await requireTenantLoginMethodAllowed(
      c,
      tenantId,
      "email",
    );
    if (methodResponse) return methodResponse;
    const authResult = await completeEmailAuth(c, testAccount.email, tenantId, {
      allowTenantJoin: true,
    });
    if (!authResult.ok) {
      return c.json<ApiResponse>(
        { ok: false, error: authResult.error },
        authResult.status,
      );
    }
    await writeAuditEvent({
      tenantId,
      actorType: "user",
      actorId:
        typeof authResult.response.user === "object" &&
        authResult.response.user !== null &&
        "id" in authResult.response.user
          ? String(authResult.response.user.id)
          : null,
      action: "auth.test_account.login",
      resourceType: "session",
      metadata: { method: "email" },
      ipAddress: c.req.header("x-forwarded-for") ?? null,
      userAgent: c.req.header("user-agent") ?? null,
      requestId: null,
    });
    return authExchangeJson(c, authResult.response);
  }

  const methodResponse = await requireTenantLoginMethodAllowed(
    c,
    tenantId,
    "sms",
  );
  if (methodResponse) return methodResponse;
  const { user, isNew } = await findOrCreatePhoneUserWithStatus(
    testAccount.phone,
  );
  await ensurePersonalTenant(user.id, `Phone ${testAccount.phone.slice(-4)}`);
  await ensureUserTenantLink(user.id, tenantId, "member");
  if (isNew) {
    dispatchUserCreated(tenantId, user.id, "auth.test_account", {
      hasPhone: true,
    });
  }

  const response = await buildAuthOrMfaResponse(
    user.id,
    tenantId,
    user.walletAddress ?? "",
    {
      userId: user.id,
      phoneHash: hashSha256Hex(testAccount.phone),
      authMethod: "test_account",
    },
    {
      id: user.id,
      email: "",
      walletAddress: user.walletAddress,
    },
  );
  await writeAuditEvent({
    tenantId,
    actorType: "user",
    actorId: user.id,
    action: "auth.test_account.login",
    resourceType: "session",
    metadata: { method: "phone" },
    ipAddress: c.req.header("x-forwarded-for") ?? null,
    userAgent: c.req.header("user-agent") ?? null,
    requestId: null,
  });
  return authExchangeJson(c, response);
});

// ── SMS OTP ─────────────────────────────────────────────────────────────────

auth.post("/sms/send", async (c) => {
  const rl = await checkAuthRateLimit(c, "sms-send", 60_000, 5);
  if (!rl.allowed) {
    return c.json<ApiResponse>(
      { ok: false, error: "Too many requests. Please try again later." },
      429,
    );
  }

  const body = await safeJsonParse<{
    phone: string;
    tenantId?: string;
    captchaToken?: string;
  }>(c);
  if (!isValidE164(body?.phone)) {
    return c.json<ApiResponse>(
      { ok: false, error: "phone must be E.164" },
      400,
    );
  }
  const headerTenantId = c.req.header("X-Steward-Tenant")?.trim();
  const bodyTenantId = body.tenantId?.trim();
  const resolvedTenantId = authTenantHint(c, body.tenantId);
  const tenantHintError = await validateExplicitAuthTenantHint(
    resolvedTenantId,
    Boolean(headerTenantId || bodyTenantId),
  );
  if (tenantHintError) {
    return c.json<ApiResponse>({ ok: false, error: tenantHintError }, 404);
  }
  const methodResponse = await requireTenantLoginMethodAllowed(
    c,
    resolvedTenantId,
    "sms",
  );
  if (methodResponse) return methodResponse;
  const authAbuseConfig = await getTenantAuthAbuseConfig(resolvedTenantId);
  const phonePolicyError = validatePhoneAbusePolicy(
    body.phone,
    authAbuseConfig,
  );
  if (phonePolicyError) {
    return c.json<ApiResponse>({ ok: false, error: phonePolicyError }, 400);
  }
  const captcha = await verifyCaptchaToken(
    authAbuseConfig,
    "sms_otp",
    body.captchaToken,
    trustedClientIp(c),
  );
  if (!captcha.ok) {
    return c.json<ApiResponse>(
      { ok: false, error: captcha.error },
      captcha.status as 400 | 502 | 503,
    );
  }
  const phoneRl = await checkAuthRateLimit(
    c,
    "sms-send-destination",
    10 * 60_000,
    5,
    body.phone,
  );
  if (!phoneRl.allowed) {
    return c.json<ApiResponse>(
      { ok: false, error: "Too many requests. Please try again later." },
      429,
    );
  }

  let expiresAt: Date;
  try {
    ({ expiresAt } = await getPhoneAuth().sendOtp(
      body.phone,
      smsLoginPurpose(resolvedTenantId),
      "sms",
    ));
  } catch (err) {
    if (err instanceof Error && err.message === "SMS provider not configured") {
      return c.json<ApiResponse>(
        { ok: false, error: "SMS provider not configured" },
        503,
      );
    }
    throw err;
  }
  return c.json({ ok: true, expiresAt: expiresAt.toISOString() });
});

auth.post("/sms/verify", async (c) => {
  const rl = await checkAuthRateLimit(c, "sms-verify", 60_000, 10);
  if (!rl.allowed) {
    return c.json<ApiResponse>(
      { ok: false, error: "Too many requests. Please try again later." },
      429,
    );
  }

  const body = await safeJsonParse<{
    phone: string;
    code: string;
    tenantId?: string;
  }>(c);
  if (!isValidE164(body?.phone) || typeof body?.code !== "string") {
    return c.json<ApiResponse>(
      { ok: false, error: "phone and code are required" },
      400,
    );
  }

  const otpTenantId = authTenantHint(c, body.tenantId);
  const tenantHintError = await validateExplicitAuthTenantHint(
    otpTenantId,
    Boolean(c.req.header("X-Steward-Tenant") || body.tenantId),
  );
  if (tenantHintError) {
    return c.json<ApiResponse>({ ok: false, error: tenantHintError }, 404);
  }
  const methodResponse = await requireTenantLoginMethodAllowed(
    c,
    otpTenantId,
    "sms",
  );
  if (methodResponse) return methodResponse;
  const otpPurpose = smsLoginPurpose(otpTenantId);

  // Claim-first: atomically consume one attempt slot BEFORE verifying, so
  // concurrent requests cannot both pass a check-then-record boundary and
  // stretch the attempt budget (~2x under a race).
  const attemptClaim = await claimSmsVerifyAttempt(body.phone, otpPurpose);
  if (!attemptClaim) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error:
          "Too many invalid codes. Request a new code and try again later.",
      },
      429,
    );
  }

  let result: Awaited<ReturnType<PhoneAuth["verifyOtp"]>>;
  try {
    result = await getPhoneAuth().verifyOtp(body.phone, body.code, otpPurpose);
  } catch (error) {
    await releaseUnattemptedSmsVerifyClaim(attemptClaim, error);
    throw error;
  }
  if (!result.valid) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid or expired code" },
      401,
    );
  }
  await clearSmsVerifyFailures(body.phone, otpPurpose);

  const { user, isNew } = await findOrCreatePhoneUserWithStatus(body.phone);
  const tenantResult = await resolveAndValidateTenant(
    c,
    user.id,
    body.tenantId,
  );
  if (!tenantResult.ok) {
    return c.json<ApiResponse>(
      { ok: false, error: tenantResult.error },
      tenantResult.status,
    );
  }
  const authAbuseConfig = await getTenantAuthAbuseConfig(tenantResult.tenantId);
  const phonePolicyError = validatePhoneAbusePolicy(
    body.phone,
    authAbuseConfig,
  );
  if (phonePolicyError) {
    return c.json<ApiResponse>({ ok: false, error: phonePolicyError }, 400);
  }
  await ensurePersonalTenant(user.id, `Phone ${body.phone.slice(-4)}`);
  await ensureUserTenantLink(
    user.id,
    tenantResult.tenantId,
    tenantResult.isPersonal ? "owner" : "member",
  );
  if (isNew) {
    dispatchUserCreated(tenantResult.tenantId, user.id, "auth.sms", {
      hasPhone: true,
    });
  }

  return authExchangeJson(
    c,
    await buildAuthOrMfaResponse(
      user.id,
      tenantResult.tenantId,
      user.walletAddress ?? "",
      {
        userId: user.id,
        phoneHash: hashSha256Hex(body.phone),
        authMethod: "sms",
      },
      {
        id: user.id,
        email: "",
        walletAddress: user.walletAddress,
      },
      c,
    ),
  );
});

auth.post("/whatsapp/send", async (c) => {
  if (!isWhatsAppOtpEnabled()) {
    return c.json<ApiResponse>(
      { ok: false, error: "WhatsApp OTP is not configured" },
      503,
    );
  }

  const rl = await checkAuthRateLimit(c, "whatsapp-send", 60_000, 5);
  if (!rl.allowed) {
    return c.json<ApiResponse>(
      { ok: false, error: "Too many requests. Please try again later." },
      429,
    );
  }

  const body = await safeJsonParse<{
    phone: string;
    tenantId?: string;
    captchaToken?: string;
  }>(c);
  if (!isValidE164(body?.phone)) {
    return c.json<ApiResponse>(
      { ok: false, error: "phone must be E.164" },
      400,
    );
  }
  const headerTenantId = c.req.header("X-Steward-Tenant")?.trim();
  const bodyTenantId = body.tenantId?.trim();
  const resolvedTenantId = authTenantHint(c, body.tenantId);
  const tenantHintError = await validateExplicitAuthTenantHint(
    resolvedTenantId,
    Boolean(headerTenantId || bodyTenantId),
  );
  if (tenantHintError) {
    return c.json<ApiResponse>({ ok: false, error: tenantHintError }, 404);
  }
  const methodResponse = await requireTenantLoginMethodAllowed(
    c,
    resolvedTenantId,
    "whatsapp",
  );
  if (methodResponse) return methodResponse;
  const authAbuseConfig = await getTenantAuthAbuseConfig(resolvedTenantId);
  const phonePolicyError = validatePhoneAbusePolicy(
    body.phone,
    authAbuseConfig,
  );
  if (phonePolicyError) {
    return c.json<ApiResponse>({ ok: false, error: phonePolicyError }, 400);
  }
  const captcha = await verifyCaptchaToken(
    authAbuseConfig,
    "sms_otp",
    body.captchaToken,
    trustedClientIp(c),
  );
  if (!captcha.ok) {
    return c.json<ApiResponse>(
      { ok: false, error: captcha.error },
      captcha.status as 400 | 502 | 503,
    );
  }
  const phoneRl = await checkAuthRateLimit(
    c,
    "whatsapp-send-destination",
    10 * 60_000,
    5,
    body.phone,
  );
  if (!phoneRl.allowed) {
    return c.json<ApiResponse>(
      { ok: false, error: "Too many requests. Please try again later." },
      429,
    );
  }

  let expiresAt: Date;
  try {
    ({ expiresAt } = await getPhoneAuth().sendOtp(
      body.phone,
      whatsappLoginPurpose(resolvedTenantId),
      "whatsapp",
    ));
  } catch (err) {
    if (err instanceof Error && err.message === "SMS provider not configured") {
      return c.json<ApiResponse>(
        { ok: false, error: "WhatsApp OTP provider not configured" },
        503,
      );
    }
    throw err;
  }
  return c.json({ ok: true, expiresAt: expiresAt.toISOString() });
});

auth.post("/whatsapp/verify", async (c) => {
  if (!isWhatsAppOtpEnabled()) {
    return c.json<ApiResponse>(
      { ok: false, error: "WhatsApp OTP is not configured" },
      503,
    );
  }

  const rl = await checkAuthRateLimit(c, "whatsapp-verify", 60_000, 10);
  if (!rl.allowed) {
    return c.json<ApiResponse>(
      { ok: false, error: "Too many requests. Please try again later." },
      429,
    );
  }

  const body = await safeJsonParse<{
    phone: string;
    code: string;
    tenantId?: string;
  }>(c);
  if (!isValidE164(body?.phone) || typeof body?.code !== "string") {
    return c.json<ApiResponse>(
      { ok: false, error: "phone and code are required" },
      400,
    );
  }

  const otpTenantId = authTenantHint(c, body.tenantId);
  const tenantHintError = await validateExplicitAuthTenantHint(
    otpTenantId,
    Boolean(c.req.header("X-Steward-Tenant") || body.tenantId),
  );
  if (tenantHintError) {
    return c.json<ApiResponse>({ ok: false, error: tenantHintError }, 404);
  }
  const methodResponse = await requireTenantLoginMethodAllowed(
    c,
    otpTenantId,
    "whatsapp",
  );
  if (methodResponse) return methodResponse;
  const otpPurpose = whatsappLoginPurpose(otpTenantId);

  // Claim-first: atomically consume one attempt slot BEFORE verifying, so
  // concurrent requests cannot both pass a check-then-record boundary and
  // stretch the attempt budget (~2x under a race).
  const attemptClaim = await claimSmsVerifyAttempt(body.phone, otpPurpose);
  if (!attemptClaim) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error:
          "Too many invalid codes. Request a new code and try again later.",
      },
      429,
    );
  }

  let result: Awaited<ReturnType<PhoneAuth["verifyOtp"]>>;
  try {
    result = await getPhoneAuth().verifyOtp(body.phone, body.code, otpPurpose);
  } catch (error) {
    await releaseUnattemptedSmsVerifyClaim(attemptClaim, error);
    throw error;
  }
  if (!result.valid) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid or expired code" },
      401,
    );
  }
  await clearSmsVerifyFailures(body.phone, otpPurpose);

  const { user, isNew } = await findOrCreatePhoneUserWithStatus(body.phone);
  const tenantResult = await resolveAndValidateTenant(
    c,
    user.id,
    body.tenantId,
  );
  if (!tenantResult.ok) {
    return c.json<ApiResponse>(
      { ok: false, error: tenantResult.error },
      tenantResult.status,
    );
  }
  const authAbuseConfig = await getTenantAuthAbuseConfig(tenantResult.tenantId);
  const phonePolicyError = validatePhoneAbusePolicy(
    body.phone,
    authAbuseConfig,
  );
  if (phonePolicyError) {
    return c.json<ApiResponse>({ ok: false, error: phonePolicyError }, 400);
  }
  await ensurePersonalTenant(user.id, `Phone ${body.phone.slice(-4)}`);
  await ensureUserTenantLink(
    user.id,
    tenantResult.tenantId,
    tenantResult.isPersonal ? "owner" : "member",
  );
  if (isNew) {
    dispatchUserCreated(tenantResult.tenantId, user.id, "auth.whatsapp", {
      hasPhone: true,
      channel: "whatsapp",
    });
  }

  return authExchangeJson(
    c,
    await buildAuthOrMfaResponse(
      user.id,
      tenantResult.tenantId,
      user.walletAddress ?? "",
      {
        userId: user.id,
        phoneHash: hashSha256Hex(body.phone),
        authMethod: "whatsapp",
      },
      {
        id: user.id,
        email: "",
        walletAddress: user.walletAddress,
      },
      c,
    ),
  );
});

// ── SIWE ──────────────────────────────────────────────────────────────────────

/**
 * GET /nonce
 * Returns a fresh one-time nonce for SIWE/SIWS message construction, bound to
 * the expected domain, chainId, and optional tenant hint.
 */
auth.get("/nonce", async (c) => {
  const rl = await checkAuthRateLimit(c, "siwe-nonce", 60_000, 30);
  if (!rl.allowed) {
    return c.json<ApiResponse>(
      { ok: false, error: "Too many nonce requests. Please try again later." },
      429,
    );
  }
  const nonce = generateNonce();
  const tenantId =
    c.req.header("X-Steward-Tenant")?.trim() || c.req.query("tenantId")?.trim();
  const methodResponse = await requireTenantLoginMethodAllowed(
    c,
    tenantId,
    "siwe",
  );
  if (methodResponse) return methodResponse;
  const originHost = requiredOriginHostFromRequest(c);
  if (!originHost) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "SIWE nonce requests require an allowed Origin or Referer",
      },
      400,
    );
  }
  await setSiweNonce(nonce, {
    allowedDomains: getAllowedSiweDomains(),
    originHost,
    tenantId: tenantId || undefined,
  });
  return c.json({ nonce });
});

/**
 * POST /verify
 * Body: { message: string; signature: string }
 * Verifies SIWE, auto-creates the wallet-owned tenant, returns JWT.
 *
 * SIWE flow is wallet-address-centric: each unique address gets its own tenant.
 * If X-Steward-Tenant is provided, the JWT may target that tenant only when the
 * wallet user already has an existing membership. Supplying a tenant header does
 * not create a new membership.
 */
auth.post("/verify", async (c) => {
  const rl = await checkAuthRateLimit(c, "siwe-verify", 60_000, 10);
  if (!rl.allowed) {
    return c.json<ApiResponse>(
      { ok: false, error: "Too many requests. Please try again later." },
      429,
    );
  }
  const body = await safeJsonParse<{ message: string; signature: string }>(c);
  if (!body?.message || !body?.signature) {
    return c.json<ApiResponse>(
      { ok: false, error: "message and signature are required" },
      400,
    );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Lenient EIP-55 path: the `siwe` library strictly enforces EIP-55 checksum
  // on the address line and throws "invalid EIP-55 address" when wallets emit
  // a lower-case address (wagmi default for many adapters, including the most
  // common MetaMask path). The signature is over the EXACT bytes the user
  // signed, so we MUST verify against `body.message` literally, not against a
  // normalized copy. We split the work:
  //   1. Try parsing as-is. If that works, fall through to the canonical path.
  //   2. If parsing fails because of EIP-55 casing, build a normalized copy
  //      with the address line re-checksummed via viem, parse THAT to extract
  //      fields (nonce / domain / chainId / etc), and verify the signature
  //      against the ORIGINAL untouched message with viem's verifyMessage.
  // This preserves cryptographic integrity while accepting SDK clients that
  // forgot to checksum.
  // ──────────────────────────────────────────────────────────────────────────
  function normalizeAddressLine(msg: string): string {
    const lines = msg.split("\n");
    if (lines.length < 2) return msg;
    const candidate = lines[1].trim();
    if (!/^0x[a-fA-F0-9]{40}$/.test(candidate)) return msg;
    try {
      lines[1] = getAddress(candidate);
    } catch {
      // not a valid hex address; let siwe surface the right error
    }
    return lines.join("\n");
  }

  let siweMessage: SiweMessage;
  let usedNormalizedParse = false;
  try {
    siweMessage = new SiweMessage(body.message);
  } catch {
    // Retry with EIP-55 normalized address line.
    try {
      siweMessage = new SiweMessage(normalizeAddressLine(body.message));
      usedNormalizedParse = true;
    } catch {
      return c.json<ApiResponse>(
        { ok: false, error: "Invalid SIWE message format" },
        400,
      );
    }
  }

  const allowedDomains = getAllowedSiweDomains();
  if (!allowedDomains.includes(siweMessage.domain.toLowerCase())) {
    return c.json<ApiResponse>(
      { ok: false, error: "SIWE domain not allowed" },
      401,
    );
  }
  if (!siweMessage.issuedAt) {
    return c.json<ApiResponse>(
      { ok: false, error: "SIWE issuedAt is required" },
      401,
    );
  }
  const siwePolicyError = evaluateSiwePolicy(
    {
      domain: siweMessage.domain.toLowerCase(),
      address: siweMessage.address,
      statement: siweMessage.statement,
      uri: siweMessage.uri,
      version: siweMessage.version,
      chainId: siweMessage.chainId,
      nonce: siweMessage.nonce,
      issuedAt: siweMessage.issuedAt ?? "",
      expirationTime: siweMessage.expirationTime,
      notBefore: siweMessage.notBefore,
    },
    { allowedDomains },
  );
  if (siwePolicyError) {
    return c.json<ApiResponse>(
      { ok: false, error: `SIWE policy violation: ${siwePolicyError}` },
      401,
    );
  }

  const requestedTenantId = c.req.header("X-Steward-Tenant")?.trim();
  const methodResponse = await requireTenantLoginMethodAllowed(
    c,
    requestedTenantId,
    "siwe",
  );
  if (methodResponse) return methodResponse;
  const nonceError = validateConsumedSiweNonce(
    await consumeSiweNonce(siweMessage.nonce),
    {
      domain: siweMessage.domain,
      tenantId: requestedTenantId,
    },
  );
  if (nonceError) {
    return c.json<ApiResponse>({ ok: false, error: nonceError }, 401);
  }

  // Enforce SIWE temporal constraints before any signature verification path.
  // siwe.verify() bundles temporal + signature checks together, but that means
  // a signature-only fallback (EIP-1271) would silently bypass time bounds.
  // Check expiration / notBefore first so smart contract wallets cannot use
  // an expired or not-yet-valid message.
  const now = new Date();
  if (siweMessage.expirationTime) {
    const exp = new Date(siweMessage.expirationTime);
    if (Number.isNaN(exp.getTime())) {
      return c.json<ApiResponse>(
        { ok: false, error: "Invalid expirationTime" },
        401,
      );
    }
    if (now >= exp) {
      return c.json<ApiResponse>({ ok: false, error: "Message expired" }, 401);
    }
  }
  if (siweMessage.notBefore) {
    const nb = new Date(siweMessage.notBefore);
    if (Number.isNaN(nb.getTime())) {
      return c.json<ApiResponse>(
        { ok: false, error: "Invalid notBefore" },
        401,
      );
    }
    if (now < nb) {
      return c.json<ApiResponse>(
        { ok: false, error: "Message not yet valid" },
        401,
      );
    }
  }

  // Try EOA verification first (siwe uses ECDSA recover internally). If that
  // fails, fall back to EIP-1271 for smart contract wallets (Safes, Argent, etc).
  //
  // When we used the EIP-55 normalized parse path above, siwe.verify would
  // reconstruct the message FROM the normalized fields and recover against
  // that, which won't match a signature taken over the original lower-case
  // bytes. So in that path we use viem's verifyMessage which verifies the
  // signature against the raw `body.message` literally.
  let eoaVerified = false;
  if (usedNormalizedParse) {
    try {
      eoaVerified = await viemVerifyMessage({
        address: siweMessage.address as `0x${string}`,
        message: body.message,
        signature: body.signature as `0x${string}`,
      });
    } catch {
      eoaVerified = false;
    }
  } else {
    try {
      await siweMessage.verify({ signature: body.signature });
      eoaVerified = true;
    } catch {
      eoaVerified = false;
    }
  }

  if (!eoaVerified) {
    const eip1271Result = await verifyEip1271({
      address: siweMessage.address as `0x${string}`,
      message: body.message,
      signature: body.signature as `0x${string}`,
      chainId: siweMessage.chainId,
    });
    if (!eip1271Result.ok) {
      return c.json<ApiResponse>(
        { ok: false, error: "Invalid signature" },
        401,
      );
    }
  }

  const address = siweMessage.address.toLowerCase();
  let tenantResult: WalletTenantResult;
  try {
    tenantResult = await findOrCreateWalletTenant({
      ownerAddress: address,
      tenantId: ethereumWalletTenantId(address),
      tenantName: `${address.slice(0, 6)}...${address.slice(-4)}`,
    });
  } catch {
    return c.json<ApiResponse>(
      { ok: false, error: "Failed to create tenant" },
      500,
    );
  }

  const { user, isNew: isNewUser } = await findOrCreateWalletUserWithStatus(
    address,
    "ethereum",
  );
  let effectiveTenantId = tenantResult.tenant.id;
  if (requestedTenantId && requestedTenantId !== tenantResult.tenant.id) {
    const tenantResolution = await resolveAndValidateTenant(
      c,
      user.id,
      requestedTenantId,
    );
    if (!tenantResolution.ok) {
      return c.json<ApiResponse>(
        { ok: false, error: tenantResolution.error },
        tenantResolution.status,
      );
    }
    effectiveTenantId = tenantResolution.tenantId;
  }
  const effectiveMethodResponse = await requireTenantLoginMethodAllowed(
    c,
    effectiveTenantId,
    "siwe",
  );
  if (effectiveMethodResponse) return effectiveMethodResponse;

  const authAbuseConfig = await getTenantAuthAbuseConfig(effectiveTenantId);
  const walletPolicyError = validateWalletAbusePolicy(
    address,
    "ethereum",
    authAbuseConfig,
  );
  if (walletPolicyError) {
    return c.json<ApiResponse>({ ok: false, error: walletPolicyError }, 403);
  }

  await ensureUserTenantLink(
    user.id,
    effectiveTenantId,
    effectiveTenantId === tenantResult.tenant.id ? "owner" : "member",
  );
  if (isNewUser) {
    dispatchUserCreated(effectiveTenantId, user.id, "auth.siwe", {
      walletChain: "ethereum",
    });
  }

  const responseData = await buildAuthOrMfaResponse(
    user.id,
    effectiveTenantId,
    address,
    {
      userId: user.id,
      authMethod: "siwe",
    },
    {
      id: user.id,
      address,
      walletAddress: address,
      walletChain: "ethereum",
    },
  );

  await writeAuditEvent({
    tenantId: effectiveTenantId,
    actorType: "user",
    actorId: user.id,
    action: "auth.login",
    resourceType: "session",
    metadata: { method: "siwe", address, walletChain: "ethereum" },
    ipAddress: c.req.header("x-forwarded-for") ?? null,
    userAgent: c.req.header("user-agent") ?? null,
    requestId: c.get("requestId") ?? null,
  });

  responseData.userId = user.id;
  responseData.address = address;
  responseData.walletChain = "ethereum";
  responseData.tenant = {
    id: tenantResult.tenant.id,
    name: tenantResult.tenant.name,
  };

  if (
    !responseData.mfaRequired &&
    tenantResult.isNewTenant &&
    tenantResult.rawApiKey
  ) {
    (responseData.tenant as Record<string, unknown>).apiKey =
      tenantResult.rawApiKey;
  }

  return authExchangeJson(c, responseData);
});

auth.post("/verify/solana", async (c) => {
  const rl = await checkAuthRateLimit(c, "siws-verify", 60_000, 10);
  if (!rl.allowed) {
    return c.json<ApiResponse>(
      { ok: false, error: "Too many requests. Please try again later." },
      429,
    );
  }
  const body = await safeJsonParse<{
    message: string;
    signature: string;
    publicKey: string;
  }>(c);
  if (!body?.message || !body?.signature || !body?.publicKey) {
    return c.json<ApiResponse>(
      { ok: false, error: "message, signature, and publicKey are required" },
      400,
    );
  }

  const parsed = parseSiwsMessage(body.message);
  if (!parsed) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid SIWS message format" },
      400,
    );
  }

  if (parsed.publicKey !== body.publicKey) {
    return c.json<ApiResponse>(
      { ok: false, error: "publicKey does not match signed message" },
      401,
    );
  }

  const allowedDomains = getAllowedSiweDomains();
  if (!allowedDomains.includes(parsed.domain.toLowerCase())) {
    return c.json<ApiResponse>(
      { ok: false, error: "SIWS domain not allowed" },
      401,
    );
  }

  if (!isAllowedSiwsUri(parsed.uri, parsed.domain)) {
    return c.json<ApiResponse>(
      { ok: false, error: "SIWS uri must match the signed domain" },
      401,
    );
  }

  if (parsed.version !== "1") {
    return c.json<ApiResponse>(
      { ok: false, error: 'SIWS version must be "1"' },
      401,
    );
  }

  if (!isAllowedSiwsChainId(parsed.chainId)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "SIWS chainId must be one of: solana, mainnet, devnet",
      },
      401,
    );
  }

  // Honor the signed message's own temporal bounds, mirroring the EVM SIWE
  // path. Reject an already-expired or not-yet-valid message BEFORE consuming
  // the single-use nonce, so a stale message cannot burn a fresh nonce.
  const now = new Date();
  if (parsed.expirationTime) {
    const exp = new Date(parsed.expirationTime);
    if (Number.isNaN(exp.getTime())) {
      return c.json<ApiResponse>(
        { ok: false, error: "Invalid expirationTime" },
        401,
      );
    }
    if (now >= exp) {
      return c.json<ApiResponse>({ ok: false, error: "Message expired" }, 401);
    }
  }
  if (parsed.notBefore) {
    const nb = new Date(parsed.notBefore);
    if (Number.isNaN(nb.getTime())) {
      return c.json<ApiResponse>(
        { ok: false, error: "Invalid notBefore" },
        401,
      );
    }
    if (now < nb) {
      return c.json<ApiResponse>(
        { ok: false, error: "Message not yet valid" },
        401,
      );
    }
  }

  const requestedTenantId = c.req.header("X-Steward-Tenant")?.trim();
  const methodResponse = await requireTenantLoginMethodAllowed(
    c,
    requestedTenantId,
    "siws",
  );
  if (methodResponse) return methodResponse;
  const nonceError = validateConsumedSiweNonce(
    await consumeSiweNonce(parsed.nonce),
    {
      domain: parsed.domain,
      tenantId: requestedTenantId,
    },
  );
  if (nonceError) {
    return c.json<ApiResponse>({ ok: false, error: nonceError }, 401);
  }

  if (
    !verifySolanaMessageSignature(body.message, body.signature, body.publicKey)
  ) {
    return c.json<ApiResponse>({ ok: false, error: "Invalid signature" }, 401);
  }

  let tenantResult: WalletTenantResult;
  try {
    tenantResult = await findOrCreateWalletTenant({
      ownerAddress: `solana:${body.publicKey}`,
      tenantId: `solana:${body.publicKey}`,
      tenantName: `${body.publicKey.slice(0, 4)}...${body.publicKey.slice(-4)}`,
    });
  } catch {
    return c.json<ApiResponse>(
      { ok: false, error: "Failed to create tenant" },
      500,
    );
  }

  const { user, isNew: isNewUser } = await findOrCreateWalletUserWithStatus(
    body.publicKey,
    "solana",
  );
  let effectiveTenantId = tenantResult.tenant.id;
  if (requestedTenantId && requestedTenantId !== tenantResult.tenant.id) {
    const tenantResolution = await resolveAndValidateTenant(
      c,
      user.id,
      requestedTenantId,
    );
    if (!tenantResolution.ok) {
      return c.json<ApiResponse>(
        { ok: false, error: tenantResolution.error },
        tenantResolution.status,
      );
    }
    effectiveTenantId = tenantResolution.tenantId;
  }
  const effectiveMethodResponse = await requireTenantLoginMethodAllowed(
    c,
    effectiveTenantId,
    "siws",
  );
  if (effectiveMethodResponse) return effectiveMethodResponse;

  const authAbuseConfig = await getTenantAuthAbuseConfig(effectiveTenantId);
  const walletPolicyError = validateWalletAbusePolicy(
    body.publicKey,
    "solana",
    authAbuseConfig,
  );
  if (walletPolicyError) {
    return c.json<ApiResponse>({ ok: false, error: walletPolicyError }, 403);
  }

  await ensureUserTenantLink(
    user.id,
    effectiveTenantId,
    effectiveTenantId === tenantResult.tenant.id ? "owner" : "member",
  );
  if (isNewUser) {
    dispatchUserCreated(effectiveTenantId, user.id, "auth.siws", {
      walletChain: "solana",
    });
  }

  const responseData = await buildAuthOrMfaResponse(
    user.id,
    effectiveTenantId,
    body.publicKey,
    {
      userId: user.id,
      authMethod: "siws",
    },
    {
      id: user.id,
      address: body.publicKey,
      publicKey: body.publicKey,
      walletAddress: body.publicKey,
      walletChain: "solana",
    },
    c,
  );

  responseData.userId = user.id;
  responseData.address = body.publicKey;
  responseData.publicKey = body.publicKey;
  responseData.walletChain = "solana";
  responseData.tenant = {
    id: tenantResult.tenant.id,
    name: tenantResult.tenant.name,
  };

  if (
    !responseData.mfaRequired &&
    tenantResult.isNewTenant &&
    tenantResult.rawApiKey
  ) {
    (responseData.tenant as Record<string, unknown>).apiKey =
      tenantResult.rawApiKey;
  }

  return authExchangeJson(c, responseData);
});

/**
 * GET /session
 * Requires: Authorization: Bearer <token>
 */
auth.get("/session", async (c) => {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer "))
    return c.json({ authenticated: false });

  const token = authHeader.slice(7);
  const payload = await verifySessionToken(token);
  if (!payload) return c.json({ authenticated: false });

  return c.json({
    authenticated: true,
    address: payload.address,
    tenantId: payload.tenantId,
    ...(payload.email ? { email: payload.email } : {}),
    ...(payload.userId ? { userId: payload.userId } : {}),
  });
});

/**
 * POST /device/code
 * RFC 8628-style device authorization issuance.
 * Body: { tenantId, client_id?/clientId?/app_client_id?, scope? }
 */
auth.post("/device/code", async (c) => {
  const rl = await checkAuthRateLimit(c, "device-code", 60_000, 20);
  if (!rl.allowed) {
    return c.json<ApiResponse>(
      { ok: false, error: "Too many device code requests" },
      429,
    );
  }

  const body = await safeJsonParse<{
    tenantId?: string;
    client_id?: string;
    clientId?: string;
    app_client_id?: string;
    appClientId?: string;
    native_bundle_id?: string;
    nativeBundleId?: string;
    bundle_id?: string;
    bundleId?: string;
    native_package_name?: string;
    nativePackageName?: string;
    package_name?: string;
    packageName?: string;
    scope?: string;
  }>(c);
  const tenantId =
    body?.tenantId?.trim() || c.req.header("X-Steward-Tenant")?.trim();
  if (!tenantId) {
    return c.json<ApiResponse>(
      { ok: false, error: "tenantId is required" },
      400,
    );
  }

  const rawClientId =
    body?.client_id ??
    body?.clientId ??
    body?.app_client_id ??
    body?.appClientId;
  const validation = await assertDeviceAuthTenantAndClient(
    tenantId,
    rawClientId,
    readNativeClientAssertion(c, body),
  );
  if (!validation.ok) {
    return c.json<ApiResponse>(
      { ok: false, error: validation.error },
      validation.status,
    );
  }

  const deviceCode = randomBase64Url(32);
  let userCode = generateDeviceUserCode();
  for (
    let i = 0;
    i < 5 && (await getMfaBackend().get(deviceUserCodeKey(userCode)));
    i += 1
  ) {
    userCode = generateDeviceUserCode();
  }
  if (await getMfaBackend().get(deviceUserCodeKey(userCode))) {
    return c.json<ApiResponse>(
      { ok: false, error: "Unable to issue device code" },
      500,
    );
  }

  const issuedAt = Date.now();
  const record: DeviceAuthorizationRecord = {
    tenantId,
    ...(validation.clientId ? { clientId: validation.clientId } : {}),
    ...(validation.nativeBundleId
      ? { nativeBundleId: validation.nativeBundleId }
      : {}),
    ...(validation.nativePackageName
      ? { nativePackageName: validation.nativePackageName }
      : {}),
    userCode,
    ...(body?.scope ? { scope: body.scope.trim().slice(0, 512) } : {}),
    status: "pending",
    issuedAt,
    expiresAt: issuedAt + DEVICE_AUTH_TTL_MS,
    intervalSeconds: DEVICE_AUTH_DEFAULT_INTERVAL_SECONDS,
    slowDownCount: 0,
  };
  await saveDeviceAuthorizationRecord(deviceCode, record);

  const verificationUri = `${authCallbackBaseUrl(c)}/auth/device`;
  return c.json({
    ok: true,
    device_code: deviceCode,
    user_code: displayDeviceUserCode(userCode),
    verification_uri: verificationUri,
    verification_uri_complete: `${verificationUri}?user_code=${encodeURIComponent(
      displayDeviceUserCode(userCode),
    )}`,
    expires_in: Math.floor(DEVICE_AUTH_TTL_MS / 1000),
    interval: DEVICE_AUTH_DEFAULT_INTERVAL_SECONDS,
    tenantId,
    ...(validation.clientId ? { client_id: validation.clientId } : {}),
    ...(validation.nativeBundleId
      ? { native_bundle_id: validation.nativeBundleId }
      : {}),
    ...(validation.nativePackageName
      ? { native_package_name: validation.nativePackageName }
      : {}),
  });
});

/**
 * POST /device/verify
 * Authenticated approval/denial endpoint for the user code shown on a device.
 * Body: { user_code/userCode, action?: "approve" | "deny" }
 */
auth.post("/device/verify", async (c) => {
  const session = await requireSession(c);
  if (!session.ok) return session.response;

  const rl = await checkAuthRateLimit(
    c,
    "device-verify",
    60_000,
    10,
    `user:${session.payload.userId}`,
  );
  if (!rl.allowed) {
    return c.json<ApiResponse>(
      { ok: false, error: "Too many device verification attempts" },
      429,
    );
  }

  const body = await safeJsonParse<{
    user_code?: string;
    userCode?: string;
    action?: string;
  }>(c);
  const userCode = normalizeDeviceUserCode(body?.user_code ?? body?.userCode);
  if (!userCode) {
    return c.json<ApiResponse>(
      { ok: false, error: "Valid user_code is required" },
      400,
    );
  }
  const action = body?.action === "deny" ? "deny" : "approve";

  const found = await readDeviceAuthorizationRecordByUserCode(userCode);
  if (!found) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid or expired user code" },
      404,
    );
  }
  const { deviceCodeHash, record } = found;
  if (record.status !== "pending") {
    return c.json<ApiResponse>(
      { ok: false, error: "Device code has already been handled" },
      409,
    );
  }
  if (record.tenantId !== session.payload.tenantId) {
    return c.json<ApiResponse>(
      { ok: false, error: "Device code tenant mismatch" },
      403,
    );
  }
  if (!(await isActiveTenantMember(session.payload.userId, record.tenantId))) {
    return c.json<ApiResponse>(
      { ok: false, error: "User is not a member of this tenant" },
      403,
    );
  }

  const next: DeviceAuthorizationRecord =
    action === "deny"
      ? { ...record, status: "denied", deniedAt: Date.now() }
      : {
          ...record,
          status: "approved",
          approvedUserId: session.payload.userId,
          approvedAt: Date.now(),
        };
  await saveDeviceAuthorizationRecordByHash(deviceCodeHash, next);
  await writeAuditEvent({
    tenantId: record.tenantId,
    actorType: "user",
    actorId: session.payload.userId,
    action: action === "deny" ? "auth.device.deny" : "auth.device.approve",
    resourceType: "session",
    metadata: { clientId: record.clientId ?? null },
    ipAddress: c.req.header("x-forwarded-for") ?? null,
    userAgent: c.req.header("user-agent") ?? null,
    requestId: c.get("requestId") ?? null,
  });

  return c.json({ ok: true, status: next.status, tenantId: record.tenantId });
});

/**
 * POST /device/token
 * Body: { grant_type, device_code, client_id?/clientId? }
 */
auth.post("/device/token", async (c) => {
  const rl = await checkAuthRateLimit(c, "device-token", 60_000, 60);
  if (!rl.allowed) {
    return c.json(
      { ok: false, error: "slow_down", interval: rl.retryAfterSecs ?? 60 },
      429,
    );
  }

  const body = await safeJsonParse<{
    grant_type?: string;
    device_code?: string;
    deviceCode?: string;
    client_id?: string;
    clientId?: string;
    app_client_id?: string;
    appClientId?: string;
    native_bundle_id?: string;
    nativeBundleId?: string;
    bundle_id?: string;
    bundleId?: string;
    native_package_name?: string;
    nativePackageName?: string;
    package_name?: string;
    packageName?: string;
  }>(c);
  if (body?.grant_type !== "urn:ietf:params:oauth:grant-type:device_code") {
    return c.json({ ok: false, error: "unsupported_grant_type" }, 400);
  }
  const deviceCode = body.device_code ?? body.deviceCode;
  if (typeof deviceCode !== "string" || deviceCode.trim().length < 20) {
    return c.json({ ok: false, error: "invalid_request" }, 400);
  }

  const record = await readDeviceAuthorizationRecord(deviceCode);
  if (!record) {
    return c.json({ ok: false, error: "expired_token" }, 400);
  }
  const rawClientId =
    body.client_id ?? body.clientId ?? body.app_client_id ?? body.appClientId;
  const clientId = rawClientId
    ? normalizePublicClientId(rawClientId)
    : undefined;
  if (rawClientId && !clientId) {
    return c.json({ ok: false, error: "invalid_client" }, 401);
  }
  if (record.clientId && clientId !== record.clientId) {
    return c.json({ ok: false, error: "invalid_client" }, 401);
  }
  const nativeAssertion = readNativeClientAssertion(c, body);
  const nativeBundleId =
    nativeAssertion.rawBundleId === undefined
      ? undefined
      : normalizeNativeBundleId(nativeAssertion.rawBundleId);
  if (nativeAssertion.rawBundleId !== undefined && !nativeBundleId) {
    return c.json({ ok: false, error: "invalid_client" }, 401);
  }
  const nativePackageName =
    nativeAssertion.rawPackageName === undefined
      ? undefined
      : normalizeNativePackageName(nativeAssertion.rawPackageName);
  if (nativeAssertion.rawPackageName !== undefined && !nativePackageName) {
    return c.json({ ok: false, error: "invalid_client" }, 401);
  }
  if (nativeBundleId && !record.nativeBundleId) {
    return c.json({ ok: false, error: "invalid_client" }, 401);
  }
  if (nativePackageName && !record.nativePackageName) {
    return c.json({ ok: false, error: "invalid_client" }, 401);
  }
  if (record.nativeBundleId && nativeBundleId !== record.nativeBundleId) {
    return c.json({ ok: false, error: "invalid_client" }, 401);
  }
  if (
    record.nativePackageName &&
    nativePackageName !== record.nativePackageName
  ) {
    return c.json({ ok: false, error: "invalid_client" }, 401);
  }
  if (record.status === "denied") {
    await consumeDeviceAuthorizationRecord(deviceCode);
    return c.json({ ok: false, error: "access_denied" }, 400);
  }

  const now = Date.now();
  if (
    record.lastPollAt &&
    now - record.lastPollAt < record.intervalSeconds * 1000 &&
    record.slowDownCount < DEVICE_AUTH_MAX_SLOW_DOWNS
  ) {
    const next = {
      ...record,
      intervalSeconds: record.intervalSeconds + 5,
      lastPollAt: now,
      slowDownCount: record.slowDownCount + 1,
    };
    await saveDeviceAuthorizationRecord(deviceCode, next);
    return c.json(
      { ok: false, error: "slow_down", interval: next.intervalSeconds },
      400,
    );
  }

  if (record.status === "pending") {
    await saveDeviceAuthorizationRecord(deviceCode, {
      ...record,
      lastPollAt: now,
    });
    return c.json(
      {
        ok: false,
        error: "authorization_pending",
        interval: record.intervalSeconds,
      },
      400,
    );
  }

  const consumed = await consumeDeviceAuthorizationRecord(deviceCode);
  if (!consumed || consumed.status !== "approved" || !consumed.approvedUserId) {
    return c.json({ ok: false, error: "expired_token" }, 400);
  }
  const [user] = await getDb()
    .select({
      id: users.id,
      email: users.email,
      walletAddress: users.walletAddress,
      walletChain: users.walletChain,
    })
    .from(users)
    .where(eq(users.id, consumed.approvedUserId));
  if (!user || !(await isActiveTenantMember(user.id, consumed.tenantId))) {
    return c.json({ ok: false, error: "access_denied" }, 400);
  }

  const claims = {
    userId: user.id,
    ...(user.email ? { email: user.email } : {}),
    authMethod: "device_code",
    ...(consumed.clientId ? { appClientId: consumed.clientId } : {}),
  };
  const token = await createSessionToken(
    user.walletAddress ?? "",
    consumed.tenantId,
    claims,
  );
  const refreshToken = await createRefreshToken(
    user.id,
    consumed.tenantId,
    claims,
  );
  await writeAuthLoginAudit(c, consumed.tenantId, user.id, claims, {
    clientId: consumed.clientId ?? null,
    grantType: "device_code",
  });
  dispatchUserAuthenticated(consumed.tenantId, user.id, "device_code");

  return c.json({
    ok: true,
    token,
    access_token: token,
    token_type: "Bearer",
    refreshToken,
    refresh_token: refreshToken,
    expiresIn: ACCESS_TOKEN_EXPIRY_SECONDS,
    expires_in: ACCESS_TOKEN_EXPIRY_SECONDS,
    user: {
      id: user.id,
      email: user.email,
      walletAddress: user.walletAddress ?? undefined,
      walletChain: user.walletChain ?? undefined,
    },
  });
});

auth.get("/identity-token", async (c) => {
  const session = await requireSession(c);
  if (!session.ok) return session.response;

  try {
    const claims = await buildIdentityClaims(
      session.payload.userId,
      session.payload.tenantId,
    );
    const token = await createIdentityToken(claims);
    return c.json({
      ok: true,
      token,
      expiresIn: ACCESS_TOKEN_EXPIRY_SECONDS,
      claims,
      user: {
        id: claims.userId,
        email: claims.email,
        emailVerified: claims.emailVerified,
        name: claims.name,
        image: claims.image,
        walletAddress: claims.walletAddress,
        walletChain: claims.walletChain,
        customMetadata: claims.customMetadata,
      },
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Identity token generation failed";
    if (
      err instanceof IdentityJwtConfigurationError ||
      message === "Identity JWT private key is not configured"
    ) {
      return c.json<ApiResponse>(
        { ok: false, error: "Identity token unavailable" },
        503,
      );
    }
    const status = message === "Not a member of this tenant" ? 403 : 404;
    return c.json<ApiResponse>({ ok: false, error: message }, status);
  }
});

// ── TOTP MFA ─────────────────────────────────────────────────────────────────

auth.get("/mfa/totp/status", async (c) => {
  const session = await requireSession(c);
  if (!session.ok) return session.response;

  const enabled = Boolean(
    await readMfaJson<StoredTotp>(
      mfaKey("totp:enabled", session.payload.userId),
    ),
  );
  const pending = Boolean(
    await readMfaJson<{ secret: string }>(
      mfaKey("totp:pending", session.payload.userId),
    ),
  );
  return c.json({ ok: true, enabled, pending });
});

auth.post("/mfa/totp/enroll", async (c) => {
  const session = await requireSession(c);
  if (!session.ok) return session.response;

  const existing = await readMfaJson<StoredTotp>(
    mfaKey("totp:enabled", session.payload.userId),
  );
  if (existing) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error:
          "TOTP is already enabled; unenroll it before enrolling a new secret",
      },
      409,
    );
  }
  const stepUpResponse = await requireRecentFactorEnrollmentStepUp(c, session);
  if (stepUpResponse) return stepUpResponse;

  const secret = generateTotpSecret();
  const accountName =
    session.payload.email ||
    session.payload.address ||
    `user:${session.payload.userId}`;
  const issuer = process.env.TOTP_ISSUER || "elizaOS";

  await writeMfaJson(
    mfaKey("totp:pending", session.payload.userId),
    { secret, createdAt: new Date().toISOString() },
    TOTP_PENDING_TTL_MS,
  );

  return c.json({
    ok: true,
    secret,
    otpauthUri: buildOtpauthUri({ issuer, accountName, secret }),
    expiresAt: new Date(Date.now() + TOTP_PENDING_TTL_MS).toISOString(),
  });
});

auth.post("/mfa/totp/verify", async (c) => {
  const session = await requireSession(c);
  if (!session.ok) return session.response;

  const rl = await checkAuthRateLimit(c, "mfa-totp-verify", 60_000, 5);
  if (!rl.allowed) {
    return c.json<ApiResponse>(
      { ok: false, error: "Too many requests. Please try again later." },
      429,
      { "Retry-After": String(rl.retryAfterSecs ?? 60) },
    );
  }

  const body = await safeJsonParse<{ code: string }>(c);
  if (typeof body?.code !== "string" || !/^\d{6}$/.test(body.code)) {
    return c.json<ApiResponse>(
      { ok: false, error: "code must be 6 digits" },
      400,
    );
  }

  const pending = await readMfaJson<{ secret: string }>(
    mfaKey("totp:pending", session.payload.userId),
  );
  if (pending) {
    const existing = await readMfaJson<StoredTotp>(
      mfaKey("totp:enabled", session.payload.userId),
    );
    if (existing) {
      await getMfaBackend().delete(
        mfaKey("totp:pending", session.payload.userId),
      );
      return c.json<ApiResponse>(
        {
          ok: false,
          error:
            "TOTP is already enabled; replacement requires unenrollment first",
        },
        409,
      );
    }
    const stepUpResponse = await requireRecentFactorEnrollmentStepUp(
      c,
      session,
    );
    if (stepUpResponse) return stepUpResponse;

    const result = await verifyTotp(pending.secret, body.code, {
      stepSec: TOTP_STEP_SEC,
    });
    if (!result.valid || typeof result.drift !== "number") {
      return c.json<ApiResponse>({ ok: false, error: "Invalid code" }, 401);
    }

    const stored: StoredTotp = {
      secret: pending.secret,
      enabledAt: new Date().toISOString(),
      lastAcceptedStep: totpStepForDrift(result.drift),
    };
    await writeAuditEvent({
      tenantId: session.payload.tenantId,
      actorType: "user",
      actorId: session.payload.userId,
      action: "mfa.enable.authorized",
      resourceType: "user",
      resourceId: session.payload.userId,
      metadata: { factor: "totp" },
      ipAddress: c.req.header("x-forwarded-for") ?? null,
      userAgent: c.req.header("user-agent") ?? null,
      requestId: c.get("requestId") ?? null,
    });
    await writeMfaJson(mfaKey("totp:enabled", session.payload.userId), stored);
    await getMfaBackend().delete(
      mfaKey("totp:pending", session.payload.userId),
    );
    const recoveryCodes = await generateRecoveryCodes(
      recoveryCodeStore,
      session.payload.userId,
    );
    const { issuedBefore } = await revokeUserRefreshSessions(
      session.payload.userId,
    );
    await writeAuditEvent({
      tenantId: session.payload.tenantId,
      actorType: "user",
      actorId: session.payload.userId,
      action: "mfa.enabled",
      resourceType: "user",
      resourceId: session.payload.userId,
      metadata: {
        factor: "totp",
        recoveryCodesIssued: recoveryCodes.length,
        revokedRefreshTokens: true,
        revokedAccessTokensIssuedBefore: issuedBefore,
      },
      ipAddress: c.req.header("x-forwarded-for") ?? null,
      userAgent: c.req.header("user-agent") ?? null,
      requestId: c.get("requestId") ?? null,
    });
    dispatchWebhook(
      session.payload.tenantId,
      session.payload.userId,
      "mfa.enabled",
      {
        userId: session.payload.userId,
        factor: "totp",
        recoveryCodesIssued: recoveryCodes.length,
      },
    );
    dispatchWebhook(
      session.payload.tenantId,
      session.payload.userId,
      "wallet.recovery_setup",
      {
        userId: session.payload.userId,
        source: "totp_enable",
        recoveryCodesIssued: recoveryCodes.length,
      },
    );

    return c.json({ ok: true, enabled: true, recoveryCodes });
  }

  const verified = await verifyStoredTotp(session.payload.userId, body.code);
  if (
    !verified.valid ||
    !verified.stored ||
    typeof verified.acceptedStep !== "number"
  ) {
    return c.json<ApiResponse>({ ok: false, error: "Invalid code" }, 401);
  }
  await writeMfaJson(mfaKey("totp:enabled", session.payload.userId), {
    ...verified.stored,
    lastAcceptedStep: verified.acceptedStep,
  });

  return c.json({ ok: true, verified: true });
});

auth.post("/mfa/totp/complete", async (c) => {
  const rl = await checkAuthRateLimit(c, "mfa-totp-complete", 60_000, 5);
  if (!rl.allowed) {
    return c.json<ApiResponse>(
      { ok: false, error: "Too many requests. Please try again later." },
      429,
      { "Retry-After": String(rl.retryAfterSecs ?? 60) },
    );
  }

  const body = await safeJsonParse<{
    challengeId: string;
    code?: string;
    recoveryCode?: string;
  }>(c);
  if (!body?.challengeId || typeof body.challengeId !== "string") {
    return c.json<ApiResponse>(
      { ok: false, error: "challengeId is required" },
      400,
    );
  }
  const hasTotpCode = typeof body.code === "string" && body.code.length > 0;
  const hasRecoveryCode =
    typeof body.recoveryCode === "string" && body.recoveryCode.length > 0;
  if (hasTotpCode === hasRecoveryCode) {
    return c.json<ApiResponse>(
      { ok: false, error: "Provide exactly one of code or recoveryCode" },
      400,
    );
  }
  if (hasTotpCode && !/^\d{6}$/.test(body.code ?? "")) {
    return c.json<ApiResponse>(
      { ok: false, error: "code must be 6 digits" },
      400,
    );
  }

  const challengeKey = `auth:challenge:${body.challengeId}`;
  const rawChallenge = await getMfaBackend().get(challengeKey);
  const challenge = rawChallenge
    ? decryptMfaJson<PendingMfaAuth>(rawChallenge)
    : null;
  if (
    !challenge ||
    challenge.mfaType !== "totp" ||
    Date.now() > challenge.expiresAt
  ) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid or expired MFA challenge" },
      401,
    );
  }
  const attemptScope = `login:${challenge.userId}:${body.challengeId}`;
  if (
    (await getTotpVerifyFailedAttempts(attemptScope)) >=
    TOTP_VERIFY_MAX_FAILED_ATTEMPTS
  ) {
    await getMfaBackend().delete(challengeKey);
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Too many invalid codes. Start a new MFA challenge.",
      },
      429,
    );
  }

  let method: "totp" | "recovery_code" = "totp";
  if (hasRecoveryCode) {
    // SEC-146: consume the challenge BEFORE burning the recovery code. The
    // burn is irreversible, so a concurrent completion must lose on the
    // challenge consume — not forfeit a valid recovery code to a 401.
    // Consequence: an invalid recovery code now consumes the challenge too
    // (each guess needs a fresh MFA challenge), which is the fail-closed
    // direction — the per-challenge attempt counter no longer applies here.
    if ((await getMfaBackend().consume(challengeKey)) === null) {
      return c.json<ApiResponse>(
        { ok: false, error: "Invalid or expired MFA challenge" },
        401,
      );
    }
    const verified = await verifyRecoveryCode(
      recoveryCodeStore,
      challenge.userId,
      body.recoveryCode ?? "",
    );
    if (!verified.valid) {
      return c.json<ApiResponse>({ ok: false, error: "Invalid code" }, 401);
    }
    method = "recovery_code";
  } else {
    const verified = await verifyStoredTotp(challenge.userId, body.code ?? "");
    if (
      !verified.valid ||
      !verified.stored ||
      typeof verified.acceptedStep !== "number"
    ) {
      const failures = await recordTotpVerifyFailure(attemptScope);
      if (failures >= TOTP_VERIFY_MAX_FAILED_ATTEMPTS)
        await getMfaBackend().delete(challengeKey);
      return c.json<ApiResponse>({ ok: false, error: "Invalid code" }, 401);
    }
    if ((await getMfaBackend().consume(challengeKey)) === null) {
      return c.json<ApiResponse>(
        { ok: false, error: "Invalid or expired MFA challenge" },
        401,
      );
    }
    await writeMfaJson(mfaKey("totp:enabled", challenge.userId), {
      ...verified.stored,
      lastAcceptedStep: verified.acceptedStep,
    });
  }
  await clearTotpVerifyFailures(attemptScope);

  const mfaClaims = {
    mfaVerifiedAt: Date.now(),
    mfaMethod: method,
    factorEnrollmentVerifiedAt: Date.now(),
  };
  if (!(await isActiveTenantMember(challenge.userId, challenge.tenantId))) {
    return c.json<ApiResponse>(
      { ok: false, error: "User is not a member of this tenant" },
      403,
    );
  }
  await writeAuthLoginAudit(
    c,
    challenge.tenantId,
    challenge.userId,
    challenge.claims,
    {
      mfaMethod: method,
    },
  );
  const token = await createSessionToken(
    challenge.address,
    challenge.tenantId,
    {
      ...(challenge.claims ?? {}),
      userId: challenge.userId,
      ...mfaClaims,
    },
  );
  const refreshToken = await createRefreshToken(
    challenge.userId,
    challenge.tenantId,
    mfaClaims,
  );
  dispatchUserAuthenticated(
    challenge.tenantId,
    challenge.userId,
    typeof challenge.claims?.authMethod === "string"
      ? challenge.claims.authMethod
      : undefined,
  );
  return c.json(buildAuthResponse(token, refreshToken, challenge.user));
});

auth.post("/mfa/totp/step-up", async (c) => {
  const session = await requireSession(c);
  if (!session.ok) return session.response;

  const rl = await checkAuthRateLimit(c, "mfa-totp-step-up", 60_000, 5);
  if (!rl.allowed) {
    return c.json<ApiResponse>(
      { ok: false, error: "Too many requests. Please try again later." },
      429,
      { "Retry-After": String(rl.retryAfterSecs ?? 60) },
    );
  }

  const body = await safeJsonParse<{
    code?: string;
    recoveryCode?: string;
  }>(c);
  const hasTotpCode = typeof body?.code === "string" && body.code.length > 0;
  const hasRecoveryCode =
    typeof body?.recoveryCode === "string" && body.recoveryCode.length > 0;
  if (hasTotpCode === hasRecoveryCode) {
    return c.json<ApiResponse>(
      { ok: false, error: "Provide exactly one of code or recoveryCode" },
      400,
    );
  }
  if (hasTotpCode && !/^\d{6}$/.test(body?.code ?? "")) {
    return c.json<ApiResponse>(
      { ok: false, error: "code must be 6 digits" },
      400,
    );
  }

  const attemptScope = `step-up:${session.payload.userId}`;
  if (
    (await getTotpVerifyFailedAttempts(attemptScope)) >=
    TOTP_VERIFY_MAX_FAILED_ATTEMPTS
  ) {
    return c.json<ApiResponse>(
      { ok: false, error: "Too many invalid codes. Please try again later." },
      429,
    );
  }

  let method: "totp" | "recovery_code" = "totp";
  if (hasRecoveryCode) {
    const verified = await verifyRecoveryCode(
      recoveryCodeStore,
      session.payload.userId,
      body?.recoveryCode ?? "",
    );
    if (!verified.valid) {
      await recordTotpVerifyFailure(attemptScope);
      return c.json<ApiResponse>({ ok: false, error: "Invalid code" }, 401);
    }
    method = "recovery_code";
  } else {
    const verified = await verifyStoredTotp(
      session.payload.userId,
      body?.code ?? "",
    );
    if (
      !verified.valid ||
      !verified.stored ||
      typeof verified.acceptedStep !== "number"
    ) {
      await recordTotpVerifyFailure(attemptScope);
      return c.json<ApiResponse>({ ok: false, error: "Invalid code" }, 401);
    }
    await writeMfaJson(mfaKey("totp:enabled", session.payload.userId), {
      ...verified.stored,
      lastAcceptedStep: verified.acceptedStep,
    });
  }
  await clearTotpVerifyFailures(attemptScope);

  return currentSessionMfaStepUpResponse(c, session, method);
});

auth.get("/mfa/recovery-codes/status", async (c) => {
  const session = await requireSession(c);
  if (!session.ok) return session.response;

  const enabled = await hasTotpEnabled(session.payload.userId);
  const remaining = enabled
    ? await unusedRecoveryCodeCount(recoveryCodeStore, session.payload.userId)
    : 0;
  return c.json({ ok: true, enabled, remaining });
});

auth.post("/mfa/recovery-codes/regenerate", async (c) => {
  const session = await requireSession(c);
  if (!session.ok) return session.response;

  const rl = await checkAuthRateLimit(c, "mfa-recovery-regenerate", 60_000, 5);
  if (!rl.allowed) {
    return c.json<ApiResponse>(
      { ok: false, error: "Too many requests. Please try again later." },
      429,
      { "Retry-After": String(rl.retryAfterSecs ?? 60) },
    );
  }

  const body = await safeJsonParse<{ code: string }>(c);
  if (typeof body?.code !== "string" || !/^\d{6}$/.test(body.code)) {
    return c.json<ApiResponse>(
      { ok: false, error: "code must be 6 digits" },
      400,
    );
  }

  const attemptScope = `manage:${session.payload.userId}:recovery-regenerate`;
  if (
    (await getTotpVerifyFailedAttempts(attemptScope)) >=
    TOTP_VERIFY_MAX_FAILED_ATTEMPTS
  ) {
    return c.json<ApiResponse>(
      { ok: false, error: "Too many invalid codes. Please try again later." },
      429,
    );
  }
  const verified = await verifyStoredTotp(session.payload.userId, body.code);
  if (
    !verified.valid ||
    !verified.stored ||
    typeof verified.acceptedStep !== "number"
  ) {
    await recordTotpVerifyFailure(attemptScope);
    return c.json<ApiResponse>({ ok: false, error: "Invalid code" }, 401);
  }
  await clearTotpVerifyFailures(attemptScope);

  await writeAuditEvent({
    tenantId: session.payload.tenantId,
    actorType: "user",
    actorId: session.payload.userId,
    action: "mfa.recovery_codes.regenerate.authorized",
    resourceType: "user",
    resourceId: session.payload.userId,
    metadata: {},
    ipAddress: c.req.header("x-forwarded-for") ?? null,
    userAgent: c.req.header("user-agent") ?? null,
    requestId: c.get("requestId") ?? null,
  });
  await writeMfaJson(mfaKey("totp:enabled", session.payload.userId), {
    ...verified.stored,
    lastAcceptedStep: verified.acceptedStep,
  });
  const recoveryCodes = await generateRecoveryCodes(
    recoveryCodeStore,
    session.payload.userId,
  );
  await writeAuditEvent({
    tenantId: session.payload.tenantId,
    actorType: "user",
    actorId: session.payload.userId,
    action: "mfa.recovery_codes.regenerate",
    resourceType: "user",
    resourceId: session.payload.userId,
    metadata: { recoveryCodesIssued: recoveryCodes.length },
    ipAddress: c.req.header("x-forwarded-for") ?? null,
    userAgent: c.req.header("user-agent") ?? null,
    requestId: c.get("requestId") ?? null,
  });
  dispatchWebhook(
    session.payload.tenantId,
    session.payload.userId,
    "wallet.recovery_setup",
    {
      userId: session.payload.userId,
      source: "recovery_code_regenerate",
      recoveryCodesIssued: recoveryCodes.length,
    },
  );

  return c.json({ ok: true, recoveryCodes });
});

// ── SMS MFA ──────────────────────────────────────────────────────────────────

function maskedPhone(phone: string): string {
  return phone.length <= 4 ? "****" : `***${phone.slice(-4)}`;
}

auth.get("/mfa/sms/status", async (c) => {
  const session = await requireSession(c);
  if (!session.ok) return session.response;

  const enabled = await getSmsMfa(session.payload.userId);
  const pending = await readMfaJson<{ phone: string }>(
    mfaKey("sms:pending", session.payload.userId),
  );
  return c.json({
    ok: true,
    enabled: Boolean(enabled),
    pending: Boolean(pending),
    phone: enabled
      ? maskedPhone(enabled.phone)
      : pending
        ? maskedPhone(pending.phone)
        : undefined,
  });
});

auth.post("/mfa/sms/enroll", async (c) => {
  const session = await requireSession(c);
  if (!session.ok) return session.response;

  const rl = await checkAuthRateLimit(c, "mfa-sms-enroll", 60_000, 3);
  if (!rl.allowed) {
    return c.json<ApiResponse>(
      { ok: false, error: "Too many requests. Please try again later." },
      429,
      { "Retry-After": String(rl.retryAfterSecs ?? 60) },
    );
  }

  const body = await safeJsonParse<{ phone: string }>(c);
  if (!isValidE164(body?.phone)) {
    return c.json<ApiResponse>(
      { ok: false, error: "phone must be E.164" },
      400,
    );
  }

  const existing = await getSmsMfa(session.payload.userId);
  if (existing) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error:
          "SMS MFA is already enabled; unenroll it before enrolling a new phone",
      },
      409,
    );
  }
  const stepUpResponse = await requireRecentFactorEnrollmentStepUp(c, session);
  if (stepUpResponse) return stepUpResponse;

  let expiresAt: Date;
  try {
    ({ expiresAt } = await getPhoneAuth().sendOtp(
      body.phone,
      smsMfaEnrollPurpose(session.payload.userId),
      "sms",
    ));
  } catch (err) {
    if (err instanceof Error && err.message === "SMS provider not configured") {
      return c.json<ApiResponse>(
        { ok: false, error: "SMS provider not configured" },
        503,
      );
    }
    throw err;
  }

  await writeMfaJson(
    mfaKey("sms:pending", session.payload.userId),
    {
      phone: body.phone,
      purpose: smsMfaEnrollPurpose(session.payload.userId),
      createdAt: new Date().toISOString(),
    },
    TOTP_PENDING_TTL_MS,
  );
  return c.json({
    ok: true,
    phone: maskedPhone(body.phone),
    expiresAt: expiresAt.toISOString(),
  });
});

auth.post("/mfa/sms/verify", async (c) => {
  const session = await requireSession(c);
  if (!session.ok) return session.response;

  const rl = await checkAuthRateLimit(c, "mfa-sms-verify", 60_000, 5);
  if (!rl.allowed) {
    return c.json<ApiResponse>(
      { ok: false, error: "Too many requests. Please try again later." },
      429,
      { "Retry-After": String(rl.retryAfterSecs ?? 60) },
    );
  }

  const body = await safeJsonParse<{ code: string }>(c);
  if (typeof body?.code !== "string" || !/^\d{6}$/.test(body.code)) {
    return c.json<ApiResponse>(
      { ok: false, error: "code must be 6 digits" },
      400,
    );
  }

  const pending = await readMfaJson<{ phone: string; purpose?: string }>(
    mfaKey("sms:pending", session.payload.userId),
  );
  if (!pending) {
    return c.json<ApiResponse>(
      { ok: false, error: "No pending SMS MFA enrollment" },
      404,
    );
  }
  const stepUpResponse = await requireRecentFactorEnrollmentStepUp(c, session);
  if (stepUpResponse) return stepUpResponse;

  const pendingPurpose =
    pending.purpose ?? smsMfaEnrollPurpose(session.payload.userId);
  // Claim-first: atomically consume one attempt slot BEFORE verifying, so
  // concurrent requests cannot both pass a check-then-record boundary.
  const attemptClaim = await claimSmsVerifyAttempt(
    pending.phone,
    pendingPurpose,
  );
  if (!attemptClaim) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error:
          "Too many invalid SMS verification attempts. Request a new code.",
      },
      429,
    );
  }

  let verified: Awaited<ReturnType<PhoneAuth["verifyOtp"]>>;
  try {
    verified = await getPhoneAuth().verifyOtp(
      pending.phone,
      body.code,
      pendingPurpose,
    );
  } catch (error) {
    await releaseUnattemptedSmsVerifyClaim(attemptClaim, error);
    throw error;
  }
  if (!verified.valid) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid or expired code" },
      401,
    );
  }
  await clearSmsVerifyFailures(pending.phone, pendingPurpose);

  await writeAuditEvent({
    tenantId: session.payload.tenantId,
    actorType: "user",
    actorId: session.payload.userId,
    action: "mfa.enable.authorized",
    resourceType: "user",
    resourceId: session.payload.userId,
    metadata: { factor: "sms", phoneHash: hashSha256Hex(pending.phone) },
    ipAddress: c.req.header("x-forwarded-for") ?? null,
    userAgent: c.req.header("user-agent") ?? null,
    requestId: c.get("requestId") ?? null,
  });
  await writeMfaJson(mfaKey("sms:enabled", session.payload.userId), {
    phone: pending.phone,
    enabledAt: new Date().toISOString(),
  });
  await getMfaBackend().delete(mfaKey("sms:pending", session.payload.userId));
  const { issuedBefore } = await revokeUserRefreshSessions(
    session.payload.userId,
  );
  await writeAuditEvent({
    tenantId: session.payload.tenantId,
    actorType: "user",
    actorId: session.payload.userId,
    action: "mfa.enabled",
    resourceType: "user",
    resourceId: session.payload.userId,
    metadata: {
      factor: "sms",
      phoneHash: hashSha256Hex(pending.phone),
      revokedRefreshTokens: true,
      revokedAccessTokensIssuedBefore: issuedBefore,
    },
    ipAddress: c.req.header("x-forwarded-for") ?? null,
    userAgent: c.req.header("user-agent") ?? null,
    requestId: c.get("requestId") ?? null,
  });
  dispatchWebhook(
    session.payload.tenantId,
    session.payload.userId,
    "mfa.enabled",
    {
      userId: session.payload.userId,
      factor: "sms",
      phoneHash: hashSha256Hex(pending.phone),
    },
  );

  return c.json({ ok: true, enabled: true, phone: maskedPhone(pending.phone) });
});

auth.post("/mfa/sms/send", async (c) => {
  const session = await requireSession(c);
  if (!session.ok) return session.response;

  const rl = await checkAuthRateLimit(c, "mfa-sms-send", 60_000, 3);
  if (!rl.allowed) {
    return c.json<ApiResponse>(
      { ok: false, error: "Too many requests. Please try again later." },
      429,
      { "Retry-After": String(rl.retryAfterSecs ?? 60) },
    );
  }

  const smsMfa = await getSmsMfa(session.payload.userId);
  if (!smsMfa) {
    return c.json<ApiResponse>(
      { ok: false, error: "SMS MFA is not enabled" },
      404,
    );
  }

  let expiresAt: Date;
  try {
    ({ expiresAt } = await getPhoneAuth().sendOtp(
      smsMfa.phone,
      smsMfaManagePurpose(session.payload.userId),
      "sms",
    ));
  } catch (err) {
    if (err instanceof Error && err.message === "SMS provider not configured") {
      return c.json<ApiResponse>(
        { ok: false, error: "SMS provider not configured" },
        503,
      );
    }
    throw err;
  }

  return c.json({
    ok: true,
    phone: maskedPhone(smsMfa.phone),
    expiresAt: expiresAt.toISOString(),
  });
});

auth.post("/mfa/sms/complete", async (c) => {
  const rl = await checkAuthRateLimit(c, "mfa-sms-complete", 60_000, 5);
  if (!rl.allowed) {
    return c.json<ApiResponse>(
      { ok: false, error: "Too many requests. Please try again later." },
      429,
      { "Retry-After": String(rl.retryAfterSecs ?? 60) },
    );
  }

  const body = await safeJsonParse<{ challengeId: string; code: string }>(c);
  if (!body?.challengeId || typeof body.challengeId !== "string") {
    return c.json<ApiResponse>(
      { ok: false, error: "challengeId is required" },
      400,
    );
  }
  if (typeof body.code !== "string" || !/^\d{6}$/.test(body.code)) {
    return c.json<ApiResponse>(
      { ok: false, error: "code must be 6 digits" },
      400,
    );
  }

  const challengeKey = `auth:challenge:${body.challengeId}`;
  const rawChallenge = await getMfaBackend().get(challengeKey);
  const challenge = rawChallenge
    ? decryptMfaJson<PendingMfaAuth>(rawChallenge)
    : null;
  if (
    !challenge ||
    challenge.mfaType !== "sms" ||
    Date.now() > challenge.expiresAt
  ) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid or expired MFA challenge" },
      401,
    );
  }

  const smsMfa = await getSmsMfa(challenge.userId);
  if (!smsMfa) {
    return c.json<ApiResponse>(
      { ok: false, error: "SMS MFA is not enabled" },
      401,
    );
  }

  const otpPurpose = smsMfaChallengePurpose(body.challengeId);
  // Claim-first: atomically consume one attempt slot BEFORE verifying, so
  // concurrent requests cannot both pass a check-then-record boundary.
  const attemptClaim = await claimSmsVerifyAttempt(smsMfa.phone, otpPurpose);
  if (!attemptClaim) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error:
          "Too many invalid codes. Request a new code and try again later.",
      },
      429,
    );
  }

  let verified: Awaited<ReturnType<PhoneAuth["verifyOtp"]>>;
  try {
    verified = await getPhoneAuth().verifyOtp(
      smsMfa.phone,
      body.code,
      otpPurpose,
    );
  } catch (error) {
    await releaseUnattemptedSmsVerifyClaim(attemptClaim, error);
    throw error;
  }
  if (!verified.valid) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid or expired code" },
      401,
    );
  }
  if ((await getMfaBackend().consume(challengeKey)) === null) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid or expired MFA challenge" },
      401,
    );
  }
  await clearSmsVerifyFailures(smsMfa.phone, otpPurpose);

  const mfaClaims = {
    mfaVerifiedAt: Date.now(),
    mfaMethod: "sms",
    factorEnrollmentVerifiedAt: Date.now(),
  };
  if (!(await isActiveTenantMember(challenge.userId, challenge.tenantId))) {
    return c.json<ApiResponse>(
      { ok: false, error: "User is not a member of this tenant" },
      403,
    );
  }
  await writeAuthLoginAudit(
    c,
    challenge.tenantId,
    challenge.userId,
    challenge.claims,
    {
      mfaMethod: "sms",
    },
  );
  const token = await createSessionToken(
    challenge.address,
    challenge.tenantId,
    {
      ...(challenge.claims ?? {}),
      userId: challenge.userId,
      ...mfaClaims,
    },
  );
  const refreshToken = await createRefreshToken(
    challenge.userId,
    challenge.tenantId,
    mfaClaims,
  );
  dispatchUserAuthenticated(
    challenge.tenantId,
    challenge.userId,
    typeof challenge.claims?.authMethod === "string"
      ? challenge.claims.authMethod
      : undefined,
  );
  return c.json(buildAuthResponse(token, refreshToken, challenge.user));
});

auth.post("/mfa/sms/step-up", async (c) => {
  const session = await requireSession(c);
  if (!session.ok) return session.response;

  const rl = await checkAuthRateLimit(c, "mfa-sms-step-up", 60_000, 5);
  if (!rl.allowed) {
    return c.json<ApiResponse>(
      { ok: false, error: "Too many requests. Please try again later." },
      429,
      { "Retry-After": String(rl.retryAfterSecs ?? 60) },
    );
  }

  const body = await safeJsonParse<{ code: string }>(c);
  if (typeof body?.code !== "string" || !/^\d{6}$/.test(body.code)) {
    return c.json<ApiResponse>(
      { ok: false, error: "code must be 6 digits" },
      400,
    );
  }

  const smsMfa = await getSmsMfa(session.payload.userId);
  if (!smsMfa) {
    return c.json<ApiResponse>(
      { ok: false, error: "SMS MFA is not enabled" },
      404,
    );
  }

  const otpPurpose = smsMfaManagePurpose(session.payload.userId);
  // Claim-first: atomically consume one attempt slot BEFORE verifying, so
  // concurrent requests cannot both pass a check-then-record boundary.
  const attemptClaim = await claimSmsVerifyAttempt(smsMfa.phone, otpPurpose);
  if (!attemptClaim) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error:
          "Too many invalid SMS verification attempts. Request a new code.",
      },
      429,
    );
  }

  let verified: Awaited<ReturnType<PhoneAuth["verifyOtp"]>>;
  try {
    verified = await getPhoneAuth().verifyOtp(
      smsMfa.phone,
      body.code,
      otpPurpose,
    );
  } catch (error) {
    await releaseUnattemptedSmsVerifyClaim(attemptClaim, error);
    throw error;
  }
  if (!verified.valid) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid or expired code" },
      401,
    );
  }
  await clearSmsVerifyFailures(smsMfa.phone, otpPurpose);

  return currentSessionMfaStepUpResponse(c, session, "sms");
});

auth.post("/mfa/passkey/options", async (c) => {
  const session = await requireSession(c);
  if (!session.ok) return session.response;
  if (!session.payload.userId) {
    return c.json<ApiResponse>(
      { ok: false, error: "User session is required" },
      403,
    );
  }
  const rl = await checkAuthRateLimit(c, "mfa-passkey-options", 60_000, 10);
  if (!rl.allowed) {
    return c.json<ApiResponse>(
      { ok: false, error: "Too many requests. Please try again later." },
      429,
      { "Retry-After": String(rl.retryAfterSecs ?? 60) },
    );
  }

  const methodResponse = await requireTenantLoginMethodAllowed(
    c,
    session.payload.tenantId,
    "passkey",
  );
  if (methodResponse) return methodResponse;

  const passkeyAuth = getPasskeyAuth(c.req.header("origin"));
  const passkeys = await getDb()
    .select({
      credentialId: authenticators.credentialId,
      rpId: authenticators.rpId,
      transports: authenticators.transports,
    })
    .from(authenticators)
    .where(eq(authenticators.userId, session.payload.userId));
  // Explicitly cross-RP credentials cannot satisfy this RP's WebAuthn
  // challenge. Legacy NULL provenance stays eligible so the browser can
  // adjudicate it, and a successful assertion will safely backfill the RP.
  const eligiblePasskeys = passkeys.filter(
    (credential) =>
      credential.rpId === null || credential.rpId === passkeyAuth.rpID,
  );
  if (eligiblePasskeys.length === 0) {
    return c.json<ApiResponse>(
      { ok: false, error: "No passkey is registered for this user" },
      404,
    );
  }

  const options = await passkeyAuth.generateAuthenticationOptions(
    `mfa:${session.payload.userId}`,
    {
      allowCredentials: eligiblePasskeys.map((credential) => ({
        id: credential.credentialId,
        transports: (credential.transports ?? []) as never[],
      })),
    },
  );
  const challengeId = options.challenge;
  await getChallengeStore().set(
    passkeyMfaChallengeKey(session.payload.userId, challengeId),
    options.challenge,
  );

  return c.json({ ...options, challengeId });
});

const completePasskeyMfaHandler = async (c: Context) => {
  const session = await requireSession(c);
  if (!session.ok) return session.response;
  if (!session.payload.userId) {
    return c.json<ApiResponse>(
      { ok: false, error: "User session is required" },
      403,
    );
  }
  const rl = await checkAuthRateLimit(c, "mfa-passkey-verify", 60_000, 10);
  if (!rl.allowed) {
    return c.json<ApiResponse>(
      { ok: false, error: "Too many requests. Please try again later." },
      429,
      { "Retry-After": String(rl.retryAfterSecs ?? 60) },
    );
  }

  const body = await safeJsonParse<{
    challengeId: string;
    response: { id: string; [key: string]: unknown };
  }>(c);
  if (!body?.challengeId || typeof body.challengeId !== "string") {
    return c.json<ApiResponse>(
      { ok: false, error: "challengeId is required" },
      400,
    );
  }
  if (!body.response?.id || typeof body.response.id !== "string") {
    return c.json<ApiResponse>(
      { ok: false, error: "response.id is required" },
      400,
    );
  }

  const methodResponse = await requireTenantLoginMethodAllowed(
    c,
    session.payload.tenantId,
    "passkey",
  );
  if (methodResponse) return methodResponse;

  const [cred] = await getDb()
    .select()
    .from(authenticators)
    .where(
      and(
        eq(authenticators.userId, session.payload.userId),
        eq(authenticators.credentialId, body.response.id),
      ),
    );
  if (!cred) {
    return c.json<ApiResponse>(
      { ok: false, error: "Passkey MFA verification failed" },
      401,
    );
  }

  const passkeyAuth = getPasskeyAuth(c.req.header("origin"));
  if (cred.rpId !== null && cred.rpId !== passkeyAuth.rpID) {
    return c.json<ApiResponse>(
      { ok: false, error: "Passkey MFA verification failed" },
      401,
    );
  }

  let verification: Awaited<ReturnType<PasskeyAuth["verifyAuthentication"]>>;
  try {
    const challengeKey = passkeyMfaChallengeKey(
      session.payload.userId,
      body.challengeId,
    );
    const expectedChallenge = await getChallengeStore().get(challengeKey);
    if (!expectedChallenge) {
      return c.json<ApiResponse>(
        { ok: false, error: "Invalid or expired passkey challenge" },
        401,
      );
    }
    verification = await passkeyAuth.verifyAuthentication(
      body.response as unknown as Parameters<
        PasskeyAuth["verifyAuthentication"]
      >[0],
      expectedChallenge,
      cred.credentialPublicKey,
      cred.counter,
    );
    if ((await getChallengeStore().consume(challengeKey)) === null) {
      return c.json<ApiResponse>(
        { ok: false, error: "Invalid or expired passkey challenge" },
        401,
      );
    }
  } catch {
    return c.json<ApiResponse>(
      { ok: false, error: "Passkey MFA verification failed" },
      400,
    );
  }

  if (!verification.verified) {
    return c.json<ApiResponse>(
      { ok: false, error: "Passkey MFA verification failed" },
      401,
    );
  }
  if (
    !(await isActiveTenantMember(
      session.payload.userId,
      session.payload.tenantId,
    ))
  ) {
    return c.json<ApiResponse>(
      { ok: false, error: "User is not a member of this tenant" },
      403,
    );
  }

  // SEC-141: reject counter regression. Once an authenticator has reported a
  // non-zero counter, a response whose counter does not exceed the stored
  // value indicates a cloned/exported credential. Authenticators that never
  // increment (always 0) keep a stored counter of 0 and are unaffected.
  if (
    cred.counter > 0 &&
    verification.authenticationInfo.newCounter <= cred.counter
  ) {
    logger.warn(
      {
        details: [
          `[PasskeyAuth] MFA counter regression for credential ${cred.id}: stored ${cred.counter}, got ${verification.authenticationInfo.newCounter}`,
        ],
      },
      "[Login:auth] warn",
    );
    return c.json<ApiResponse>(
      { ok: false, error: "Passkey MFA verification failed" },
      401,
    );
  }

  const updatedMfaCounters = await getDb()
    .update(authenticators)
    .set({
      counter: verification.authenticationInfo.newCounter,
      // A verified assertion proves a legacy credential's RP provenance.
      ...(cred.rpId === null ? { rpId: passkeyAuth.rpID } : {}),
    })
    .where(
      and(
        eq(authenticators.id, cred.id),
        eq(authenticators.counter, cred.counter),
      ),
    )
    .returning({ id: authenticators.id });
  if (updatedMfaCounters.length !== 1) {
    logger.warn(
      {
        details: [
          `[PasskeyAuth] Concurrent MFA counter update rejected for credential ${cred.id}`,
        ],
      },
      "[Login:auth] warn",
    );
    return c.json<ApiResponse>(
      { ok: false, error: "Passkey MFA verification failed" },
      401,
    );
  }

  const [user] = await getDb()
    .select({
      id: users.id,
      email: users.email,
      walletAddress: users.walletAddress,
      walletChain: users.walletChain,
    })
    .from(users)
    .where(eq(users.id, session.payload.userId));

  const mfaClaims = {
    mfaVerifiedAt: Date.now(),
    mfaMethod: "passkey",
    factorEnrollmentVerifiedAt: Date.now(),
  };
  const token = await createSessionToken(
    session.payload.address,
    session.payload.tenantId,
    {
      userId: session.payload.userId,
      email: session.payload.email,
      authMethod: session.payload.authMethod,
      ...mfaClaims,
    },
  );
  const refreshToken = await createRefreshToken(
    session.payload.userId,
    session.payload.tenantId,
    mfaClaims,
  );

  return c.json(
    buildAuthResponse(token, refreshToken, {
      id: user?.id ?? session.payload.userId,
      email: user?.email ?? session.payload.email ?? "",
      walletAddress: user?.walletAddress ?? session.payload.address,
      walletChain: user?.walletChain ?? undefined,
    }),
  );
};

auth.post("/mfa/passkey/complete", completePasskeyMfaHandler);
auth.post("/mfa/passkey/verify", completePasskeyMfaHandler);

auth.post("/mfa/sms/unenroll", async (c) => {
  const session = await requireSession(c);
  if (!session.ok) return session.response;

  const rl = await checkAuthRateLimit(c, "mfa-sms-unenroll", 60_000, 5);
  if (!rl.allowed) {
    return c.json<ApiResponse>(
      { ok: false, error: "Too many requests. Please try again later." },
      429,
      { "Retry-After": String(rl.retryAfterSecs ?? 60) },
    );
  }

  const body = await safeJsonParse<{ code: string }>(c);
  if (typeof body?.code !== "string" || !/^\d{6}$/.test(body.code)) {
    return c.json<ApiResponse>(
      { ok: false, error: "code must be 6 digits" },
      400,
    );
  }

  const smsMfa = await getSmsMfa(session.payload.userId);
  if (!smsMfa) {
    return c.json<ApiResponse>(
      { ok: false, error: "SMS MFA is not enabled" },
      404,
    );
  }
  const otpPurpose = smsMfaManagePurpose(session.payload.userId);
  // Claim-first: atomically consume one attempt slot BEFORE verifying, so
  // concurrent requests cannot both pass a check-then-record boundary.
  const attemptClaim = await claimSmsVerifyAttempt(smsMfa.phone, otpPurpose);
  if (!attemptClaim) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error:
          "Too many invalid codes. Request a new code and try again later.",
      },
      429,
    );
  }
  let verified: Awaited<ReturnType<PhoneAuth["verifyOtp"]>>;
  try {
    verified = await getPhoneAuth().verifyOtp(
      smsMfa.phone,
      body.code,
      otpPurpose,
    );
  } catch (error) {
    await releaseUnattemptedSmsVerifyClaim(attemptClaim, error);
    throw error;
  }
  if (!verified.valid) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid or expired code" },
      401,
    );
  }
  await clearSmsVerifyFailures(smsMfa.phone, otpPurpose);

  await writeAuditEvent({
    tenantId: session.payload.tenantId,
    actorType: "user",
    actorId: session.payload.userId,
    action: "mfa.disable.authorized",
    resourceType: "user",
    resourceId: session.payload.userId,
    metadata: { factor: "sms", phoneHash: hashSha256Hex(smsMfa.phone) },
    ipAddress: c.req.header("x-forwarded-for") ?? null,
    userAgent: c.req.header("user-agent") ?? null,
    requestId: c.get("requestId") ?? null,
  });
  await getMfaBackend().delete(mfaKey("sms:enabled", session.payload.userId));
  const { issuedBefore } = await revokeUserRefreshSessions(
    session.payload.userId,
  );
  await writeAuditEvent({
    tenantId: session.payload.tenantId,
    actorType: "user",
    actorId: session.payload.userId,
    action: "mfa.disabled",
    resourceType: "user",
    resourceId: session.payload.userId,
    metadata: {
      factor: "sms",
      phoneHash: hashSha256Hex(smsMfa.phone),
      revokedRefreshTokens: true,
      revokedAccessTokensIssuedBefore: issuedBefore,
    },
    ipAddress: c.req.header("x-forwarded-for") ?? null,
    userAgent: c.req.header("user-agent") ?? null,
    requestId: c.get("requestId") ?? null,
  });
  dispatchWebhook(
    session.payload.tenantId,
    session.payload.userId,
    "mfa.disabled",
    {
      userId: session.payload.userId,
      factor: "sms",
      phoneHash: hashSha256Hex(smsMfa.phone),
    },
  );
  return c.json<ApiResponse>({ ok: true });
});

auth.post("/mfa/totp/unenroll", async (c) => {
  const session = await requireSession(c);
  if (!session.ok) return session.response;

  const rl = await checkAuthRateLimit(c, "mfa-totp-unenroll", 60_000, 5);
  if (!rl.allowed) {
    return c.json<ApiResponse>(
      { ok: false, error: "Too many requests. Please try again later." },
      429,
      { "Retry-After": String(rl.retryAfterSecs ?? 60) },
    );
  }

  const body = await safeJsonParse<{ code: string }>(c);
  if (typeof body?.code !== "string" || !/^\d{6}$/.test(body.code)) {
    return c.json<ApiResponse>(
      { ok: false, error: "code must be 6 digits" },
      400,
    );
  }

  const attemptScope = `manage:${session.payload.userId}:totp-unenroll`;
  if (
    (await getTotpVerifyFailedAttempts(attemptScope)) >=
    TOTP_VERIFY_MAX_FAILED_ATTEMPTS
  ) {
    return c.json<ApiResponse>(
      { ok: false, error: "Too many invalid codes. Please try again later." },
      429,
    );
  }
  const verified = await verifyStoredTotp(session.payload.userId, body.code);
  if (!verified.valid) {
    await recordTotpVerifyFailure(attemptScope);
    return c.json<ApiResponse>({ ok: false, error: "Invalid code" }, 401);
  }
  await clearTotpVerifyFailures(attemptScope);

  await writeAuditEvent({
    tenantId: session.payload.tenantId,
    actorType: "user",
    actorId: session.payload.userId,
    action: "mfa.disable.authorized",
    resourceType: "user",
    resourceId: session.payload.userId,
    metadata: { factor: "totp" },
    ipAddress: c.req.header("x-forwarded-for") ?? null,
    userAgent: c.req.header("user-agent") ?? null,
    requestId: c.get("requestId") ?? null,
  });
  await getMfaBackend().delete(mfaKey("totp:enabled", session.payload.userId));
  await getMfaBackend().delete(mfaKey("recovery", session.payload.userId));
  const { issuedBefore } = await revokeUserRefreshSessions(
    session.payload.userId,
  );
  await writeAuditEvent({
    tenantId: session.payload.tenantId,
    actorType: "user",
    actorId: session.payload.userId,
    action: "mfa.disabled",
    resourceType: "user",
    resourceId: session.payload.userId,
    metadata: {
      factor: "totp",
      revokedRefreshTokens: true,
      revokedAccessTokensIssuedBefore: issuedBefore,
    },
    ipAddress: c.req.header("x-forwarded-for") ?? null,
    userAgent: c.req.header("user-agent") ?? null,
    requestId: c.get("requestId") ?? null,
  });
  dispatchWebhook(
    session.payload.tenantId,
    session.payload.userId,
    "mfa.disabled",
    {
      userId: session.payload.userId,
      factor: "totp",
    },
  );
  return c.json<ApiResponse>({ ok: true });
});

/**
 * POST /logout
 * Revokes the presented access token's JTI until its natural expiry. If a
 * refresh token is supplied, it is revoked too so logout cannot be bypassed by
 * silently rotating the same session back in.
 */
auth.post("/logout", async (c) => {
  const body = await safeJsonParse<{ refreshToken?: string }>(c);
  const authHeader = c.req.header("Authorization");
  let auditCtx: { tenantId?: string; userId?: string; jti?: string } = {};
  if (authHeader?.startsWith("Bearer ")) {
    let payload: Awaited<ReturnType<typeof verifyToken>> | undefined;
    try {
      payload = await verifyToken(authHeader.slice(7));
    } catch (error) {
      // error-policy:J3 invalid or expired credentials are already unusable; storage failures still propagate.
      if (
        !(
          error instanceof joseErrors.JWTExpired ||
          error instanceof joseErrors.JWTInvalid ||
          error instanceof joseErrors.JWTClaimValidationFailed ||
          error instanceof joseErrors.JWSInvalid ||
          error instanceof joseErrors.JWSSignatureVerificationFailed
        )
      )
        throw error;
    }
    if (
      payload &&
      typeof payload.jti === "string" &&
      typeof payload.exp === "number"
    ) {
      if (payload.tenantId) {
        await writeAuditEvent({
          tenantId: payload.tenantId,
          actorType: "user",
          actorId: payload.userId ?? null,
          action: "auth.logout.authorized",
          resourceType: "session",
          resourceId: payload.jti,
          ipAddress: c.req.header("x-forwarded-for") ?? null,
          userAgent: c.req.header("user-agent") ?? null,
          requestId: c.get("requestId") ?? null,
        });
      }
      await revocationStore.revokeToken(payload.jti, payload.exp);
      auditCtx = {
        tenantId: payload.tenantId,
        userId: payload.userId,
        jti: payload.jti,
      };
    }
  }
  if (body?.refreshToken) {
    const tokenHash = hashToken(body.refreshToken);
    const subject = await resolveRefreshTokenSubject(tokenHash);
    const [revokedRefresh] = subject
      ? await withVerifiedAuthTenant(subject.tenantId, subject.userId, () =>
          getDb()
            .delete(refreshTokens)
            .where(eq(refreshTokens.tokenHash, tokenHash))
            .returning(),
        )
      : [];
    if (!auditCtx.tenantId && revokedRefresh) {
      auditCtx = {
        tenantId: revokedRefresh.tenantId,
        userId: revokedRefresh.userId,
        jti: auditCtx.jti,
      };
    }
  }
  if (auditCtx.tenantId) {
    await writeAuditEvent({
      tenantId: auditCtx.tenantId,
      actorType: "user",
      actorId: auditCtx.userId ?? null,
      action: "auth.logout",
      resourceType: "session",
      resourceId: auditCtx.jti ?? null,
      ipAddress: c.req.header("x-forwarded-for") ?? null,
      userAgent: c.req.header("user-agent") ?? null,
      requestId: c.get("requestId") ?? null,
    });
  }
  return c.json<ApiResponse>({ ok: true });
});

/**
 * POST /refresh
 * Body: { refreshToken: string }
 * Validates the refresh token, rotates it (one-time use), issues new access + refresh tokens.
 * Supports silent re-auth without user interaction when the access token nears expiry.
 */
auth.post("/refresh", async (c) => {
  const rl = await checkAuthRateLimit(c, "refresh", 60_000, 60);
  if (!rl.allowed) {
    return c.json<ApiResponse>(
      { ok: false, error: "Too many requests. Please try again later." },
      429,
    );
  }
  const body = await safeJsonParse<{
    refreshToken: string;
    tenantId?: unknown;
  }>(c);
  if (!body?.refreshToken) {
    return c.json<ApiResponse>(
      { ok: false, error: "refreshToken is required" },
      400,
    );
  }
  if (body.tenantId !== undefined && !isValidTenantId(body.tenantId)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid tenant id format" },
      400,
    );
  }

  const rotatedRefresh = await rotateRefreshTokenForUserSession(
    body.refreshToken,
    body.tenantId,
  );
  if (rotatedRefresh.status === "reused") {
    await withVerifiedAuthTenant(
      rotatedRefresh.tenantId,
      rotatedRefresh.userId,
      async () => {
        const { issuedBefore: revokedBefore } = await revokeUserRefreshSessions(
          rotatedRefresh.userId,
        );
        await writeAuditEvent({
          tenantId: rotatedRefresh.tenantId,
          actorType: "user",
          actorId: rotatedRefresh.userId,
          action: "auth.refresh.reuse_detected",
          resourceType: "session",
          metadata: {
            revokedRefreshTokens: true,
            revokedAccessTokensIssuedBefore: revokedBefore,
          },
          ipAddress: c.req.header("x-forwarded-for") ?? null,
          userAgent: c.req.header("user-agent") ?? null,
          requestId: c.get("requestId") ?? null,
        });
      },
    );
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Refresh token reuse detected. Please sign in again.",
      },
      401,
    );
  }
  if (rotatedRefresh.status === "invalid") {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid or expired refresh token" },
      401,
    );
  }
  if (rotatedRefresh.status === "deactivated") {
    return c.json<ApiResponse>(
      { ok: false, error: "User is deactivated" },
      403,
    );
  }
  if (rotatedRefresh.status === "not_member") {
    return c.json<ApiResponse>(
      { ok: false, error: "Not a member of this tenant" },
      403,
    );
  }
  if (rotatedRefresh.status === "revoked") {
    return c.json<ApiResponse>(
      { ok: false, error: "Session was revoked. Please sign in again." },
      401,
    );
  }

  const { record, newAccessToken, newRefreshToken } = rotatedRefresh;
  await withVerifiedAuthTenant(record.tenantId, record.userId, async () => {
    const db = getDb();
    try {
      await writeAuditEvent({
        tenantId: record.tenantId,
        actorType: "user",
        actorId: record.userId,
        action: "auth.refresh",
        resourceType: "session",
        metadata: { rotated: true },
        ipAddress: c.req.header("x-forwarded-for") ?? null,
        userAgent: c.req.header("user-agent") ?? null,
        requestId: c.get("requestId") ?? null,
      });
    } catch (err) {
      await db
        .delete(refreshTokens)
        .where(eq(refreshTokens.tokenHash, hashToken(newRefreshToken)));
      throw err;
    }
  });
  dispatchUserAuthenticated(record.tenantId, record.userId, "refresh");

  return c.json({
    ok: true,
    token: newAccessToken,
    refreshToken: newRefreshToken,
    expiresIn: ACCESS_TOKEN_EXPIRY_SECONDS,
  });
});

/**
 * POST /revoke
 * Body: { refreshToken: string }
 * Revokes a specific refresh token (sign out from this session/device).
 */
auth.post("/revoke", async (c) => {
  const body = await safeJsonParse<{ refreshToken: string }>(c);
  if (!body?.refreshToken) {
    return c.json<ApiResponse>(
      { ok: false, error: "refreshToken is required" },
      400,
    );
  }

  const tokenHash = hashToken(body.refreshToken);
  const subject = await resolveRefreshTokenSubject(tokenHash);
  if (!subject) return c.json<ApiResponse>({ ok: true });
  const revoked = await withVerifiedAuthTenant(
    subject.tenantId,
    subject.userId,
    () =>
      getDb().transaction(async (tx) => {
        const [candidate] = await tx
          .select()
          .from(refreshTokens)
          .where(eq(refreshTokens.tokenHash, tokenHash));
        const usedBeforeLock = candidate
          ? null
          : await readMfaJson<UsedRefreshTokenRecord>(
              `refresh:used:${tokenHash}`,
            );
        const userId = candidate?.userId ?? usedBeforeLock?.userId;
        if (userId) await lockUserSession(tx, userId);
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`refresh_token_${tokenHash}`}, 0))`,
        );
        // Re-read after both locks: rotation may have replaced the candidate while
        // this revoke waited for the user-wide session lock.
        const used = await readMfaJson<UsedRefreshTokenRecord>(
          `refresh:used:${tokenHash}`,
        );
        const hashes = [tokenHash];
        if (used?.successorTokenHash) hashes.push(used.successorTokenHash);
        return tx
          .delete(refreshTokens)
          .where(inArray(refreshTokens.tokenHash, hashes))
          .returning();
      }),
  );
  const existing = revoked[0];
  if (existing) {
    await writeAuditEvent({
      tenantId: existing.tenantId,
      actorType: "user",
      actorId: existing.userId,
      action: "auth.refresh_token.revoke.authorized",
      resourceType: "session",
      metadata: { tokenId: existing.id },
      ipAddress: c.req.header("x-forwarded-for") ?? null,
      userAgent: c.req.header("user-agent") ?? null,
      requestId: c.get("requestId") ?? null,
    });
  }
  for (const revokedToken of revoked) {
    await writeAuditEvent({
      tenantId: revokedToken.tenantId,
      actorType: "user",
      actorId: revokedToken.userId,
      action: "auth.refresh_token.revoke",
      resourceType: "session",
      metadata: { tokenId: revokedToken.id },
      ipAddress: c.req.header("x-forwarded-for") ?? null,
      userAgent: c.req.header("user-agent") ?? null,
      requestId: c.get("requestId") ?? null,
    });
  }

  return c.json<ApiResponse>({ ok: true });
});

/**
 * DELETE /sessions
 * Requires: Authorization: Bearer <access-token>
 * Revokes ALL refresh tokens for the authenticated user (sign out everywhere / all devices).
 */
auth.delete("/sessions", async (c) => {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json<ApiResponse>(
      { ok: false, error: "Authorization header required" },
      401,
    );
  }

  const payload = await verifySessionToken(authHeader.slice(7));
  if (!payload) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid or expired token" },
      401,
    );
  }

  if (!payload.userId) {
    return c.json<ApiResponse>(
      { ok: false, error: "Token does not contain userId" },
      400,
    );
  }

  await writeAuditEvent({
    tenantId: payload.tenantId,
    actorType: "user",
    actorId: payload.userId,
    action: "auth.sessions.revoke_all.authorized",
    resourceType: "session",
    resourceId: payload.jti ?? null,
    ipAddress: c.req.header("x-forwarded-for") ?? null,
    userAgent: c.req.header("user-agent") ?? null,
    requestId: c.get("requestId") ?? null,
  });
  const { revoked, issuedBefore } = await revokeUserRefreshSessions(
    payload.userId,
  );
  if (payload.jti && payload.exp) {
    await revocationStore.revokeToken(payload.jti, payload.exp);
  }

  await writeAuditEvent({
    tenantId: payload.tenantId,
    actorType: "user",
    actorId: payload.userId,
    action: "auth.sessions.revoke_all",
    resourceType: "session",
    metadata: {
      revokedRefreshTokenCount: revoked.length,
      revokedUserTokensIssuedBefore: issuedBefore,
    },
    ipAddress: c.req.header("x-forwarded-for") ?? null,
    userAgent: c.req.header("user-agent") ?? null,
    requestId: c.get("requestId") ?? null,
  });

  return c.json<ApiResponse>({ ok: true });
});

// ── Passkey registration ───────────────────────────────────────────────────────

/**
 * POST /passkey/register/options
 * Body: { email, emailGrant? }
 * Verified-email enrollment returns 409 when the account already has a
 * passkey for this RP, while authenticated sessions can add devices.
 */
auth.post("/passkey/register/options", async (c) => {
  // Pre-auth reachable via the email-grant path — rate limit like the other
  // pre-auth passkey endpoints.
  const optionsRl = await checkAuthRateLimit(
    c,
    "passkey-register-options",
    60_000,
    20,
  );
  if (!optionsRl.allowed) {
    return c.json<ApiResponse>(
      { ok: false, error: "Too many requests. Please try again later." },
      429,
    );
  }
  const body = await safeJsonParse<{
    email: string;
    authenticatorAttachment?: "platform" | "cross-platform";
    emailGrant?: string;
    tenantId?: string;
  }>(c);
  if (!body?.email) {
    return c.json<ApiResponse>({ ok: false, error: "email is required" }, 400);
  }
  const email = body.email.toLowerCase().trim();
  const db = getDb();
  const emailGrant =
    typeof body.emailGrant === "string" && body.emailGrant.length > 0
      ? body.emailGrant
      : null;
  const usingEmailGrant = emailGrant !== null;

  // Two ways in: an authenticated session (add-passkey for logged-in users)
  // or a verified-email grant from /email/otp/verify (Privy-style signup:
  // email → 6-digit code → Touch ID, no session required). The grant proves
  // ownership of the email, which is what blocks account pre-hijack.
  let userId: string;
  let userEmail: string | null;
  let ssoTenantId: string;

  if (emailGrant !== null) {
    const resolvedTenantId =
      c.req.header("X-Steward-Tenant")?.trim() ||
      body.tenantId?.trim() ||
      defaultAuthTenantId();
    const methodResponse = await requireTenantLoginMethodAllowed(
      c,
      resolvedTenantId,
      "passkey",
    );
    if (methodResponse) return methodResponse;
    // Peek (not consume): the grant is only burned at register/verify so a
    // cancelled Touch ID prompt doesn't cost the user their verification.
    const grantScope = await peekEmailGrant(
      emailGrant,
      email,
      resolvedTenantId,
    );
    const personalRequest = !(
      c.req.header("X-Steward-Tenant")?.trim() || body.tenantId?.trim()
    );
    if (!grantScope || (grantScope === "personal") !== personalRequest) {
      return c.json<ApiResponse>(
        { ok: false, error: "Invalid or expired email grant" },
        401,
      );
    }
    const { user } = await findOrCreateUserWithStatus(email);
    userId = user.id;
    userEmail = user.email;
    ssoTenantId = resolvedTenantId;
  } else {
    const session = await requireSession(c);
    if (!session.ok) return session.response;
    const sessionMethodResponse = await requireTenantLoginMethodAllowed(
      c,
      session.payload.tenantId,
      "passkey",
    );
    if (sessionMethodResponse) return sessionMethodResponse;

    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, session.payload.userId));
    if (!user || user.email?.toLowerCase().trim() !== email) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error:
            "Passkey registration requires an authenticated matching email session",
        },
        403,
      );
    }
    if (!user.emailVerified) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error: "Email must be verified before registering a passkey",
        },
        403,
      );
    }
    const stepUpResponse = await requireRecentFactorEnrollmentStepUp(
      c,
      session,
    );
    if (stepUpResponse) return stepUpResponse;
    userId = user.id;
    userEmail = user.email;
    ssoTenantId = session.payload.tenantId;
  }

  const ssoRequiredResponse = await requireNonSsoEmailLoginAllowed(
    c,
    ssoTenantId,
    email,
    "Passkey",
  );
  if (ssoRequiredResponse) return ssoRequiredResponse;

  const passkeyAuth = getPasskeyAuth(c.req.header("origin"));
  const existingCreds = await db
    .select({
      credentialId: authenticators.credentialId,
      rpId: authenticators.rpId,
    })
    .from(authenticators)
    .where(eq(authenticators.userId, userId));

  // The verified-email path exists to establish the account's first passkey.
  // Only provenance that explicitly matches the current RP can trigger the
  // recovery signal. A cross-RP credential must not block registration here,
  // and a legacy NULL row is ambiguous: keep it in excludeCredentials so the
  // browser can safely adjudicate whether it belongs to this RP.
  if (
    usingEmailGrant &&
    existingCreds.some((cred) => cred.rpId === passkeyAuth.rpID)
  ) {
    return c.json<ApiResponse & { code: "passkey_already_registered" }>(
      {
        ok: false,
        error:
          "A passkey already exists for this email. Sign in with it instead.",
        code: "passkey_already_registered",
      },
      409,
    );
  }

  const sameOrLegacyCreds = existingCreds.filter(
    (cred) => cred.rpId === null || cred.rpId === passkeyAuth.rpID,
  );

  const attachment =
    body.authenticatorAttachment === "platform" ||
    body.authenticatorAttachment === "cross-platform"
      ? body.authenticatorAttachment
      : undefined;

  const options = await passkeyAuth.generateRegistrationOptions(
    userId,
    userEmail ?? email,
    sameOrLegacyCreds.map((cred) => cred.credentialId),
    attachment ? { authenticatorAttachment: attachment } : undefined,
  );

  return c.json(options);
});

/**
 * POST /passkey/register/verify
 * Body: { email, response, tenantId? }
 * Headers: X-Steward-Tenant (optional)
 * Verifies registration, stores credential, provisions wallet, returns JWT.
 */
auth.post("/passkey/register/verify", async (c) => {
  // Distinct endpoint key from login's "passkey-verify" so registration and
  // login verification do not share one bucket.
  const rl = await checkAuthRateLimit(c, "passkey-register-verify", 60_000, 10);
  if (!rl.allowed) {
    return c.json<ApiResponse>(
      { ok: false, error: "Too many requests. Please try again later." },
      429,
    );
  }
  const body = await safeJsonParse<{
    email: string;
    response: Record<string, unknown>;
    tenantId?: string;
    emailGrant?: string;
  }>(c);

  if (!body?.email || !body?.response) {
    return c.json<ApiResponse>(
      { ok: false, error: "email and response are required" },
      400,
    );
  }

  const db = getDb();
  const email = body.email.toLowerCase().trim();

  // Session path (logged-in add-passkey) or verified-email-grant path
  // (Privy-style signup). The grant is CONSUMED here — single use — and
  // proves email ownership, so completing registration also marks the
  // email verified.
  let user: typeof users.$inferSelect | undefined;
  const usingGrant =
    typeof body.emailGrant === "string" && body.emailGrant.length > 0;

  let grantTenantId: string | null = null;
  let grantScope: EmailGrantScope | null = null;
  if (usingGrant) {
    // PEEK only here. The grant is consumed AFTER the WebAuthn ceremony
    // succeeds (below) so a failed/cancelled ceremony doesn't burn the
    // user's OTP verification, while consumption before any state change
    // keeps it strictly single-use.
    grantTenantId =
      c.req.header("X-Steward-Tenant")?.trim() ||
      body.tenantId?.trim() ||
      defaultAuthTenantId();
    grantScope = await peekEmailGrant(
      body.emailGrant as string,
      email,
      grantTenantId,
    );
    const personalRequest = !(
      c.req.header("X-Steward-Tenant")?.trim() || body.tenantId?.trim()
    );
    if (!grantScope || (grantScope === "personal") !== personalRequest) {
      return c.json<ApiResponse>(
        { ok: false, error: "Invalid or expired email grant" },
        401,
      );
    }
    const found = await findOrCreateUserWithStatus(email);
    user = found.user;
  } else {
    const session = await requireSession(c);
    if (!session.ok) return session.response;
    const [sessionUser] = await db
      .select()
      .from(users)
      .where(eq(users.id, session.payload.userId));
    if (
      !sessionUser ||
      sessionUser.email?.toLowerCase().trim() !== email ||
      !sessionUser.emailVerified
    ) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error:
            "Passkey registration requires an authenticated verified email session",
        },
        403,
      );
    }
    const stepUpResponse = await requireRecentFactorEnrollmentStepUp(
      c,
      session,
    );
    if (stepUpResponse) return stepUpResponse;
    user = sessionUser;
  }

  // Tenant resolution uses the SAME join_mode-gated path as oauth and
  // magic-link signup (resolveAndValidateTenant). The email grant proves
  // address ownership — it must NOT also become a side door around
  // invite-only tenants. Open-signup tenants set join_mode=open in config.
  const tenantResult = await resolveAndValidateTenant(
    c,
    user.id,
    body.tenantId,
  );
  if (!tenantResult.ok) {
    return c.json<ApiResponse>(
      { ok: false, error: tenantResult.error },
      tenantResult.status,
    );
  }
  const tenantId = tenantResult.tenantId;
  if (
    usingGrant &&
    tenantId !== grantTenantId &&
    !(
      grantScope === "personal" &&
      tenantResult.isPersonal &&
      tenantId === `personal-${user.id}`
    )
  ) {
    // Explicit tenant grants cannot become personal or cross-tenant authority.
    // Tenant-less grants can resolve only to this verified user's personal tenant.
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid or expired email grant" },
      401,
    );
  }
  const methodResponse = await requireTenantLoginMethodAllowed(
    c,
    tenantId,
    "passkey",
  );
  if (methodResponse) return methodResponse;
  const ssoRequiredResponse = await requireNonSsoEmailLoginAllowed(
    c,
    tenantId,
    email,
    "Passkey",
  );
  if (ssoRequiredResponse) return ssoRequiredResponse;

  const passkeyAuth = getPasskeyAuth(c.req.header("origin"));
  let verification: Awaited<ReturnType<PasskeyAuth["verifyRegistration"]>>;
  try {
    verification = await passkeyAuth.verifyRegistration(
      user.id,
      body.response as unknown as Parameters<
        PasskeyAuth["verifyRegistration"]
      >[1],
    );
  } catch (err) {
    logger.warn(
      {
        details: [
          "[PasskeyAuth] Registration failed",
          redactedThrownDiagnostics(err),
        ],
      },
      "[Login:auth] warn",
    );
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Registration verification failed",
      },
      400,
    );
  }

  if (!verification.verified || !verification.registrationInfo) {
    return c.json<ApiResponse>(
      { ok: false, error: "Registration verification failed" },
      400,
    );
  }

  if (usingGrant && grantTenantId) {
    // Ceremony succeeded — NOW consume the grant (atomic single-use gate
    // before any state is written). A replayed request with the same grant
    // fails here even if it carries a valid ceremony response.
    const consumed = await consumeEmailGrant(
      body.emailGrant as string,
      email,
      grantTenantId,
    );
    if (!consumed) {
      return c.json<ApiResponse>(
        { ok: false, error: "Invalid or expired email grant" },
        401,
      );
    }
    // The OTP proved address ownership.
    await db
      .update(users)
      .set({ emailVerified: true })
      .where(eq(users.id, user.id));
    user = { ...user, emailVerified: true };
  }

  const { credential, credentialDeviceType, credentialBackedUp } =
    verification.registrationInfo;

  await db
    .insert(authenticators)
    .values({
      userId: user.id,
      credentialId: credential.id,
      credentialPublicKey: uint8ArrayToBase64url(credential.publicKey),
      rpId: passkeyAuth.rpID,
      counter: credential.counter,
      credentialDeviceType,
      credentialBackedUp,
      transports:
        (body.response.response as { transports?: string[] } | undefined)
          ?.transports ?? [],
    })
    .onConflictDoNothing();

  // Provision the user's personal wallet (idempotent)
  let walletAddress = user.walletAddress;
  try {
    const w = await provisionWalletForUser(user.id, email);
    walletAddress = w.walletAddress;
  } catch (err) {
    logger.error(
      {
        details: [
          "[PasskeyAuth] Wallet provision failed on register",
          redactedThrownDiagnostics(err),
        ],
      },
      "[Login:auth] error",
    );
  }

  // Link the user only after tenant authorization has been validated.
  await ensureUserTenantLink(user.id, tenantId);

  return authExchangeJson(
    c,
    await buildAuthOrMfaResponse(
      user.id,
      tenantId,
      walletAddress ?? "",
      {
        userId: user.id,
        email,
        authMethod: "passkey",
      },
      {
        id: user.id,
        email,
        walletAddress,
      },
      c,
    ),
  );
});

// ── Passkey authentication ────────────────────────────────────────────────────

/**
 * POST /passkey/login/options
 * Body: { email }
 * Returns privacy-preserving discoverable-credential options. `allowCredentials`
 * is intentionally empty for every email so this pre-auth route cannot reveal
 * whether an account or passkey exists.
 */
auth.post("/passkey/login/options", async (c) => {
  const rl = await checkAuthRateLimit(c, "passkey-options", 60_000, 20);
  if (!rl.allowed) {
    return c.json<ApiResponse>(
      { ok: false, error: "Too many requests. Please try again later." },
      429,
      { "Retry-After": String(rl.retryAfterSecs ?? 60) },
    );
  }

  const body = await safeJsonParse<{ email: string; tenantId?: string }>(c);
  if (!body?.email) {
    return c.json<ApiResponse>({ ok: false, error: "email is required" }, 400);
  }
  const optionTenantId = authTenantHint(c, body.tenantId);
  const tenantHintError = await validateExplicitAuthTenantHint(
    optionTenantId,
    Boolean(c.req.header("X-Steward-Tenant") || body.tenantId),
  );
  if (tenantHintError) {
    return c.json<ApiResponse>({ ok: false, error: tenantHintError }, 404);
  }
  const methodResponse = await requireTenantLoginMethodAllowed(
    c,
    optionTenantId,
    "passkey",
  );
  if (methodResponse) return methodResponse;

  const email = body.email.toLowerCase().trim();
  const ssoRequiredResponse = await requireNonSsoEmailLoginAllowed(
    c,
    optionTenantId,
    email,
    "Passkey",
  );
  if (ssoRequiredResponse) return ssoRequiredResponse;

  const options = await getPasskeyAuth(
    c.req.header("origin"),
  ).generateAuthenticationOptions(email);
  const challengeId = options.challenge;
  await getChallengeStore().set(
    `passkey-login:${email}:${challengeId}`,
    options.challenge,
  );

  return c.json({ ...options, allowCredentials: [], challengeId });
});

/**
 * POST /passkey/login/verify
 * Body: { email, response, tenantId? }
 * Headers: X-Steward-Tenant (optional)
 * Verifies authentication, updates counter, links user to tenant, returns JWT.
 */
auth.post("/passkey/login/verify", async (c) => {
  const rl = await checkAuthRateLimit(c, "passkey-verify", 60_000, 10);
  if (!rl.allowed) {
    return c.json<ApiResponse>(
      { ok: false, error: "Too many requests. Please try again later." },
      429,
    );
  }
  const body = await safeJsonParse<{
    email: string;
    challengeId?: string;
    response: { id: string; [key: string]: unknown };
    tenantId?: string;
  }>(c);

  if (!body?.email || !body?.response) {
    return c.json<ApiResponse>(
      { ok: false, error: "email and response are required" },
      400,
    );
  }
  if (!body.challengeId || typeof body.challengeId !== "string") {
    return c.json<ApiResponse>(
      { ok: false, error: "challengeId is required" },
      400,
    );
  }

  const email = body.email.toLowerCase().trim();
  const db = getDb();

  const [user] = await db.select().from(users).where(eq(users.email, email));
  if (!user) {
    return c.json<ApiResponse>(
      { ok: false, error: "Passkey authentication failed" },
      401,
    );
  }

  // Resolve tenant policy before consuming the one-time WebAuthn challenge.
  const tenantResult = await resolveAndValidateTenant(
    c,
    user.id,
    body.tenantId,
  );
  if (!tenantResult.ok) {
    return c.json<ApiResponse>(
      { ok: false, error: tenantResult.error },
      tenantResult.status,
    );
  }
  const { tenantId } = tenantResult;
  const methodResponse = await requireTenantLoginMethodAllowed(
    c,
    tenantId,
    "passkey",
  );
  if (methodResponse) return methodResponse;
  const ssoRequiredResponse = await requireNonSsoEmailLoginAllowed(
    c,
    tenantId,
    email,
    "Passkey",
  );
  if (ssoRequiredResponse) return ssoRequiredResponse;

  const [cred] = await db
    .select()
    .from(authenticators)
    .where(
      and(
        eq(authenticators.userId, user.id),
        eq(authenticators.credentialId, body.response.id),
      ),
    );

  if (!cred) {
    return c.json<ApiResponse>(
      { ok: false, error: "Passkey authentication failed" },
      401,
    );
  }

  const passkeyAuth = getPasskeyAuth(c.req.header("origin"));
  if (cred.rpId !== null && cred.rpId !== passkeyAuth.rpID) {
    return c.json<ApiResponse>(
      { ok: false, error: "Passkey authentication failed" },
      401,
    );
  }

  let verification: Awaited<ReturnType<PasskeyAuth["verifyAuthentication"]>>;
  try {
    const expectedChallenge = await getChallengeStore().consume(
      `passkey-login:${email}:${body.challengeId}`,
    );
    if (!expectedChallenge) {
      return c.json<ApiResponse>(
        { ok: false, error: "Passkey authentication failed" },
        401,
      );
    }
    verification = await passkeyAuth.verifyAuthentication(
      body.response as unknown as Parameters<
        PasskeyAuth["verifyAuthentication"]
      >[0],
      expectedChallenge,
      cred.credentialPublicKey,
      cred.counter,
    );
  } catch (err) {
    logger.warn(
      {
        details: [
          "[PasskeyAuth] Authentication failed",
          redactedThrownDiagnostics(err),
        ],
      },
      "[Login:auth] warn",
    );
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Passkey authentication failed",
      },
      400,
    );
  }

  if (!verification.verified) {
    return c.json<ApiResponse>(
      { ok: false, error: "Passkey authentication failed" },
      401,
    );
  }

  // SEC-141: reject counter regression. Once an authenticator has reported a
  // non-zero counter, a response whose counter does not exceed the stored
  // value indicates a cloned/exported credential. Authenticators that never
  // increment (always 0) keep a stored counter of 0 and are unaffected.
  if (
    cred.counter > 0 &&
    verification.authenticationInfo.newCounter <= cred.counter
  ) {
    logger.warn(
      {
        details: [
          `[PasskeyAuth] Counter regression for credential ${cred.id}: stored ${cred.counter}, got ${verification.authenticationInfo.newCounter}`,
        ],
      },
      "[Login:auth] warn",
    );
    return c.json<ApiResponse>(
      { ok: false, error: "Passkey authentication failed" },
      401,
    );
  }

  // Update counter to prevent replay attacks
  const updatedCounters = await db
    .update(authenticators)
    .set({
      counter: verification.authenticationInfo.newCounter,
      // A verified assertion proves a legacy credential's RP provenance.
      ...(cred.rpId === null ? { rpId: passkeyAuth.rpID } : {}),
    })
    .where(
      and(
        eq(authenticators.id, cred.id),
        eq(authenticators.counter, cred.counter),
      ),
    )
    .returning({ id: authenticators.id });
  if (updatedCounters.length !== 1) {
    logger.warn(
      {
        details: [
          `[PasskeyAuth] Concurrent counter update rejected for credential ${cred.id}`,
        ],
      },
      "[Login:auth] warn",
    );
    return c.json<ApiResponse>(
      { ok: false, error: "Passkey authentication failed" },
      401,
    );
  }

  // Ensure wallet is provisioned (idempotent)
  let walletAddress = user.walletAddress;
  if (!walletAddress) {
    try {
      const w = await provisionWalletForUser(user.id, email);
      walletAddress = w.walletAddress;
    } catch (err) {
      logger.error(
        {
          details: [
            "[PasskeyAuth] Wallet provision failed on login",
            redactedThrownDiagnostics(err),
          ],
        },
        "[Login:auth] error",
      );
    }
  } else {
    // Wallet exists — still ensure personal tenant is in place
    await ensurePersonalTenant(user.id, email);
  }

  await ensureUserTenantLink(user.id, tenantId);

  return authExchangeJson(
    c,
    await buildAuthOrMfaResponse(
      user.id,
      tenantId,
      walletAddress ?? "",
      {
        userId: user.id,
        email,
        authMethod: "passkey",
      },
      {
        id: user.id,
        email,
        walletAddress,
      },
      c,
    ),
  );
});

// ── Email magic link ──────────────────────────────────────────────────────────

/**
 * POST /email/send
 * Body: { email, tenantId? }
 * Sends a magic link email, returns expiry time.
 */
auth.post("/email/send", async (c) => {
  // Tiered limits: the per-IP burst is generous (30/min) because one IP is
  // often an office/NAT/dev box full of legit users; the tight anti-abuse
  // backstop is email-send-destination (5 per 10min per address) below.
  const rl = await checkAuthRateLimit(c, "email-send", 60_000, 30);
  if (!rl.allowed) {
    return c.json<ApiResponse>(
      { ok: false, error: "Too many requests. Please try again later." },
      429,
    );
  }
  const body = await safeJsonParse<{
    email: string;
    tenantId?: string;
    captchaToken?: string;
  }>(c);
  if (!body?.email) {
    return c.json<ApiResponse>({ ok: false, error: "email is required" }, 400);
  }

  const email = body.email.toLowerCase().trim();
  const headerTenantId = c.req.header("X-Steward-Tenant")?.trim();
  const bodyTenantId = body.tenantId?.trim();
  const resolvedTenantId =
    headerTenantId || bodyTenantId || defaultAuthTenantId();
  const tenantHintError = await validateExplicitAuthTenantHint(
    resolvedTenantId,
    Boolean(headerTenantId || bodyTenantId),
  );
  if (tenantHintError) {
    return c.json<ApiResponse>({ ok: false, error: tenantHintError }, 404);
  }
  const methodResponse = await requireTenantLoginMethodAllowed(
    c,
    resolvedTenantId,
    "email",
  );
  if (methodResponse) return methodResponse;
  const ssoRequiredResponse = await requireNonSsoEmailLoginAllowed(
    c,
    resolvedTenantId,
    email,
    "Email",
  );
  if (ssoRequiredResponse) return ssoRequiredResponse;
  const authAbuseConfig = await getTenantAuthAbuseConfig(resolvedTenantId);
  const emailPolicyError = validateEmailAbusePolicy(email, authAbuseConfig);
  if (emailPolicyError) {
    return c.json<ApiResponse>({ ok: false, error: emailPolicyError }, 400);
  }
  const captcha = await verifyCaptchaToken(
    authAbuseConfig,
    "email_otp",
    body.captchaToken,
    trustedClientIp(c),
  );
  if (!captcha.ok) {
    return c.json<ApiResponse>(
      { ok: false, error: captcha.error },
      captcha.status as 400 | 502 | 503,
    );
  }
  const emailRl = await checkAuthRateLimit(
    c,
    "email-send-destination",
    10 * 60_000,
    5,
    email,
  );
  if (!emailRl.allowed) {
    return c.json<ApiResponse>(
      { ok: false, error: "Too many requests. Please try again later." },
      429,
    );
  }
  const emailAuth = await getEmailAuthForTenant(resolvedTenantId);
  let sent: Awaited<ReturnType<EmailAuth["sendMagicLink"]>>;
  try {
    sent = await emailAuth.sendMagicLink(email, { tenantId: resolvedTenantId });
  } catch (err) {
    // Fail closed: ok:true only after the provider accepted the message. On
    // typed delivery failures the challenge is not redeemable (never issued
    // for 503; invalidated by EmailAuth for 502).
    const deliveryFailure = emailDeliveryFailureResponse(c, err);
    if (deliveryFailure) return deliveryFailure;
    throw err;
  }
  const { expiresAt, challengeId, pollSecret } = sent;

  return c.json<
    ApiResponse<{ expiresAt: string; challengeId: string; pollSecret: string }>
  >({
    ok: true,
    data: { expiresAt: expiresAt.toISOString(), challengeId, pollSecret },
  });
});

/**
 * GET /callback/email
 * Query: ?token=<token>&email=<email>&tenantId=<tenantId?>
 * Mirrors POST /email/verify for browser clicks from magic link emails,
 * but redirects to the dashboard login page instead of returning JSON.
 */
auth.get("/callback/email", async (c) => {
  const rl = await checkAuthRateLimit(c, "email-callback", 60_000, 10);
  if (!rl.allowed) {
    return redirectEmailAuthFailure(c, "rate_limited");
  }

  const token = c.req.query("token");
  const emailParam = c.req.query("email");
  const tenantId = c.req.query("tenantId");

  if (!token || !emailParam) {
    return redirectEmailAuthFailure(c, "missing_params");
  }

  const email = emailParam.toLowerCase().trim();
  const resolvedTenantId = tenantId || defaultAuthTenantId();
  const methodResponse = await requireTenantLoginMethodAllowed(
    c,
    resolvedTenantId,
    "email",
  );
  if (methodResponse) return redirectEmailAuthFailure(c, "method_disabled");
  const ssoRequiredResponse = await requireNonSsoEmailLoginAllowed(
    c,
    resolvedTenantId,
    email,
    "Email",
  );
  if (ssoRequiredResponse) return redirectEmailAuthFailure(c, "sso_required");
  const tokenRl = await checkAuthRateLimit(
    c,
    "email-callback-token",
    10 * 60_000,
    5,
    emailMagicLinkVerifySubject(token, email, resolvedTenantId),
  );
  if (!tokenRl.allowed) {
    return redirectEmailAuthFailure(c, "rate_limited");
  }

  let result: Awaited<ReturnType<EmailAuth["verifyMagicLink"]>>;
  try {
    const emailAuth = await getEmailAuthForTenant(resolvedTenantId);
    result = await emailAuth.verifyMagicLink(token, email, resolvedTenantId);
  } catch {
    return redirectEmailAuthFailure(c, "invalid_link");
  }

  if (!result.valid) {
    return redirectEmailAuthFailure(c, "invalid_link");
  }
  if (result.tenantId && result.tenantId !== resolvedTenantId) {
    return redirectEmailAuthFailure(c, "tenant_mismatch");
  }

  if (result.email.toLowerCase().trim() !== email) {
    return redirectEmailAuthFailure(c, "email_mismatch");
  }

  const authResult = await completeEmailAuth(c, email, tenantId);
  if (!authResult.ok) {
    const reason =
      authResult.status === 404 ? "tenant_not_found" : "tenant_forbidden";
    return redirectEmailAuthFailure(c, reason);
  }

  if (authResult.response.mfaRequired) {
    return redirectEmailAuthFailure(c, "mfa_required");
  }

  const emailRedirectUrl = buildEmailAuthRedirectUrl();
  const nonceBytes = new Uint8Array(32);
  crypto.getRandomValues(nonceBytes);
  const exchangeCode = uint8ArrayToBase64url(nonceBytes);
  const issuedAt = Date.now();
  const expiresAt = issuedAt + OAUTH_CODE_TTL_MS;
  await getOAuthCodeStore().set(
    `oauth-code:${exchangeCode}`,
    JSON.stringify({
      token: authResult.response.token,
      refreshToken: authResult.response.refreshToken,
      redirectUri: emailRedirectUrl,
      tenantId: tenantId ?? null,
      expiresAt,
      expiresIn: ACCESS_TOKEN_EXPIRY_SECONDS,
    }),
  );
  const redirectUrl = new URL(emailRedirectUrl);
  setRedirectFragment(redirectUrl, {
    code: exchangeCode,
    auth: "email",
    tenantId,
  });
  return c.redirect(redirectUrl.toString(), 302);
});

/**
 * POST /email/verify
 * Body: { token, email, tenantId? }
 * Headers: X-Steward-Tenant (optional)
 * Verifies the magic link token, provisions user + wallet, links to tenant, returns JWT.
 */
auth.post("/email/verify", async (c) => {
  const rl = await checkAuthRateLimit(c, "email-verify", 60_000, 10);
  if (!rl.allowed) {
    return c.json<ApiResponse>(
      { ok: false, error: "Too many verification attempts. Try again later." },
      429,
    );
  }

  const body = await safeJsonParse<{
    token: string;
    email: string;
    tenantId?: string;
  }>(c);
  if (!body?.token || !body?.email) {
    return c.json<ApiResponse>(
      { ok: false, error: "token and email are required" },
      400,
    );
  }

  const email = body.email.toLowerCase().trim();
  const headerTenantId = c.req.header("X-Steward-Tenant")?.trim();
  const bodyTenantId = body.tenantId?.trim();
  const resolvedTenantId =
    headerTenantId || bodyTenantId || defaultAuthTenantId();
  const tenantHintError = await validateExplicitAuthTenantHint(
    resolvedTenantId,
    Boolean(headerTenantId || bodyTenantId),
  );
  if (tenantHintError) {
    return c.json<ApiResponse>({ ok: false, error: tenantHintError }, 404);
  }
  const methodResponse = await requireTenantLoginMethodAllowed(
    c,
    resolvedTenantId,
    "email",
  );
  if (methodResponse) return methodResponse;
  const ssoRequiredResponse = await requireNonSsoEmailLoginAllowed(
    c,
    resolvedTenantId,
    email,
    "Email",
  );
  if (ssoRequiredResponse) return ssoRequiredResponse;
  const tokenRl = await checkAuthRateLimit(
    c,
    "email-verify-token",
    10 * 60_000,
    5,
    emailMagicLinkVerifySubject(body.token, email, resolvedTenantId),
  );
  if (!tokenRl.allowed) {
    return c.json<ApiResponse>(
      { ok: false, error: "Too many verification attempts. Try again later." },
      429,
    );
  }
  const emailAuth = await getEmailAuthForTenant(resolvedTenantId);
  const result = await emailAuth.verifyMagicLink(
    body.token,
    email,
    resolvedTenantId,
  );

  if (!result.valid || result.email.toLowerCase().trim() !== email) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid or expired magic link" },
      401,
    );
  }
  if (result.tenantId && result.tenantId !== resolvedTenantId) {
    return c.json<ApiResponse>(
      { ok: false, error: "Magic link tenant mismatch" },
      401,
    );
  }

  const authResult = await completeEmailAuth(c, email, body.tenantId);
  if (!authResult.ok) {
    return c.json<ApiResponse>(
      { ok: false, error: authResult.error },
      authResult.status,
    );
  }

  return authExchangeJson(c, authResult.response);
});

auth.post("/email/code/verify", async (c) => {
  const rl = await checkAuthRateLimit(c, "email-code-verify", 60_000, 10);
  if (!rl.allowed) {
    return c.json<ApiResponse>(
      { ok: false, error: "Too many verification attempts. Try again later." },
      429,
    );
  }

  const body = await safeJsonParse<{
    email: string;
    code: string;
    tenantId?: string;
  }>(c);
  if (!body?.email || !body?.code) {
    return c.json<ApiResponse>(
      { ok: false, error: "email and code are required" },
      400,
    );
  }

  const email = body.email.toLowerCase().trim();
  const code = body.code.trim();
  const resolvedTenantId =
    c.req.header("X-Steward-Tenant") || body.tenantId || defaultAuthTenantId();
  const methodResponse = await requireTenantLoginMethodAllowed(
    c,
    resolvedTenantId,
    "email",
  );
  if (methodResponse) return methodResponse;
  const ssoRequiredResponse = await requireNonSsoEmailLoginAllowed(
    c,
    resolvedTenantId,
    email,
    "Email",
  );
  if (ssoRequiredResponse) return ssoRequiredResponse;
  const attemptRl = await checkAuthRateLimit(
    c,
    "email-code-verify-target",
    10 * 60_000,
    5,
    `${resolvedTenantId}:${hashSha256Hex(email)}`,
  );
  if (!attemptRl.allowed) {
    return c.json<ApiResponse>(
      { ok: false, error: "Too many verification attempts. Try again later." },
      429,
    );
  }

  const emailAuth = await getEmailAuthForTenant(resolvedTenantId);
  const result = await emailAuth.verifyEmailLoginCode(
    email,
    code,
    resolvedTenantId,
  );
  if (!result.valid) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error:
          result.reason === "locked"
            ? "Too many verification attempts. Try again later."
            : "Invalid or expired code",
      },
      result.reason === "locked" ? 429 : 401,
    );
  }

  const authResult = await completeEmailAuth(c, email, body.tenantId);
  if (!authResult.ok) {
    return c.json<ApiResponse>(
      { ok: false, error: authResult.error },
      authResult.status,
    );
  }
  return authExchangeJson(c, authResult.response);
});

auth.post("/email/status", async (c) => {
  const rl = await checkAuthRateLimit(c, "email-status", 60_000, 120);
  if (!rl.allowed) {
    return c.json<ApiResponse>(
      { ok: false, error: "Too many requests. Please try again later." },
      429,
    );
  }
  const body = await safeJsonParse<{
    challengeId: string;
    pollSecret: string;
    tenantId?: string;
  }>(c);
  if (!body?.challengeId || !body?.pollSecret) {
    return c.json<ApiResponse>(
      { ok: false, error: "challengeId and pollSecret are required" },
      400,
    );
  }
  const headerTenantId = c.req.header("X-Steward-Tenant")?.trim();
  const bodyTenantId = body.tenantId?.trim();
  const resolvedTenantId =
    headerTenantId || bodyTenantId || defaultAuthTenantId();
  const tenantHintError = await validateExplicitAuthTenantHint(
    resolvedTenantId,
    Boolean(headerTenantId || bodyTenantId),
  );
  if (tenantHintError) {
    return c.json<ApiResponse>({ ok: false, error: tenantHintError }, 404);
  }
  const emailAuth = await getEmailAuthForTenant(resolvedTenantId);
  const status = await emailAuth.getEmailLoginStatus(
    body.challengeId,
    body.pollSecret,
  );
  return c.json<ApiResponse<{ status: string; expiresAt?: string }>>({
    ok: true,
    data: {
      status: status.status,
      ...(status.status === "pending" ? { expiresAt: status.expiresAt } : {}),
    },
  });
});
// ── Email OTP (Privy-style verified signup) ───────────────────────────────
//
// POST /auth/email/otp/send    — email a 6-digit one-time code.
// POST /auth/email/otp/verify  — exchange a correct code for a short-lived
//                                single-use verified-email GRANT. The grant
//                                unlocks passkey registration for that exact
//                                {email, tenant} without a session, enabling
//                                email → code → Touch ID signup while keeping
//                                unverified registration (pre-hijack) closed.

auth.post("/email/otp/send", async (c) => {
  // Tiered limits: generous per-IP burst (30/min — shared NATs must not
  // block); email-otp-send-destination (5 per 10min per address) below is the
  // tight anti-abuse backstop.
  const rl = await checkAuthRateLimit(c, "email-otp-send", 60_000, 30);
  if (!rl.allowed) {
    return c.json<ApiResponse>(
      { ok: false, error: "Too many requests. Please try again later." },
      429,
    );
  }
  const body = await safeJsonParse<{
    email: string;
    tenantId?: string;
    captchaToken?: string;
  }>(c);
  if (!body?.email) {
    return c.json<ApiResponse>({ ok: false, error: "email is required" }, 400);
  }

  const email = body.email.toLowerCase().trim();
  const headerTenantId = c.req.header("X-Steward-Tenant")?.trim();
  const bodyTenantId = body.tenantId?.trim();
  const resolvedTenantId =
    headerTenantId || bodyTenantId || defaultAuthTenantId();
  const tenantHintError = await validateExplicitAuthTenantHint(
    resolvedTenantId,
    Boolean(headerTenantId || bodyTenantId),
  );
  if (tenantHintError) {
    return c.json<ApiResponse>({ ok: false, error: tenantHintError }, 404);
  }
  const methodResponse = await requireTenantLoginMethodAllowed(
    c,
    resolvedTenantId,
    "email",
  );
  if (methodResponse) return methodResponse;
  const ssoRequiredResponse = await requireNonSsoEmailLoginAllowed(
    c,
    resolvedTenantId,
    email,
    "Email",
  );
  if (ssoRequiredResponse) return ssoRequiredResponse;
  const authAbuseConfig = await getTenantAuthAbuseConfig(resolvedTenantId);
  const emailPolicyError = validateEmailAbusePolicy(email, authAbuseConfig);
  if (emailPolicyError) {
    return c.json<ApiResponse>({ ok: false, error: emailPolicyError }, 400);
  }
  const captcha = await verifyCaptchaToken(
    authAbuseConfig,
    "email_otp",
    body.captchaToken,
    trustedClientIp(c),
  );
  if (!captcha.ok) {
    return c.json<ApiResponse>(
      { ok: false, error: captcha.error },
      captcha.status as 400 | 502 | 503,
    );
  }
  const emailRl = await checkAuthRateLimit(
    c,
    "email-otp-send-destination",
    10 * 60_000,
    5,
    email,
  );
  if (!emailRl.allowed) {
    return c.json<ApiResponse>(
      { ok: false, error: "Too many requests. Please try again later." },
      429,
    );
  }
  const emailAuth = await getEmailAuthForTenant(resolvedTenantId);
  let expiresAt: Date;
  try {
    ({ expiresAt } = await emailAuth.sendOtp(email, {
      tenantId: resolvedTenantId,
    }));
  } catch (err) {
    // Fail closed: mirror /email/send — no ok:true without an acceptance
    // receipt, and EmailAuth keeps an unaccepted code non-redeemable.
    const deliveryFailure = emailDeliveryFailureResponse(c, err);
    if (deliveryFailure) return deliveryFailure;
    throw err;
  }

  return c.json<ApiResponse<{ expiresAt: string }>>({
    ok: true,
    data: { expiresAt: expiresAt.toISOString() },
  });
});

auth.post("/email/otp/verify", async (c) => {
  const rl = await checkAuthRateLimit(c, "email-otp-verify", 60_000, 10);
  if (!rl.allowed) {
    return c.json<ApiResponse>(
      { ok: false, error: "Too many verification attempts. Try again later." },
      429,
    );
  }

  const body = await safeJsonParse<{
    email: string;
    code: string;
    tenantId?: string;
  }>(c);
  if (!body?.email || !body?.code) {
    return c.json<ApiResponse>(
      { ok: false, error: "email and code are required" },
      400,
    );
  }

  const email = body.email.toLowerCase().trim();
  const code = body.code.trim();
  const resolvedTenantId =
    c.req.header("X-Steward-Tenant") || body.tenantId || defaultAuthTenantId();
  const methodResponse = await requireTenantLoginMethodAllowed(
    c,
    resolvedTenantId,
    "email",
  );
  if (methodResponse) return methodResponse;
  const ssoRequiredResponse = await requireNonSsoEmailLoginAllowed(
    c,
    resolvedTenantId,
    email,
    "Email",
  );
  if (ssoRequiredResponse) return ssoRequiredResponse;
  // Per-{email,tenant} attempt limiter so 6 digits can't be brute-forced:
  // 5 attempts / 10 min regardless of source IP.
  const attemptRl = await checkAuthRateLimit(
    c,
    "email-otp-verify-target",
    10 * 60_000,
    5,
    `${resolvedTenantId}:${email}`,
  );
  if (!attemptRl.allowed) {
    return c.json<ApiResponse>(
      { ok: false, error: "Too many verification attempts. Try again later." },
      429,
    );
  }

  const emailAuth = await getEmailAuthForTenant(resolvedTenantId);
  const valid = await emailAuth.verifyOtp(email, code, resolvedTenantId);
  if (!valid) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid or expired code" },
      401,
    );
  }

  const grant = await issueEmailGrant(
    email,
    resolvedTenantId,
    c.req.header("X-Steward-Tenant") || body.tenantId ? "tenant" : "personal",
  );
  return c.json<ApiResponse<{ emailGrant: string; expiresInSeconds: number }>>({
    ok: true,
    data: {
      emailGrant: grant,
      expiresInSeconds: Math.floor(EMAIL_GRANT_TTL_MS / 1000),
    },
  });
});

// ── Guest (ephemeral / anonymous) accounts — Privy parity ─────────────────────
//
// POST /auth/guest          — mint an ephemeral guest user + bounded session.
// POST /auth/guest/upgrade  — promote a guest into a full account by attaching a
//                             verified identity, preserving the user id + data.
//
// A guest carries strictly LIMITED authority: it is linked to its tenant with
// role "guest", which does NOT satisfy requireTenantLevel(), so guest sessions
// are denied from owner/admin/tenant-config/key-import/export actions. The
// guest session is hard-bounded by users.guest_expires_at (enforced server-side
// in verifySessionToken, fail-closed), independent of the access-token exp.

/** Guest session role — deliberately below "member" so requireTenantLevel() is false. */
const GUEST_TENANT_ROLE = "guest";
/** Default guest session lifetime (24h) and hard cap (7d). Bounded + revocable. */
const GUEST_DEFAULT_LIFETIME_MS = 24 * 3600 * 1000;
const GUEST_MAX_LIFETIME_MS = 7 * 24 * 3600 * 1000;

/** Parse a duration string like "30m", "24h", "7d" into ms. Null on parse error. */
function parseGuestLifetimeMs(input: unknown): number | null {
  if (input === undefined || input === null || input === "")
    return GUEST_DEFAULT_LIFETIME_MS;
  if (typeof input !== "string") return null;
  const m = /^(\d+)\s*(s|m|h|d)$/i.exec(input.trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = m[2].toLowerCase();
  const mult =
    unit === "s"
      ? 1000
      : unit === "m"
        ? 60_000
        : unit === "h"
          ? 3_600_000
          : 86_400_000;
  return Math.min(n * mult, GUEST_MAX_LIFETIME_MS);
}

/**
 * Resolve + gate the tenant a guest is created into. A guest may only be minted
 * into the default tenant or an explicitly "open"-join tenant; reserved/personal
 * tenants of other users and invite/closed tenants are refused (fail-closed).
 */
async function resolveGuestTenant(
  c: Context,
  bodyTenantId: unknown,
): Promise<TenantResolutionResult> {
  const headerTenant = c.req.header("X-Steward-Tenant")?.trim();
  const requested =
    headerTenant ||
    (typeof bodyTenantId === "string" ? bodyTenantId.trim() : "") ||
    defaultAuthTenantId();

  if (!isValidTenantId(requested)) {
    return { ok: false, status: 400, error: "Invalid tenant id format" };
  }
  if (isReservedTenantId(requested)) {
    return {
      ok: false,
      status: 403,
      error: "Guests cannot be created in a personal tenant",
    };
  }
  const subject = await authTenantSubject(requested);
  if (!subject) {
    return { ok: false, status: 404, error: `Tenant '${requested}' not found` };
  }
  if (requested === defaultAuthTenantId()) {
    return { ok: true, tenantId: requested, isPersonal: false };
  }
  if (subject.join_mode === "open") {
    return { ok: true, tenantId: requested, isPersonal: false };
  }
  return {
    ok: false,
    status: 403,
    error: `Tenant '${requested}' does not accept guest sign-in`,
  };
}

auth.post("/guest", async (c) => {
  const rl = await checkAuthRateLimit(c, "guest-create", 60_000, 20);
  if (!rl.allowed) {
    return c.json<ApiResponse>(
      { ok: false, error: "Too many guest sign-in attempts. Try again later." },
      429,
    );
  }

  const body = await safeJsonParse<{ tenantId?: unknown; expiresIn?: unknown }>(
    c,
  );
  // A malformed JSON body is tolerated (guest create takes no required fields),
  // but if a body was sent it must be an object so we don't silently ignore a
  // mistyped tenantId/expiresIn.
  if (body !== null && (typeof body !== "object" || Array.isArray(body))) {
    return c.json<ApiResponse>(
      { ok: false, error: "Request body must be a JSON object" },
      400,
    );
  }

  const lifetimeMs = parseGuestLifetimeMs(body?.expiresIn);
  if (lifetimeMs === null) {
    return c.json<ApiResponse>(
      { ok: false, error: "'expiresIn' must be like '30m', '24h', '7d'" },
      400,
    );
  }

  const tenantResult = await resolveGuestTenant(c, body?.tenantId);
  if (!tenantResult.ok) {
    return c.json<ApiResponse>(
      { ok: false, error: tenantResult.error },
      tenantResult.status,
    );
  }
  const tenantId = tenantResult.tenantId;

  const guestExpiresAt = new Date(Date.now() + lifetimeMs);
  const db = getDb();
  const [guest] = await db
    .insert(users)
    .values({
      email: null,
      emailVerified: false,
      isGuest: true,
      guestExpiresAt,
    })
    .returning();

  // Link the guest to the requesting tenant with the LIMITED "guest" role so the
  // session cannot satisfy requireTenantLevel(). onConflictDoNothing keeps this
  // idempotent against a racing insert on the (userId, tenantId) unique index.
  await withVerifiedAuthTenant(tenantId, guest.id, async () => {
    await getDb()
      .insert(userTenants)
      .values({ userId: guest.id, tenantId, role: GUEST_TENANT_ROLE })
      .onConflictDoNothing();
  });

  // Provision the guest's wallet under its own personal namespace so it has a
  // wallet/agents immediately AND those rows survive a later upgrade unchanged.
  let walletAddress = guest.walletAddress;
  try {
    const provisioned = await provisionWalletForUser(
      guest.id,
      `guest-${guest.id}`,
    );
    walletAddress = provisioned.walletAddress;
  } catch (err) {
    logger.error(
      {
        details: [
          "[GuestAuth] Wallet provision failed",
          redactedThrownDiagnostics(err),
        ],
      },
      "[Login:auth] error",
    );
  }

  const sessionClaims: Record<string, unknown> = {
    userId: guest.id,
    tenantId,
    guest: true,
    guestExpiresAt: guestExpiresAt.toISOString(),
    authMethod: "guest",
  };
  const token = await createSessionToken(
    walletAddress ?? "",
    tenantId,
    sessionClaims,
  );
  const refreshToken = await createRefreshToken(
    guest.id,
    tenantId,
    sessionClaims,
  );

  await writeAuditEvent({
    tenantId,
    actorType: "user",
    actorId: guest.id,
    action: "auth.guest.created",
    resourceType: "session",
    metadata: { method: "guest", guestExpiresAt: guestExpiresAt.toISOString() },
    ipAddress: c.req.header("x-forwarded-for") ?? null,
    userAgent: c.req.header("user-agent") ?? null,
    requestId: c.get("requestId") ?? null,
  });
  dispatchUserAuthenticated(tenantId, guest.id, "guest");

  return c.json(
    buildAuthResponse(token, refreshToken, {
      id: guest.id,
      isGuest: true,
      guestExpiresAt: guestExpiresAt.toISOString(),
      email: null,
      walletAddress: walletAddress ?? null,
      tenantId,
    }),
  );
});

auth.delete("/guest", async (c) => {
  const session = await requireSession(c);
  if (!session.ok) return session.response;
  const userId = session.payload.userId;
  const tenantId = session.payload.tenantId;
  const db = getDb();

  const [user] = await db
    .select({
      id: users.id,
      isGuest: users.isGuest,
      deactivatedAt: users.deactivatedAt,
    })
    .from(users)
    .where(eq(users.id, userId));
  if (!user)
    return c.json<ApiResponse>({ ok: false, error: "User not found" }, 404);
  if (!user.isGuest) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Only guest accounts can be deleted with this endpoint",
      },
      409,
    );
  }

  await writeAuditEvent({
    tenantId,
    actorType: "user",
    actorId: userId,
    action: "auth.guest.delete.authorized",
    resourceType: "user",
    resourceId: userId,
    metadata: { method: "guest" },
    ipAddress: c.req.header("x-forwarded-for") ?? null,
    userAgent: c.req.header("user-agent") ?? null,
    requestId: c.get("requestId") ?? null,
  });

  await db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({ deactivatedAt: new Date() })
      .where(eq(users.id, userId));
    await tx.delete(refreshTokens).where(eq(refreshTokens.userId, userId));
  });
  await revocationStore.revokeUserTokens(userId);

  await writeAuditEvent({
    tenantId,
    actorType: "user",
    actorId: userId,
    action: "auth.guest.deleted",
    resourceType: "user",
    resourceId: userId,
    metadata: {
      method: "guest",
      wasAlreadyDeactivated: user.deactivatedAt !== null,
    },
    ipAddress: c.req.header("x-forwarded-for") ?? null,
    userAgent: c.req.header("user-agent") ?? null,
    requestId: c.get("requestId") ?? null,
  });

  return c.json({
    ok: true,
    deleted: true,
    userId,
  });
});

auth.post("/guest/upgrade", async (c) => {
  const rl = await checkAuthRateLimit(c, "guest-upgrade", 60_000, 20);
  if (!rl.allowed) {
    return c.json<ApiResponse>(
      { ok: false, error: "Too many upgrade attempts. Try again later." },
      429,
    );
  }

  const session = await requireSession(c);
  if (!session.ok) return session.response;
  const userId = session.payload.userId;
  const tenantId = session.payload.tenantId;

  const body = await safeJsonParse<{
    method?: unknown;
    token?: unknown;
    email?: unknown;
  }>(c);
  // Only email-magic-link upgrade is supported here. The identity MUST be
  // verified (a valid, unexpired magic-link token) BEFORE any promotion — never
  // promote on an unverified/claimed email.
  if (!body || (body.method !== undefined && body.method !== "email")) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Unsupported upgrade method — only 'email' is supported",
      },
      400,
    );
  }
  const magicLinkToken =
    typeof body.token === "string" ? body.token.trim() : "";
  const rawEmail = typeof body.email === "string" ? body.email.trim() : "";
  if (!magicLinkToken || !rawEmail) {
    return c.json<ApiResponse>(
      { ok: false, error: "token and email are required to upgrade a guest" },
      400,
    );
  }
  const email = rawEmail.toLowerCase();

  const emailAuth = await getEmailAuthForTenant(tenantId);
  // The shared link+code challenge binds each token to {email, tenant}; pass
  // both so verification enforces the binding (token-only calls fail closed).
  const result = await emailAuth.verifyMagicLink(
    magicLinkToken,
    email,
    tenantId,
  );
  if (!result.valid || result.email.toLowerCase().trim() !== email) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid or expired magic link" },
      401,
    );
  }
  if (result.tenantId && result.tenantId !== tenantId) {
    return c.json<ApiResponse>(
      { ok: false, error: "Magic link tenant mismatch" },
      401,
    );
  }

  const db = getDb();
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  if (!user)
    return c.json<ApiResponse>({ ok: false, error: "User not found" }, 404);

  // Idempotent replay: re-running the upgrade with the SAME verified email on an
  // already-upgraded account is a no-op success (same id, no re-guesting).
  if (!user.isGuest) {
    if (user.email && user.email.toLowerCase() === email) {
      const token = await createSessionToken(
        user.walletAddress ?? "",
        tenantId,
        {
          userId,
          tenantId,
          authMethod: "email",
        },
      );
      const refreshToken = await createRefreshToken(userId, tenantId, {
        userId,
        tenantId,
        authMethod: "email",
      });
      return c.json(
        buildAuthResponse(token, refreshToken, {
          id: userId,
          isGuest: false,
          email: user.email,
          walletAddress: user.walletAddress ?? null,
          tenantId,
          alreadyUpgraded: true,
        }),
      );
    }
    return c.json<ApiResponse>(
      { ok: false, error: "Account is already a full user" },
      409,
    );
  }

  // Reject upgrading an expired guest (fail-closed): the session is dead.
  if (user.guestExpiresAt && user.guestExpiresAt.getTime() <= Date.now()) {
    return c.json<ApiResponse>(
      { ok: false, error: "Guest session has expired" },
      401,
    );
  }

  // The verified email must not already belong to a DIFFERENT user, or upgrading
  // would either collide on the unique email index or hijack another identity.
  const existingByEmail = await findUserByEmail(email);
  if (existingByEmail && existingByEmail.id !== userId) {
    return c.json<ApiResponse>(
      { ok: false, error: "Email is already associated with another account" },
      409,
    );
  }

  // Promote in a single transaction, preserving users.id and every owned row
  // (agents/wallets/memberships are keyed by user id and are untouched). The
  // membership role is raised guest -> member only; never auto-escalated to
  // admin/owner, and the tenant is never changed (no cross-tenant escalation).
  await db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({ email, emailVerified: true, isGuest: false, guestExpiresAt: null })
      .where(eq(users.id, userId));
    await tx
      .update(userTenants)
      .set({ role: "member" })
      .where(
        and(
          eq(userTenants.userId, userId),
          eq(userTenants.tenantId, tenantId),
          eq(userTenants.role, GUEST_TENANT_ROLE),
        ),
      );
  });

  const sessionClaims: Record<string, unknown> = {
    userId,
    tenantId,
    authMethod: "email",
  };
  const token = await createSessionToken(
    user.walletAddress ?? "",
    tenantId,
    sessionClaims,
  );
  const refreshToken = await createRefreshToken(
    userId,
    tenantId,
    sessionClaims,
  );

  await writeAuditEvent({
    tenantId,
    actorType: "user",
    actorId: userId,
    action: "auth.guest.upgraded",
    resourceType: "user",
    resourceId: userId,
    metadata: { method: "email" },
    ipAddress: c.req.header("x-forwarded-for") ?? null,
    userAgent: c.req.header("user-agent") ?? null,
    requestId: c.get("requestId") ?? null,
  });
  dispatchUserAuthenticated(tenantId, userId, "email");

  return c.json(
    buildAuthResponse(token, refreshToken, {
      id: userId,
      isGuest: false,
      email,
      walletAddress: user.walletAddress ?? null,
      tenantId,
    }),
  );
});

// ── OAuth authorization-code flow ─────────────────────────────────────────────

/**
 * GET /oauth/:provider/authorize
 * Query: ?redirect_uri=<url>&tenant_id=<id>
 *
 * Generates an OAuth authorization URL, stores the CSRF state in the challenge
 * store (keyed as `oauth:<state>`), then redirects the user to the provider.
 */
auth.get("/oauth/:provider/authorize", async (c) => {
  const providerName = c.req.param("provider");
  if (!isBuiltInProvider(providerName)) {
    return c.json<ApiResponse>(
      { ok: false, error: `Unknown provider: ${providerName}` },
      400,
    );
  }
  const rl = await checkAuthRateLimit(
    c,
    `oauth-authorize:${providerName}`,
    60_000,
    30,
  );
  if (!rl.allowed) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Too many OAuth authorization requests. Please try again later.",
      },
      429,
    );
  }

  const redirectUri = c.req.query("redirect_uri");
  const appState = c.req.query("state")?.trim() || undefined;
  // Accept both `tenant_id` (snake_case, canonical) and `tenantId` (camelCase)
  // so integrators sending either shape land on the right tenant. Whitespace
  // is trimmed defensively for the same reason we trim headers elsewhere.
  const tenantId =
    c.req.query("tenant_id")?.trim() ||
    c.req.query("tenantId")?.trim() ||
    undefined;
  const rawClientId = c.req.query("client_id") ?? c.req.query("clientId");
  const clientId = rawClientId
    ? normalizePublicClientId(rawClientId)
    : undefined;
  if (rawClientId && !clientId) {
    return c.json<ApiResponse>(
      { ok: false, error: "client_id is invalid" },
      400,
    );
  }
  const methodResponse = await requireTenantLoginMethodAllowed(
    c,
    tenantId,
    "oauth",
    providerName,
    clientId,
  );
  if (methodResponse) return methodResponse;

  // Default to the nonce-exchange flow so access and refresh tokens stay out
  // of browser history, server access logs, Referer headers, and copied URLs.
  // Token-in-query redirects are an explicitly unsafe compatibility mode.
  const responseType = c.req.query("response_type")?.trim() || "code";
  const codeChallenge = c.req.query("code_challenge")?.trim() || undefined;
  const codeChallengeMethod =
    c.req.query("code_challenge_method")?.trim() || "S256";

  if (!redirectUri) {
    return c.json<ApiResponse>(
      { ok: false, error: "redirect_uri is required" },
      400,
    );
  }

  if (
    responseType !== undefined &&
    responseType !== "code" &&
    responseType !== "token"
  ) {
    return c.json<ApiResponse>(
      { ok: false, error: "response_type must be 'code' or 'token'" },
      400,
    );
  }
  if (responseType === "token") {
    return c.json<ApiResponse>(
      {
        ok: false,
        error:
          "response_type=token is disabled because it exposes tokens in URLs; use response_type=code",
      },
      400,
    );
  }
  if (responseType === "code") {
    if (!codeChallenge) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error: "code_challenge is required for response_type=code",
        },
        400,
      );
    }
    if (codeChallengeMethod !== "S256") {
      return c.json<ApiResponse>(
        { ok: false, error: "code_challenge_method must be 'S256'" },
        400,
      );
    }
  }

  let oauthClient: OAuthClient;
  try {
    oauthClient = new OAuthClient(getProviderConfig(providerName));
  } catch (err) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: err instanceof Error ? err.message : "Provider not configured",
      },
      503,
    );
  }

  try {
    await assertAllowedOAuthRedirectUri(redirectUri, tenantId, clientId);
  } catch (err) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: err instanceof Error ? err.message : "Invalid redirect_uri",
      },
      400,
    );
  }

  // Generate a cryptographically random state value
  const stateBytes = new Uint8Array(16);
  crypto.getRandomValues(stateBytes);
  const state = Array.from(stateBytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  const callbackUrl = buildOAuthCallbackUrl(c, providerName);
  const oidcNonce = providerName === "apple" ? randomBase64Url(24) : undefined;
  const generatedAuth = oauthClient.generateAuthUrl(state, callbackUrl);
  let authUrl = generatedAuth.url;
  const codeVerifier = generatedAuth.codeVerifier;
  if (oidcNonce) {
    const url = new URL(authUrl);
    url.searchParams.set("nonce", oidcNonce);
    authUrl = url.toString();
  }

  // Store state metadata in the challenge store — include PKCE verifier when present
  const statePayload = JSON.stringify({
    provider: providerName,
    tenantId,
    clientId,
    redirectUri,
    responseType,
    appState,
    codeChallenge,
    codeChallengeMethod,
    ...(oidcNonce ? { oidcNonce } : {}),
    ...(codeVerifier ? { codeVerifier } : {}),
  });
  await getChallengeStore().set(`oauth:${state}`, statePayload);

  return c.redirect(authUrl, 302);
});

/**
 * GET /oauth/:provider/callback
 * Handles the redirect from the OAuth provider.
 *
 * Flow:
 *   1. Validate state (CSRF)
 *   2. Exchange code for access token
 *   3. Fetch user profile from provider
 *   4. Find/create user by email
 *   5. Upsert entry in `accounts` table
 *   6. Link user to requested tenant
 *   7. Mint JWT → redirect to app redirect_uri with ?token=<jwt>
 */
auth.get("/oauth/:provider/callback", async (c) => {
  const providerName = c.req.param("provider");
  const code = c.req.query("code");
  const state = c.req.query("state");
  const errorParam = c.req.query("error");

  if (errorParam) {
    // Provider-controlled text may contain markup, credentials, or diagnostics.
    // Keep the browser response stable and non-reflective.
    const recovery = await oauthCallbackRecoveryFromStoredState(
      "oauth",
      state,
      providerName,
    );
    return oauthCallbackFailure(c, {
      code: "oauth_authorization_failed",
      message: "The provider did not authorize this sign-in.",
      status: 400,
      ...recovery,
    });
  }

  if (!isBuiltInProvider(providerName)) {
    return oauthCallbackFailure(c, {
      code: "oauth_provider_unknown",
      message: "This sign-in provider is not supported.",
      status: 400,
    });
  }

  if (!code || !state) {
    const recovery = await oauthCallbackRecoveryFromStoredState(
      "oauth",
      state,
      providerName,
    );
    return oauthCallbackFailure(c, {
      code: "oauth_callback_incomplete",
      message: "The provider returned an incomplete sign-in response.",
      status: 400,
      ...recovery,
    });
  }

  // Load state before provider calls, then consume it only after provider token
  // exchange and identity verification succeed. Invalid provider codes must not
  // burn a legitimate browser login attempt's one-time state.
  const stateKey = `oauth:${state}`;
  const rawPayload = await getChallengeStore().get(stateKey);
  if (!rawPayload) {
    return oauthCallbackFailure(c, {
      code: "oauth_state_expired",
      message: "This sign-in attempt is invalid or has expired.",
      status: 401,
    });
  }

  let stateData: {
    provider: string;
    tenantId?: string;
    clientId?: string;
    redirectUri: string;
    responseType?: string;
    appState?: string;
    codeChallenge?: string;
    codeChallengeMethod?: string;
    codeVerifier?: string;
    oidcNonce?: string;
  };
  try {
    stateData = JSON.parse(rawPayload) as typeof stateData;
  } catch {
    return oauthCallbackFailure(c, {
      code: "oauth_state_invalid",
      message: "This sign-in attempt could not be validated.",
      status: 400,
    });
  }

  if (stateData.provider !== providerName) {
    return oauthCallbackFailure(c, {
      code: "oauth_provider_mismatch",
      message: "The provider does not match this sign-in attempt.",
      status: 400,
    });
  }
  const methodResponse = await requireTenantLoginMethodAllowed(
    c,
    stateData.tenantId,
    "oauth",
    providerName,
    stateData.clientId,
  );
  if (methodResponse) {
    return oauthCallbackFailure(c, {
      code: "oauth_login_disabled",
      message: "OAuth sign-in is disabled for this application.",
      status: 403,
    });
  }

  let redirectUrl: URL;
  try {
    redirectUrl = await assertAllowedOAuthRedirectUri(
      stateData.redirectUri,
      stateData.tenantId,
      stateData.clientId,
    );
  } catch (err) {
    logger.error(
      {
        details: [
          "[OAuthAuth] Callback redirect validation failed",
          redactedThrownDiagnostics(err),
        ],
      },
      "[Login:auth] error",
    );
    return oauthCallbackFailure(c, {
      code: "oauth_redirect_invalid",
      message: "The application return address is not allowed.",
      status: 400,
    });
  }

  let oauthClient: OAuthClient;
  try {
    oauthClient = new OAuthClient(getProviderConfig(providerName));
  } catch (err) {
    logger.error(
      {
        details: [
          "[OAuthAuth] Callback provider setup failed",
          redactedThrownDiagnostics(err),
        ],
      },
      "[Login:auth] error",
    );
    return oauthCallbackFailure(c, {
      code: "oauth_provider_unavailable",
      message: "This sign-in provider is not available.",
      status: 503,
      redirectUrl,
      appState: stateData.appState,
    });
  }

  const callbackUrl = buildOAuthCallbackUrl(c, providerName);
  if (providerName === "apple") {
    oauthClient.setExpectedNonce(stateData.oidcNonce);
  }

  // Exchange code for access token — pass codeVerifier for PKCE providers (e.g. Twitter)
  let tokenResponse: Awaited<ReturnType<OAuthClient["exchangeCode"]>>;
  try {
    tokenResponse = await oauthClient.exchangeCode(
      code,
      callbackUrl,
      stateData.codeVerifier,
    );
  } catch (err) {
    logger.error(
      {
        details: [
          "[OAuthAuth] Callback token exchange failed",
          redactedThrownDiagnostics(err),
        ],
      },
      "[Login:auth] error",
    );
    return oauthCallbackFailure(c, {
      code: "oauth_token_exchange_failed",
      message: "The provider could not complete sign-in. Please try again.",
      status: 502,
      redirectUrl,
      appState: stateData.appState,
    });
  }

  // Fetch user info from provider
  let providerUser: Awaited<ReturnType<OAuthClient["getUserInfo"]>>;
  try {
    providerUser = await oauthClient.getUserInfo(tokenResponse.access_token);
  } catch (err) {
    logger.error(
      {
        details: [
          "[OAuthAuth] Callback profile fetch failed",
          redactedThrownDiagnostics(err),
        ],
      },
      "[Login:auth] error",
    );
    return oauthCallbackFailure(c, {
      code: "oauth_profile_fetch_failed",
      message: "The provider profile could not be loaded. Please try again.",
      status: 502,
      redirectUrl,
      appState: stateData.appState,
    });
  }

  // Twitter and some providers do not return an email address.
  // Generate a synthetic internal email so findOrCreateUser() can still work.
  // This email is never displayed or sent — it is purely an internal identity key.
  if (!providerUser.email) {
    if (!providerUser.id) {
      return oauthCallbackFailure(c, {
        code: "oauth_identity_incomplete",
        message: "The provider did not return enough account information.",
        status: 400,
        redirectUrl,
        appState: stateData.appState,
      });
    }
    providerUser = {
      ...providerUser,
      email: oauthSyntheticEmail(providerName, providerUser.id),
      syntheticEmailGenerated: true,
    } as OAuthUserInfoWithEmailSource;
  }

  const consumedPayload = await getChallengeStore().consume(stateKey);
  if (consumedPayload !== rawPayload) {
    return oauthCallbackFailure(c, {
      code: "oauth_state_consumed",
      message: "This sign-in attempt is invalid or has already been used.",
      status: 401,
      redirectUrl,
      appState: stateData.appState,
    });
  }

  // Create/find user + provision wallet + link tenant
  const result = await provisionOAuthUser({
    c,
    providerName,
    providerUser,
    tokenResponse,
    tenantId: stateData.tenantId,
  });

  if (!result.ok) {
    const isUnverifiedEmail =
      result.error ===
      "Provider email must be verified before OAuth sign-in is allowed";
    return oauthCallbackFailure(c, {
      code: isUnverifiedEmail
        ? "oauth_verified_email_required"
        : "oauth_account_provisioning_failed",
      message: isUnverifiedEmail
        ? "Provider email must be verified before OAuth sign-in is allowed."
        : "Your account could not be prepared for sign-in.",
      status: result.status ?? 500,
      redirectUrl,
      appState: stateData.appState,
    });
  }

  if (result.response.ok === false) {
    return oauthCallbackFailure(c, {
      code: "oauth_authentication_failed",
      message: "Sign-in could not be completed.",
      status: 403,
      redirectUrl,
      appState: stateData.appState,
    });
  }

  if (result.response.mfaRequired) {
    return oauthCallbackFailure(c, {
      code: "mfa_required",
      message: "Additional verification is required to complete sign-in.",
      status: 403,
      redirectUrl,
      appState: stateData.appState,
    });
  }

  // Nonce-exchange path: issue a one-time, short-lived (60s) code that the
  // caller's backend trades for the real tokens via POST /oauth/exchange.
  // This keeps the tokens off the address bar / browser history / Referer /
  // upstream access logs / any window the user copy-pastes. The pair
  // {redirectUri, tenantId} is bound to the code so a stolen code cannot be
  // redeemed against a different redirect_uri or pivoted to another tenant.
  const nonceBytes = new Uint8Array(32);
  crypto.getRandomValues(nonceBytes);
  const exchangeCode = uint8ArrayToBase64url(nonceBytes);
  const issuedAt = Date.now();
  const expiresAt = issuedAt + OAUTH_CODE_TTL_MS;
  const codePayload = JSON.stringify({
    providerName,
    token: result.response.token,
    refreshToken: result.response.refreshToken,
    user: result.response.user,
    redirectUri: stateData.redirectUri,
    tenantId: stateData.tenantId ?? null,
    codeChallenge: stateData.codeChallenge,
    codeChallengeMethod: stateData.codeChallengeMethod ?? "S256",
    expiresAt,
    expiresIn: ACCESS_TOKEN_EXPIRY_SECONDS,
  });
  await getOAuthCodeStore().set(`oauth-code:${exchangeCode}`, codePayload);
  setRedirectFragment(redirectUrl, {
    code: exchangeCode,
    state: stateData.appState,
  });
  return c.redirect(redirectUrl.toString(), 302);
});

/**
 * POST /auth/oauth/exchange
 *
 * Nonce-exchange endpoint for the `response_type=code` OAuth flow above.
 * Trades a one-time `code` for the real `{token, refreshToken, expiresAt}`
 * payload. The code is bound to the `redirect_uri` and `tenant_id` that were
 * supplied at /authorize time; both must match or the exchange is rejected.
 *
 * Body: { code: string; redirect_uri: string; tenant_id?: string | null }
 * Returns 200 { ok: true, token, refreshToken, expiresIn, expiresAt }
 * Errors:
 *   400 invalid_request        — missing/blank `code` or `redirect_uri`
 *   401 code_invalid           — unknown / already-consumed / expired code
 *   401 code_expired           — found but past `expiresAt` (defense-in-depth;
 *                                the store TTL already evicts these)
 *   401 code_redirect_mismatch — `redirect_uri` does not match
 *   401 code_tenant_mismatch   — `tenant_id` does not match
 *
 * Invalid redemption attempts do not burn the code. A short lock serializes
 * valid redemption so the code remains single-use without letting a bad PKCE
 * verifier kill the user's login.
 */
auth.post("/oauth/exchange", async (c) => {
  const rl = await checkAuthRateLimit(c, "oauth-exchange", 60_000, 30);
  if (!rl.allowed) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Too many OAuth exchange attempts. Try again later.",
      },
      429,
      { "Retry-After": String(rl.retryAfterSecs ?? 60) },
    );
  }

  const body = await safeJsonParse<{
    code?: unknown;
    redirect_uri?: unknown;
    redirectUri?: unknown;
    tenant_id?: unknown;
    tenantId?: unknown;
    code_verifier?: unknown;
    codeVerifier?: unknown;
  }>(c);

  const code = typeof body?.code === "string" ? body.code.trim() : "";
  const redirectUri =
    typeof body?.redirect_uri === "string"
      ? body.redirect_uri.trim()
      : typeof body?.redirectUri === "string"
        ? body.redirectUri.trim()
        : "";
  const rawTenantId =
    typeof body?.tenant_id === "string"
      ? body.tenant_id.trim()
      : typeof body?.tenantId === "string"
        ? body.tenantId.trim()
        : "";
  const tenantId = rawTenantId.length > 0 ? rawTenantId : null;
  const codeVerifier =
    typeof body?.code_verifier === "string"
      ? body.code_verifier.trim()
      : typeof body?.codeVerifier === "string"
        ? body.codeVerifier.trim()
        : "";

  if (!code || !redirectUri) {
    return c.json<ApiResponse>(
      { ok: false, error: "code and redirect_uri are required" },
      400,
    );
  }

  const codeKey = `oauth-code:${code}`;
  const raw = await getOAuthCodeStore().get(codeKey);
  if (!raw) {
    return c.json<ApiResponse & { code: string }>(
      {
        ok: false,
        error: "Invalid or already-used code",
        code: "code_invalid",
      },
      401,
    );
  }

  let payload: {
    providerName?: string;
    token: string;
    refreshToken: string;
    user?: unknown;
    redirectUri: string;
    tenantId: string | null;
    codeChallenge?: string;
    codeChallengeMethod?: string;
    expiresAt: number;
    expiresIn: number;
  };
  try {
    payload = JSON.parse(raw);
  } catch {
    return c.json<ApiResponse & { code: string }>(
      { ok: false, error: "Malformed code payload", code: "code_invalid" },
      401,
    );
  }

  if (Date.now() > payload.expiresAt) {
    return c.json<ApiResponse & { code: string }>(
      { ok: false, error: "Code expired", code: "code_expired" },
      401,
    );
  }

  if (payload.codeChallenge) {
    if (!codeVerifier || !isValidPkceCodeVerifier(codeVerifier)) {
      return c.json<ApiResponse & { code: string }>(
        {
          ok: false,
          error: "Invalid code verifier",
          code: "code_verifier_invalid",
        },
        401,
      );
    }
    const computedChallenge = await pkceChallengeForVerifier(
      codeVerifier,
      payload.codeChallengeMethod ?? "S256",
    );
    if (!computedChallenge || computedChallenge !== payload.codeChallenge) {
      return c.json<ApiResponse & { code: string }>(
        {
          ok: false,
          error: "Code verifier mismatch",
          code: "code_verifier_mismatch",
        },
        401,
      );
    }
  }

  if (payload.redirectUri !== redirectUri) {
    return c.json<ApiResponse & { code: string }>(
      {
        ok: false,
        error: "redirect_uri does not match the one issued with the code",
        code: "code_redirect_mismatch",
      },
      401,
    );
  }

  if ((payload.tenantId ?? null) !== tenantId) {
    return c.json<ApiResponse & { code: string }>(
      {
        ok: false,
        error: "tenant_id does not match the one issued with the code",
        code: "code_tenant_mismatch",
      },
      401,
    );
  }
  const methodResponse = await requireTenantLoginMethodAllowed(
    c,
    payload.tenantId ?? undefined,
    "oauth",
    payload.providerName,
  );
  if (methodResponse) return methodResponse;

  if (!(await lockOAuthCodeRedemption(code))) {
    return c.json<ApiResponse & { code: string }>(
      {
        ok: false,
        error: "OAuth code is already being redeemed",
        code: "code_in_use",
      },
      409,
    );
  }

  try {
    const consumed = await getOAuthCodeStore().consume(codeKey);
    if (!consumed) {
      return c.json<ApiResponse & { code: string }>(
        {
          ok: false,
          error: "Invalid or already-used code",
          code: "code_invalid",
        },
        401,
      );
    }
    if (consumed !== raw) {
      return c.json<ApiResponse & { code: string }>(
        {
          ok: false,
          error: "OAuth code changed during redemption",
          code: "code_invalid",
        },
        401,
      );
    }
  } finally {
    await releaseOAuthCodeRedemptionLock(code);
  }

  return c.json({
    ok: true,
    token: payload.token,
    refreshToken: payload.refreshToken,
    ...(payload.user ? { user: payload.user } : {}),
    expiresIn: payload.expiresIn,
    expiresAt: payload.expiresAt,
  });
});

/**
 * POST /oauth/:provider/token
 * SPA / popup flow — the client has already obtained the code.
 *
 * Body: { code: string; redirectUri: string; tenantId?: string; codeVerifier?: string }
 * Returns: { ok: true; token: string; user: { id, email, walletAddress } }
 */
auth.post("/oauth/:provider/token", async (c) => {
  const providerName = c.req.param("provider");
  if (!isBuiltInProvider(providerName)) {
    return c.json<ApiResponse>(
      { ok: false, error: `Unknown provider: ${providerName}` },
      400,
    );
  }
  const rl = await checkAuthRateLimit(
    c,
    `oauth-token:${providerName}`,
    60_000,
    20,
  );
  if (!rl.allowed) {
    return c.json<ApiResponse>(
      { ok: false, error: "Too many OAuth token attempts. Try again later." },
      429,
      { "Retry-After": String(rl.retryAfterSecs ?? 60) },
    );
  }

  const body = await safeJsonParse<{
    code: string;
    redirectUri: string;
    tenantId?: string;
    codeVerifier?: string;
  }>(c);

  if (!body?.code || !body?.redirectUri) {
    return c.json<ApiResponse>(
      { ok: false, error: "code and redirectUri are required" },
      400,
    );
  }

  const bodyTenantId = body.tenantId?.trim() || undefined;
  const headerTenantId = c.req.header("X-Steward-Tenant")?.trim() || undefined;
  if (bodyTenantId && headerTenantId && bodyTenantId !== headerTenantId) {
    return c.json<ApiResponse>(
      { ok: false, error: "tenantId and X-Steward-Tenant must match" },
      400,
    );
  }
  const requestedTenantId = bodyTenantId || headerTenantId;
  const methodResponse = await requireTenantLoginMethodAllowed(
    c,
    requestedTenantId,
    "oauth",
    providerName,
  );
  if (methodResponse) return methodResponse;
  try {
    await assertAllowedOAuthRedirectUri(body.redirectUri, requestedTenantId);
  } catch (err) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: err instanceof Error ? err.message : "Invalid redirectUri",
      },
      400,
    );
  }

  const boundCodeKey = `oauth-code:${body.code}`;
  const boundCode = await getOAuthCodeStore().get(boundCodeKey);
  if (boundCode) {
    let payload: {
      providerName?: string;
      token: string;
      refreshToken: string;
      user?: unknown;
      redirectUri: string;
      tenantId: string | null;
      codeChallenge?: string;
      codeChallengeMethod?: string;
      expiresAt: number;
      expiresIn: number;
    };
    try {
      payload = JSON.parse(boundCode);
    } catch {
      return c.json<ApiResponse>(
        { ok: false, error: "Malformed OAuth code payload" },
        401,
      );
    }
    if (Date.now() > payload.expiresAt) {
      return c.json<ApiResponse>(
        { ok: false, error: "OAuth code expired" },
        401,
      );
    }
    if (payload.redirectUri !== body.redirectUri) {
      return c.json<ApiResponse>(
        { ok: false, error: "OAuth code redirectUri mismatch" },
        401,
      );
    }
    if ((payload.tenantId ?? null) !== (requestedTenantId ?? null)) {
      return c.json<ApiResponse>(
        { ok: false, error: "OAuth code tenant mismatch" },
        401,
      );
    }
    if (payload.providerName && payload.providerName !== providerName) {
      return c.json<ApiResponse>(
        { ok: false, error: "OAuth code provider mismatch" },
        401,
      );
    }
    const payloadMethodResponse = await requireTenantLoginMethodAllowed(
      c,
      payload.tenantId ?? undefined,
      "oauth",
      payload.providerName ?? providerName,
    );
    if (payloadMethodResponse) return payloadMethodResponse;
    if (payload.codeChallenge) {
      const verifier = body.codeVerifier?.trim() ?? "";
      if (!verifier || !isValidPkceCodeVerifier(verifier)) {
        return c.json<ApiResponse>(
          { ok: false, error: "Invalid code verifier" },
          401,
        );
      }
      const computedChallenge = await pkceChallengeForVerifier(
        verifier,
        payload.codeChallengeMethod ?? "S256",
      );
      if (!computedChallenge || computedChallenge !== payload.codeChallenge) {
        return c.json<ApiResponse>(
          { ok: false, error: "Code verifier mismatch" },
          401,
        );
      }
    }
    if (!(await lockOAuthCodeRedemption(body.code))) {
      return c.json<ApiResponse>(
        { ok: false, error: "OAuth code is already being redeemed" },
        409,
      );
    }
    try {
      const consumed = await getOAuthCodeStore().consume(boundCodeKey);
      if (!consumed || consumed !== boundCode) {
        return c.json<ApiResponse>(
          { ok: false, error: "Invalid or already-used code" },
          401,
        );
      }
    } finally {
      await releaseOAuthCodeRedemptionLock(body.code);
    }
    return c.json({
      ok: true,
      token: payload.token,
      refreshToken: payload.refreshToken,
      ...(payload.user ? { user: payload.user } : {}),
      expiresIn: payload.expiresIn,
      expiresAt: payload.expiresAt,
    });
  }

  if (!isUnsafeUnboundOAuthProviderCodeExchangeAllowed()) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error:
          "Unbound OAuth provider code exchange is disabled; use /auth/oauth/:provider/authorize and /auth/oauth/exchange",
      },
      401,
    );
  }

  let oauthClient: OAuthClient;
  try {
    oauthClient = new OAuthClient(getProviderConfig(providerName));
  } catch (err) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: err instanceof Error ? err.message : "Provider not configured",
      },
      503,
    );
  }

  let tokenResponse: Awaited<ReturnType<OAuthClient["exchangeCode"]>>;
  try {
    tokenResponse = await oauthClient.exchangeCode(
      body.code,
      body.redirectUri,
      body.codeVerifier,
    );
  } catch (err) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: err instanceof Error ? err.message : "Token exchange failed",
      },
      502,
    );
  }

  let providerUser: Awaited<ReturnType<OAuthClient["getUserInfo"]>>;
  try {
    providerUser = await oauthClient.getUserInfo(tokenResponse.access_token);
  } catch (err) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: err instanceof Error ? err.message : "Failed to fetch user info",
      },
      502,
    );
  }

  // Twitter and some providers do not return an email address.
  // Generate a synthetic internal email so findOrCreateUser() can still work.
  if (!providerUser.email) {
    if (!providerUser.id) {
      return c.json<ApiResponse>(
        { ok: false, error: "Provider returned neither email nor user ID" },
        400,
      );
    }
    providerUser = {
      ...providerUser,
      email: oauthSyntheticEmail(providerName, providerUser.id),
      syntheticEmailGenerated: true,
    } as OAuthUserInfoWithEmailSource;
  }

  const result = await provisionOAuthUser({
    c,
    providerName,
    providerUser,
    tokenResponse,
    tenantId: requestedTenantId,
  });

  if (!result.ok) {
    return c.json<ApiResponse>(
      { ok: false, error: result.error },
      result.status ?? 500,
    );
  }

  return authExchangeJson(c, result.response);
});

// ─── OAuth helper: provision user + account + tenant link ─────────────────────

type OAuthUserInfo = Awaited<ReturnType<OAuthClient["getUserInfo"]>>;
type OAuthTokenResponse = Awaited<ReturnType<OAuthClient["exchangeCode"]>>;
type OAuthUserInfoWithEmailSource = OAuthUserInfo & {
  syntheticEmailGenerated?: boolean;
};

function oauthSyntheticEmail(
  providerName: string,
  providerUserId: string,
): string {
  return `${providerName}.${providerUserId}@id.steward.internal`;
}

async function provisionOAuthUser(opts: {
  c: Context;
  providerName: string;
  providerUser: OAuthUserInfoWithEmailSource;
  tokenResponse: OAuthTokenResponse;
  tenantId?: string;
}): Promise<
  | {
      ok: true;
      response: Record<string, unknown>;
    }
  | { ok: false; status?: 400 | 403 | 404 | 409 | 500; error: string }
> {
  const { c, providerName, providerUser, tokenResponse, tenantId } = opts;
  const db = getDb();
  const email = providerUser.email.toLowerCase().trim();
  const isInternalSyntheticEmail = email.endsWith("@id.steward.internal");

  try {
    if (
      isInternalSyntheticEmail &&
      providerUser.syntheticEmailGenerated !== true
    ) {
      return {
        ok: false,
        status: 403,
        error: "Provider email uses a reserved internal domain",
      };
    }
    if (
      !providerUser.syntheticEmailGenerated &&
      providerUser.verified_email !== true
    ) {
      return {
        ok: false,
        status: 403,
        error:
          "Provider email must be verified before OAuth sign-in is allowed",
      };
    }

    const requestedTenantId =
      c.req.header("X-Steward-Tenant")?.trim() || tenantId?.trim();
    const [existingUser] = await db
      .select()
      .from(users)
      .where(eq(users.email, email));
    let resolvedTenantId: string | undefined;

    if (existingUser) {
      const tenantResult = await resolveAndValidateTenant(
        c,
        existingUser.id,
        tenantId,
      );
      if (!tenantResult.ok) {
        return {
          ok: false as const,
          status: tenantResult.status,
          error: tenantResult.error,
        };
      }
      resolvedTenantId = tenantResult.tenantId;
    } else if (requestedTenantId) {
      const tenantResult = await validateOidcJitTenant(requestedTenantId);
      if (!tenantResult.ok) {
        return {
          ok: false as const,
          status: tenantResult.status,
          error: tenantResult.error,
        };
      }
      resolvedTenantId = requestedTenantId;
    }

    if (resolvedTenantId) {
      const authAbuseConfig = await getTenantAuthAbuseConfig(resolvedTenantId);
      const emailPolicyError = validateEmailAbusePolicy(email, authAbuseConfig);
      if (emailPolicyError) {
        return {
          ok: false as const,
          status: 400,
          error: emailPolicyError,
        };
      }
      if (
        !providerUser.syntheticEmailGenerated &&
        (await isSsoRequiredForEmailDomain(resolvedTenantId, email))
      ) {
        return {
          ok: false as const,
          status: 403,
          error:
            "OAuth login is disabled because this email domain requires SSO",
        };
      }
    }

    // 1. Find or create global user record after tenant/policy checks that can
    // be evaluated without a new personal tenant.
    const { user, isNew } = existingUser
      ? { user: existingUser, isNew: false }
      : await findOrCreateUserWithStatus(email);

    if (!resolvedTenantId) {
      const tenantResult = await resolveAndValidateTenant(c, user.id, tenantId);
      if (!tenantResult.ok) {
        return {
          ok: false as const,
          status: tenantResult.status,
          error: tenantResult.error,
        };
      }
      resolvedTenantId = tenantResult.tenantId;
      const authAbuseConfig = await getTenantAuthAbuseConfig(resolvedTenantId);
      const emailPolicyError = validateEmailAbusePolicy(email, authAbuseConfig);
      if (emailPolicyError) {
        return {
          ok: false as const,
          status: 400,
          error: emailPolicyError,
        };
      }
      if (
        !providerUser.syntheticEmailGenerated &&
        (await isSsoRequiredForEmailDomain(resolvedTenantId, email))
      ) {
        return {
          ok: false as const,
          status: 403,
          error:
            "OAuth login is disabled because this email domain requires SSO",
        };
      }
    }

    // Update name/image if we have richer data from the provider and the user doesn't have it yet
    const updates: Partial<typeof users.$inferInsert> = {};
    if (!user.name && providerUser.name) updates.name = providerUser.name;
    if (!user.image && providerUser.picture)
      updates.image = providerUser.picture;
    if (!user.emailVerified && providerUser.verified_email)
      updates.emailVerified = true;
    if (Object.keys(updates).length > 0) {
      await db.update(users).set(updates).where(eq(users.id, user.id));
    }

    // 2. Upsert the OAuth account link (provider + providerAccountId → user).
    // Provider tokens are stored encrypted with the deployment master password.
    // If STEWARD_MASTER_PASSWORD changes, operators must run a decrypt +
    // re-encrypt rotation pass before switching the application to the new
    // password, otherwise existing OAuth provider tokens cannot be decrypted.
    const encryptedProviderTokens = encryptOAuthProviderTokens(
      tokenResponse.access_token,
      tokenResponse.refresh_token ?? null,
    );
    const [insertedAccount] = await db
      .insert(accounts)
      .values({
        userId: user.id,
        provider: providerName,
        providerAccountId: providerUser.id,
        ...encryptedProviderTokens,
        expiresAt: tokenResponse.expires_in
          ? Math.floor(Date.now() / 1000) + tokenResponse.expires_in
          : null,
      })
      .onConflictDoNothing({
        target: [accounts.provider, accounts.providerAccountId],
      })
      .returning({ id: accounts.id });
    if (!insertedAccount) {
      const [currentAccount] = await db
        .select({ id: accounts.id, userId: accounts.userId })
        .from(accounts)
        .where(
          and(
            eq(accounts.provider, providerName),
            eq(accounts.providerAccountId, providerUser.id),
          ),
        );
      if (!currentAccount || currentAccount.userId !== user.id) {
        return {
          ok: false as const,
          status: 403,
          error: "OAuth account is already linked to another user",
        };
      }
      const [updatedAccount] = await db
        .update(accounts)
        .set({
          ...encryptedProviderTokens,
          expiresAt: tokenResponse.expires_in
            ? Math.floor(Date.now() / 1000) + tokenResponse.expires_in
            : null,
        })
        .where(
          and(eq(accounts.id, currentAccount.id), eq(accounts.userId, user.id)),
        )
        .returning({ id: accounts.id });
      if (!updatedAccount) {
        return {
          ok: false as const,
          status: 403,
          error: "OAuth account ownership changed during sign-in",
        };
      }
    }

    // 3. Provision personal wallet (idempotent)
    let walletAddress = user.walletAddress;
    try {
      const w = await provisionWalletForUser(user.id, email);
      walletAddress = w.walletAddress;
    } catch (err) {
      logger.error(
        {
          details: [
            `[OAuthAuth:${providerName}] Wallet provision failed`,
            redactedThrownDiagnostics(err),
          ],
        },
        "[Login:auth] error",
      );
    }

    // 4. Link user to the already-authorized requesting tenant.
    await ensureUserTenantLink(user.id, resolvedTenantId);
    if (isNew) {
      dispatchUserCreated(resolvedTenantId, user.id, "auth.oauth", {
        provider: providerName,
        hasEmail: true,
      });
    }

    return {
      ok: true,
      response: await buildAuthOrMfaResponse(
        user.id,
        resolvedTenantId,
        walletAddress ?? "",
        {
          userId: user.id,
          email,
          authMethod: "oauth",
        },
        { id: user.id, email, walletAddress },
        c,
      ),
    };
  } catch (err) {
    logger.error(
      {
        details: [
          `[OAuthAuth:${providerName}] provisionOAuthUser failed`,
          redactedThrownDiagnostics(err),
        ],
      },
      "[Login:auth] error",
    );
    return {
      ok: false,
      error: "Internal server error",
    };
  }
}

/**
 * Build the canonical OAuth callback URL for the given provider.
 * APP_URL is mandatory in production so a forged Host/X-Forwarded-Proto header
 * cannot influence the provider redirect_uri.
 */
function authCallbackBaseUrl(c: Context): string {
  const configured = process.env.APP_URL?.trim();
  if (configured) return configured.replace(/\/$/, "");
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "APP_URL is required for OAuth/OIDC callback URLs in production",
    );
  }
  return `${c.req.header("x-forwarded-proto") ?? "https"}://${c.req.header("host") ?? "localhost"}`;
}

function buildOAuthCallbackUrl(c: Context, providerName: string): string {
  const appUrl = authCallbackBaseUrl(c);
  return `${appUrl}/auth/oauth/${encodeURIComponent(providerName)}/callback`;
}

function buildOidcCallbackUrl(c: Context, providerId: string): string {
  const appUrl = authCallbackBaseUrl(c);
  return `${appUrl}/auth/oidc/${encodeURIComponent(providerId)}/callback`;
}

function randomBase64Url(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return uint8ArrayToBase64url(bytes);
}

const OIDC_TOKEN_EXCHANGE_TIMEOUT_MS = 10_000;
const OIDC_TOKEN_EXCHANGE_MAX_BYTES = 64 * 1024;

async function postPublicOidcTokenEndpoint(
  tokenUrl: string,
  body: URLSearchParams,
): Promise<{ ok: boolean; status: number; text: string }> {
  const url = assertPublicHttpsEndpoint(tokenUrl, "OIDC token endpoint");
  assertPinnedDnsTransportSupported("OIDC token endpoint");
  const bodyText = body.toString();
  if (new TextEncoder().encode(bodyText).length > 16 * 1024) {
    throw new Error("OIDC token endpoint request is too large");
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let bytes = 0;
    let responseText = "";
    const finish = <T>(fn: (value: T) => void, value: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      fn(value);
    };
    const request = httpsRequest(
      url,
      {
        method: "POST",
        timeout: OIDC_TOKEN_EXCHANGE_TIMEOUT_MS,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": new TextEncoder()
            .encode(bodyText)
            .length.toString(),
        },
        lookup: createPublicInternetLookup("OIDC token endpoint"),
      },
      (response) => {
        if (
          response.statusCode &&
          response.statusCode >= 300 &&
          response.statusCode < 400
        ) {
          finish(
            reject,
            new Error("OIDC token endpoint redirects are not allowed"),
          );
          response.resume();
          return;
        }
        const declaredLength = Number(response.headers["content-length"]);
        if (
          Number.isFinite(declaredLength) &&
          declaredLength > OIDC_TOKEN_EXCHANGE_MAX_BYTES
        ) {
          finish(
            reject,
            new Error("OIDC token endpoint response is too large"),
          );
          response.resume();
          return;
        }
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          bytes += new TextEncoder().encode(chunk).length;
          if (bytes > OIDC_TOKEN_EXCHANGE_MAX_BYTES) {
            finish(
              reject,
              new Error("OIDC token endpoint response is too large"),
            );
            request.destroy();
            return;
          }
          responseText += chunk;
        });
        response.on("end", () => {
          finish(resolve, {
            ok: Boolean(
              response.statusCode &&
                response.statusCode >= 200 &&
                response.statusCode < 300,
            ),
            status: response.statusCode ?? 0,
            text: responseText,
          });
        });
        response.on("aborted", () => {
          finish(
            reject,
            new Error("OIDC token endpoint response was interrupted"),
          );
        });
        response.on("error", () => {
          finish(reject, new Error("OIDC token endpoint response failed"));
        });
      },
    );
    request.on("error", (error) => finish(reject, error));
    request.setTimeout(OIDC_TOKEN_EXCHANGE_TIMEOUT_MS, () => {
      finish(reject, new Error("OIDC token endpoint request timed out"));
      request.destroy();
    });
    const deadline = setTimeout(() => {
      finish(reject, new Error("OIDC token endpoint request timed out"));
      request.destroy();
    }, OIDC_TOKEN_EXCHANGE_TIMEOUT_MS);
    request.write(bodyText);
    request.end();
  });
}

async function exchangeOidcAuthorizationCode(opts: {
  provider: TenantOidcProviderConfig;
  tenantId: string;
  code: string;
  redirectUri: string;
  codeVerifier: string;
}): Promise<string> {
  const { provider, tenantId, code, redirectUri, codeVerifier } = opts;
  if (!provider.clientId || !provider.tokenUrl) {
    throw new Error(
      "OIDC provider is not configured for authorization-code login",
    );
  }
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: provider.clientId,
    code_verifier: codeVerifier,
  });
  if (provider.clientSecretEnv) {
    // Defense in depth: legacy rows may predate the config-time allowlist, so
    // re-enforce the tenant-bound env namespace before reading any secret
    // (SEC-005: a cross-tenant env reference must never reach the exchange).
    if (
      !isAllowedOidcClientSecretEnvForTenant(provider.clientSecretEnv, tenantId)
    ) {
      throw new Error(
        "OIDC client secret env is outside the allowed tenant namespace",
      );
    }
    const secret = process.env[provider.clientSecretEnv];
    if (!secret)
      throw new Error(
        `OIDC client secret env ${provider.clientSecretEnv} is not set`,
      );
    body.set("client_secret", secret);
  }

  let response: Awaited<ReturnType<typeof postPublicOidcTokenEndpoint>>;
  try {
    response = await postPublicOidcTokenEndpoint(provider.tokenUrl, body);
  } catch (error) {
    // Keep resolver, TLS, socket, and certificate diagnostics server-side.
    // They may contain configured hostnames or runtime network details and are
    // not useful to an unauthenticated callback client.
    logger.warn(
      {
        details: [
          "[OIDC] Token endpoint request failed",
          redactedThrownDiagnostics(error),
        ],
      },
      "[Login:auth] warn",
    );
    throw new Error("OIDC token endpoint request failed");
  }
  const text = response.text;
  let payload: unknown;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    throw new Error("OIDC token endpoint returned invalid JSON");
  }
  if (!response.ok) {
    // SEC-139: the IdP-supplied `error` string is untrusted text. Do not echo
    // it into logs or the client-facing 502 response.
    const idpError =
      payload &&
      typeof payload === "object" &&
      "error" in payload &&
      typeof payload.error === "string"
        ? payload.error
        : undefined;
    if (idpError) {
      logger.warn(
        { details: ["[OIDC] Token endpoint rejected authorization code"] },
        "[Login:auth] warn",
      );
    }
    throw new Error("OIDC token endpoint rejected authorization code");
  }
  if (
    !payload ||
    typeof payload !== "object" ||
    !("id_token" in payload) ||
    typeof payload.id_token !== "string" ||
    payload.id_token.trim() === ""
  ) {
    throw new Error("OIDC token endpoint did not return an id_token");
  }
  return payload.id_token.trim();
}

const OAUTH_REDIRECT_ALLOWLIST_ENV_KEYS = [
  "STEWARD_OAUTH_ALLOWED_REDIRECTS",
  "STEWARD_OAUTH_REDIRECT_ALLOWLIST",
] as const;

function parseOAuthRedirectAllowlistEnv(): string[] {
  const entries = new Set<string>();

  for (const envName of OAUTH_REDIRECT_ALLOWLIST_ENV_KEYS) {
    const raw = process.env[envName];
    if (!raw) continue;

    for (const entry of raw.split(",")) {
      const trimmed = entry.trim();
      if (trimmed && trimmed !== "*") {
        entries.add(trimmed);
      }
    }
  }

  return [...entries];
}

function parseOAuthRedirectUri(redirectUri: string): URL {
  let redirectUrl: URL;
  try {
    redirectUrl = new URL(redirectUri);
  } catch {
    throw new Error("redirect_uri must be a valid absolute URL");
  }

  if (redirectUrl.protocol === "http:") {
    const host = redirectUrl.hostname.toLowerCase();
    const isLoopback =
      host === "localhost" || host === "127.0.0.1" || host === "::1";
    if (!isLoopback) {
      throw new Error(
        "redirect_uri must use https except for loopback development origins",
      );
    }
  } else if (redirectUrl.protocol !== "https:") {
    throw new Error("redirect_uri must use https");
  }

  if (redirectUrl.username || redirectUrl.password) {
    throw new Error("redirect_uri must not contain credentials");
  }

  return redirectUrl;
}

function isOAuthRedirectEntryMatch(
  redirectUrl: URL,
  allowedEntry: string,
): boolean {
  let allowedUrl: URL;
  try {
    allowedUrl = new URL(allowedEntry);
  } catch {
    return false;
  }

  if (allowedUrl.protocol !== "https:" && allowedUrl.protocol !== "http:") {
    return false;
  }

  const isOriginOnly =
    allowedUrl.pathname === "/" &&
    !allowedUrl.search &&
    !allowedUrl.hash &&
    !allowedUrl.username;

  if (isOriginOnly) {
    return (
      allowedUrl.origin === redirectUrl.origin &&
      redirectUrl.pathname === "/" &&
      !redirectUrl.search &&
      !redirectUrl.hash
    );
  }

  return (
    allowedUrl.origin === redirectUrl.origin &&
    allowedUrl.pathname === redirectUrl.pathname &&
    allowedUrl.search === redirectUrl.search
  );
}

function normalizePublicClientId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const id = value.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9_-]{2,63}$/.test(id) ? id : undefined;
}

async function getAllowedOAuthRedirectEntries(
  tenantId?: string,
  clientId?: string,
): Promise<string[]> {
  const explicitTenantId = tenantId?.trim() || undefined;
  const resolvedTenantId = explicitTenantId || defaultAuthTenantId();
  const entries = new Set<string>();

  const normalizedClientId = normalizePublicClientId(clientId);
  const appClientRows = await authAppClientSubjects(resolvedTenantId);

  if (normalizedClientId) {
    const client = appClientRows.find(
      (candidate) => candidate.id === normalizedClientId,
    );
    if (client) {
      for (const entry of client.allowed_redirect_urls ?? []) {
        const trimmed = entry.trim();
        if (trimmed && trimmed !== "*") entries.add(trimmed);
      }
    }
    return [...entries];
  }

  const config = await authTenantConfigSubject(resolvedTenantId);
  for (const entry of config?.allowed_redirect_urls ?? []) {
    const trimmed = entry.trim();
    if (trimmed && trimmed !== "*") {
      entries.add(trimmed);
    }
  }

  for (const client of appClientRows) {
    for (const entry of client.allowed_redirect_urls ?? []) {
      const trimmed = entry.trim();
      if (trimmed && trimmed !== "*") entries.add(trimmed);
    }
  }

  if (!explicitTenantId) {
    for (const entry of parseOAuthRedirectAllowlistEnv()) {
      entries.add(entry);
    }
  }

  return [...entries];
}

export async function assertAllowedOAuthRedirectUri(
  redirectUri: string,
  tenantId?: string,
  clientId?: string,
): Promise<URL> {
  const redirectUrl = parseOAuthRedirectUri(redirectUri);
  const allowlist = await getAllowedOAuthRedirectEntries(tenantId, clientId);

  if (allowlist.length === 0) {
    throw new Error(
      "OAuth redirect_uri allowlist is not configured for this tenant. Configure tenant allowedRedirectUrls or STEWARD_OAUTH_ALLOWED_REDIRECTS.",
    );
  }

  if (
    !allowlist.some((entry) => isOAuthRedirectEntryMatch(redirectUrl, entry))
  ) {
    throw new Error("redirect_uri is not allowed for this tenant");
  }

  return redirectUrl;
}

export { auth as authRoutes };
