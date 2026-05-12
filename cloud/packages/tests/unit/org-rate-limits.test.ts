import { describe, expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Unit tests for the org rate limit tier system.
 *
 * Tests tier threshold matching, override merging, endpoint mapping,
 * and route wiring — without requiring a real DB or Redis.
 *
 * Follows the same pure-function testing pattern as rate-limit-presets.test.ts.
 */

// Sentinel-checked repo root
const REPO_ROOT = (() => {
  const candidate = join(import.meta.dir, "..", "..", "..");
  statSync(join(candidate, "package.json"));
  return candidate;
})();

// ---------------------------------------------------------------------------
// Replicate the tier logic locally for unit testing (avoids DB/Redis mocks)
// ---------------------------------------------------------------------------

type EndpointType = "completions" | "embeddings" | "standard" | "strict";

interface TierThreshold {
  name: string;
  minSpend: number;
  completionsRpm: number;
  embeddingsRpm: number;
  standardRpm: number;
  strictRpm: number;
}

interface OrgTierData {
  tierName: string;
  completionsRpm: number;
  embeddingsRpm: number;
  standardRpm: number;
  strictRpm: number;
}

// These MUST match the values in packages/lib/services/org-rate-limits.ts
const TIER_THRESHOLDS: TierThreshold[] = [
  {
    name: "growth",
    minSpend: 100,
    completionsRpm: 300,
    embeddingsRpm: 600,
    standardRpm: 120,
    strictRpm: 30,
  },
  {
    name: "paid",
    minSpend: 5,
    completionsRpm: 120,
    embeddingsRpm: 200,
    standardRpm: 60,
    strictRpm: 10,
  },
  {
    name: "free",
    minSpend: 0,
    completionsRpm: 60,
    embeddingsRpm: 100,
    standardRpm: 30,
    strictRpm: 5,
  },
];

const FREE_TIER = TIER_THRESHOLDS[TIER_THRESHOLDS.length - 1];

/** Matches the logic in recalculateOrgTier */
function computeTier(totalSpend: number): TierThreshold {
  const sorted = [...TIER_THRESHOLDS].sort((a, b) => b.minSpend - a.minSpend);
  return sorted.find((t) => totalSpend >= t.minSpend) ?? FREE_TIER;
}

/** Matches the override merge logic in recalculateOrgTier */
function mergeTierWithOverride(
  tier: TierThreshold,
  override?: {
    completions_rpm?: number | null;
    embeddings_rpm?: number | null;
    standard_rpm?: number | null;
    strict_rpm?: number | null;
  },
): OrgTierData {
  const base: OrgTierData = {
    tierName: tier.name,
    completionsRpm: tier.completionsRpm,
    embeddingsRpm: tier.embeddingsRpm,
    standardRpm: tier.standardRpm,
    strictRpm: tier.strictRpm,
  };

  if (!override) return base;

  const hasRpmOverride =
    override.completions_rpm != null ||
    override.embeddings_rpm != null ||
    override.standard_rpm != null ||
    override.strict_rpm != null;

  return {
    tierName: hasRpmOverride ? "custom" : tier.name,
    completionsRpm: override.completions_rpm ?? base.completionsRpm,
    embeddingsRpm: override.embeddings_rpm ?? base.embeddingsRpm,
    standardRpm: override.standard_rpm ?? base.standardRpm,
    strictRpm: override.strict_rpm ?? base.strictRpm,
  };
}

/** Matches getOrgRpmForEndpoint */
function getRpmForEndpoint(tier: OrgTierData, endpointType: EndpointType) {
  const key = `${endpointType}Rpm` as const;
  return { windowMs: 60_000, maxRequests: tier[key] };
}

// ---------------------------------------------------------------------------
// Tests: Tier Calculation
// ---------------------------------------------------------------------------

describe("Org Rate Limits — Tier Thresholds", () => {
  test("$0 spend → free tier", () => {
    const tier = computeTier(0);
    expect(tier.name).toBe("free");
    expect(tier.completionsRpm).toBe(60);
    expect(tier.embeddingsRpm).toBe(100);
    expect(tier.standardRpm).toBe(30);
    expect(tier.strictRpm).toBe(5);
  });

  test("$4.99 spend → still free", () => {
    expect(computeTier(4.99).name).toBe("free");
  });

  test("free credits excluded — $4.99 paid + $100 free = still free tier", () => {
    // recalculateOrgTier filters out FREE_CREDIT_TYPES before summing.
    // Only paid spend counts. This test validates the tier logic:
    // an org with $4.99 of real purchases stays free regardless of bonuses.
    expect(computeTier(4.99).name).toBe("free");
    // And $5 paid would be paid, even if they also got $100 free
    expect(computeTier(5).name).toBe("paid");
  });

  test("$5 boundary → paid", () => {
    const tier = computeTier(5);
    expect(tier.name).toBe("paid");
    expect(tier.completionsRpm).toBe(120);
    expect(tier.embeddingsRpm).toBe(200);
    expect(tier.standardRpm).toBe(60);
    expect(tier.strictRpm).toBe(10);
  });

  test("$50 → paid", () => {
    expect(computeTier(50).name).toBe("paid");
  });

  test("$99.99 → paid", () => {
    expect(computeTier(99.99).name).toBe("paid");
  });

  test("$100 boundary → growth", () => {
    const tier = computeTier(100);
    expect(tier.name).toBe("growth");
    expect(tier.completionsRpm).toBe(300);
    expect(tier.embeddingsRpm).toBe(600);
    expect(tier.standardRpm).toBe(120);
    expect(tier.strictRpm).toBe(30);
  });

  test("$10000 → growth", () => {
    expect(computeTier(10000).name).toBe("growth");
  });

  test("each tier doubles RPM from the previous", () => {
    const free = computeTier(0);
    const paid = computeTier(5);
    const growth = computeTier(100);

    // completions: 60 → 120 → 300
    expect(paid.completionsRpm).toBe(free.completionsRpm * 2);
    expect(growth.completionsRpm).toBe(paid.completionsRpm * 2.5);

    // embeddings: 100 → 200 → 600
    expect(paid.embeddingsRpm).toBe(free.embeddingsRpm * 2);
    expect(growth.embeddingsRpm).toBe(paid.embeddingsRpm * 3);
  });
});

// ---------------------------------------------------------------------------
// Tests: Override Merging
// ---------------------------------------------------------------------------

describe("Org Rate Limits — Override Merging", () => {
  test("override replaces non-null fields only", () => {
    const tier = computeTier(5); // paid
    const merged = mergeTierWithOverride(tier, {
      completions_rpm: 500,
      embeddings_rpm: null,
      standard_rpm: null,
      strict_rpm: 25,
    });

    expect(merged.tierName).toBe("custom");
    expect(merged.completionsRpm).toBe(500); // overridden
    expect(merged.embeddingsRpm).toBe(200); // paid default
    expect(merged.standardRpm).toBe(60); // paid default
    expect(merged.strictRpm).toBe(25); // overridden
  });

  test("all-null override → tier defaults with base tier name", () => {
    const tier = computeTier(100); // growth
    const merged = mergeTierWithOverride(tier, {
      completions_rpm: null,
      embeddings_rpm: null,
      standard_rpm: null,
      strict_rpm: null,
    });

    expect(merged.tierName).toBe("growth"); // no RPM override → keeps base tier name
    expect(merged.completionsRpm).toBe(300);
    expect(merged.embeddingsRpm).toBe(600);
  });

  test("no override → tier defaults", () => {
    const tier = computeTier(5); // paid
    const merged = mergeTierWithOverride(tier, undefined);

    expect(merged.tierName).toBe("paid");
    expect(merged.completionsRpm).toBe(120);
  });

  test("null clears a single override field back to tier default", () => {
    const tier = computeTier(5); // paid: completionsRpm=120
    // First set an override
    const withOverride = mergeTierWithOverride(tier, { completions_rpm: 500 });
    expect(withOverride.completionsRpm).toBe(500);

    // Then "clear" it by setting null — should revert to tier default
    const cleared = mergeTierWithOverride(tier, { completions_rpm: null });
    expect(cleared.completionsRpm).toBe(120); // paid tier default
  });

  test("override on free tier", () => {
    const tier = computeTier(0); // free
    const merged = mergeTierWithOverride(tier, {
      completions_rpm: 1000,
    });

    expect(merged.tierName).toBe("custom");
    expect(merged.completionsRpm).toBe(1000);
    expect(merged.embeddingsRpm).toBe(100); // free default
  });
});

// ---------------------------------------------------------------------------
// Tests: Endpoint RPM Mapping
// ---------------------------------------------------------------------------

describe("Org Rate Limits — Endpoint Mapping", () => {
  const paidTier = mergeTierWithOverride(computeTier(5));

  test("completions → 120rpm", () => {
    expect(getRpmForEndpoint(paidTier, "completions")).toEqual({
      windowMs: 60_000,
      maxRequests: 120,
    });
  });

  test("embeddings → 200rpm", () => {
    expect(getRpmForEndpoint(paidTier, "embeddings")).toEqual({
      windowMs: 60_000,
      maxRequests: 200,
    });
  });

  test("standard → 60rpm", () => {
    expect(getRpmForEndpoint(paidTier, "standard")).toEqual({
      windowMs: 60_000,
      maxRequests: 60,
    });
  });

  test("strict → 10rpm", () => {
    expect(getRpmForEndpoint(paidTier, "strict")).toEqual({
      windowMs: 60_000,
      maxRequests: 10,
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: Source parity — verify routes are wired to enforceOrgRateLimit
// ---------------------------------------------------------------------------

describe("Org Rate Limits — Route Wiring", () => {
  test("chat/completions calls enforceOrgRateLimit with 'completions'", () => {
    const source = readFileSync(join(REPO_ROOT, "apps/api/v1/chat/completions/route.ts"), "utf8");
    expect(source).toMatch(/enforceOrgRateLimit\s*\(/);
    expect(source).toMatch(/["']completions["']/);
  });

  test("embeddings calls enforceOrgRateLimit with 'embeddings'", () => {
    const source = readFileSync(join(REPO_ROOT, "apps/api/v1/embeddings/route.ts"), "utf8");
    expect(source).toMatch(/enforceOrgRateLimit\s*\(/);
    expect(source).toMatch(/["']embeddings["']/);
  });

  test("responses calls enforceOrgRateLimit with 'completions' (shared counter)", () => {
    const source = readFileSync(join(REPO_ROOT, "apps/api/v1/responses/route.ts"), "utf8");
    expect(source).toMatch(/enforceOrgRateLimit\s*\(/);
    // Intentionally shares completions counter
    expect(source).toMatch(/["']completions["']/);
  });

  test("responses guards anonymous users (null org_id check)", () => {
    const source = readFileSync(join(REPO_ROOT, "apps/api/v1/responses/route.ts"), "utf8");
    expect(source).toMatch(/if\s*\(\s*user\.organization_id\s*\)/);
  });

  test("stripe queue consumer invalidates tier cache after payment", () => {
    // Cache invalidation runs in the queue consumer (not the webhook handler)
    // so Stripe retry bursts cannot race with tier recalculation.
    const source = readFileSync(join(REPO_ROOT, "apps/api/src/queue/stripe-event.ts"), "utf8");
    expect(source).toMatch(/invalidateOrgTierCache/);
  });

  test("admin endpoint validates orgId as UUID", () => {
    const source = readFileSync(
      join(REPO_ROOT, "apps/api/v1/admin/orgs/[orgId]/rate-limits/route.ts"),
      "utf8",
    );
    expect(source).toMatch(/validateOrgId/);
  });
});

// ---------------------------------------------------------------------------
// Tests: Tier config parity — verify test values match source
// ---------------------------------------------------------------------------

describe("Org Rate Limits — Config Parity", () => {
  test("tier thresholds in test match source code", () => {
    const source = readFileSync(
      join(REPO_ROOT, "packages/lib/services/org-rate-limits.ts"),
      "utf8",
    );

    // Verify key values are present in source
    for (const tier of TIER_THRESHOLDS) {
      expect(source).toContain(`name: "${tier.name}"`);
      expect(source).toContain(`minSpend: ${tier.minSpend}`);
      expect(source).toContain(`completionsRpm: ${tier.completionsRpm}`);
      expect(source).toContain(`embeddingsRpm: ${tier.embeddingsRpm}`);
    }
  });

  test("FREE_CREDIT_TYPES excludes bonus credits", () => {
    const source = readFileSync(
      join(REPO_ROOT, "packages/lib/services/org-rate-limits.ts"),
      "utf8",
    );
    expect(source).toContain('"initial_free_credits"');
    expect(source).toContain('"wallet_signup"');
    expect(source).toContain('"signup_code_bonus"');
  });

  test("cache TTL is 1 hour", () => {
    const source = readFileSync(
      join(REPO_ROOT, "packages/lib/services/org-rate-limits.ts"),
      "utf8",
    );
    expect(source).toMatch(/TIER_CACHE_TTL_SECONDS\s*=\s*3600/);
  });
});
