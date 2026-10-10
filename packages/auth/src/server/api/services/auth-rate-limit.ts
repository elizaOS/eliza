/** Shared client attribution and login attempt budgets. */
import { isIP } from "node:net";
import { logger } from "@elizaos/core";
import type { Context } from "hono";
import { hashSha256Hex } from "../../auth/index";
import { formatRateLimitHeaders } from "../middleware/redis-enforcement";
import { socketPeerFromEnv } from "./runtime-gate";

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
  // Number.parseInt stops at the first non-digit ("1e3" -> 1), so a typo
  // was silently accepted as the outage valve cap instead of the 300
  // default. Require the whole trimmed value to be decimal, mirroring
  // trustedProxyHops above.
  const rawText = raw.trim();
  const parsed = /^\+?\d+$/.test(rawText) ? Number(rawText) : Number.NaN;
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

    const { checkRateLimit } = await import("../../redis/index.ts");
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
