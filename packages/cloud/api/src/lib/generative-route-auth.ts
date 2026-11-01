/**
 * Resolves generative-route callers through the combined inference identity
 * decision so warm API-key and Steward-session requests perform one remote
 * cache read and never join database authorization to provider dispatch.
 */

import { ApiError } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import { requireAuthOrApiKeyWithOrg } from "@elizaos/cloud-shared/lib/auth";
import type {
  BillingContext,
  FlatBillingCost,
} from "@elizaos/cloud-shared/lib/services/ai-billing";
import type { PricingCacheReadOptions } from "@elizaos/cloud-shared/lib/services/ai-pricing/cache";
import {
  AiPricingCacheUnavailableError,
  AiPricingCacheWarmingError,
} from "@elizaos/cloud-shared/lib/services/ai-pricing/cache";
import type { GenerativeOperationContext } from "@elizaos/cloud-shared/lib/services/generative-operation";
import type {
  InferenceAdmissionSnapshot,
  InferenceAuthRejectionReason,
} from "@elizaos/cloud-shared/lib/services/inference-auth-cache";
import {
  assertInferenceCredentialActive,
  type InferenceCredentialCheck,
  InferenceCredentialRevokedError,
  inferenceCredentialRevocationReason,
} from "@elizaos/cloud-shared/lib/services/inference-credential-revocation";
import type { EndpointType } from "@elizaos/cloud-shared/lib/services/org-rate-limits";
import type { OrganizationInferenceAdmission } from "@elizaos/cloud-shared/lib/services/organization-inference-admission";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type { AppContext } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { isInferenceTraceId } from "@elizaos/core/protocol";

export interface GenerativeRouteCaller {
  user: {
    id: string;
    organization_id: string;
  };
  apiKeyId: string | null;
  authSource: "combined_cache" | "compatibility";
  admissionSnapshot?: InferenceAdmissionSnapshot;
  /** Strong proof that the next paid admission must consume atomically. */
  credential?: InferenceCredentialCheck;
  appScopeId: string | null;
}

export interface InferenceAuthStandingDenial {
  status: 401 | 403 | 503;
  type: "authentication_error" | "permission_error" | "service_unavailable";
  code: "authentication_required" | "access_denied" | "service_unavailable";
  message: string;
  reason:
    | InferenceAuthRejectionReason
    | "account_suspended"
    | "authentication_rejected"
    | "authorization_unavailable";
  retryAfterSeconds?: number;
}

type InferenceAuthStandingResolution =
  | { kind: "suspended"; reason?: InferenceAuthRejectionReason }
  | {
      kind: "rejected";
      status: 401 | 403 | 503;
      reason?: InferenceAuthRejectionReason;
    };

function standingMessage(
  reason: InferenceAuthRejectionReason | undefined,
  fallback: string,
): string {
  switch (reason) {
    case "moderation_blocked":
      return "Account access is blocked by policy moderation";
    case "organization_inactive":
      return "Organization is inactive";
    case "account_inactive":
      return "Account is inactive";
    case "credential_inactive":
      return "API key is inactive";
    case "membership_missing":
      return "Account is not associated with an active organization";
    case "credential_invalid":
      return "Authentication required";
    default:
      return fallback;
  }
}

/**
 * Maps cache and authoritative standing decisions to one bounded API contract.
 * Routes retain their native response envelope, but status, reason, code, and
 * retry semantics must come from this mapping without another identity read.
 */
export function resolveInferenceAuthStandingDenial(
  resolution: InferenceAuthStandingResolution,
  logContext?: { route: string; traceId?: string },
): InferenceAuthStandingDenial {
  let denial: InferenceAuthStandingDenial;
  if (resolution.kind === "suspended") {
    denial = {
      status: 403,
      type: "permission_error",
      code: "access_denied",
      message: standingMessage(resolution.reason, "Account suspended"),
      reason: resolution.reason ?? "account_suspended",
    };
  } else if (resolution.status === 503) {
    denial = {
      status: 503,
      type: "service_unavailable",
      code: "service_unavailable",
      message: "Authorization service is unavailable. Retry shortly.",
      reason: resolution.reason ?? "authorization_unavailable",
      retryAfterSeconds: 1,
    };
  } else {
    denial = {
      status: resolution.status,
      type:
        resolution.status === 403 ? "permission_error" : "authentication_error",
      code:
        resolution.status === 403 ? "access_denied" : "authentication_required",
      message: standingMessage(
        resolution.reason,
        resolution.status === 403 ? "Forbidden" : "Authentication required",
      ),
      reason: resolution.reason ?? "authentication_rejected",
    };
  }

  if (logContext) {
    logger.warn("[InferenceAuth] blocked provider dispatch at route boundary", {
      route: logContext.route,
      traceId: logContext.traceId ?? "unavailable",
      decision: resolution.kind,
      status: denial.status,
      reason: denial.reason,
      retryable: denial.status === 503,
    });
  }
  return denial;
}

