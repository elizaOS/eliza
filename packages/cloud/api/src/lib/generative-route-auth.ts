/**
 * Resolves generative-route callers through the combined inference identity
 * decision so warm API-key and Steward-session requests perform one remote
 * cache read and never join database authorization to provider dispatch.
 */

import { ApiError } from "@/lib/api/cloud-worker-errors";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import type {
  BillingContext,
  FlatBillingCost,
} from "@/lib/services/ai-billing";
import type { PricingCacheReadOptions } from "@/lib/services/ai-pricing/cache";
import {
  AiPricingCacheUnavailableError,
  AiPricingCacheWarmingError,
} from "@/lib/services/ai-pricing/cache";
import type { InferenceAdmissionSnapshot } from "@/lib/services/inference-auth-cache";
import type { EndpointType } from "@/lib/services/org-rate-limits";
import type { OrganizationInferenceAdmission } from "@/lib/services/organization-inference-admission";
import type { AppContext } from "@/types/cloud-worker-env";

export interface GenerativeRouteCaller {
  user: {
    id: string;
    organization_id: string;
  };
  apiKeyId: string | null;
  authSource: "combined_cache" | "compatibility";
  admissionSnapshot?: InferenceAdmissionSnapshot;
  appScopeId: string | null;
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

export function getGenerativePricingCacheOptions(
  c: AppContext,
): PricingCacheReadOptions {
  const executionCtx = getGenerativeExecutionContext(c);
  return { cacheOnly: Boolean(executionCtx), executionCtx };
}

export function asGenerativeCacheApiError(error: unknown): ApiError | null {
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
      "@/lib/services/ai-billing"
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
      "@/lib/services/organization-inference-admission"
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

/**
 * Cache misses fail closed with a retryable response while authoritative
 * hydration runs under the Worker lifetime. Wallet proof remains on the
 * compatibility path because replay-protected signatures cannot be cached.
 *
 * `awaitWarmingMs` opts a latency-tolerant caller (voice STT/TTS) into one
 * bounded inline wait for the coalesced hydration: on a warming resolve the
 * caller races the hydration against the budget; if the hydration settles in
 * time the resolver runs exactly once more against the cache entry it just
 * wrote, so the first utterance after idle no longer degrades to a
 * client-retried 503. The immediate retryable 503 semantics are preserved
 * verbatim when the budget expires, the hydration is absent (cache outage),
 * or the option is unset — every other generative route is unchanged.
 */
export async function requireGenerativeRouteCaller(
  c: AppContext,
  options: {
    compatibility?: "hono" | "raw";
    rateLimitEndpoint?: EndpointType;
    awaitWarmingMs?: number;
  } = {},
): Promise<GenerativeRouteCaller> {
  const executionCtx = getGenerativeExecutionContext(c);
  if (!executionCtx) {
    if (options.compatibility === "raw") {
      const { user, apiKey } = await requireAuthOrApiKeyWithOrg(c.req.raw);
      return {
        user: { id: user.id, organization_id: user.organization_id },
        apiKeyId: apiKey?.id ?? null,
        authSource: "compatibility",
        appScopeId: null,
      };
    }
    const { requireUserOrApiKeyWithOrg } = await import(
      "@/lib/auth/workers-hono-auth"
    );
    const user = await requireUserOrApiKeyWithOrg(c);
    return {
      user: { id: user.id, organization_id: user.organization_id },
      apiKeyId: c.get("apiKeyId") ?? null,
      authSource: "compatibility",
      appScopeId: null,
    };
  }
  const { resolveInferenceAuthContext } = await import(
    "@/lib/services/inference-auth-context"
  );

  // Single resolver integration point (a source tripwire pins this file to
  // exactly one resolver invocation site); the bounded warming retry re-runs
  // through the same helper.
  const resolveCallerAuth = () =>
    resolveInferenceAuthContext(c.req.raw, {
      traceId: c.get("traceId") ?? c.get("requestId"),
      cacheOnly: Boolean(executionCtx),
      executionCtx,
    });

  function toCallerIfAuthorized(
    resolution: Awaited<ReturnType<typeof resolveCallerAuth>>,
  ): Extract<typeof resolution, { kind: "authorized" }> | null {
    if (resolution.kind !== "authorized") return null;
    const user = {
      id: resolution.ctx.userId,
      organization_id: resolution.ctx.orgId,
    };
    c.set("user", user);
    c.set("authMethod", resolution.ctx.apiKeyId ? "api_key" : "session");
    if (resolution.ctx.apiKeyId) {
      c.set("apiKeyId", resolution.ctx.apiKeyId);
    }
    return resolution;
  }

  async function enforceOrgRateLimitFor(
    resolution: Extract<
      Awaited<ReturnType<typeof resolveCallerAuth>>,
      { kind: "authorized" }
    >,
  ): Promise<void> {
    if (!options.rateLimitEndpoint) return;
    const [{ enforceOrgRateLimit }, { inferenceRateLimitConfig }] =
      await Promise.all([
        import("@/lib/middleware/rate-limit"),
        import("@/lib/services/inference-admission-snapshot"),
      ]);
    const limited = await enforceOrgRateLimit(
      resolution.ctx.orgId,
      options.rateLimitEndpoint,
      {
        // The combined decision carries the rate policy only when the hot
        // cache is enabled. Development and integration Workers still have
        // an execution context, but their authoritative origin decision has
        // no snapshot and must retain the compatibility limiter path.
        cacheOnly: Boolean(resolution.ctx.admission),
        executionCtx,
        config: inferenceRateLimitConfig(
          resolution.ctx.admission,
          options.rateLimitEndpoint,
        ),
      },
    );
    if (limited) {
      throw new ApiError(
        limited.status,
        limited.status === 429 ? "rate_limit_exceeded" : "service_unavailable",
        limited.status === 429
          ? "Rate limit exceeded"
          : "Rate limiter is unavailable",
      );
    }
  }

  let resolution = await resolveCallerAuth();

  if (resolution.kind === "warming" && options.awaitWarmingMs !== undefined) {
    if (resolution.hydration) {
      // The budget timer must never outlive the race: clear it as soon as
      // either side settles so a winning hydration does not leave a dangling
      // timer holding the isolate.
      let budgetTimer: ReturnType<typeof setTimeout> | undefined;
      const budget = new Promise<void>((resolve) => {
        budgetTimer = setTimeout(resolve, options.awaitWarmingMs);
      });
      try {
        await Promise.race([
          // A rejected hydration is not an auth verdict and must not surface
          // as an opaque 500: the resolver's single-flight already observed
          // and logged it (error-policy:J5 — the same rejection is observed
          // by the resolver's own waitUntil/logging copy). It only means
          // "stop waiting"; the re-resolve below decides the outcome, which
          // degrades to the designed retryable 503 when nothing was cached.
          resolution.hydration.catch(() => undefined),
          budget,
        ]);
      } finally {
        if (budgetTimer !== undefined) clearTimeout(budgetTimer);
      }
      resolution = await resolveCallerAuth();
    }
  }

  const authorized = toCallerIfAuthorized(resolution);
  if (authorized) {
    await enforceOrgRateLimitFor(authorized);
    return {
      user: {
        id: authorized.ctx.userId,
        organization_id: authorized.ctx.orgId,
      },
      apiKeyId: authorized.ctx.apiKeyId,
      authSource: "combined_cache",
      admissionSnapshot: authorized.ctx.admission,
      appScopeId:
        "appScopeId" in authorized.ctx ? authorized.ctx.appScopeId : null,
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
    throw new ApiError(403, "access_denied", "Account suspended");
  }
  if (resolution.kind === "rejected") {
    throw new ApiError(
      resolution.status,
      resolution.status === 403 ? "access_denied" : "authentication_required",
      resolution.status === 403 ? "Forbidden" : "Authentication required",
    );
  }

  // Wallet signatures are timestamped and replay-protected, so they retain the
  // authoritative compatibility path. API keys and Steward sessions never
  // reach this branch.
  if (options.compatibility === "raw") {
    const { user, apiKey } = await requireAuthOrApiKeyWithOrg(c.req.raw);
    return {
      user: { id: user.id, organization_id: user.organization_id },
      apiKeyId: apiKey?.id ?? null,
      authSource: "compatibility",
      appScopeId: null,
    };
  }
  const { requireUserOrApiKeyWithOrg } = await import(
    "@/lib/auth/workers-hono-auth"
  );
  const user = await requireUserOrApiKeyWithOrg(c);
  return {
    user: { id: user.id, organization_id: user.organization_id },
    apiKeyId: c.get("apiKeyId") ?? null,
    authSource: "compatibility",
    appScopeId: null,
  };
}
