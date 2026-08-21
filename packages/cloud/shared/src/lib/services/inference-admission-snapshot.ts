/**
 * Hydrates the immutable admission projection stored beside inference identity.
 * Database work is allowed only while warming the combined decision under a
 * Worker lifetime; warm requests consume the projection from their single KV read.
 */

import { cache } from "../cache/client";
import { InMemoryLRUCache } from "../cache/in-memory-lru-cache";
import { CacheKeys, CacheTTL } from "../cache/keys";
import { logger } from "../utils/logger";
import { creditsService } from "./credits";
import {
  type InferenceAdmissionSnapshot,
  isInferenceAdmissionSnapshot,
} from "./inference-auth-cache";
import { type EndpointType, type OrgRateLimitConfig, recalculateOrgTier } from "./org-rate-limits";

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
  if (!snapshot) return undefined;
  const rpmKey = `${endpointType}Rpm` as const;
  return { windowMs: 60_000, maxRequests: snapshot.rateLimits[rpmKey] };
}

export async function loadInferenceAdmissionSnapshot(
  organizationId: string,
): Promise<InferenceAdmissionSnapshot> {
  const balanceAt = Date.now();
  const [balance, tier] = await Promise.all([
    creditsService.getOrganizationBalanceSnapshot(organizationId),
    recalculateOrgTier(organizationId),
  ]);
  return {
    balance: {
      balanceUsd: balance.balanceUsd,
      balanceAt,
      balanceRevision: balance.revision,
    },
    rateLimits: {
      completionsRpm: tier.completionsRpm,
      embeddingsRpm: tier.embeddingsRpm,
      standardRpm: tier.standardRpm,
      strictRpm: tier.strictRpm,
      catalogVersion: tier.catalogVersion,
      entitlementVersion: tier.entitlementVersion,
      manualOverrideVersion: tier.manualOverrideVersion,
    },
  };
}

/** Populate the combined projection from authoritative stores off the hot path. */
export async function warmInferenceAdmissionSnapshot(
  organizationId: string,
): Promise<InferenceAdmissionSnapshot> {
  const key = CacheKeys.inference.orgAdmission(organizationId);
  const snapshot = await loadInferenceAdmissionSnapshot(organizationId);
  admissionMemoryCache.set(key, snapshot);
  await cache.set(key, snapshot, CacheTTL.inference.orgAdmission);
  return snapshot;
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
  if (local) return local;

  let cached: unknown;
  try {
    cached = await cache.get<unknown>(key);
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
