/**
 * Provides the inference shell's bounded pre-authentication flood backstop.
 * Cloudflare's machine-local counter is primary, with a short deadline and a
 * bounded per-isolate fallback so a platform stall cannot delay inference.
 */

import type { MiddlewareHandler } from "hono";
import { getRequestIp } from "@/lib/middleware/rate-limit-hono-cloudflare";
import { logger } from "@/lib/utils/logger";
import type { AppEnv, RuntimeRateLimitBinding } from "@/types/cloud-worker-env";

const WINDOW_MS = 60_000;
const MAX_REQUESTS = 600;
const MAX_KEYS = 4_096;
const NATIVE_DEADLINE_MS = 20;

interface InferenceIngressBucket {
  count: number;
  resetAt: number;
}

type NativeOutcome =
  | { kind: "decision"; success: boolean }
  | { kind: "failure"; error: unknown }
  | { kind: "timeout" };

const buckets = new Map<string, InferenceIngressBucket>();

function makeRoom(): void {
  if (buckets.size < MAX_KEYS) return;
  const leastRecentlyUsedKey = buckets.keys().next().value;
  if (leastRecentlyUsedKey !== undefined) buckets.delete(leastRecentlyUsedKey);
}

function consumeFallback(key: string, now: number): InferenceIngressBucket {
  const current = buckets.get(key);
  if (current && current.resetAt > now) {
    buckets.delete(key);
    current.count += 1;
    buckets.set(key, current);
    return current;
  }

  if (current) buckets.delete(key);
  makeRoom();
  const bucket = { count: 1, resetAt: now + WINDOW_MS };
  buckets.set(key, bucket);
  return bucket;
}

function nativeDecision(
  binding: RuntimeRateLimitBinding,
  key: string,
): Promise<NativeOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const observed = Promise.resolve()
    .then(() => binding.limit({ key }))
    .then<NativeOutcome, NativeOutcome>(
      ({ success }) => ({ kind: "decision", success }),
      (error: unknown) => ({ kind: "failure", error }),
    );
  const timeout = new Promise<NativeOutcome>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "timeout" }), NATIVE_DEADLINE_MS);
  });
  return Promise.race([observed, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Rejects sustained per-IP inference floods before route authentication. */
export function inferenceIngressRateLimit(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    // CORS preflight does not enter route authentication and must not consume a
    // caller's billable-request ingress budget.
    if (c.req.method === "OPTIONS") {
      await next();
      return;
    }

    const key = `inference:${getRequestIp(c) ?? "unknown"}`;
    const binding = c.env?.GLOBAL_RATE_LIMITER;
    let policy = "cloudflare-native";
    let allowed: boolean;
    let retryAfter = Math.ceil(WINDOW_MS / 1_000);

    if (binding) {
      const outcome = await nativeDecision(binding, key);
      if (outcome.kind === "decision") {
        allowed = outcome.success;
      } else {
        policy = "worker-isolate-fallback";
        logger.warn(
          "[InferenceIngress] Native rate limiter unavailable; using local fallback",
          {
            requestId: c.get("requestId") ?? null,
            traceId: c.get("traceId") ?? null,
            failure:
              outcome.kind === "timeout"
                ? `deadline_exceeded_${NATIVE_DEADLINE_MS}ms`
                : errorDetail(outcome.error),
          },
        );
        const bucket = consumeFallback(key, Date.now());
        allowed = bucket.count <= MAX_REQUESTS;
        retryAfter = Math.max(
          1,
          Math.ceil((bucket.resetAt - Date.now()) / 1_000),
        );
      }
    } else {
      policy = "worker-isolate-fallback";
      const bucket = consumeFallback(key, Date.now());
      allowed = bucket.count <= MAX_REQUESTS;
      retryAfter = Math.max(
        1,
        Math.ceil((bucket.resetAt - Date.now()) / 1_000),
      );
    }

    if (allowed) {
      await next();
      return;
    }

    return c.json(
      {
        success: false,
        error: "Too many requests",
        code: "rate_limit_exceeded" as const,
        message: `Inference ingress limit exceeded. Maximum ${MAX_REQUESTS} requests per minute.`,
        retryAfter,
      },
      429,
      {
        "Retry-After": String(retryAfter),
        "X-RateLimit-Limit": String(MAX_REQUESTS),
        "X-RateLimit-Policy": policy,
      },
    );
  };
}

/** Test-only reset for deterministic process-local middleware coverage. */
export function _resetInferenceIngressRateLimit(): void {
  buckets.clear();
}
