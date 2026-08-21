/**
 * Exercises authoritative organization-tier calculation with deterministic
 * database seams and a counted cache seam, including corrupt persisted data.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

type RpmOverride = {
  completions_rpm: number | null;
  embeddings_rpm: number | null;
  standard_rpm: number | null;
  strict_rpm: number | null;
};

let tierSourceCreditTotal: unknown = "0";
let override: RpmOverride | undefined;
let cacheWrites = 0;

mock.module("../../db/helpers", () => ({
  dbRead: {
    select: () => ({
      from: () => ({
        where: async () => [{ tierSourceCreditTotal }],
      }),
    }),
  },
}));

mock.module("../../db/repositories/org-rate-limit-overrides", () => ({
  orgRateLimitOverridesRepository: {
    findByOrganizationId: async () => override,
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

const { readOrgTierFromSources, recalculateOrgTier } = await import("./org-rate-limits");

const noOverride = (): RpmOverride => ({
  completions_rpm: null,
  embeddings_rpm: null,
  standard_rpm: null,
  strict_rpm: null,
});

beforeEach(() => {
  tierSourceCreditTotal = "0";
  override = undefined;
  cacheWrites = 0;
});

describe("authoritative organization rate-limit tier reads", () => {
  test.each(["NaN", "-1"])("rejects the corrupt tier-source credit total %s", async (value) => {
    tierSourceCreditTotal = value;

    await expect(readOrgTierFromSources("org-corrupt-spend")).rejects.toMatchObject({
      code: "ORG_RATE_LIMIT_SOURCE_INVALID",
      context: { field: "tier_source_credit_total" },
    });
    expect(cacheWrites).toBe(0);
  });

  test.each([0, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects the invalid completions override %s",
    async (value) => {
      override = { ...noOverride(), completions_rpm: value };

      await expect(readOrgTierFromSources("org-corrupt-override")).rejects.toMatchObject({
        code: "ORG_RATE_LIMIT_SOURCE_INVALID",
        context: { field: "org_rate_limit_overrides" },
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
});
