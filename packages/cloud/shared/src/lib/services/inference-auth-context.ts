/**
 * Inference hot-path auth resolver (#9899).
 *
 * `resolveInferenceAuthContext(req)` collapses the pre-forward auth + org +
 * moderation chain into a SINGLE KV read for API-key dedicated-agent inference.
 * On a cache miss it runs the existing authoritative chain exactly once, then
 * starts caching the result for the next request. Worker callers register that
 * positive cache write with `waitUntil` so KV latency cannot hold the current
 * authorized response; non-Worker callers await the same operation inline.
 *
 * Scope: ONLY `X-API-Key` / `Bearer eliza_*` credentials are eligible. Wallet
 * (signature/timestamp-bound, fail-closed), Bearer-JWT, and cookie sessions are
 * NOT cacheable (no invalidation path / replay risk) and always take the
 * authoritative slow path. See `packages/cloud/api/docs/inference-hot-path.md`.
 *
 * Safety invariants:
 *   - A positive IAC entry is written ONLY for a fully-authorized credential.
 *   - Auth failures (invalid/inactive/no-org) throw from the authoritative chain
 *     and propagate unchanged -> the route maps them to the exact 401/403.
 *   - No try/catch returns a synthesized context. Cache failure bypasses lower
 *     caches and authorizes from the database, never from stale/fabricated data.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { type CacheBackendKind, cache } from "../cache/client";
import { getCloudAwareEnv } from "../runtime/cloud-bindings";
import { logger } from "../utils/logger";
import { adminService } from "./admin";
import { apiKeysService } from "./api-keys";
import { contentModerationService } from "./content-moderation";
import { requireInferenceApiKeyWithOrg } from "./inference-api-key-auth";
import {
  hashApiKey,
  INFERENCE_AUTH_CONTEXT_VERSION,
  type InferenceAuthContext,
  readInferenceAuthContextWithOutcome,
  writeInferenceAuthContext,
} from "./inference-auth-cache";

export type { InferenceAuthContext } from "./inference-auth-cache";

export const INFERENCE_AUTH_PROBE_HEADER = "X-Eliza-Auth-Probe";

export type InferenceAuthCredentialSource = "x_api_key" | "bearer_api_key" | "other";
export type InferenceAuthCacheRead =
  | "not_run"
  | "hit"
  | "miss"
  | "invalid"
  | "unavailable"
  | "error";
export type InferenceAuthAuthoritativeResult =
  | "not_run"
  | "authorized"
  | "suspended"
  | "rejected"
  | "error";
export type InferenceAuthCacheWrite =
  | "not_run"
  | "deferred"
  | "written"
  | "invalid"
  | "unavailable"
  | "error";
export type InferenceAuthResult =
  | "authorized_cache"
  | "authorized_origin"
  | "suspended"
  | "slow_path"
  | "rejected"
  | "error";

export interface InferenceAuthTimings {
  readonly extractMs: number;
  readonly cacheAvailabilityMs: number | null;
  readonly cacheReadMs: number | null;
  readonly keyLookupMs: number | null;
  readonly userOrgLookupMs: number | null;
  readonly moderationMs: number | null;
  readonly cacheWriteMs: number | null;
  readonly totalMs: number;
}

/** A privacy-bounded snapshot shared by structured logs and response telemetry. */
export interface InferenceAuthTelemetry {
  readonly v: 1;
  readonly traceId: string;
  readonly authSource: InferenceAuthCredentialSource;
  readonly controlledProbe: "on" | "off";
  readonly cacheAvailability: "not_checked" | "available" | "unavailable";
  readonly cacheBackend: CacheBackendKind;
  readonly cacheRead: InferenceAuthCacheRead;
  readonly authoritative: InferenceAuthAuthoritativeResult;
  readonly cacheWrite: InferenceAuthCacheWrite;
  readonly result: InferenceAuthResult;
  readonly timings: InferenceAuthTimings;
}

/** Completion record for a positive cache population deferred off the request path. */
export interface InferenceAuthCacheWriteTelemetry {
  readonly v: 1;
  readonly kind: "cache_write";
  readonly traceId: string;
  readonly cacheBackend: CacheBackendKind;
  readonly cacheWrite: Exclude<InferenceAuthCacheWrite, "not_run" | "deferred">;
  readonly durationMs: number;
}

export interface ResolveInferenceAuthOptions {
  traceId?: string;
  onTelemetry?(telemetry: InferenceAuthTelemetry): void;
  executionCtx?: { waitUntil(promise: Promise<unknown>): void };
  onCacheWriteTelemetry?(telemetry: InferenceAuthCacheWriteTelemetry): void;
}

