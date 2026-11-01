/**
 * Inference hot-path auth resolver (#9899).
 *
 * `resolveInferenceAuthContext(req)` collapses the pre-forward auth + org +
 * moderation chain into one cache decision for API-key and Steward-session
 * inference.
 *
 * Qualified Worker hot path (`cacheOnly`, authorization caching and strong
 * revocation enabled): the request is decided by ONE cache read and
 * never queries Postgres, not even on a miss. Entries are stale-while-
 * revalidate: an entry older than the refresh age is still served, and one
 * coalesced authoritative refresh runs under `waitUntil`; when it finds a
 * suspension, revocation, plan or policy change it rewrites the entry so the
 * next request fails (one stale allow is accepted). A true miss returns a
 * retryable warming result and hydrates under `waitUntil`. Writers (key
 * revoke/delete, ban, org disable) invalidate entries directly.
 *
 * API keys (including mobile lifecycle keys, whose revocations invalidate the
 * same key-hash entry) are keyed by their full hash and Steward sessions by a
 * hash of the verified subject. Wallet signatures remain on the general
 * non-Worker path because their timestamped proof cannot be replayed as
 * asynchronous cache hydration.
 *
 * Safety invariants:
 *   - A positive IAC entry is written ONLY for a fully-authorized credential.
 *   - Auth failures (invalid/inactive/no-org) throw from the authoritative chain
 *     and propagate unchanged -> the route maps them to the exact 401/403.
 *   - A Worker cache miss or failure returns an explicit retryable warming
 *     result; hydration never joins the request.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { ElizaError } from "@elizaos/core";
import { dbWrite } from "../../db/helpers";
import { AuthenticationError, ForbiddenError, getErrorStatusCode } from "../api/errors";
import { type CacheBackendKind, cache } from "../cache/client";
import { getCloudAwareEnv } from "../runtime/cloud-bindings";
import { logger } from "../utils/logger";
import { adminService } from "./admin";
import { apiKeysService } from "./api-keys";
import {
  inferenceAdmissionSnapshotInTransaction,
  loadInferenceAdmissionSnapshot,
} from "./inference-admission-snapshot";
import { requireInferenceApiKeyWithOrg } from "./inference-api-key-auth";
import { loadInferenceAppKeyScope } from "./inference-app-key-scope";
import type { InferenceAuthRejectionReason } from "./inference-auth-cache";
import {
  hashApiKey,
  INFERENCE_AUTH_CONTEXT_VERSION,
  type InferenceAuthContext,
  type ResolvedInferenceAuthContext,
  readInferenceAuthContextWithOutcome,
  startOffResponse,
  writeInferenceApiKeyAuthRejection,
  writeInferenceAuthContext,
} from "./inference-auth-cache";
import {
  assertInferenceCredentialActive,
  type InferenceCredentialCheck,
  InferenceCredentialRevocationUnavailableError,
  InferenceCredentialRevokedError,
  inferenceCredentialRevocationReason,
  isInferenceStrongRevocationEnabled,
} from "./inference-credential-revocation";
import { isInferencePolicyAdmissionEnabled } from "./inference-funded-budget-admission";
import { isInferenceAuthCacheEnabled } from "./inference-hot-path-caches";
import { resolveInferenceSessionAuthContext } from "./inference-session-auth-context";
import { readOrganizationQuotaPolicyInTransaction } from "./organization-quota-policy";

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
  /** Combined key/user/organization primary statement. */
  readonly identityLookupMs: number | null;
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
  /**
   * Request cache-only resolution when authorization caching is eligible.
   * With that staged rollout enabled, a miss returns `warming` and hydrates
   * under `waitUntil`; disabled hosts retain authoritative authorization.
   */
  cacheOnly?: boolean;
  /** Internal background refresh: bypass the combined decision and revalidate. */
  forceAuthoritative?: boolean;
  /** Internal hook preserving a bounded authoritative standing reason. */
  onAuthoritativeRejection?(reason: InferenceAuthRejectionReason): void;
  /** The caller will fuse this strong check into its atomic admission lease. */
  deferStrongCredentialCheck?: boolean;
  /** Return verified identity metadata for a bounded speech session; never skips an auth check. */
  includeVerifiedCredential?: boolean;
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
    identityLookupMs: number | null;
    moderationMs: number | null;
    cacheWriteMs: number | null;
  };
}

