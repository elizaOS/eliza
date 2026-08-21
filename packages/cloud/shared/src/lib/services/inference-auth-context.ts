/**
 * Inference hot-path auth resolver (#9899).
 *
 * `resolveInferenceAuthContext(req)` collapses the pre-forward auth + org +
 * moderation chain into one cache decision for API-key and Steward-session
 * inference. A cold Worker request returns a retryable warming result and
 * hydrates the authoritative decision under `waitUntil`; non-Worker callers may
 * still await the same operation inline for deterministic tools and tests.
 *
 * API keys are keyed by their full hash and Steward sessions by a hash of the
 * verified subject. The cache-backed mode is independently default-off:
 * lifecycle invalidation of an eventually consistent cache is not a strong
 * revocation boundary. Wallet signatures remain on the general non-Worker path
 * because their timestamped proof cannot be replayed as asynchronous cache
 * hydration. Mobile and CLI lifecycle credentials always take the
 * authoritative path because their activation/revocation invariants are
 * stricter than this cache's fixed TTL.
 *
 * Safety invariants:
 *   - A positive IAC entry is written ONLY for a fully-authorized credential.
 *   - Auth failures (invalid/inactive/no-org) throw from the authoritative chain
 *     and propagate unchanged -> the route maps them to the exact 401/403.
 *   - A Worker cache failure returns an explicit unavailable/warming result;
 *     it never authorizes by joining a database fallback to model dispatch.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { ElizaError } from "@elizaos/core";
import { getErrorStatusCode } from "../api/errors";
import { type CacheBackendKind, cache } from "../cache/client";
import { getCloudAwareEnv } from "../runtime/cloud-bindings";
import { logger } from "../utils/logger";
import { adminService } from "./admin";
import { apiKeysService, isCliApiKeySecret, isMobileApiKeySecret } from "./api-keys";
import { contentModerationService } from "./content-moderation";
import { loadInferenceAdmissionSnapshot } from "./inference-admission-snapshot";
import { requireInferenceApiKeyWithOrg } from "./inference-api-key-auth";
import { loadInferenceAppKeyScope } from "./inference-app-key-scope";
import {
  hashApiKey,
  INFERENCE_AUTH_CONTEXT_VERSION,
  type InferenceAuthContext,
  type ResolvedInferenceAuthContext,
  readInferenceAuthContextWithOutcome,
  writeInferenceApiKeyAuthRejection,
  writeInferenceAuthContext,
} from "./inference-auth-cache";
import {
  assertInferenceCredentialActive,
  InferenceCredentialRevokedError,
} from "./inference-credential-revocation";
import { isInferenceAuthCacheEnabled } from "./inference-hot-path-caches";
import { resolveInferenceSessionAuthContext } from "./inference-session-auth-context";

export type {
  InferenceAuthContext,
  InferenceSessionAuthContext,
  ResolvedInferenceAuthContext,
} from "./inference-auth-cache";

export const INFERENCE_AUTH_PROBE_HEADER = "X-Eliza-Auth-Probe";

export type InferenceAuthCredentialSource =
  | "x_api_key"
  | "bearer_api_key"
  | "steward_session"
  | "other";
export type InferenceAuthCacheRead =
  | "not_run"
  | "hit"
  | "rejected"
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
  | "warming"
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
  /** Never join a Postgres hydration to the inference response promise. */
  cacheOnly?: boolean;
  /** Internal background refresh: bypass the combined decision and revalidate. */
  forceAuthoritative?: boolean;
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

const apiKeyHydrations = new Map<string, Promise<void>>();
const AUTH_CONTEXT_REFRESH_AFTER_MS = 30_000;
const DEFAULT_HYDRATION_DEADLINE_MS = 10_000;
const MAX_HYDRATION_DEADLINE_MS = 2_147_483_647;

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
  | {
      kind: "authorized";
      ctx: ResolvedInferenceAuthContext;
      source: "cache" | "origin";
    }
  | { kind: "suspended"; userId?: string }
  | { kind: "rejected"; status: 401 | 403 }
  | { kind: "warming"; hydration?: Promise<unknown> }
  | {
      kind: "slow_path";
      reason: "mobile_api_key" | "non_api_key";
    };

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