interface MutableInferenceAuthTrace {
  authSource: InferenceAuthCredentialSource;
  controlledProbe: "on" | "off";
  cacheAvailability: "not_checked" | "available" | "unavailable";
  cacheBackend: CacheBackendKind;
  cacheRead: InferenceAuthCacheRead;
  authoritative: InferenceAuthAuthoritativeResult;
  cacheWrite: InferenceAuthCacheWrite;
  result: InferenceAuthResult;
  timings: {
    extractMs: number;
    cacheAvailabilityMs: number | null;
    cacheReadMs: number | null;
    keyLookupMs: number | null;
    userOrgLookupMs: number | null;
    moderationMs: number | null;
    cacheWriteMs: number | null;
  };
}

const OPAQUE_TRACE_ID =
  /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

function boundedTraceId(traceId: string | undefined): string {
  const value = traceId?.trim();
  return value && OPAQUE_TRACE_ID.test(value) ? value.toLowerCase() : "unavailable";
}

function durationSince(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 100) / 100;
}

function controlledProbeDiscriminator(req: Request): string | null {
  const expected = getCloudAwareEnv().INFERENCE_AUTH_PROBE_TOKEN;
  const supplied = req.headers.get(INFERENCE_AUTH_PROBE_HEADER);
  if (!expected || !supplied) return null;
  if (supplied.length > 512) return null;
  const separator = supplied.lastIndexOf(":");
  if (separator <= 0) return null;
  const token = supplied.slice(0, separator);
  const nonce = supplied.slice(separator + 1);
  if (!/^[0-9a-f]{32}$/.test(nonce)) return null;
  const expectedDigest = createHash("sha256").update(expected).digest();
  const suppliedDigest = createHash("sha256").update(token).digest();
  if (!timingSafeEqual(expectedDigest, suppliedDigest)) return null;
  return createHash("sha256").update(nonce).digest("hex");
}

function freezeTrace(
  traceId: string | undefined,
  trace: MutableInferenceAuthTrace,
  totalStartedAt: number,
): InferenceAuthTelemetry {
  return Object.freeze({
    v: 1 as const,
    traceId: boundedTraceId(traceId),
    authSource: trace.authSource,
    controlledProbe: trace.controlledProbe,
    cacheAvailability: trace.cacheAvailability,
    cacheBackend: trace.cacheBackend,
    cacheRead: trace.cacheRead,
    authoritative: trace.authoritative,
    cacheWrite: trace.cacheWrite,
    result: trace.result,
    timings: Object.freeze({
      ...trace.timings,
      totalMs: durationSince(totalStartedAt),
    }),
  });
}

function freezeCacheWriteTrace(
  traceId: string | undefined,
  write: Awaited<ReturnType<typeof writeInferenceAuthContext>>,
  startedAt: number,
): InferenceAuthCacheWriteTelemetry {
  return Object.freeze({
    v: 1 as const,
    kind: "cache_write" as const,
    traceId: boundedTraceId(traceId),
    cacheBackend: write.backend,
    cacheWrite: write.kind,
    durationMs: durationSince(startedAt),
  });
}

/**
 * Discriminated resolution outcome.
 *   - `authorized`: proceed; the route uses ctx and SKIPS auth + moderation.
 *   - `suspended`: the route returns the 403 account-suspended response.
 *   - `slow_path`: the route runs the general auth chain for non-API-key credentials.
 */
export type InferenceAuthResolution =
  | { kind: "authorized"; ctx: InferenceAuthContext; source: "cache" | "origin" }
  | { kind: "suspended"; userId: string }
  | { kind: "slow_path"; reason: "non_api_key" };

/**
 * Extract a cacheable API-key credential from the request, mirroring the
 * precedence of `requireAuthOrApiKey`. Returns null when the request is not
 * eligible for the fast path (wallet headers present, or no API key).
 */
function extractApiKeyCredentialWithSource(
  req: Request,
): { rawKey: string; source: Exclude<InferenceAuthCredentialSource, "other"> } | null {
  // Wallet auth is fail-closed and replay-protected - never cache it.
  if (
    req.headers.get("X-Wallet-Address") &&
    req.headers.get("X-Wallet-Signature") &&
    req.headers.get("X-Timestamp")
  ) {
    return null;
  }

  const xApiKey = req.headers.get("X-API-Key");
  if (xApiKey && xApiKey.trim().length > 0) {
    return { rawKey: xApiKey.trim(), source: "x_api_key" };
  }

  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) {
    const token = auth.slice(7).trim();
    // Only `eliza_*` bearer tokens are API keys (matches requireAuthOrApiKey).
    if (token.startsWith("eliza_")) return { rawKey: token, source: "bearer_api_key" };
  }

  return null;
}

export function extractApiKeyCredential(req: Request): string | null {
  return extractApiKeyCredentialWithSource(req)?.rawKey ?? null;
}

