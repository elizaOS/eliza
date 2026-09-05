/**
 * Hydrates the immutable admission projection stored beside inference identity.
 * Database work is allowed only while warming the combined decision under a
 * Worker lifetime; warm requests consume the projection from their single KV read.
 */

import { ElizaError } from "@elizaos/core";
import { subscriptionEntitlementsRepository } from "../../db/repositories/subscription-entitlements";
import type { Organization } from "../../db/schemas/organizations";
import { cache } from "../cache/client";
import { InMemoryLRUCache } from "../cache/in-memory-lru-cache";
import { CacheKeys, CacheTTL } from "../cache/keys";
import { logger } from "../utils/logger";
import { creditsService } from "./credits";
import type { InferenceAdmissionSnapshot } from "./inference-auth-cache";
import {
  type EndpointType,
  type OrgRateLimitConfig,
  readOrgTierFromSources,
} from "./org-rate-limits";
import { parseOrganizationBalanceSnapshot } from "./organization-balance-snapshot";

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
  primaryRead?: {
    organization: Pick<Organization, "id" | "credit_balance" | "balance_revision">;
    startedAt: number;
  },
): Promise<InferenceAdmissionSnapshot> {
  const now = Date.now();
  if (
    primaryRead &&
    (primaryRead.organization.id !== organizationId ||
      !Number.isFinite(primaryRead.startedAt) ||
      primaryRead.startedAt <= 0 ||
      primaryRead.startedAt > now)
  ) {
    throw new ElizaError("[inference-admission] Invalid primary balance observation", {
      code: "INVALID_PRIMARY_BALANCE_OBSERVATION",
    });
  }
  const balanceAt = primaryRead ? primaryRead.startedAt : now;
  const primaryBalance = primaryRead
    ? parseOrganizationBalanceSnapshot(primaryRead.organization)
    : undefined;
  const [balance, tier, entitlement] = await Promise.all([
    primaryBalance ?? creditsService.getOrganizationBalanceSnapshot(organizationId),
    readOrgTierFromSources(organizationId),
    subscriptionEntitlementsRepository.find(organizationId),
  ]);
  const subscriptionFunded = entitlement !== undefined && entitlement.plan_key !== "free";
  return {
    subscriptionFunded,
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

  let cached: InferenceAdmissionSnapshot | null;
  try {
    cached = await cache.get<InferenceAdmissionSnapshot>(key);
  } catch (error) {
    // error-policy:J4 inference cannot safely proceed without admission policy.
    throw new InferenceAdmissionSnapshotCacheWarmingError(
      error instanceof Error ? error.message : undefined,
    );
  }
  if (cached) {
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