/** Maps a combined admission-gate credential refusal to the same route contract. */
export function resolveInferenceCredentialAdmissionDenial(
  error: unknown,
  logContext?: { route: string; traceId?: string },
): InferenceAuthStandingDenial | null {
  let credentialError = error;
  if (error instanceof Error && error.name === "SuppressedError") {
    // `SuppressedError.error` is the newer disposal failure and `.suppressed`
    // the one it displaced, so the revocation can land in either slot: a
    // disposal revocation after a failed body lands in `.error`, while a body
    // revocation followed by an unrelated disposal failure lands in
    // `.suppressed`.
    const raised = "error" in error ? error.error : undefined;
    const displaced = "suppressed" in error ? error.suppressed : undefined;
    const revocation =
      raised instanceof InferenceCredentialRevokedError
        ? raised
        : displaced instanceof InferenceCredentialRevokedError
          ? displaced
          : undefined;
    if (revocation) {
      credentialError = revocation;
      const companion = revocation === raised ? displaced : raised;
      const suppressedError =
        companion instanceof Error
          ? {
              name: companion.name,
              ...(companion instanceof ApiError
                ? { code: companion.code, status: companion.status }
                : {}),
            }
          : { name: typeof companion };
      logger.error(
        "[InferenceAuth] deferred revocation suppressed an earlier route failure",
        {
          route: logContext?.route ?? "unavailable",
          traceId: logContext?.traceId ?? "unavailable",
          credentialReason: revocation.reason,
          suppressedError,
        },
      );
    }
  }
  if (!(credentialError instanceof InferenceCredentialRevokedError)) {
    return null;
  }
  const reason = inferenceCredentialRevocationReason(credentialError.reason);
  return resolveInferenceAuthStandingDenial(
    {
      kind: "rejected",
      status: reason === "credential_inactive" ? 401 : 403,
      reason,
    },
    logContext,
  );
}

export function getGenerativeExecutionContext(
  c: AppContext,
): { waitUntil(promise: Promise<unknown>): void } | undefined {
  try {
    const candidate = c.executionCtx;
    return typeof candidate?.waitUntil === "function" ? candidate : undefined;
  } catch {
    // error-policy:J4 local Hono requests have no Worker lifetime context and
    // retain the authoritative compatibility path used by tests and tooling.
    return undefined;
  }
}

export function getGenerativeOperationContext(
  c: AppContext,
  caller: GenerativeRouteCaller,
  options: {
    credentialForAdmission?: () => InferenceCredentialCheck | undefined;
  } = {},
): GenerativeOperationContext {
  return {
    organizationId: caller.user.organization_id,
    userId: caller.user.id,
    apiKeyId: caller.apiKeyId,
    requestId: c.get("requestId") ?? c.get("traceId") ?? crypto.randomUUID(),
    admissionSnapshot: caller.admissionSnapshot,
    credential: caller.credential,
    ...options,
    executionCtx: getGenerativeExecutionContext(c),
  };
}

export function getGenerativePricingCacheOptions(
  c: AppContext,
): PricingCacheReadOptions {
  const executionCtx = getGenerativeExecutionContext(c);
  return { cacheOnly: Boolean(executionCtx), executionCtx };
}