export async function resolveInferenceAuthContext(
  req: Request,
  options: ResolveInferenceAuthOptions = {},
): Promise<InferenceAuthResolution> {
  const totalStartedAt = performance.now();
  const trace: MutableInferenceAuthTrace = {
    authSource: "other",
    controlledProbe: "off",
    cacheAvailability: "not_checked",
    cacheBackend: "none",
    cacheRead: "not_run",
    authoritative: "not_run",
    cacheWrite: "not_run",
    result: "slow_path",
    timings: {
      extractMs: 0,
      cacheAvailabilityMs: null,
      cacheReadMs: null,
      keyLookupMs: null,
      userOrgLookupMs: null,
      moderationMs: null,
      cacheWriteMs: null,
    },
  };

  try {
    const extractStartedAt = performance.now();
    const credential = extractApiKeyCredentialWithSource(req);
    trace.timings.extractMs = durationSince(extractStartedAt);
    if (!credential) return { kind: "slow_path", reason: "non_api_key" };
    trace.authSource = credential.source;
    trace.result = "error";
    const probeDiscriminator = controlledProbeDiscriminator(req);
    trace.controlledProbe = probeDiscriminator ? "on" : "off";

    const availabilityStartedAt = performance.now();
    const cacheAvailable = cache.isAvailable();
    trace.timings.cacheAvailabilityMs = durationSince(availabilityStartedAt);
    trace.cacheAvailability = cacheAvailable ? "available" : "unavailable";
    trace.cacheBackend = cache.getBackendKind();

    const keyHash = hashApiKey(credential.rawKey);
    if (cacheAvailable) {
      const cacheReadStartedAt = performance.now();
      const cached = await readInferenceAuthContextWithOutcome(
        keyHash,
        probeDiscriminator ?? undefined,
      );
      trace.timings.cacheReadMs = durationSince(cacheReadStartedAt);
      trace.cacheRead = cached.kind;
      trace.cacheBackend = cached.backend;
      if (cached.kind === "hit") {
        void apiKeysService.incrementUsageDebounced(cached.ctx.apiKeyId);
        trace.result = "authorized_cache";
        return { kind: "authorized", ctx: cached.ctx, source: "cache" };
      }
    } else {
      trace.cacheRead = "unavailable";
    }

    trace.authoritative = "error";
    trace.result = "error";
    const bypassAuthoritativeCaches =
      trace.controlledProbe === "on" ||
      trace.cacheRead === "invalid" ||
      trace.cacheRead === "unavailable" ||
      trace.cacheRead === "error";
    const { user, apiKey } = await requireInferenceApiKeyWithOrg(credential.rawKey, {
      bypassCache: bypassAuthoritativeCaches,
      timing: {
        keyLookup: (durationMs) => {
          trace.timings.keyLookupMs = Math.round(durationMs * 100) / 100;
        },
        userOrgLookup: (durationMs) => {
          trace.timings.userOrgLookupMs = Math.round(durationMs * 100) / 100;
        },
      },
      rejected: () => {
        trace.authoritative = "rejected";
        trace.result = "rejected";
      },
    });

    const moderationStartedAt = performance.now();
    // Cache failure recovery cannot authorize from another process-local memo;
    // the normal healthy-miss path retains the bounded moderation memo.
    const suspended = bypassAuthoritativeCaches
      ? await adminService.shouldBlockUser(user.id)
      : await contentModerationService.shouldBlockUser(user.id);
    trace.timings.moderationMs = durationSince(moderationStartedAt);
    if (suspended) {
      trace.authoritative = "suspended";
      trace.result = "suspended";
      return { kind: "suspended", userId: user.id };
    }

    const ctx: InferenceAuthContext = {
      v: INFERENCE_AUTH_CONTEXT_VERSION,
      cachedAt: Date.now(),
      userId: user.id,
      orgId: user.organization_id,
      apiKeyId: apiKey.id,
      keyHash,
    };
    trace.authoritative = "authorized";
    trace.result = "authorized_origin";
    const cacheWriteStartedAt = performance.now();
    const cacheWrite = writeInferenceAuthContext(ctx);
    if (cacheAvailable && typeof options.executionCtx?.waitUntil === "function") {
      trace.cacheWrite = "deferred";
      const observedWrite = cacheWrite.then((write) => {
        const telemetry = freezeCacheWriteTrace(options.traceId, write, cacheWriteStartedAt);
        logger.info("[InferenceAuth] trace", telemetry);
        options.onCacheWriteTelemetry?.(telemetry);
      });
      // Authorization is already authoritative; waitUntil preserves cache
      // population and its observed outcome without holding the response path.
      options.executionCtx.waitUntil(observedWrite);
    } else {
      const write = await cacheWrite;
      trace.timings.cacheWriteMs = durationSince(cacheWriteStartedAt);
      trace.cacheWrite = write.kind;
      trace.cacheBackend = write.backend;
    }
    return { kind: "authorized", ctx, source: "origin" };
  } finally {
    const telemetry = freezeTrace(options.traceId, trace, totalStartedAt);
    logger.info("[InferenceAuth] trace", telemetry);
    options.onTelemetry?.(telemetry);
  }
}
