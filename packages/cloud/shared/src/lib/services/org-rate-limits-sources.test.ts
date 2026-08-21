/**
 * Exercises authoritative organization-tier calculation with deterministic
 * database seams and a counted cache seam, including corrupt persisted data.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

type RpmOverride = {
  id: string;
  completions_rpm: number | null;
  embeddings_rpm: number | null;
  standard_rpm: number | null;
  strict_rpm: number | null;
  updated_at: Date;
};

let tierSourceCreditTotal: unknown = "0";
let override: RpmOverride | undefined;
let projection: Record<string, unknown> | undefined;
let legacyReads = 0;
let cacheWrites = 0;

mock.module("../../db/helpers", () => ({
  dbRead: {
    select: () => ({
      from: () => ({
        where: async () => {
          legacyReads += 1;
          return [{ tierSourceCreditTotal }];
        },
      }),
    }),
  },
}));

mock.module("../../db/repositories/org-rate-limit-overrides", () => ({
  orgRateLimitOverridesRepository: {
    findByOrganizationId: async () => override,
  },
}));

mock.module("../../db/repositories/subscription-entitlements", () => ({
  subscriptionEntitlementsRepository: {
    find: async () => projection,
  },
}));

mock.module("../cache/client", () => ({
  cache: {
    set: async () => {
      cacheWrites += 1;
    },
    get: async () => null,
    getWithOutcome: async () => ({ kind: "miss" as const }),
    del: async () => undefined,
  },
}));

const { getOrgRpmForEndpoint, readOrgTierFromSources, recalculateOrgTier } = await import(
  "./org-rate-limits"
);

const noOverride = (): RpmOverride => ({
  id: "40000000-0000-4000-8000-000000000001",
  completions_rpm: null,
  embeddings_rpm: null,
  standard_rpm: null,
  strict_rpm: null,
  updated_at: new Date("2026-01-01T00:00:00Z"),
});

beforeEach(() => {
  tierSourceCreditTotal = "0";
  override = undefined;
  projection = undefined;
  legacyReads = 0;
  cacheWrites = 0;
});

describe("authoritative organization rate-limit tier reads", () => {
  test.each(["NaN", "-1"])("rejects the corrupt tier-source credit total %s", async (value) => {
    tierSourceCreditTotal = value;

    await expect(readOrgTierFromSources("org-corrupt-spend")).rejects.toMatchObject({
      code: "ORG_ENTITLEMENT_UNAVAILABLE",
      context: { reason: "legacy_source_unavailable" },
    });
    expect(cacheWrites).toBe(0);
  });

  test.each([0, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects the invalid completions override %s",
    async (value) => {
      override = { ...noOverride(), completions_rpm: value };

      await expect(readOrgTierFromSources("org-corrupt-override")).rejects.toMatchObject({
        code: "ORG_ENTITLEMENT_UNAVAILABLE",
        context: { reason: "invalid_manual_override" },
      });
      expect(cacheWrites).toBe(0);
    },
  );

  test("returns a valid custom override without writing the inference cache", async () => {
    tierSourceCreditTotal = "7.25";
    override = {
      ...noOverride(),
      completions_rpm: 240,
      strict_rpm: 20,
    };

    await expect(readOrgTierFromSources("org-observation-only")).resolves.toEqual({
      tierName: "custom",
      completionsRpm: 240,
      embeddingsRpm: 200,
      standardRpm: 60,
      strictRpm: 20,
      catalogVersion: "v1",
      entitlementVersion: "legacy:credit-total:7.25|override:2026-01-01T00:00:00.000Z",
      manualOverrideVersion: "2026-01-01T00:00:00.000Z",
    });
    expect(cacheWrites).toBe(0);
  });

  test("recalculation caches the same authoritative result", async () => {
    tierSourceCreditTotal = "100";
    override = { ...noOverride(), embeddings_rpm: 900 };

    const observed = await readOrgTierFromSources("org-shared-calculation");
    const recalculated = await recalculateOrgTier("org-shared-calculation");

    expect(recalculated).toEqual(observed);
    expect(cacheWrites).toBe(1);
  });

  test("paid projection beats legacy spend while audited override remains highest", async () => {
    tierSourceCreditTotal = "9999";
    projection = {
      plan_key: "plus_monthly",
      state: "active",
      catalog_version: "v1",
      projection_revision: 12,
      effective_from: new Date("2026-01-01T00:00:00Z"),
      effective_until: new Date("2099-01-01T00:00:00Z"),
      completions_rpm: 120,
      embeddings_rpm: 200,
      standard_rpm: 60,
      strict_rpm: 10,
      cloud_characters_ceiling: 100,
      agent_sandboxes_ceiling: 100,
      containers_ceiling: 25,
      storage_gib_ceiling: 25,
      apps_ceiling: 25,
    };
    override = { ...noOverride(), standard_rpm: 77 };

    await expect(readOrgTierFromSources("org-subscriber")).resolves.toEqual({
      tierName: "custom",
      completionsRpm: 120,
      embeddingsRpm: 200,
      standardRpm: 77,
      strictRpm: 10,
      catalogVersion: "v1",
      entitlementVersion: "projection:12|override:2026-01-01T00:00:00.000Z",
      manualOverrideVersion: "2026-01-01T00:00:00.000Z",
    });
    expect(legacyReads).toBe(0);
  });

  test("all four endpoint limiters equal the central paid projection", async () => {
    projection = {
      plan_key: "pro_monthly",
      state: "grace",
      catalog_version: "v1",
      projection_revision: 13,
      effective_from: new Date("2026-01-01T00:00:00Z"),
      effective_until: new Date("2099-01-01T00:00:00Z"),
      completions_rpm: 300,
      embeddings_rpm: 600,
      standard_rpm: 120,
      strict_rpm: 30,
      cloud_characters_ceiling: 500,
      agent_sandboxes_ceiling: 500,
      containers_ceiling: 100,
      storage_gib_ceiling: 100,
      apps_ceiling: 25,
    };

    await expect(
      Promise.all(
        (["completions", "embeddings", "standard", "strict"] as const).map((endpoint) =>
          getOrgRpmForEndpoint("org-pro-grace", endpoint),
        ),
      ),
    ).resolves.toEqual([
      { windowMs: 60_000, maxRequests: 300 },
      { windowMs: 60_000, maxRequests: 600 },
      { windowMs: 60_000, maxRequests: 120 },
      { windowMs: 60_000, maxRequests: 30 },
    ]);
    expect(legacyReads).toBe(0);
  });
});
