/**
 * Hydrates the immutable admission projection stored beside inference identity.
 * Database work is allowed only while warming the combined decision under a
 * Worker lifetime; warm requests consume the projection from their single KV read.
 */

import { cache } from "../cache/client";
import { InMemoryLRUCache } from "../cache/in-memory-lru-cache";
import { CacheKeys, CacheTTL } from "../cache/keys";
import { logger } from "../utils/logger";
import {
  type InferenceAdmissionSnapshot,
  isInferenceAdmissionSnapshot,
} from "./inference-auth-cache";
import { type EndpointType, type OrgRateLimitConfig } from "./org-rate-limits";
import { withOrganizationPolicyAdmission } from "./organization-policy-admission";
import {
  type OrganizationQuotaPolicy,
  readOrganizationQuotaPolicy,
  requireOrganizationPolicyBalance,
  requireOrganizationRateTier,
} from "./organization-quota-policy";

const admissionMemoryCache = new InMemoryLRUCache<InferenceAdmissionSnapshot>(1_000, 5_000);

/** Clears isolate-local projection state for deterministic cache contract tests. */
export function resetInferenceAdmissionMemoryCacheForTests(): void {
  admissionMemoryCache.clear();
}

export interface AdmissionSnapshotExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

export class InferenceAdmissionSnapshotCacheWarmingError extends Error {
  constructor(message = "Inference admission cache is warming") {
    super(message);
    this.name = "InferenceAdmissionSnapshotCacheWarmingError";
  }
}

/** Derive the exact endpoint limiter without another shared-cache lookup. */
export function inferenceRateLimitConfig(
  snapshot: InferenceAdmissionSnapshot | undefined,
  endpointType: EndpointType,
): OrgRateLimitConfig | undefined {
  if (!isInferenceAdmissionSnapshot(snapshot)) return undefined;
  const rpmKey = `${endpointType}Rpm` as const;
  return {
    windowMs: 60_000,
    maxRequests: snapshot.rateLimits[rpmKey],
    authority: snapshot.authority,
  };
}

export async function loadInferenceAdmissionSnapshot(
  organizationId: string,
): Promise<InferenceAdmissionSnapshot> {
  const policy = await readOrganizationQuotaPolicy(organizationId);
  return inferenceAdmissionSnapshotFromPolicy(policy);
}
export function inferenceAdmissionSnapshotFromPolicy(
  policy: OrganizationQuotaPolicy,
): InferenceAdmissionSnapshot {
  return {
    authority: policy.authority,
    subscriptionFunded: policy.subscriptionFunded,
    balance: {
      balanceUsd: requireOrganizationPolicyBalance(policy).balanceUsd,
      balanceAt: Date.parse(policy.observedAt),
      balanceRevision: requireOrganizationPolicyBalance(policy).revision,
    },
    rateLimits: {
      completionsRpm: requireOrganizationRateTier(policy).completionsRpm,
      embeddingsRpm: requireOrganizationRateTier(policy).embeddingsRpm,
      standardRpm: requireOrganizationRateTier(policy).standardRpm,
      strictRpm: requireOrganizationRateTier(policy).strictRpm,
    },
  };
}

/** Populate the combined projection from authoritative stores off the hot path. */
export async function warmInferenceAdmissionSnapshot(
  organizationId: string,
): Promise<InferenceAdmissionSnapshot> {
  const key = CacheKeys.inference.orgAdmission(organizationId);
  return withOrganizationPolicyAdmission(organizationId, undefined, async (policy) => {
    const snapshot = inferenceAdmissionSnapshotFromPolicy(policy);
    const outcome = await cache.setWithOutcome(key, snapshot, CacheTTL.inference.orgAdmission);
    if (outcome.kind !== "written")
      throw new InferenceAdmissionSnapshotCacheWarmingError(
        "Admission snapshot publication was not acknowledged",
      );
    admissionMemoryCache.set(key, snapshot);
    return snapshot;
  });
}

/**
 * Resolve the shared-runtime billing and rate policy with one remote cache read.
 * Misses hydrate from authoritative stores only under the Worker lifetime.
 */
export async function getInferenceAdmissionSnapshotCacheOnly(
  organizationId: string,
  executionCtx: AdmissionSnapshotExecutionContext,
): Promise<InferenceAdmissionSnapshot> {
  const key = CacheKeys.inference.orgAdmission(organizationId);
  const local = admissionMemoryCache.get(key);
  if (isInferenceAdmissionSnapshot(local)) return local;

  let cached: InferenceAdmissionSnapshot | null;
  try {
    cached = await cache.get<InferenceAdmissionSnapshot>(key);
  } catch (error) {
    // error-policy:J4 inference cannot safely proceed without admission policy.
    throw new InferenceAdmissionSnapshotCacheWarmingError(
      error instanceof Error ? error.message : undefined,
    );
  }
  if (isInferenceAdmissionSnapshot(cached)) {
    admissionMemoryCache.set(key, cached);
    return cached;
  }

  const hydration = Promise.resolve()
    .then(() => warmInferenceAdmissionSnapshot(organizationId))
    .then(() => undefined)
    .catch((error) => {
      // error-policy:J7 authoritative hydration is deliberately detached from
      // the request; the next request remains fail-closed if it did not finish.
      logger.warn("[inference-admission] combined snapshot hydration failed", {
        organizationId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  executionCtx.waitUntil(hydration);
  throw new InferenceAdmissionSnapshotCacheWarmingError();
}