/** Revalidates a signed non-Steward session before paid provider admission. */
export async function requireGenerativeKnownIdentity(
  c: AppContext,
  identity: { userId: string; organizationId: string },
): Promise<GenerativeRouteCaller> {
  const [{ usersRepository }, { adminService }] = await Promise.all([
    import("@elizaos/cloud-shared/db/repositories/users"),
    import("@elizaos/cloud-shared/lib/services/admin"),
  ]);
  const user = await usersRepository.findWithOrganization(identity.userId);
  const reason = !user
    ? "account_inactive"
    : user.organization_id !== identity.organizationId || !user.organization
      ? "membership_missing"
      : !user.is_active
        ? "account_inactive"
        : !user.organization.is_active
          ? "organization_inactive"
          : (await adminService.shouldBlockUser(user.id))
            ? "moderation_blocked"
            : null;
  if (reason) {
    logger.warn(
      "[InferenceAuth] blocked known identity before provider dispatch",
      {
        traceId: c.get("traceId") ?? c.get("requestId") ?? "unavailable",
        route: "eliza-app/provisioning-agent/chat",
        reason,
        status: 403,
      },
    );
    throw new ApiError(
      403,
      "access_denied",
      "Account is not eligible for generative work",
      {
        reason,
      },
    );
  }

  const executionCtx = getGenerativeExecutionContext(c);
  const admissionSnapshot = executionCtx
    ? await import(
        "@elizaos/cloud-shared/lib/services/inference-admission-snapshot"
      ).then((module) =>
        module.getInferenceAdmissionSnapshotCacheOnly(
          identity.organizationId,
          executionCtx,
        ),
      )
    : await import(
        "@elizaos/cloud-shared/lib/services/inference-admission-snapshot"
      ).then((module) =>
        module.loadInferenceAdmissionSnapshot(identity.organizationId),
      );

  return {
    user: { id: identity.userId, organization_id: identity.organizationId },
    apiKeyId: null,
    authSource: "compatibility",
    admissionSnapshot,
    appScopeId: null,
  };
}

export function asGenerativeCacheApiError(
  error: unknown,
  logContext?: { route: string; traceId?: string },
): ApiError | null {
  const admissionDenial = resolveInferenceCredentialAdmissionDenial(
    error,
    logContext,
  );
  if (admissionDenial) {
    return new ApiError(
      admissionDenial.status,
      admissionDenial.code,
      admissionDenial.message,
      {
        reason: admissionDenial.reason,
      },
    );
  }
  if (
    error instanceof AiPricingCacheWarmingError ||
    error instanceof AiPricingCacheUnavailableError ||
    (error instanceof Error &&
      error.name.startsWith("Inference") &&
      (error.name.includes("Warming") || error.name.includes("Unavailable")))
  ) {
    return new ApiError(
      503,
      "service_unavailable",
      "Generative admission cache is warming; retry shortly",
      { retryable: true, retryAfterSeconds: 1 },
    );
  }
  return null;
}

export async function admitFlatGenerativeOperation(params: {
  c: AppContext;
  context: BillingContext;
  apiKeyId: string | null;
  cost: FlatBillingCost;
  idempotencyKey?: string;
  admissionSnapshot?: InferenceAdmissionSnapshot;
  credential?: InferenceCredentialCheck;
  /** Use only when the caller must invoke the returned dispatch marker. */
  atomicProviderBoundary?: boolean;
}): Promise<OrganizationInferenceAdmission> {
  const executionCtx = getGenerativeExecutionContext(params.c);
  const { provider, billingSource, requestId } = params.context;
  if (!provider || !billingSource || !requestId) {
    throw new Error(
      "Flat generative admission requires provider, billingSource, and requestId",
    );
  }
  const context = {
    ...params.context,
    provider,
    billingSource,
    requestId,
  };
  if (!executionCtx) {
    const { reserveFlatUsageCredits } = await import(
      "@elizaos/cloud-shared/lib/services/ai-billing"
    );
    const reservation = await reserveFlatUsageCredits(
      context,
      params.cost,
      params.idempotencyKey
        ? { idempotencyKey: params.idempotencyKey }
        : undefined,
    );
    let settled = false;
    const settle = async (actualCostUsd: number) => {
      if (settled) return null;
      settled = true;
      return (await reservation.reconcile(actualCostUsd)) ?? null;
    };
    return {
      mode: "synchronous_reservation",
      reservation,
      affiliateAttribution: reservation.affiliateAttribution ?? null,
      settle,
      settleUnknown: () => settle(params.cost.totalCost),
    };
  }
  try {
    const { admitOrganizationInference } = await import(
      "@elizaos/cloud-shared/lib/services/organization-inference-admission"
    );
    return await admitOrganizationInference({
      context,
      apiKeyId: params.apiKeyId,
      estimatedInputTokens: 0,
      estimatedOutputTokens: 0,
      affiliateCode: params.context.affiliateCode,
      executionCtx,
      flatCost: params.cost,
      admissionSnapshot: params.admissionSnapshot,
      ...(params.credential ? { credential: params.credential } : {}),
      atomicProviderBoundary: params.atomicProviderBoundary === true,
    });
  } catch (error) {
    if (
      error instanceof Error &&
      error.name.startsWith("Inference") &&
      (error.name.includes("Warming") || error.name.includes("Unavailable"))
    ) {
      throw new ApiError(
        503,
        "service_unavailable",
        "Billing cache is warming; retry shortly",
        { retryable: true, retryAfterSeconds: 1 },
      );
    }
    throw error;
  }
}