/**
 * Wall-clock bound on one background hydration attempt. A hung authoritative
 * resolve (stalled Postgres, dead moderation dependency) must not pin the
 * single-flight slot for the Worker isolate's lifetime — that turned a cold
 * cache into a permanent 503 loop (live incident 2026-08-10: "warming"
 * returned unchanged for minutes because the coalesced hydration never
 * settled). On deadline the slot clears so the next request starts a fresh
 * attempt, and the miss counts toward the authoritative-escape threshold.
 */
export function resolveInferenceAuthHydrationDeadlineMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_HYDRATION_DEADLINE_MS;
  }
  const normalized = raw.trim();
  if (!/^\d+$/.test(normalized)) {
    throw invalidHydrationDeadline(raw);
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_HYDRATION_DEADLINE_MS) {
    throw invalidHydrationDeadline(raw);
  }
  return parsed;
}

function invalidHydrationDeadline(configured: string): ElizaError {
  return new ElizaError(
    `INFERENCE_AUTH_HYDRATION_DEADLINE_MS must be an integer from 1 through ${MAX_HYDRATION_DEADLINE_MS} milliseconds`,
    {
      code: "INVALID_INFERENCE_AUTH_HYDRATION_DEADLINE",
      context: { envKey: "INFERENCE_AUTH_HYDRATION_DEADLINE_MS", configured },
      severity: "fatal",
    },
  );
}

const HYDRATION_DEADLINE_MS = resolveInferenceAuthHydrationDeadlineMs(
  process.env.INFERENCE_AUTH_HYDRATION_DEADLINE_MS,
);

/**
 * After this many consecutive failed or timed-out hydrations for one key,
 * the cacheOnly warming shortcut is bypassed and the request resolves
 * authoritatively inline: slower, but definitive — and the successful inline
 * resolve writes the cache, self-healing the loop. "Retry shortly" must never
 * be a lie the caller can't escape.
 */
const HYDRATION_FAILURE_ESCAPE_THRESHOLD = 3;

const apiKeyHydrationFailures = new Map<string, number>();

function noteHydrationFailure(keyHash: string): void {
  apiKeyHydrationFailures.set(keyHash, (apiKeyHydrationFailures.get(keyHash) ?? 0) + 1);
}

function hydrationEscapeActive(keyHash: string): boolean {
  return (apiKeyHydrationFailures.get(keyHash) ?? 0) >= HYDRATION_FAILURE_ESCAPE_THRESHOLD;
}

