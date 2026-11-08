/**
 * Hydrates the immutable admission projection stored beside inference identity.
 * Warm requests consume the projection from their single cache read; a cold or
 * superseded projection is filled from the primary once, inline.
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
import type { EndpointType, OrgRateLimitConfig } from "./org-rate-limits";
import { withOrganizationPolicyAdmission } from "./organization-policy-admission";
import {
  type OrganizationQuotaPolicy,
  requireOrganizationPolicyBalance,
  requireOrganizationRateTier,
} from "./organization-quota-policy";
import { readSubscriberFundingCapacityInTransaction } from "./subscriber-inference-funding";

const admissionMemoryCache = new InMemoryLRUCache<InferenceAdmissionSnapshot>(1_000, 5_000);

/** Clears isolate-local projection state for deterministic cache contract tests. */
export function resetInferenceAdmissionMemoryCacheForTests(): void {
  admissionMemoryCache.clear();
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
    ...(typeof snapshot.planKey === "string" && { planKey: snapshot.planKey }),
  };
}

export async function loadInferenceAdmissionSnapshot(
  organizationId: string,
): Promise<InferenceAdmissionSnapshot> {
  // Always the complete projection (hold and funding included): the Worker
  // admission lane decides from it without reading the primary again.
  return withOrganizationPolicyAdmission(organizationId, undefined, (policy, tx) =>
    inferenceAdmissionSnapshotInTransaction(tx, organizationId, policy),
  );
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
    planKey: requireOrganizationRateTier(policy).tierName,
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
    ? await readSubscriberFundingCapacityInTransaction(tx, organizationId, {
        policy,
      })
    : undefined;
  const { readInferenceBudgetPolicy, readInferencePolicy, isRatePolicyAdmissionEnabled } =
    await import("./inference-funded-budget-admission");
  const fundedBudget = await readInferenceBudgetPolicy(tx, organizationId, policy);
  const ratePolicy = isRatePolicyAdmissionEnabled()
    ? await readInferencePolicy(tx, organizationId, policy)
    : undefined;
  return {
    ...snapshot,
    billingHold: hold.status === "held",
    ...(funding && { funding }),
    ...(fundedBudget && { fundedBudget }),
    ...(ratePolicy?.rateEnabled && { ratePolicy }),
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

/**
 * Populate the combined projection from the primary and publish it to the
 * organization gate. The snapshot read inside the policy transaction is the
 * decision; a failed shared-cache write only means the next isolate fills
 * again, so it is reported and never fails the request being served.
 */
export async function warmInferenceAdmissionSnapshot(
  organizationId: string,
): Promise<InferenceAdmissionSnapshot> {
  const key = CacheKeys.inference.orgAdmission(organizationId);
  return withOrganizationPolicyAdmission(organizationId, undefined, async (policy, tx) => {
    const snapshot = await inferenceAdmissionSnapshotInTransaction(tx, organizationId, policy);
    await publishInferenceAdmissionSnapshotToGate(organizationId, snapshot);
    const outcome = await cache.setWithOutcome(key, snapshot, CacheTTL.inference.orgAdmission);
    if (outcome.kind !== "written")
      logger.warn("[inference-admission] admission snapshot cache write failed", {
        organizationId,
        cacheWrite: outcome.kind,
      });
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
 * Make a committed credit-balance change (top-up, refund, hold settlement or a
 * non-inference debit) visible to Worker admission before the next lease.
 * Where the organization gate is bound, the projection is republished from
 * the primary: that advances the gate to the committed balance revision, and
 * because the gate keeps the newest revision, a request still carrying an
 * older snapshot leases against the committed balance. Hosts without a gate
 * drop the shared projection so the next Worker admission refills it. Run
 * only after the owning transaction commits; the republish locks the policy row.
 */
export async function republishInferenceAdmissionAfterCreditMutation(
  organizationId: string,
): Promise<void> {
  if (getCloudBinding("INFERENCE_ADMISSION_GATES")) {
    await refreshStaleInferenceAdmissionSnapshot(organizationId);
    return;
  }
  const key = CacheKeys.inference.orgAdmission(organizationId);
  admissionMemoryCache.delete(key);
  await cache.del(key);
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

const inflightAdmissionFills = new Map<string, Promise<InferenceAdmissionSnapshot>>();

/**
 * Resolve the organization admission snapshot cache-first. A warm request does
 * one isolate or shared-cache read. A cold one fills the cache inline from the
 * authoritative stores (coalesced per isolate) and is served from that fill,
 * so a cold cache never fails the request.
 */
export async function getInferenceAdmissionSnapshotCacheFirst(
  organizationId: string,
): Promise<InferenceAdmissionSnapshot> {
  const key = CacheKeys.inference.orgAdmission(organizationId);
  const local = admissionMemoryCache.get(key);
  if (isInferenceAdmissionSnapshot(local)) return local;

  let cached: InferenceAdmissionSnapshot | null = null;
  try {
    cached = await cache.get<InferenceAdmissionSnapshot>(key);
  } catch (error) {
    // error-policy:J4 an unreadable shared cache falls through to the
    // authoritative fill below instead of failing the request.
    logger.warn("[inference-admission] admission snapshot cache read failed", {
      organizationId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  if (isInferenceAdmissionSnapshot(cached)) {
    admissionMemoryCache.set(key, cached);
    return cached;
  }
  return await fillInferenceAdmissionSnapshot(organizationId);
}

/** Authoritative fill shared by concurrent cold requests in this isolate. */
export function fillInferenceAdmissionSnapshot(
  organizationId: string,
): Promise<InferenceAdmissionSnapshot> {
  const existing = inflightAdmissionFills.get(organizationId);
  if (existing) return existing;
  const fill = warmInferenceAdmissionSnapshot(organizationId).finally(() => {
    inflightAdmissionFills.delete(organizationId);
  });
  inflightAdmissionFills.set(organizationId, fill);
  return fill;
}
