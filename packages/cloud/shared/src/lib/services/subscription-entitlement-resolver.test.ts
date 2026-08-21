/** Exercises the entitlement resolver's state and precedence truth table with deterministic sources. */
import { describe, expect, test } from "bun:test";
import type { SubscriptionPlanKey } from "../types/cloud-api";
import { getSubscriptionCatalogPlan } from "./subscription-catalog";
import {
  FREE_SUBSCRIPTION_ENTITLEMENT_LIMITS,
  type LegacyEntitlementSelection,
  type ManualEntitlementOverride,
  type SubscriptionEntitlementLimits,
  type SubscriptionEntitlementProjection,
  SubscriptionEntitlementService,
  type SubscriptionEntitlementSource,
  type SubscriptionEntitlementSources,
} from "./subscription-entitlement-resolver";

const ORG = "10000000-0000-4000-8000-000000000001";
const NOW = new Date("2026-01-15T00:00:00Z");

function paidProjection(
  planKey: SubscriptionPlanKey,
  state: SubscriptionEntitlementProjection["state"] = "active",
): SubscriptionEntitlementProjection {
  const plan = getSubscriptionCatalogPlan(planKey);
  return {
    planKey,
    state,
    catalogVersion: plan.catalogVersion,
    projectionRevision: 7,
    effectiveFrom: new Date("2026-01-01T00:00:00Z"),
    effectiveUntil: new Date("2026-02-01T00:00:00Z"),
    limits: { ...plan.rateLimits, ...plan.resourceCeilings },
  };
}

function available<T>(value: T | null): SubscriptionEntitlementSource<T> {
  return { kind: "available", value };
}

function legacySelection(): LegacyEntitlementSelection {
  return {
    selectorKey: "legacy-growth",
    selectorVersion: "credit-ledger:42",
    limits: {
      completionsRpm: 999,
      embeddingsRpm: 998,
      standardRpm: 997,
      strictRpm: 996,
      cloudCharacters: 95,
      agentSandboxes: 94,
      containers: 93,
      storageGiB: 92,
      apps: 91,
    },
  };
}

function sources(
  input: {
    projection?: SubscriptionEntitlementSource<SubscriptionEntitlementProjection>;
    override?: SubscriptionEntitlementSource<ManualEntitlementOverride>;
    legacy?: SubscriptionEntitlementSource<LegacyEntitlementSelection>;
    onLegacyRead?: () => void;
  } = {},
): SubscriptionEntitlementSources {
  return {
    readProjection: async () => input.projection ?? available(null),
    readManualOverride: async () => input.override ?? available(null),
    readLegacySelection: async () => {
      input.onLegacyRead?.();
      return input.legacy ?? available(null);
    },
  };
}

function expectedPlanLimits(planKey: SubscriptionPlanKey): SubscriptionEntitlementLimits {
  const plan = getSubscriptionCatalogPlan(planKey);
  return { ...plan.rateLimits, ...plan.resourceCeilings };
}

