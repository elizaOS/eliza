/**
 * Per-session request-storm cap for the shared HTTP dispatch. A misbehaving
 * client (observed live: paired devices polling the dashboard suite with no
 * backoff at ~20 req/s) must not be able to pin the API core and degrade
 * message turns for every other surface. Each bearer session gets a token
 * bucket generous enough for any legitimate UI burst; sustained storm traffic
 * beyond it receives 429 + Retry-After before auth resolution and route
 * handlers spend anything. Requests without a bearer (cookie-auth pages,
 * internal loopback service calls) and long-lived streaming endpoints are
 * exempt — this cap targets high-frequency polling, never conversations,
 * sockets, or media.
 */
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { logger } from "@elizaos/core";
import { resolveSelfApiCredential } from "@elizaos/shared/runtime-env";

const BUCKET_CAPACITY = 30;
const REFILL_PER_SECOND = 10;
const RETRY_AFTER_SECONDS = 3;
const IDLE_EVICT_MS = 10 * 60 * 1000;
const WARN_INTERVAL_MS = 60 * 1000;

interface Bucket {
  tokens: number;
  updatedAt: number;
  lastWarnAt: number;
}

const buckets = new Map<string, Bucket>();

const EXEMPT_PATH_MARKERS = [
  "/messages/stream",
  "/ws",
  "/api/voice",
  "/api/media/",
] as const;

let selfCredential: string | null | undefined;

function bearerKey(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return null;
  const token = header.slice(7).trim();
  if (!token) return null;
  // The runtime's own loopback service calls (views client, app-control,
  // status frames) authenticate with the shared self-API credential. Capping
  // that shared identity throttles the agent's own actions — observed live as
  // hung turns — so it is exempt; the cap exists for per-device sessions.
  if (selfCredential === undefined) {
    selfCredential = resolveSelfApiCredential(process.env) ?? null;
  }
  if (selfCredential !== null && token === selfCredential) return null;
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

function evictIdle(now: number): void {
  if (buckets.size < 512) return;
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
  if (EXEMPT_PATH_MARKERS.some((marker) => pathname.includes(marker))) {
    return false;
  }
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

/** Test-only: reset all buckets and re-resolve the self credential. */
export function __resetRequestStormCapForTests(): void {
  buckets.clear();
  selfCredential = undefined;
}
