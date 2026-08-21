/**
 * Exposes the authoritative subscription resource ceilings used by server admission paths.
 * Unavailable entitlement sources remain typed and fail closed at the enforcement boundary.
 */
import { ElizaError } from "@elizaos/core";
import type { SubscriptionPlanKey } from "../types/cloud-api";
import type {
  SubscriptionEntitlementLifecycleState,
  SubscriptionEntitlementService,
  SubscriptionEntitlementVersions,
} from "./subscription-entitlement-resolver";

export interface SubscriptionResourceLimits {
  cloudCharacters: number;
  agentSandboxes: number;
  containers: number;
  storageGiB: number;
  storageBytes: bigint;
  apps: number;
}

export interface ReadySubscriptionResourceLimitSnapshot {
  kind: "ready";
  organizationId: string;
  planKey: "free" | SubscriptionPlanKey;
  lifecycleState: SubscriptionEntitlementLifecycleState;
  source: "free" | "legacy" | "subscription" | "manual_override";
  limits: SubscriptionResourceLimits;
  catalogVersion: string;
  entitlementVersion: string;
  versions: SubscriptionEntitlementVersions;
}

export interface UnavailableSubscriptionResourceLimitSnapshot {
  kind: "unavailable";
  organizationId: string;
  reason: string;
  retryable: boolean;
  detail: string;
}

export type SubscriptionResourceLimitSnapshot =
  | ReadySubscriptionResourceLimitSnapshot
  | UnavailableSubscriptionResourceLimitSnapshot;

const GIB_BYTES = 1024n * 1024n * 1024n;

export class SubscriptionResourceLimitService {
  constructor(private readonly entitlements?: Pick<SubscriptionEntitlementService, "resolve">) {}

  private async resolveEntitlement(organizationId: string) {
    if (this.entitlements) return await this.entitlements.resolve(organizationId);
    const { subscriptionEntitlementService } = await import("./org-rate-limits");
    return await subscriptionEntitlementService.resolve(organizationId);
  }

  async resolve(organizationId: string): Promise<SubscriptionResourceLimitSnapshot> {
    const entitlement = await this.resolveEntitlement(organizationId);
    if (entitlement.kind === "unavailable") return entitlement;
    return {
      kind: "ready",
      organizationId,
      planKey: entitlement.planKey,
      lifecycleState: entitlement.lifecycleState,
      source: entitlement.source,
      limits: {
        cloudCharacters: entitlement.limits.cloudCharacters,
        agentSandboxes: entitlement.limits.agentSandboxes,
        containers: entitlement.limits.containers,
        storageGiB: entitlement.limits.storageGiB,
        storageBytes: BigInt(entitlement.limits.storageGiB) * GIB_BYTES,
        apps: entitlement.limits.apps,
      },
      catalogVersion: entitlement.catalogVersion,
      entitlementVersion: entitlement.entitlementVersion,
      versions: entitlement.versions,
    };
  }

  async requireReady(organizationId: string): Promise<ReadySubscriptionResourceLimitSnapshot> {
    const snapshot = await this.resolve(organizationId);
    if (snapshot.kind === "ready") return snapshot;
    throw new ElizaError("Organization subscription resource limits are unavailable", {
      code: "ORG_RESOURCE_LIMITS_UNAVAILABLE",
      context: {
        organizationId,
        reason: snapshot.reason,
        detail: snapshot.detail,
        retryable: snapshot.retryable,
      },
      severity: "ephemeral",
    });
  }
}

/**
 * Atomic admission callers acquire the organization row lock before resolving.
 * Projection rebuilds acquire that same lock before changing any ceiling, so
 * the resolver's separate connection observes either the completed old state
 * or the completed new state; it cannot authorize from a revision that is
 * concurrently being downgraded. Legacy selection and production manual
 * overrides do not alter resource fields.
 */
export const subscriptionResourceLimitService = new SubscriptionResourceLimitService();