const SPEECH_PHASES = [
  "upload_read",
  "multipart_decode",
  "audio_buffer",
  "audio_sniff",
  "audio_metadata",
  "json_decode",
  "auth_module_load",
  "auth_resolution",
  "limiter_module_load",
  "org_limiter",
] as const;

/** Optional diagnostics cannot change request results or disclose caller data. */
export async function timeSpeechPhase<T>(
  c: AppContext,
  phase: (typeof SPEECH_PHASES)[number],
  run: () => Promise<T>,
): Promise<T> {
  let route: "stt" | "tts" | undefined;
  let traceId = "unavailable";
  let enabled = false;
  try {
    const path = new URL(c.req.url).pathname;
    route =
      path === "/api/v1/voice/stt"
        ? "stt"
        : path === "/api/v1/voice/tts"
          ? "tts"
          : undefined;
    enabled = Boolean(route) && SPEECH_PHASES.includes(phase);
    const candidate = c.get("traceId") ?? c.get("requestId");
    if (isInferenceTraceId(candidate)) traceId = candidate;
  } catch {
    // Optional diagnostic context failure must not alter the actual operation.
  }
  if (!enabled) return run();
  const start = performance.now();
  let outcome: "returned" | "threw" = "returned";
  try {
    return await run();
  } catch (error) {
    outcome = "threw";
    throw error;
  } finally {
    try {
      const durationMs = Math.round((performance.now() - start) * 10) / 10;
      if (Number.isFinite(durationMs) && durationMs >= 0) {
        logger.audit("[CloudSpeech] phase timing", {
          schema: "cloud_speech_phase_v1",
          traceId,
          route,
          phase,
          durationMs,
          outcome,
        });
      }
    } catch {
      // Best-effort telemetry: preserve the operation's result or original error.
    }
  }
}

/**
 * Cache misses consume the already-coalesced authoritative continuation under
 * one bounded deadline. The continuation does not re-read the combined cache;
 * it returns the origin decision directly. The route invokes the real limiter
 * once after authorization. Wallet proof remains on the compatibility path
 * because replay-protected signatures cannot be cached.
 */