describe("subscription entitlement state and precedence truth table", () => {
  test.each([
    ["plus_monthly", "active"],
    ["plus_monthly", "grace"],
    ["pro_monthly", "active"],
    ["pro_monthly", "grace"],
  ] as const)("returns exact %s catalog limits while %s", async (planKey, state) => {
    let legacyReads = 0;
    const result = await new SubscriptionEntitlementService(
      sources({
        projection: available(paidProjection(planKey, state)),
        legacy: available(legacySelection()),
        onLegacyRead: () => {
          legacyReads += 1;
        },
      }),
    ).resolve(ORG, NOW);

    expect(result).toMatchObject({
      kind: "ready",
      source: "subscription",
      baseSource: "subscription",
      planKey,
      lifecycleState: state,
      catalogVersion: "v1",
      entitlementVersion: "projection:7",
      versions: { catalog: "v1", entitlement: "projection:7", manualOverride: null },
      limits: expectedPlanLimits(planKey),
    });
    expect(legacyReads).toBe(0);
  });

  test.each(["past_due", "unpaid", "canceled"] as const)(
    "falls to exact Free limits when subscription is %s",
    async (state) => {
      const result = await new SubscriptionEntitlementService(
        sources({
          projection: available(paidProjection("pro_monthly", state)),
          legacy: available(legacySelection()),
        }),
      ).resolve(ORG, NOW);
      expect(result).toMatchObject({
        kind: "ready",
        source: "free",
        planKey: "free",
        lifecycleState: state,
        limits: FREE_SUBSCRIPTION_ENTITLEMENT_LIMITS,
        entitlementVersion: "projection:7",
      });
    },
  );

  test("uses legacy only for a missing or explicit Free projection", async () => {
    for (const projection of [
      null,
      {
        planKey: "free",
        state: "free",
        catalogVersion: "v1",
        projectionRevision: 3,
        effectiveFrom: new Date("2026-01-01T00:00:00Z"),
        effectiveUntil: null,
        limits: { ...FREE_SUBSCRIPTION_ENTITLEMENT_LIMITS },
      } satisfies SubscriptionEntitlementProjection,
    ]) {
      const result = await new SubscriptionEntitlementService(
        sources({ projection: available(projection), legacy: available(legacySelection()) }),
      ).resolve(ORG, NOW);
      expect(result).toMatchObject({
        kind: "ready",
        source: "legacy",
        baseSource: "legacy",
        lifecycleState: "free",
        limits: legacySelection().limits,
        versions: { catalog: "v1", entitlement: "legacy:credit-ledger:42" },
      });
    }
  });

  test("returns exact Free limits when neither subscription nor legacy classification exists", async () => {
    const result = await new SubscriptionEntitlementService(sources()).resolve(ORG, NOW);
    expect(result).toMatchObject({
      kind: "ready",
      source: "free",
      baseSource: "free",
      planKey: "free",
      lifecycleState: "free",
      limits: FREE_SUBSCRIPTION_ENTITLEMENT_LIMITS,
      catalogVersion: "v1",
      entitlementVersion: "free:v1",
    });
  });

  test("applies an audited manual override after the paid projection", async () => {
    const override: ManualEntitlementOverride = {
      auditId: "audit-admin-ticket-23094",
      version: "override:12",
      fields: { completionsRpm: 777, containers: 44 },
    };
    const result = await new SubscriptionEntitlementService(
      sources({
        projection: available(paidProjection("plus_monthly")),
        override: available(override),
      }),
    ).resolve(ORG, NOW);
    expect(result).toMatchObject({
      kind: "ready",
      source: "manual_override",
      baseSource: "subscription",
      planKey: "plus_monthly",
      limits: {
        ...expectedPlanLimits("plus_monthly"),
        completionsRpm: 777,
        containers: 44,
      },
      entitlementVersion: "projection:7|override:override:12",
      versions: { catalog: "v1", manualOverride: "override:12" },
    });
  });

  test.each([
    [
      "catalog_projection_mismatch",
      {
        ...paidProjection("plus_monthly"),
        limits: { ...expectedPlanLimits("plus_monthly"), strictRpm: 11 },
      },
    ],
    ["projection_not_effective", { ...paidProjection("plus_monthly"), effectiveUntil: NOW }],
  ] as const)("fails closed with typed %s state", async (reason, projection) => {
    const result = await new SubscriptionEntitlementService(
      sources({ projection: available(projection) }),
    ).resolve(ORG, NOW);
    expect(result).toMatchObject({ kind: "unavailable", reason });
  });

  test.each([
    [
      "projection_source_unavailable",
      { projection: { kind: "unavailable", reason: "database timeout", retryable: true } },
    ],
    [
      "manual_override_source_unavailable",
      { override: { kind: "unavailable", reason: "audit store timeout", retryable: true } },
    ],
    [
      "legacy_source_unavailable",
      { legacy: { kind: "unavailable", reason: "legacy store timeout", retryable: true } },
    ],
  ] as const)("propagates %s as an explicit unavailable result", async (reason, input) => {
    const result = await new SubscriptionEntitlementService(sources(input)).resolve(ORG, NOW);
    expect(result).toMatchObject({ kind: "unavailable", reason, retryable: true });
  });

  test("rejects unaudited or unbounded manual override data", async () => {
    const result = await new SubscriptionEntitlementService(
      sources({
        projection: available(paidProjection("pro_monthly")),
        override: available({ auditId: "", version: "override:1", fields: { strictRpm: 0 } }),
      }),
    ).resolve(ORG, NOW);
    expect(result).toMatchObject({ kind: "unavailable", reason: "invalid_manual_override" });
  });
});