function getOrCreateApiKeyHydration(
  req: Request,
  keyHash: string,
  traceId: string | undefined,
): Promise<void> {
  const existing = apiKeyHydrations.get(keyHash);
  if (existing) return existing;

  // The outer Worker waitUntil retains this whole operation, so the
  // authoritative resolver intentionally runs without an execution context:
  // it must finish the cache write before releasing the single-flight slot.
  const attempt = resolveInferenceAuthContext(req, {
    traceId,
    cacheOnly: false,
    forceAuthoritative: true,
  })
    .then(async (result) => {
      if (result.kind === "suspended") {
        const write = await writeInferenceApiKeyAuthRejection(keyHash, "suspended", 403);
        if (write.kind !== "written") {
          throw new Error(`Suspended inference-auth decision cache write failed: ${write.kind}`);
        }
      }
      apiKeyHydrationFailures.delete(keyHash);
    })
    .catch(async (error) => {
      const status = getErrorStatusCode(error);
      if (status === 401 || status === 403) {
        const write = await writeInferenceApiKeyAuthRejection(keyHash, "rejected", status);
        if (write.kind !== "written") {
          logger.warn("[InferenceAuth] rejected decision cache write failed", {
            traceId: boundedTraceId(traceId),
            status,
            cacheWrite: write.kind,
          });
        }
        // A definitive rejection is a successful decision, not a failed
        // hydration — the cache now answers; no escape pressure needed.
        apiKeyHydrationFailures.delete(keyHash);
      } else {
        noteHydrationFailure(keyHash);
      }
      // error-policy:J7 the current request already returned an explicit
      // warming state; preserve the failure in logs and allow a later retry.
      logger.warn("[InferenceAuth] background hydration failed", {
        traceId: boundedTraceId(traceId),
        failureCount: apiKeyHydrationFailures.get(keyHash) ?? 0,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  // Deadline: a never-settling attempt must not hold the single-flight slot.
  // The timed-out promise resolves (never rejects), counts as a failure, and
  // frees the slot for a fresh attempt on the next request.
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const hydration = Promise.race([
    attempt,
    new Promise<void>((resolve) => {
      deadline = setTimeout(() => {
        noteHydrationFailure(keyHash);
        logger.warn("[InferenceAuth] background hydration exceeded deadline", {
          traceId: boundedTraceId(traceId),
          deadlineMs: HYDRATION_DEADLINE_MS,
          failureCount: apiKeyHydrationFailures.get(keyHash) ?? 0,
        });
        resolve();
      }, HYDRATION_DEADLINE_MS);
      if (typeof deadline.unref === "function") deadline.unref();
    }),
  ]);
  apiKeyHydrations.set(keyHash, hydration);
  const clear = () => {
    if (deadline !== undefined) clearTimeout(deadline);
    if (apiKeyHydrations.get(keyHash) === hydration) {
      apiKeyHydrations.delete(keyHash);
    }
  };
  hydration.then(clear, clear);
  return hydration;
}

/** Test hook: reset the hydration-failure escape counters. */
export function __clearInferenceApiKeyHydrationFailures(): void {
  apiKeyHydrationFailures.clear();
}

/** Test hook for isolating coalesced API-key hydration state. */
export function __clearInferenceApiKeyHydrations(): void {
  apiKeyHydrations.clear();
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
    const authCacheEnabled = isInferenceAuthCacheEnabled();
    const extractStartedAt = performance.now();
    const credential = extractApiKeyCredentialWithSource(req);
    trace.timings.extractMs = durationSince(extractStartedAt);
    if (!credential) {
      const session = await resolveInferenceSessionAuthContext(req, {
        cacheOnly: authCacheEnabled && options.cacheOnly,
        useAuthCache: authCacheEnabled,
        executionCtx: options.executionCtx,
      });
      if (session.kind === "not_session") {
        return { kind: "slow_path", reason: "non_api_key" };
      }

      trace.authSource = "steward_session";
      trace.cacheAvailability = cache.isAvailable() ? "available" : "unavailable";
      trace.cacheBackend = cache.getBackendKind();
      if (session.kind === "authorized") {
        trace.cacheRead = session.source === "cache" ? "hit" : "miss";
        trace.authoritative = session.source === "origin" ? "authorized" : "not_run";
        trace.result = session.source === "cache" ? "authorized_cache" : "authorized_origin";
        return session;
      }
      if (session.kind === "warming") {
        trace.cacheRead = cache.isAvailable() ? "miss" : "unavailable";
        trace.result = "warming";
        return session;
      }
      if (session.kind === "suspended") {
        trace.cacheRead = "hit";
        trace.result = "suspended";
        return session;
      }
      trace.cacheRead = "hit";
      trace.result = "rejected";
      return session;
    }
    trace.authSource = credential.source;
    if (isMobileApiKeySecret(credential.rawKey)) {
      return { kind: "slow_path", reason: "mobile_api_key" };
    }
    const isCliCredential = isCliApiKeySecret(credential.rawKey);
    trace.result = "error";
    const probeDiscriminator = controlledProbeDiscriminator(req);
    trace.controlledProbe = probeDiscriminator ? "on" : "off";

    const availabilityStartedAt = performance.now();
    const cacheAvailable = cache.isAvailable();
    trace.timings.cacheAvailabilityMs = durationSince(availabilityStartedAt);
    trace.cacheAvailability = cacheAvailable ? "available" : "unavailable";
    trace.cacheBackend = cache.getBackendKind();

    const keyHash = hashApiKey(credential.rawKey);
    if (authCacheEnabled && cacheAvailable && !options.forceAuthoritative && !isCliCredential) {
      const cacheReadStartedAt = performance.now();
      const cached = await readInferenceAuthContextWithOutcome(
        keyHash,
        probeDiscriminator ?? undefined,
      );
      trace.timings.cacheReadMs = durationSince(cacheReadStartedAt);
      trace.cacheRead = cached.kind;
      trace.cacheBackend = cached.backend;
      if (cached.kind === "hit") {
        try {
          await assertInferenceCredentialActive(cached.ctx.orgId, {
            kind: "api_key",
            credentialId: cached.ctx.apiKeyId,
            userId: cached.ctx.userId,
          });
        } catch (error) {
          if (error instanceof InferenceCredentialRevokedError) {
            trace.result = error.reason === "credential_revoked" ? "rejected" : "suspended";
            return error.reason === "credential_revoked"
              ? { kind: "rejected", status: 401 }
              : { kind: "suspended", userId: cached.ctx.userId };
          }
          throw error;
        }
        const usageUpdate = apiKeysService
          .incrementUsageDebounced(cached.ctx.apiKeyId)
          .catch((error) => {
            // error-policy:J7 usage telemetry must not add latency or create an
            // unhandled rejection on an otherwise authorized inference.
            logger.warn("[InferenceAuth] API-key usage update failed", {
              apiKeyId: cached.ctx.apiKeyId,
              error: error instanceof Error ? error.message : String(error),
            });
          });
        if (options.executionCtx) {
          options.executionCtx.waitUntil(usageUpdate);
          if (Date.now() - cached.ctx.cachedAt >= AUTH_CONTEXT_REFRESH_AFTER_MS) {
            options.executionCtx.waitUntil(
              getOrCreateApiKeyHydration(req, keyHash, options.traceId),
            );
          }
        } else {
          void usageUpdate;
        }
        trace.result = "authorized_cache";
        return { kind: "authorized", ctx: cached.ctx, source: "cache" };
      }
      if (cached.kind === "rejected") {
        trace.result = cached.decision === "suspended" ? "suspended" : "rejected";
        return cached.decision === "suspended"
          ? { kind: "suspended" }
          : { kind: "rejected", status: cached.status };
      }
    } else {
      trace.cacheRead = "unavailable";
    }

    if (
      authCacheEnabled &&
      options.cacheOnly &&
      !isCliCredential &&
      !hydrationEscapeActive(keyHash)
    ) {
      trace.authoritative = "not_run";
      trace.result = "warming";
      if (cacheAvailable && options.executionCtx) {
        const hydration = getOrCreateApiKeyHydration(req, keyHash, options.traceId);
        options.executionCtx.waitUntil(hydration);
        return { kind: "warming", hydration };
      }
      return { kind: "warming" };
    }
    if (authCacheEnabled && options.cacheOnly && !isCliCredential) {
      // Escape hatch: repeated hydration failures/timeouts mean "retry
      // shortly" has become a lie — resolve authoritatively inline instead.
      // The successful resolve below writes the cache, healing the loop.
      logger.warn("[InferenceAuth] hydration escape — resolving inline", {
        traceId: boundedTraceId(options.traceId),
        failureCount: apiKeyHydrationFailures.get(keyHash) ?? 0,
      });
      apiKeyHydrationFailures.delete(keyHash);
    }

    trace.authoritative = "error";
    trace.result = "error";
    const bypassAuthoritativeCaches =
      isCliCredential ||
      options.forceAuthoritative === true ||
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

    const [admission, appScopeId] = authCacheEnabled
      ? await Promise.all([
          loadInferenceAdmissionSnapshot(user.organization_id),
          loadInferenceAppKeyScope(apiKey.id),
        ])
      : [undefined, null];
    const ctx: InferenceAuthContext = {
      v: INFERENCE_AUTH_CONTEXT_VERSION,
      cachedAt: Date.now(),
      userId: user.id,
      orgId: user.organization_id,
      apiKeyId: apiKey.id,
      keyHash,
      appScopeId,
      ...(admission ? { admission } : {}),
    };
    try {
      await assertInferenceCredentialActive(ctx.orgId, {
        kind: "api_key",
        credentialId: ctx.apiKeyId,
        userId: ctx.userId,
      });
    } catch (error) {
      if (error instanceof InferenceCredentialRevokedError) {
        trace.result = error.reason === "credential_revoked" ? "rejected" : "suspended";
        return error.reason === "credential_revoked"
          ? { kind: "rejected", status: 401 }
          : { kind: "suspended", userId: ctx.userId };
      }
      throw error;
    }
    trace.authoritative = "authorized";
    trace.result = "authorized_origin";
    // CLI activation and revocation are primary-consistent. Never write a
    // positive IAC entry that could outlive a later acknowledgement/cancel
    // transition; every inference request re-enters this authoritative path.
    if (isCliCredential) {
      return { kind: "authorized", ctx, source: "origin" };
    }
    const cacheWriteStartedAt = performance.now();
    if (!authCacheEnabled) {
      return { kind: "authorized", ctx, source: "origin" };
    }
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