type InferenceStandingDecisionSource = "authoritative" | "cache" | "session_resolution";

interface ApiKeyHydration {
  readonly decision: Promise<InferenceAuthResolution | undefined>;
  readonly projection: Promise<void>;
  authoritativeTelemetry(): InferenceAuthTelemetry;
  projectionTelemetry(): InferenceAuthCacheWriteTelemetry | undefined;
}

const apiKeyHydrations = new Map<string, ApiKeyHydration>();
const SKIP_CACHE_PROJECTION_WRITE = Symbol("skip-cache-projection-write");
// A cold request owns the canonical denial log after consuming its nested
// authoritative continuation; hydration diagnostics have a distinct log scope.
const SUPPRESS_STANDING_DENIAL_LOG = Symbol("suppress-standing-denial-log");
/** Age after which a served entry is re-authorized from Postgres under `waitUntil`. */
export const AUTH_CONTEXT_REFRESH_AFTER_MS = 30_000;
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
      credential?: InferenceCredentialCheck;
    }
  | { kind: "suspended"; userId?: string; reason?: InferenceAuthRejectionReason }
  | { kind: "rejected"; status: 401 | 403; reason?: InferenceAuthRejectionReason }
  | {
      kind: "warming";
      /** Background hydration retained under `waitUntil`; never awaited by the request. */
      hydration?: Promise<unknown>;
    }
  | { kind: "slow_path"; reason: "mobile_api_key" | "non_api_key" };

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

