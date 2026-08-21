/**
 * Verifies deterministic resource snapshots and fail-closed unavailable handling with mocked entitlement authority.
 */
import { describe, expect, it } from "vitest";
import type { SubscriptionEntitlementResolution } from "../subscription-entitlement-resolver";
import { SubscriptionResourceLimitService } from "../subscription-resource-limits";

function ready(
  planKey: "free" | "plus_monthly" | "pro_monthly",
  limits: {
    cloudCharacters: number;
    agentSandboxes: number;
    containers: number;
    storageGiB: number;
    apps: number;
  },
): SubscriptionEntitlementResolution {
  return {
    kind: "ready",
    organizationId: "org-1",
    source: planKey === "free" ? "free" : "subscription",
    baseSource: planKey === "free" ? "free" : "subscription",
    planKey,
    lifecycleState: planKey === "free" ? "free" : "active",
    legacySelectorKey: null,
    limits: {
      completionsRpm: 60,
      embeddingsRpm: 100,
      standardRpm: 30,
      strictRpm: 5,
      ...limits,
    },
    catalogVersion: "v1",
    entitlementVersion: "projection:7",
    versions: { catalog: "v1", entitlement: "projection:7", manualOverride: null },
  };
}

describe("SubscriptionResourceLimitService", () => {
  it.each([
    ["free", 5, 5, 1, 5, 25],
    ["plus_monthly", 100, 100, 25, 25, 25],
    ["pro_monthly", 500, 500, 100, 100, 25],
  ] as const)(
    "maps the exact %s catalog ceilings",
    async (plan, characters, agents, containers, storage, apps) => {
      const entitlement = ready(plan, {
        cloudCharacters: characters,
        agentSandboxes: agents,
        containers,
        storageGiB: storage,
        apps,
      });
      const service = new SubscriptionResourceLimitService({ resolve: async () => entitlement });

      const snapshot = await service.requireReady("org-1");
      expect(snapshot.limits).toEqual({
        cloudCharacters: characters,
        agentSandboxes: agents,
        containers,
        storageGiB: storage,
        storageBytes: BigInt(storage) * 1024n * 1024n * 1024n,
        apps,
      });
      expect(snapshot.entitlementVersion).toBe("projection:7");
    },
  );

  it("represents downgrade snapshots without mutating existing-resource state", async () => {
    let entitlement = ready("pro_monthly", {
      cloudCharacters: 500,
      agentSandboxes: 500,
      containers: 100,
      storageGiB: 100,
      apps: 25,
    });
    const service = new SubscriptionResourceLimitService({ resolve: async () => entitlement });
    expect((await service.requireReady("org-1")).limits.agentSandboxes).toBe(500);

    entitlement = ready("free", {
      cloudCharacters: 5,
      agentSandboxes: 5,
      containers: 1,
      storageGiB: 5,
      apps: 25,
    });
    expect((await service.requireReady("org-1")).limits.agentSandboxes).toBe(5);
  });

  it("fails closed with a typed error when entitlement authority is unavailable", async () => {
    const service = new SubscriptionResourceLimitService({
      resolve: async () => ({
        kind: "unavailable",
        organizationId: "org-1",
        reason: "projection_source_unavailable",
        retryable: true,
        detail: "database unavailable",
      }),
    });

    await expect(service.requireReady("org-1")).rejects.toMatchObject({
      code: "ORG_RESOURCE_LIMITS_UNAVAILABLE",
    });
  });
});
