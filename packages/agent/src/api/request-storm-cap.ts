/**
 * Per-session request-storm cap for the shared HTTP dispatch. A misbehaving
 * client (observed live: paired devices polling the dashboard suite with no
 * backoff at ~20 req/s) must not be able to pin the API core and degrade
 * message turns for every other surface. Each bearer session gets a token
 * bucket generous enough for any legitimate UI burst; sustained storm traffic
 * beyond it receives 429 + Retry-After before auth resolution and route
 * handlers spend anything. Requests without a bearer (cookie-auth pages,
 * internal loopback service calls) and long-lived streaming endpoints are
 * exempt. This is a politeness cap for authenticated polling loops, never a
 * substitute for edge rate limiting against adversarial traffic.
 */
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { logger } from "@elizaos/core";
import { isLoopbackRemoteAddress } from "@elizaos/shared";
import { resolveSelfApiCredential } from "@elizaos/shared/runtime-env";

// One cold dashboard hydration fans out across the independent product
// surfaces (chat, views, plugins, approvals, notifications, and settings).
// Leave room for two complete hydration bursts so a reconnect or immediate
// reload cannot throttle its own recovery. The 10 req/s refill still caps the
// observed 20 req/s runaway poller after a short sustained interval.
const BUCKET_CAPACITY = 80;
const REFILL_PER_SECOND = 10;
const RETRY_AFTER_SECONDS = 3;
const IDLE_EVICT_MS = 10 * 60 * 1000;
const EVICT_SCAN_INTERVAL_MS = 60 * 1000;
const WARN_INTERVAL_MS = 60 * 1000;

interface Bucket {
  tokens: number;
  updatedAt: number;
  lastWarnAt: number;
}

const buckets = new Map<string, Bucket>();

let nextEvictScanAt = 0;

function isExemptPath(pathname: string): boolean {
  return (
    pathname === "/ws" ||
    pathname.endsWith("/messages/stream") ||
    pathname === "/api/voice" ||
    pathname.startsWith("/api/voice/") ||
    pathname.startsWith("/api/media/")
  );
}

function bearerKey(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return null;
  const token = header.slice(7).trim();
  if (!token) return null;
  // The runtime's own loopback service calls (views client, app-control,
  // status frames) authenticate with the shared self-API credential. Capping
  // that shared identity throttles the agent's own actions — observed live as
  // hung turns — so it is exempt; the cap exists for per-device sessions.
  // Bind the exemption to the actual loopback transport. Token equality alone
  // would let a remote caller test a suspected credential by observing whether
  // sustained traffic is capped before authentication runs.
  const selfCredential = resolveSelfApiCredential(process.env);
  if (
    selfCredential !== null &&
    token === selfCredential &&
    isLoopbackRemoteAddress(req.socket?.remoteAddress)
  ) {
    return null;
  }
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

function evictIdle(now: number): void {
  if (buckets.size < 512) return;
  if (now < nextEvictScanAt) return;
  nextEvictScanAt = now + EVICT_SCAN_INTERVAL_MS;
  for (const [key, bucket] of buckets) {
    if (now - bucket.updatedAt > IDLE_EVICT_MS) buckets.delete(key);
  }
}

/**
 * Returns true when the request was answered with 429 and dispatch must stop.
 */
export function maybeCapRequestStorm(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): boolean {
  if (req.method === "OPTIONS") return false;
  if (isExemptPath(pathname)) return false;
  const key = bearerKey(req);
  if (!key) return false;

  const now = Date.now();
  evictIdle(now);
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = { tokens: BUCKET_CAPACITY, updatedAt: now, lastWarnAt: 0 };
    buckets.set(key, bucket);
  } else {
    const elapsed = (now - bucket.updatedAt) / 1000;
    bucket.tokens = Math.min(
      BUCKET_CAPACITY,
      bucket.tokens + elapsed * REFILL_PER_SECOND,
    );
    bucket.updatedAt = now;
  }

  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return false;
  }

  if (now - bucket.lastWarnAt > WARN_INTERVAL_MS) {
    bucket.lastWarnAt = now;
    logger.warn(
      { src: "request-storm-cap", session: key.slice(0, 8), pathname },
      "[RequestStormCap] Session exceeded the sustained request budget; answering 429",
    );
  }
  res.writeHead(429, {
    "Content-Type": "application/json",
    "Retry-After": String(RETRY_AFTER_SECONDS),
  });
  res.end(
    JSON.stringify({
      error: "Too many requests from this session; slow the polling loop.",
      retryAfterSeconds: RETRY_AFTER_SECONDS,
    }),
  );
  return true;
}

/** Test-only: reset all request-budget state. */
export function __resetRequestStormCapForTests(): void {
  buckets.clear();
  nextEvictScanAt = 0;
}

/** Test-only: inspect bounded in-memory state without exposing session keys. */
export function __requestStormCapBucketCountForTests(): number {
  return buckets.size;
}