function isExpiredApiKeyContext(ctx: InferenceAuthContext): boolean {
  return typeof ctx.apiKeyExpiresAt === "number" && ctx.apiKeyExpiresAt <= Date.now();
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

function getOrCreateApiKeyHydration(
  req: Request,
  keyHash: string,
  options: ResolveInferenceAuthOptions & {
    executionCtx: { waitUntil(promise: Promise<unknown>): void };
  },
): ApiKeyHydration {
  const existing = apiKeyHydrations.get(keyHash);
  if (existing) {
    options.executionCtx.waitUntil(existing.projection);
    return existing;
  }

  let authoritativeRejectionReason: InferenceAuthRejectionReason | undefined;
  let authoritativeTelemetry: InferenceAuthTelemetry | undefined;
  let projectionTelemetry: InferenceAuthCacheWriteTelemetry | undefined;

  // The authoritative decision and its cache projection are separate promises.
  // A request may consume the decision immediately and carry its credential to
  // the atomic admission lease, while refresh-only callers retain the
  // projection barrier, including its standalone strong credential check.
  const hydrationOptions: ResolveInferenceAuthOptions & {
    [SKIP_CACHE_PROJECTION_WRITE]: true;
    [SUPPRESS_STANDING_DENIAL_LOG]: true;
  } = {
    traceId: options.traceId,
    // Background hydration builds a cacheable decision (with its admission
    // snapshot) but skips the cache read and the warming shortcut.
    cacheOnly: true,
    forceAuthoritative: true,
    deferStrongCredentialCheck: true,
    [SKIP_CACHE_PROJECTION_WRITE]: true,
    [SUPPRESS_STANDING_DENIAL_LOG]: true,
    onTelemetry: (telemetry) => {
      authoritativeTelemetry = telemetry;
    },
    onAuthoritativeRejection: (reason) => {
      authoritativeRejectionReason = reason;
    },
  };
  const attempt = startOffResponse(() => resolveInferenceAuthContext(req, hydrationOptions))
    .then((result): InferenceAuthResolution => result)
    .catch((error): InferenceAuthResolution | undefined => {
      const status = getErrorStatusCode(error);
      if (status === 401 || status === 403) {
        const reason = authoritativeRejectionReason ?? "credential_invalid";
        // A definitive rejection is a successful decision. The projection
        // barrier below owns its negative cache write.
        return { kind: "rejected", status, reason };
      }
      // error-policy:J7 the current request already returned an explicit
      // warming state; preserve the failure in logs and allow a later retry.
      logger.warn("[InferenceAuth] background hydration failed", {
        traceId: boundedTraceId(options.traceId),
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
      return undefined;
    });
  // Deadline: a never-settling attempt must not hold the single-flight slot.
  // The timed-out promise resolves (never rejects), counts as a failure, and
  // frees the slot for a fresh attempt on the next request.
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const decision = Promise.race([
    attempt,
    new Promise<undefined>((resolve) => {
      deadline = setTimeout(() => {
        logger.warn("[InferenceAuth] background hydration exceeded deadline", {
          traceId: boundedTraceId(options.traceId),
          deadlineMs: HYDRATION_DEADLINE_MS,
        });
        resolve(undefined);
      }, HYDRATION_DEADLINE_MS);
      if (typeof deadline.unref === "function") deadline.unref();
    }),
  ]);

  const projection = decision
    .then(async (result) => {
      if (!result) return;
      if (result.kind === "authorized" && "keyHash" in result.ctx) {
        const credential: InferenceCredentialCheck = {
          kind: "api_key",
          credentialId: result.ctx.apiKeyId,
          userId: result.ctx.userId,
          rateLimit: result.ctx.apiKeyRateLimit,
          expiresAt: result.ctx.apiKeyExpiresAt,
        };
        try {
          await assertInferenceCredentialActive(result.ctx.orgId, credential);
        } catch (error) {
          if (!(error instanceof InferenceCredentialRevocationUnavailableError)) throw error;
          // error-policy:J2 background projection may retry one unavailable
          // read with a fresh stub. A cold object can outlive the short check
          // deadline; abandoning the projection leaves every later request
          // paying origin auth again. Neither attempt authorizes inference,
          // extends cache freshness, nor retries an explicit revocation.
          logger.info("[InferenceAuth] retrying background credential projection", {
            traceId: boundedTraceId(options.traceId),
          });
          await assertInferenceCredentialActive(result.ctx.orgId, credential);
        }
        const startedAt = performance.now();
        const write = await writeInferenceAuthContext(result.ctx);
        const telemetry = freezeCacheWriteTrace(options.traceId, write, startedAt);
        projectionTelemetry = telemetry;
        logger.info("[InferenceAuth] hydration cache write", telemetry);
        if (write.kind !== "written") {
          logger.warn("[InferenceAuth] positive decision cache write failed", {
            traceId: boundedTraceId(options.traceId),
            cacheWrite: write.kind,
          });
        }
        return;
      }
      if (result.kind !== "suspended" && result.kind !== "rejected") return;
      const status = result.kind === "suspended" ? 403 : result.status;
      const decision = result.kind === "suspended" ? "suspended" : "rejected";
      const reason =
        result.reason ??
        (result.kind === "suspended" ? "moderation_blocked" : "credential_invalid");
      const write = await writeInferenceApiKeyAuthRejection(keyHash, decision, status, reason);
      if (write.kind !== "written") {
        logger.warn("[InferenceAuth] negative decision cache write failed", {
          traceId: boundedTraceId(options.traceId),
          status,
          cacheWrite: write.kind,
        });
      }
    })
    .catch((error) => {
      // error-policy:J7 the authoritative decision is independently observed;
      // a failed projection remains fail-closed and must not reject waitUntil.
      logger.warn("[InferenceAuth] deferred cache projection failed", {
        traceId: boundedTraceId(options.traceId),
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
    });

  const hydration: ApiKeyHydration = {
    decision,
    projection,
    authoritativeTelemetry: () => {
      if (!authoritativeTelemetry) {
        throw new ElizaError("Authoritative hydration completed without telemetry", {
          code: "INFERENCE_AUTH_HYDRATION_TELEMETRY_MISSING",
          context: { traceId: boundedTraceId(options.traceId) },
        });
      }
      return authoritativeTelemetry;
    },
    projectionTelemetry: () => projectionTelemetry,
  };
  apiKeyHydrations.set(keyHash, hydration);
  options.executionCtx.waitUntil(projection);
  const clearDeadline = () => {
    if (deadline !== undefined) clearTimeout(deadline);
  };
  decision.then(clearDeadline, clearDeadline);
  const clearProjection = () => {
    if (apiKeyHydrations.get(keyHash) === hydration) {
      apiKeyHydrations.delete(keyHash);
    }
  };
  projection.then(clearProjection, clearProjection);
  return hydration;
}

/** Correlate one shared projection to each request that consumed its decision. */
function observeHydrationProjection(
  hydration: ApiKeyHydration,
  options: ResolveInferenceAuthOptions & {
    executionCtx: { waitUntil(promise: Promise<unknown>): void };
  },
  canonical: boolean,
): void {
  const observed = hydration.projection
    .then(() => {
      const completed = hydration.projectionTelemetry();
      // Projection failures are already reported by the hydration boundary.
      if (!completed) return;
      const telemetry = Object.freeze({ ...completed, traceId: boundedTraceId(options.traceId) });
      if (canonical) logger.audit("[InferenceAuth] trace", telemetry);
      options.onCacheWriteTelemetry?.(telemetry);
    })
    .catch((error) => {
      // error-policy:J7 diagnostic callbacks must not reject the observed projection.
      logger.warn("[InferenceAuth] deferred projection telemetry failed", {
        traceId: boundedTraceId(options.traceId),
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
    });
  options.executionCtx.waitUntil(observed);
}

/** Test hook for isolating coalesced API-key hydration state. */
export function __clearInferenceApiKeyHydrations(): void {
  apiKeyHydrations.clear();
}

/** Retain accepted API-key usage telemetry when a cold-auth continuation is consumed. */
export function observeInferenceApiKeyUsage(
  resolution: InferenceAuthResolution,
  executionCtx?: { waitUntil(promise: Promise<unknown>): void },
): void {
  if (resolution.kind !== "authorized" || resolution.ctx.apiKeyId === null) return;
  const apiKeyId = resolution.ctx.apiKeyId;
  const usageUpdate = startOffResponse(() =>
    apiKeysService.incrementUsageDebounced(apiKeyId),
  ).catch((error) => {
    // error-policy:J7 usage telemetry must not add latency or reject an
    // otherwise authorized inference continuation.
    logger.warn("[InferenceAuth] API-key usage update failed", {
      apiKeyId: resolution.ctx.apiKeyId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  if (executionCtx) {
    executionCtx.waitUntil(usageUpdate);
  } else {
    void usageUpdate;
  }
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
      identityLookupMs: null,
      moderationMs: null,
      cacheWriteMs: null,
    },
  };
  let standingDenialLogged = false;
  let authoritativeStandingReason: InferenceAuthRejectionReason | undefined;
  const logStandingDenial = (params: {
    status: 401 | 403;
    reason: unknown;
    source: InferenceStandingDecisionSource;
  }): void => {
    standingDenialLogged = true;
    if (
      (
        options as ResolveInferenceAuthOptions & {
          [SUPPRESS_STANDING_DENIAL_LOG]?: true;
        }
      )[SUPPRESS_STANDING_DENIAL_LOG]
    ) {
      return;
    }
    const reason =
      typeof params.reason === "string" && /^[a-z0-9_:-]{1,64}$/.test(params.reason)
        ? params.reason
        : "unavailable";
    logger.error("[InferenceAuth] account standing denied inference", {
      traceId: boundedTraceId(options.traceId),
      status: params.status,
      reason,
      authSource: trace.authSource,
      cacheBackend: trace.cacheBackend,
      cacheRead: trace.cacheRead,
      source: params.source,
    });
  };

  try {
    // A Worker request must not bypass the staged positive-cache and strongly
    // consistent revocation contract merely by selecting cache-only resolution.
    const authCacheEnabled = isInferenceAuthCacheEnabled();
    const deferStrongCredentialCheck =
      authCacheEnabled &&
      options.deferStrongCredentialCheck === true &&
      isInferenceStrongRevocationEnabled();
    const extractStartedAt = performance.now();
    const credential = extractApiKeyCredentialWithSource(req);
    trace.timings.extractMs = durationSince(extractStartedAt);
    if (!credential) {
      const session = await resolveInferenceSessionAuthContext(req, {
        cacheOnly: options.cacheOnly,
        useAuthCache: authCacheEnabled,
        executionCtx: options.executionCtx,
        deferStrongCredentialCheck,
        includeVerifiedCredential: options.includeVerifiedCredential === true,
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
        logStandingDenial({
          status: 403,
          reason: session.reason,
          source: "session_resolution",
        });
        return session;
      }
      trace.cacheRead = "hit";
      trace.result = "rejected";
      logStandingDenial({
        status: session.status,
        reason: session.reason,
        source: "session_resolution",
      });
      return session;
    }
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
    if (authCacheEnabled && cacheAvailable && !options.forceAuthoritative) {
      const cacheReadStartedAt = performance.now();
      const cached = await readInferenceAuthContextWithOutcome(
        keyHash,
        probeDiscriminator ?? undefined,
        options.executionCtx,
      );
      trace.timings.cacheReadMs = durationSince(cacheReadStartedAt);
      trace.cacheRead = cached.kind;
      trace.cacheBackend = cached.backend;
      // Stale-while-revalidate: an aged entry (positive or denial) is still
      // the decision for THIS request; one coalesced authoritative refresh
      // runs under `waitUntil` and rewrites the entry for later requests.
      // The deferred-credential branch returns early below, so the refresh
      // must be scheduled before it (#30722).
      const scheduleRefresh = (cachedAt: number, force = false) => {
        if (!options.executionCtx) return;
        if (!force && Date.now() - cachedAt < AUTH_CONTEXT_REFRESH_AFTER_MS) return;
        const hydrationOptions = {
          ...options,
          executionCtx: options.executionCtx,
        };
        const hydration = getOrCreateApiKeyHydration(req, keyHash, hydrationOptions);
        observeHydrationProjection(hydration, hydrationOptions, false);
      };
      if (cached.kind === "hit" && isExpiredApiKeyContext(cached.ctx)) {
        // The cached key expiry is part of the decision: deny locally and let
        // the refresh persist the authoritative denial.
        scheduleRefresh(cached.ctx.cachedAt, true);
        trace.result = "rejected";
        logStandingDenial({ status: 401, reason: "credential_invalid", source: "cache" });
        return { kind: "rejected", status: 401, reason: "credential_invalid" };
      }
      if (cached.kind === "hit") {
        const credential: InferenceCredentialCheck = {
          kind: "api_key",
          credentialId: cached.ctx.apiKeyId,
          userId: cached.ctx.userId,
          rateLimit: cached.ctx.apiKeyRateLimit,
          expiresAt: cached.ctx.apiKeyExpiresAt,
        };
        const scheduleAgedRefresh = () => scheduleRefresh(cached.ctx.cachedAt);
        if (deferStrongCredentialCheck) {
          observeInferenceApiKeyUsage(
            { kind: "authorized", ctx: cached.ctx, source: "cache" },
            options.executionCtx,
          );
          scheduleAgedRefresh();
          trace.result = "authorized_cache";
          return {
            kind: "authorized",
            ctx: cached.ctx,
            source: "cache",
            credential,
          };
        }
        try {
          await assertInferenceCredentialActive(cached.ctx.orgId, credential);
        } catch (error) {
          if (error instanceof InferenceCredentialRevokedError) {
            trace.result = error.reason === "credential_revoked" ? "rejected" : "suspended";
            const reason = inferenceCredentialRevocationReason(error.reason);
            logStandingDenial({
              status: error.reason === "credential_revoked" ? 401 : 403,
              reason,
              source: "authoritative",
            });
            return error.reason === "credential_revoked"
              ? { kind: "rejected", status: 401, reason }
              : { kind: "suspended", userId: cached.ctx.userId, reason };
          }
          throw error;
        }
        observeInferenceApiKeyUsage(
          { kind: "authorized", ctx: cached.ctx, source: "cache" },
          options.executionCtx,
        );
        scheduleAgedRefresh();
        trace.result = "authorized_cache";
        return {
          kind: "authorized",
          ctx: cached.ctx,
          source: "cache",
          ...(options.includeVerifiedCredential === true ? { credential } : {}),
        };
      }
      if (cached.kind === "rejected") {
        scheduleRefresh(cached.cachedAt);
        trace.result = cached.decision === "suspended" ? "suspended" : "rejected";
        logStandingDenial({
          status: cached.status,
          reason: cached.reason,
          source: "cache",
        });
        return cached.decision === "suspended"
          ? { kind: "suspended", reason: cached.reason }
          : { kind: "rejected", status: cached.status, reason: cached.reason };
      }
    } else if (!cacheAvailable) {
      trace.cacheRead = "unavailable";
    }

    // Cache-only resolution needs a configured cache backend; every deployed
    // environment has one. Without any backend (local dev, e2e harness) a miss
    // could never hydrate, so those hosts keep the authoritative path.
    if (
      authCacheEnabled &&
      options.cacheOnly &&
      !options.forceAuthoritative &&
      cache.isBackendConfigured()
    ) {
      // A true miss (or an unreadable cache) never queries Postgres inline:
      // the request gets a retryable warming result and the authoritative
      // decision is projected into the cache under `waitUntil`.
      trace.authoritative = "not_run";
      trace.result = "warming";
      if (cacheAvailable && options.executionCtx) {
        const hydrationOptions = { ...options, executionCtx: options.executionCtx };
        const hydration = getOrCreateApiKeyHydration(req, keyHash, hydrationOptions);
        trace.cacheWrite = "deferred";
        observeHydrationProjection(hydration, hydrationOptions, true);
        return { kind: "warming", hydration: hydration.projection };
      }
      return { kind: "warming" };
    }

    trace.authoritative = "error";
    trace.result = "error";
    let { user, apiKey } = await requireInferenceApiKeyWithOrg(credential.rawKey, {
      timing: {
        identityLookup: (durationMs) => {
          trace.timings.identityLookupMs = Math.round(durationMs * 100) / 100;
        },
      },
      rejected: (reason) => {
        authoritativeStandingReason = reason;
        options.onAuthoritativeRejection?.(reason);
        trace.authoritative = "rejected";
        trace.result = "rejected";
      },
    });
    // Tenant isolation: the cached decision is bound to one organization, and
    // the Worker limiter never re-reads the key row. A key whose row belongs
    // to another organization than its user is refused here, once, and that
    // denial is what the cache projects.
    if (apiKey.organization_id !== user.organization_id) {
      authoritativeStandingReason = "membership_missing";
      options.onAuthoritativeRejection?.("membership_missing");
      trace.authoritative = "rejected";
      trace.result = "rejected";
      throw new ForbiddenError("API key does not belong to the caller's organization");
    }

    const moderationStartedAt = performance.now();
    // Every IAC miss is an authorization refresh, so it must read moderation
    // from the primary rather than re-projecting an isolate-local memo or a
    // lagging replica after an unban invalidated the shared denial.
    const suspended = await adminService.shouldBlockUserConsistent(user.id);
    trace.timings.moderationMs = durationSince(moderationStartedAt);
    if (suspended) {
      trace.authoritative = "suspended";
      trace.result = "suspended";
      logStandingDenial({
        status: 403,
        reason: "moderation_blocked",
        source: "authoritative",
      });
      return { kind: "suspended", userId: user.id, reason: "moderation_blocked" };
    }

    // One MVCC snapshot binds identity, moderation and limits to the policy
    // epoch. Dispatch validates that epoch with the Durable Object authority.
    const coherent = isInferencePolicyAdmissionEnabled()
      ? await dbWrite.transaction(
          async (tx) => {
            const fresh = await requireInferenceApiKeyWithOrg(credential.rawKey, {
              tx,
              rejected: (reason) => {
                authoritativeStandingReason = reason;
                options.onAuthoritativeRejection?.(reason);
                trace.authoritative = "rejected";
                trace.result = "rejected";
              },
            });
            if (
              fresh.apiKey.id !== apiKey.id ||
              fresh.user.id !== user.id ||
              fresh.apiKey.organization_id !== fresh.user.organization_id ||
              fresh.user.organization_id !== user.organization_id
            ) {
              throw new AuthenticationError("API key identity changed; retry authentication");
            }
            const blocked = await adminService.shouldBlockUserConsistent(fresh.user.id, tx);
            const policy = blocked
              ? undefined
              : await readOrganizationQuotaPolicyInTransaction(tx, fresh.user.organization_id);
            return {
              ...fresh,
              blocked,
              admission: policy
                ? await inferenceAdmissionSnapshotInTransaction(
                    tx,
                    fresh.user.organization_id,
                    policy,
                  )
                : undefined,
            };
          },
          { isolationLevel: "repeatable read", accessMode: "read only" },
        )
      : undefined;
    if (coherent?.blocked) {
      trace.authoritative = "suspended";
      trace.result = "suspended";
      logStandingDenial({ status: 403, reason: "moderation_blocked", source: "authoritative" });
      return { kind: "suspended", userId: coherent.user.id, reason: "moderation_blocked" };
    }
    if (coherent) ({ user, apiKey } = coherent);
    // A Worker decision carries the admission snapshot and app scope even when
    // the combined cache is not eligible: its limiter and app-scope checks read
    // them from the decision, never from a cold organization projection.
    const [admission, appScopeId] =
      authCacheEnabled || options.cacheOnly === true
        ? await Promise.all([
            coherent ? coherent.admission : loadInferenceAdmissionSnapshot(user.organization_id),
            loadInferenceAppKeyScope(apiKey.id),
          ])
        : [coherent?.admission, null];
    const ctx: InferenceAuthContext = {
      v: INFERENCE_AUTH_CONTEXT_VERSION,
      cachedAt: Date.now(),
      userId: user.id,
      orgId: user.organization_id,
      apiKeyId: apiKey.id,
      apiKeyRateLimit: apiKey.rate_limit,
      apiKeyExpiresAt: apiKey.expires_at?.getTime() ?? null,
      keyHash,
      appScopeId,
      ...(admission ? { admission } : {}),
    };
    try {
      if (!deferStrongCredentialCheck) {
        await assertInferenceCredentialActive(ctx.orgId, {
          kind: "api_key",
          credentialId: ctx.apiKeyId,
          userId: ctx.userId,
          rateLimit: ctx.apiKeyRateLimit,
          expiresAt: ctx.apiKeyExpiresAt,
        });
      }
    } catch (error) {
      if (error instanceof InferenceCredentialRevokedError) {
        trace.result = error.reason === "credential_revoked" ? "rejected" : "suspended";
        const reason = inferenceCredentialRevocationReason(error.reason);
        logStandingDenial({
          status: error.reason === "credential_revoked" ? 401 : 403,
          reason,
          source: "authoritative",
        });
        return error.reason === "credential_revoked"
          ? { kind: "rejected", status: 401, reason }
          : { kind: "suspended", userId: ctx.userId, reason };
      }
      throw error;
    }
    trace.authoritative = "authorized";
    trace.result = "authorized_origin";
    const hydrationOnly =
      (
        options as ResolveInferenceAuthOptions & {
          [SKIP_CACHE_PROJECTION_WRITE]?: true;
        }
      )[SKIP_CACHE_PROJECTION_WRITE] === true;
    // Internal hydration is not a consumed authorization. Its caller records
    // usage only if it consumes the result; direct requests own their update here.
    if (!hydrationOnly) {
      observeInferenceApiKeyUsage(
        { kind: "authorized", ctx, source: "origin" },
        options.executionCtx,
      );
    }
    const cacheWriteStartedAt = performance.now();
    if (!authCacheEnabled) {
      return {
        kind: "authorized",
        ctx,
        source: "origin",
        ...(deferStrongCredentialCheck || options.includeVerifiedCredential === true
          ? {
              credential: {
                kind: "api_key" as const,
                credentialId: ctx.apiKeyId,
                userId: ctx.userId,
                rateLimit: ctx.apiKeyRateLimit,
                expiresAt: ctx.apiKeyExpiresAt,
              },
            }
          : {}),
      };
    }
    if (hydrationOnly) {
      trace.cacheWrite = "deferred";
      return {
        kind: "authorized",
        ctx,
        source: "origin",
        ...(deferStrongCredentialCheck || options.includeVerifiedCredential === true
          ? {
              credential: {
                kind: "api_key" as const,
                credentialId: ctx.apiKeyId,
                userId: ctx.userId,
                rateLimit: ctx.apiKeyRateLimit,
                expiresAt: ctx.apiKeyExpiresAt,
              },
            }
          : {}),
      };
    }
    const cacheWrite = writeInferenceAuthContext(ctx);
    if (cacheAvailable && typeof options.executionCtx?.waitUntil === "function") {
      trace.cacheWrite = "deferred";
      const observedWrite = cacheWrite.then(
        (write) => {
          const telemetry = freezeCacheWriteTrace(options.traceId, write, cacheWriteStartedAt);
          logger.audit("[InferenceAuth] trace", telemetry);
          options.onCacheWriteTelemetry?.(telemetry);
        },
        (error) => {
          // error-policy:J7 authorization is complete; projection failure is
          // structured and observed without rejecting the Worker lifetime.
          logger.warn("[InferenceAuth] deferred cache write rejected", {
            traceId: boundedTraceId(options.traceId),
            errorName: error instanceof Error ? error.name : "UnknownError",
          });
        },
      );
      // Authorization is already authoritative; waitUntil preserves cache
      // population and its observed outcome without holding the response path.
      options.executionCtx.waitUntil(observedWrite);
    } else {
      const write = await cacheWrite;
      trace.timings.cacheWriteMs = durationSince(cacheWriteStartedAt);
      trace.cacheWrite = write.kind;
      trace.cacheBackend = write.backend;
    }
    return {
      kind: "authorized",
      ctx,
      source: "origin",
      ...(deferStrongCredentialCheck || options.includeVerifiedCredential === true
        ? {
            credential: {
              kind: "api_key" as const,
              credentialId: ctx.apiKeyId,
              userId: ctx.userId,
              rateLimit: ctx.apiKeyRateLimit,
              expiresAt: ctx.apiKeyExpiresAt,
            },
          }
        : {}),
    };
  } catch (error) {
    if (authoritativeStandingReason && !standingDenialLogged) {
      const status = getErrorStatusCode(error);
      logStandingDenial({
        status: status === 401 ? 401 : 403,
        reason: authoritativeStandingReason,
        source: "authoritative",
      });
    }
    if (!standingDenialLogged) {
      logger.error("[InferenceAuth] authorization flow failed", {
        traceId: boundedTraceId(options.traceId),
        authSource: trace.authSource,
        cacheBackend: trace.cacheBackend,
        cacheRead: trace.cacheRead,
        authoritative: trace.authoritative,
        result: trace.result,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    throw error;
  } finally {
    const telemetry = freezeTrace(options.traceId, trace, totalStartedAt);
    const nested = (
      options as ResolveInferenceAuthOptions & { [SUPPRESS_STANDING_DENIAL_LOG]?: true }
    )[SUPPRESS_STANDING_DENIAL_LOG];
    if (nested) logger.info("[InferenceAuth] hydration trace", telemetry);
    else logger.audit("[InferenceAuth] trace", telemetry);
    options.onTelemetry?.(telemetry);
  }
}
