/**
 * Tests for rubric utilities
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_RUBRIC,
  getAllRubricsHash,
  getAvailableArchetypes,
  getPriorityMetrics,
  getRubric,
  getRubricHash,
  hasCustomRubric,
  normalizeArchetype,
  RUBRICS_VERSION,
} from "../index";

describe("normalizeArchetype", () => {
  it("should convert to lowercase", () => {
    expect(normalizeArchetype("DEGEN")).toBe("degen");
    expect(normalizeArchetype("Trader")).toBe("trader");
    expect(normalizeArchetype("SOCIAL-BUTTERFLY")).toBe("social-butterfly");
  });

  it("should replace underscores with hyphens", () => {
    expect(normalizeArchetype("social_butterfly")).toBe("social-butterfly");
    expect(normalizeArchetype("goody_twoshoes")).toBe("goody-twoshoes");
    expect(normalizeArchetype("perps_trader")).toBe("perps-trader");
  });

  it("should trim whitespace", () => {
    expect(normalizeArchetype("  degen  ")).toBe("degen");
    expect(normalizeArchetype("\ttrader\n")).toBe("trader");
  });

  it("should handle mixed case with underscores", () => {
    expect(normalizeArchetype("Social_Butterfly")).toBe("social-butterfly");
    expect(normalizeArchetype("PERPS_TRADER")).toBe("perps-trader");
  });

  it('should return "default" for empty/null/undefined', () => {
    expect(normalizeArchetype("")).toBe("default");
    expect(normalizeArchetype("   ")).toBe("default");
    expect(normalizeArchetype(null)).toBe("default");
    expect(normalizeArchetype(undefined)).toBe("default");
  });

  it("should handle already normalized archetypes", () => {
    expect(normalizeArchetype("degen")).toBe("degen");
    expect(normalizeArchetype("social-butterfly")).toBe("social-butterfly");
  });
});

describe("getRubric", () => {
  it("should return rubric for known archetypes", () => {
    const archetypes = getAvailableArchetypes();
    for (const archetype of archetypes) {
      const rubric = getRubric(archetype);
      expect(typeof rubric).toBe("string");
      expect(rubric.length).toBeGreaterThan(0);
    }
  });

  it("should return custom rubrics (not default) for all available archetypes", () => {
    const archetypes = getAvailableArchetypes();
    for (const archetype of archetypes) {
      expect(hasCustomRubric(archetype)).toBe(true);
      // Also verify the rubric is different from default
      const rubric = getRubric(archetype);
      expect(rubric).not.toBe(DEFAULT_RUBRIC);
    }
  });

  it("should return default rubric for unknown archetypes", () => {
    const rubric = getRubric("unknown-archetype-xyz");
    expect(rubric).toBe(DEFAULT_RUBRIC);
  });

  it("should handle case normalization", () => {
    const lower = getRubric("degen");
    const upper = getRubric("DEGEN");
    const mixed = getRubric("Degen");
    expect(lower).toBe(upper);
    expect(lower).toBe(mixed);
  });

  it("should handle underscore/hyphen normalization", () => {
    const hyphen = getRubric("social-butterfly");
    const underscore = getRubric("social_butterfly");
    expect(hyphen).toBe(underscore);
  });
});

describe("getPriorityMetrics", () => {
  it("should return array of metrics for known archetypes", () => {
    const archetypes = getAvailableArchetypes();
    for (const archetype of archetypes) {
      const metrics = getPriorityMetrics(archetype);
      expect(Array.isArray(metrics)).toBe(true);
      expect(metrics.length).toBeGreaterThan(0);
    }
  });

  it("should return default metrics for unknown archetypes", () => {
    const metrics = getPriorityMetrics("unknown-archetype");
    expect(Array.isArray(metrics)).toBe(true);
    expect(metrics.length).toBeGreaterThan(0);
  });
});

describe("hasCustomRubric", () => {
  it("should return true for known archetypes", () => {
    expect(hasCustomRubric("degen")).toBe(true);
    expect(hasCustomRubric("trader")).toBe(true);
    expect(hasCustomRubric("social-butterfly")).toBe(true);
  });

  it("should return false for unknown archetypes", () => {
    expect(hasCustomRubric("unknown")).toBe(false);
    expect(hasCustomRubric("random-name")).toBe(false);
  });

  it("should handle case normalization", () => {
    expect(hasCustomRubric("DEGEN")).toBe(true);
    expect(hasCustomRubric("Trader")).toBe(true);
  });
});

describe("getAvailableArchetypes", () => {
  it("should return array of canonical archetype names", () => {
    const archetypes = getAvailableArchetypes();
    expect(Array.isArray(archetypes)).toBe(true);
    expect(archetypes.length).toBeGreaterThanOrEqual(12);
  });

  it("should only contain hyphenated names (not aliases)", () => {
    const archetypes = getAvailableArchetypes();
    // Should not contain aliases like 'socialbutterfly'
    expect(archetypes).not.toContain("socialbutterfly");
    expect(archetypes).not.toContain("goodytwoshoes");
    // Should contain canonical names
    expect(archetypes).toContain("social-butterfly");
    expect(archetypes).toContain("goody-twoshoes");
  });
});

describe("getRubricHash", () => {
  it("should return consistent hash for same archetype", () => {
    const hash1 = getRubricHash("degen");
    const hash2 = getRubricHash("degen");
    expect(hash1).toBe(hash2);
  });

  it("should return different hashes for different archetypes", () => {
    const degenHash = getRubricHash("degen");
    const traderHash = getRubricHash("trader");
    expect(degenHash).not.toBe(traderHash);
  });

  it("should return 16-character hex string", () => {
    const hash = getRubricHash("degen");
    expect(hash.length).toBe(16);
    expect(/^[0-9a-f]+$/.test(hash)).toBe(true);
  });
});

describe("getAllRubricsHash", () => {
  it("should return consistent hash", () => {
    const hash1 = getAllRubricsHash();
    const hash2 = getAllRubricsHash();
    expect(hash1).toBe(hash2);
  });

  it("should return 16-character hex string", () => {
    const hash = getAllRubricsHash();
    expect(hash.length).toBe(16);
    expect(/^[0-9a-f]+$/.test(hash)).toBe(true);
  });
});

describe("RUBRICS_VERSION", () => {
  it("should be a valid semver string", () => {
    expect(RUBRICS_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
