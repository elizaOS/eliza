/**
 * runtime-gate.ts — pure logic behind the Bun entry's global rate limiter
 * (index.ts). Extracted so the derivation and eviction rules are unit-testable
 * (index.ts itself boots a server at module scope and cannot be imported by
 * tests).
 *
 * Client-supplied forwarding headers are honored only when the operator
 * declares the trusted proxy-hop count (`STEWARD_TRUSTED_PROXY_HOPS`):
 *
 *   - each proxy appends the peer it observed, so with N trusted hops the real
 *     client is the entry N positions from the RIGHT of the XFF list — every
 *     entry to its left is attacker-controlled prefix and ignored;
 *   - with zero trusted hops (default) both forwarding headers are ignored and
 *     the socket peer is used;
 *   - when the chain is shorter than the configured trust, no forwarded entry
 *     is trustworthy; fall back to the socket peer instead of accepting a
 *     client-supplied leftmost value.
 *
 * `X-Real-IP` is never consulted: it carries no chain semantics, so the hop
 * count cannot be applied to it, and whenever XFF is absent/short a direct
 * client can simply spoof it to rotate rate-limit identities. This matches the
 * auth-route resolver (routes/auth.ts), which deliberately ignores it too.
 *
 * The log is also capped (`STEWARD_RATE_LIMIT_MAX_KEYS`): when full it sweeps
 * expired entries inline and then fails CLOSED (429) rather than letting the
 * map grow without bound.
 */

export const DEFAULT_RATE_LIMIT_MAX_KEYS = 10_000;

/**
 * Key in the Hono `env` bag (app.fetch's second argument) through which a
 * server entry point hands the app the socket peer it observed (Bun's
 * `server.requestIP`). Unlike any request header, this value is set by the
 * runtime and cannot be client-influenced, so downstream rate limiters may
 * key on it when no trusted forwarding config exists (SEC-014 posture
 * extended to the per-route auth limiter). Runtimes without a socket (e.g.
 * Cloudflare Workers) simply never set it.
 */
export const SOCKET_PEER_ENV_KEY = "steward.socketPeer";

/** Read the entry-injected socket peer from a Hono context's env bag. */
export function socketPeerFromEnv(env: unknown): string | undefined {
  if (typeof env !== "object" || env === null) return undefined;
  const peer = (env as Record<string, unknown>)[SOCKET_PEER_ENV_KEY];
  return typeof peer === "string" && peer.length > 0 ? peer : undefined;
}

export function parseNonNegativeInt(
  value: string | undefined,
  fallback: number,
): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

export function parsePositiveInt(
  value: string | undefined,
  fallback: number,
): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Derive the rate-limit key for a request. `peerAddress` is the socket peer
 * (`server.requestIP()` on Bun; null when the runtime cannot provide it).
 */
export function resolveClientIp(
  headers: Headers,
  peerAddress: string | null,
  trustedProxyHops: number,
): string {
  if (trustedProxyHops > 0) {
    const forwardedFor = headers.get("x-forwarded-for");
    if (forwardedFor) {
      const hops = forwardedFor
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean);
      if (hops.length >= trustedProxyHops) {
        const clientIndex = hops.length - trustedProxyHops;
        const derived = hops[clientIndex];
        if (derived) return derived;
      }
    }
  }
  return peerAddress ?? "unknown";
}

export type RateLimitVerdict =
  | { limited: false }
  | { limited: true; retryAfterSeconds: number };

/**
 * Fixed-window in-memory limiter with a hard cap on tracked keys. Only safe
 * for the single-process Bun entry (the Workers entry must not use it).
 */
export class InMemoryRateLimiter {
  private readonly log = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly maxRequests: number,
    private readonly windowMs: number,
    private readonly maxKeys: number = DEFAULT_RATE_LIMIT_MAX_KEYS,
  ) {}

  check(key: string, now: number = Date.now()): RateLimitVerdict {
    const current = this.log.get(key);

    if (!current || current.resetAt <= now) {
      if (!current && this.log.size >= this.maxKeys) {
        this.sweep(now);
        if (this.log.size >= this.maxKeys) {
          // Fail closed: rather track nothing new than grow without bound.
          return {
            limited: true,
            retryAfterSeconds: Math.ceil(this.windowMs / 1000),
          };
        }
      }
      this.log.set(key, { count: 1, resetAt: now + this.windowMs });
      return { limited: false };
    }

    if (current.count >= this.maxRequests) {
      return {
        limited: true,
        retryAfterSeconds: Math.ceil((current.resetAt - now) / 1000),
      };
    }

    current.count += 1;
    this.log.set(key, current);
    return { limited: false };
  }

  sweep(now: number = Date.now()): void {
    for (const [key, entry] of this.log.entries()) {
      if (entry.resetAt <= now) this.log.delete(key);
    }
  }

  clear(): void {
    this.log.clear();
  }

  get size(): number {
    return this.log.size;
  }
}
