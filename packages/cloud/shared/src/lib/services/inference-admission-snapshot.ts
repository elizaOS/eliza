/**
 * Hydrates the immutable admission projection stored beside inference identity.
 * Database work is allowed only while warming the combined decision under a
 * Worker lifetime; warm requests consume the projection from their single KV read.
 */

import type { DbTransaction } from "../../db/client";
import { cache } from "../cache/client";
import { InMemoryLRUCache } from "../cache/in-memory-lru-cache";
import { CacheKeys, CacheTTL } from "../cache/keys";
import { getCloudBinding } from "../runtime/cloud-bindings";
import { logger } from "../utils/logger";
import { billingHoldService } from "./billing-hold";
import { publishInferenceAdmissionPolicy } from "./inference-admission-gate";
import {
  type InferenceAdmissionSnapshot,
  isInferenceAdmissionSnapshot,
} from "./inference-auth-cache";
import { isSnapshotAdmissionEnabled } from "./inference-billing-deferred";
import { type EndpointType, type OrgRateLimitConfig } from "./org-rate-limits";
import { withOrganizationPolicyAdmission } from "./organization-policy-admission";
import {
  type OrganizationQuotaPolicy,
  readOrganizationQuotaPolicy,
  requireOrganizationPolicyBalance,
  requireOrganizationRateTier,
} from "./organization-quota-policy";
import { hydrationSettledWithin } from "./shared-runtime/bounded-hydration";
import { readSubscriberFundingCapacityInTransaction } from "./subscriber-inference-funding";

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

/**
 * Build the complete admission projection under the caller's policy lock:
 * the policy fields plus the billing-hold state and, for subscribers, funding
 * capacity at the same balance revision. These are what the snapshot admission
 * lane needs to admit without reading the primary before dispatch.
 */
export async function inferenceAdmissionSnapshotInTransaction(
  tx: DbTransaction,
  organizationId: string,
  policy: OrganizationQuotaPolicy,
): Promise<InferenceAdmissionSnapshot> {
  const snapshot = inferenceAdmissionSnapshotFromPolicy(policy);
  const hold = await billingHoldService.getState(organizationId, tx);
  const funding = policy.subscriptionFunded
    ? await readSubscriberFundingCapacityInTransaction(tx, organizationId, { policy })
    : undefined;
  return {
    ...snapshot,
    billingHold: hold.status === "held",
    ...(funding && { funding }),
  };
}

/**
 * Publish the snapshot's policy generation and balance to the organization
 * Durable Object before the projection becomes visible in any cache. Once the
 * gate has seen a generation, a cache-served admission carrying an older one
 * fails closed. A failed publication aborts the cache write.
 */
export async function publishInferenceAdmissionSnapshotToGate(
  organizationId: string,
  snapshot: InferenceAdmissionSnapshot,
): Promise<void> {
  if (!isSnapshotAdmissionEnabled()) return;
  // Non-Worker hosts have no gate binding and never serve snapshot admission.
  if (!getCloudBinding("INFERENCE_ADMISSION_GATES")) return;
  await publishInferenceAdmissionPolicy({
    organizationId,
    policyGeneration: snapshot.authority.generation,
    ...(snapshot.funding
      ? {
          balanceUsd: snapshot.funding.balanceUsd,
          balanceRevision: snapshot.funding.balanceRevision,
          balanceView: "funding" as const,
        }
      : {
          balanceUsd: snapshot.balance.balanceUsd,
          balanceRevision: snapshot.balance.balanceRevision,
        }),
  });
}

/** Populate the combined projection from authoritative stores off the hot path. */
export async function warmInferenceAdmissionSnapshot(
  organizationId: string,
): Promise<InferenceAdmissionSnapshot> {
  const key = CacheKeys.inference.orgAdmission(organizationId);
  return withOrganizationPolicyAdmission(organizationId, undefined, async (policy, tx) => {
    const snapshot = await inferenceAdmissionSnapshotInTransaction(tx, organizationId, policy);
    await publishInferenceAdmissionSnapshotToGate(organizationId, snapshot);
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
 * Repairs a projection that the authoritative admission check proved stale
 * (for example after a policy-generation bump from renewal, cancellation or an
 * override). The isolate copy is dropped at once and the shared entry is
 * republished from the primary, so the stale window closes on the first
 * rejected request instead of lasting the full cache TTL.
 */
export async function refreshStaleInferenceAdmissionSnapshot(
  organizationId: string,
): Promise<void> {
  const key = CacheKeys.inference.orgAdmission(organizationId);
  admissionMemoryCache.delete(key);
  try {
    await warmInferenceAdmissionSnapshot(organizationId);
  } catch (error) {
    // error-policy:J7 a failed republish must not leave the stale entry usable.
    await cache.del(key);
    throw error;
  }
}

/**
 * Read the published organization projection from the isolate or shared cache
 * only. Returns null on a miss or an unreadable cache; it never hydrates.
 */
export async function peekInferenceAdmissionSnapshot(
  organizationId: string,
): Promise<InferenceAdmissionSnapshot | null> {
  const key = CacheKeys.inference.orgAdmission(organizationId);
  const local = admissionMemoryCache.get(key);
  if (isInferenceAdmissionSnapshot(local)) return local;
  try {
    const cached = await cache.get<InferenceAdmissionSnapshot>(key);
    if (!isInferenceAdmissionSnapshot(cached)) return null;
    admissionMemoryCache.set(key, cached);
    return cached;
  } catch (error) {
    // error-policy:J4 a peek is advisory; the caller keeps its own fence.
    logger.warn("[inference-admission] admission snapshot peek failed", {
      organizationId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Resolve the shared-runtime billing and rate policy with one remote cache read.
 * Misses hydrate from authoritative stores only under the Worker lifetime.
 */
export async function getInferenceAdmissionSnapshotCacheOnly(
  organizationId: string,
  executionCtx: AdmissionSnapshotExecutionContext,
  options: {
    /**
     * Join the scheduled hydration for up to this long before reporting
     * warming. The hydration still runs under the Worker lifetime either way.
     */
    awaitHydrationMs?: number;
  } = {},
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
  if (
    options.awaitHydrationMs !== undefined &&
    options.awaitHydrationMs > 0 &&
    (await hydrationSettledWithin(hydration, options.awaitHydrationMs))
  ) {
    const hydrated = admissionMemoryCache.get(key);
    if (isInferenceAdmissionSnapshot(hydrated)) return hydrated;
  }
  throw new InferenceAdmissionSnapshotCacheWarmingError();
}