export async function requireGenerativeRouteCaller(
  c: AppContext,
  options: {
    /** Effective request after any route-local credential rewrite. */
    request?: Request;
    compatibility?: "hono" | "raw";
    rateLimitEndpoint?: EndpointType;
    /**
     * Override the default bounded wait for the one-shot origin continuation.
     * Zero preserves an immediate retryable warming response.
     */
    awaitWarmingMs?: number;
    /**
     * This route has a mandatory paid admission before provider dispatch and
     * will thread the returned credential into that admission consumer.
     */
    deferStrongCredentialCheck?: boolean;
  } = {},
): Promise<GenerativeRouteCaller> {
  const request = options.request ?? c.req.raw;
  const executionCtx = getGenerativeExecutionContext(c);
  if (!executionCtx) {
    if (options.compatibility === "raw") {
      const { user, apiKey } = await requireAuthOrApiKeyWithOrg(request);
      return {
        user: { id: user.id, organization_id: user.organization_id },
        apiKeyId: apiKey?.id ?? null,
        authSource: "compatibility",
        appScopeId: null,
      };
    }
    const { requireUserOrApiKeyWithOrg } = await import(
      "@elizaos/cloud-shared/auth"
    );
    const user = await requireUserOrApiKeyWithOrg(c);
    return {
      user: { id: user.id, organization_id: user.organization_id },
      apiKeyId: c.get("apiKeyId") ?? null,
      authSource: "compatibility",
      appScopeId: null,
    };
  }
  const { resolveInferenceAuthContext } = await timeSpeechPhase(
    c,
    "auth_module_load",
    () => import("@elizaos/cloud-shared/lib/services/inference-auth-context"),
  );
  const resolveCallerAuth = () =>
    resolveInferenceAuthContext(request, {
      traceId: c.get("traceId") ?? c.get("requestId"),
      cacheOnly: Boolean(executionCtx),
      executionCtx,
      inlineContinuationDeadlineMs: options.awaitWarmingMs,
      ...(options.deferStrongCredentialCheck === true
        ? { deferStrongCredentialCheck: true }
        : {}),
    });
  const resolution = await timeSpeechPhase(
    c,
    "auth_resolution",
    resolveCallerAuth,
  );

  if (resolution.kind === "authorized") {
    const user = {
      id: resolution.ctx.userId,
      organization_id: resolution.ctx.orgId,
    };
    try {
      c.set("user", user);
      c.set("authMethod", resolution.ctx.apiKeyId ? "api_key" : "session");
      if (resolution.ctx.apiKeyId) {
        c.set("apiKeyId", resolution.ctx.apiKeyId);
      }
      const rateLimitEndpoint = options.rateLimitEndpoint;
      if (rateLimitEndpoint) {
        const [{ enforceOrgRateLimit }, { inferenceRateLimitConfig }] =
          await timeSpeechPhase(c, "limiter_module_load", () =>
            Promise.all([
              import("@elizaos/cloud-shared/lib/middleware/rate-limit"),
              import(
                "@elizaos/cloud-shared/lib/services/inference-admission-snapshot"
              ),
            ]),
          );
        const limited = await timeSpeechPhase(c, "org_limiter", () =>
          enforceOrgRateLimit(resolution.ctx.orgId, rateLimitEndpoint, {
            // Same limiter as chat completions: a shared policy lock and one
            // Durable Object decision. Without a snapshot the locked primary
            // policy supplies the limit. The compatibility path took the
            // exclusive policy lock across Redis REST round trips that fail
            // open, and every origin-authorized key had no snapshot.
            cacheOnly: true,
            executionCtx,
            config: inferenceRateLimitConfig(
              resolution.ctx.admission,
              rateLimitEndpoint,
            ),
            apiKeyId: resolution.ctx.apiKeyId,
          }),
        );
        if (limited) {
          throw new ApiError(
            limited.status,
            limited.status === 429
              ? "rate_limit_exceeded"
              : "service_unavailable",
            limited.status === 429
              ? "Rate limit exceeded"
              : "Rate limiter is unavailable",
            limited.status === 503
              ? { retryable: true, retryAfterSeconds: 1 }
              : {
                  retryAfterSeconds: Math.max(
                    1,
                    Number.parseInt(
                      limited.headers.get("Retry-After") ?? "",
                      10,
                    ) || 60,
                  ),
                },
          );
        }
      }
    } catch (error) {
      // A deferred credential may leave this helper only through its admission
      // consumer. If a post-resolution boundary fails first, consume the same
      // proof with the standalone strong check before exposing that failure.
      if (resolution.credential) {
        await assertInferenceCredentialActive(
          resolution.ctx.orgId,
          resolution.credential,
        );
      }
      throw error;
    }
    return {
      user,
      apiKeyId: resolution.ctx.apiKeyId,
      authSource: "combined_cache",
      admissionSnapshot: resolution.ctx.admission,
      credential: resolution.credential,
      appScopeId:
        "appScopeId" in resolution.ctx ? resolution.ctx.appScopeId : null,
    };
  }

  if (resolution.kind === "warming") {
    throw new ApiError(
      503,
      "service_unavailable",
      "Authorization cache is warming; retry shortly",
      { retryable: true, retryAfterSeconds: 1 },
    );
  }
  if (resolution.kind === "suspended") {
    const denial = resolveInferenceAuthStandingDenial(resolution, {
      route: "generative",
      traceId: c.get("traceId") ?? c.get("requestId"),
    });
    throw new ApiError(denial.status, denial.code, denial.message, {
      reason: denial.reason,
    });
  }
  if (resolution.kind === "rejected") {
    const denial = resolveInferenceAuthStandingDenial(resolution, {
      route: "generative",
      traceId: c.get("traceId") ?? c.get("requestId"),
    });
    throw new ApiError(denial.status, denial.code, denial.message, {
      reason: denial.reason,
      ...(denial.retryAfterSeconds
        ? { retryAfterSeconds: denial.retryAfterSeconds, retryable: true }
        : {}),
    });
  }

  // Wallet signatures are timestamped and replay-protected, so they retain the
  // authoritative compatibility path. API keys and Steward sessions never
  // reach this branch.
  if (options.compatibility === "raw") {
    const { user, apiKey } = await requireAuthOrApiKeyWithOrg(request);
    return {
      user: { id: user.id, organization_id: user.organization_id },
      apiKeyId: apiKey?.id ?? null,
      authSource: "compatibility",
      appScopeId: null,
    };
  }
  const { requireUserOrApiKeyWithOrg } = await import(
    "@elizaos/cloud-shared/auth"
  );
  const user = await requireUserOrApiKeyWithOrg(c);
  return {
    user: { id: user.id, organization_id: user.organization_id },
    apiKeyId: c.get("apiKeyId") ?? null,
    authSource: "compatibility",
    appScopeId: null,
  };
}
