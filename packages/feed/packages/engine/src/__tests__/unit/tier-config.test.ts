/**
 * Tests for Tier Configuration
 *
 * Verifies tier configuration helpers, engagement score mapping,
 * promotion/demotion eligibility, and NPC-specific overrides.
 */

import { describe, expect, it } from "vitest";
import {
  ALL_TIERS,
  getEffectiveTierConfig,
  getHigherTier,
  getLowerTier,
  getTierConfig,
  getTierForEngagementScore,
  getTierForEngagementScoreWithNpc,
  getTierGroupName,
  getTierMessageGuidance,
  getTotalNpcCapacity,
  isEligibleForPromotion,
  isValidTier,
  shouldDemote,
  TIER_CONFIG,
} from "../../services/tier-config";

describe("Tier Config", () => {
  describe("isValidTier", () => {
    it("should return true for valid tier numbers", () => {
      expect(isValidTier(1)).toBe(true);
      expect(isValidTier(2)).toBe(true);
      expect(isValidTier(3)).toBe(true);
    });

    it("should return false for invalid tier numbers", () => {
      expect(isValidTier(0)).toBe(false);
      expect(isValidTier(4)).toBe(false);
      expect(isValidTier(-1)).toBe(false);
      expect(isValidTier(1.5)).toBe(false);
    });

    it("should return false for non-numeric values", () => {
      expect(isValidTier(null)).toBe(false);
      expect(isValidTier(undefined)).toBe(false);
      expect(isValidTier("1")).toBe(false);
      expect(isValidTier({})).toBe(false);
    });
  });

  describe("ALL_TIERS", () => {
    it("should contain exactly 3 tiers", () => {
      expect(ALL_TIERS).toHaveLength(3);
      expect(ALL_TIERS).toEqual([1, 2, 3]);
    });
  });

  describe("getTierConfig", () => {
    it("should return correct config for Tier 1 (Inner Circle)", () => {
      const config = getTierConfig(1);
      expect(config.name).toBe("Inner Circle");
      expect(config.maxMembers).toBe(12);
      expect(config.minEngagementScore).toBe(80);
      expect(config.alphaLevel).toBe("full");
    });

    it("should return correct config for Tier 2 (Community)", () => {
      const config = getTierConfig(2);
      expect(config.name).toBe("Community");
      expect(config.maxMembers).toBe(50);
      expect(config.minEngagementScore).toBe(50);
      expect(config.alphaLevel).toBe("partial");
    });

    it("should return correct config for Tier 3 (Followers)", () => {
      const config = getTierConfig(3);
      expect(config.name).toBe("Followers");
      expect(config.maxMembers).toBe(500);
      expect(config.minEngagementScore).toBe(20);
      expect(config.alphaLevel).toBe("public");
    });

    it("should have decreasing exclusivity from Tier 1 to Tier 3", () => {
      expect(TIER_CONFIG[1].maxMembers).toBeLessThan(TIER_CONFIG[2].maxMembers);
      expect(TIER_CONFIG[2].maxMembers).toBeLessThan(TIER_CONFIG[3].maxMembers);

      expect(TIER_CONFIG[1].minEngagementScore).toBeGreaterThan(
        TIER_CONFIG[2].minEngagementScore,
      );
      expect(TIER_CONFIG[2].minEngagementScore).toBeGreaterThan(
        TIER_CONFIG[3].minEngagementScore,
      );
    });
  });

  describe("getTierGroupName", () => {
    it("should format group names correctly", () => {
      expect(getTierGroupName("AIlon Musk", 1)).toBe(
        "AIlon Musk's Inner Circle",
      );
      expect(getTierGroupName("AIlon Musk", 2)).toBe("AIlon Musk's Community");
      expect(getTierGroupName("AIlon Musk", 3)).toBe("AIlon Musk's Followers");
    });

    it("should handle NPC names with special characters", () => {
      expect(getTierGroupName("Sam AIltman", 1)).toBe(
        "Sam AIltman's Inner Circle",
      );
      expect(getTierGroupName("BAIri Weiss", 3)).toBe(
        "BAIri Weiss's Followers",
      );
    });
  });

  describe("getTierForEngagementScore", () => {
    it("should return Tier 1 for scores >= 80", () => {
      expect(getTierForEngagementScore(80)).toBe(1);
      expect(getTierForEngagementScore(100)).toBe(1);
      expect(getTierForEngagementScore(95)).toBe(1);
    });

    it("should return Tier 2 for scores 50-79", () => {
      expect(getTierForEngagementScore(50)).toBe(2);
      expect(getTierForEngagementScore(79)).toBe(2);
      expect(getTierForEngagementScore(65)).toBe(2);
    });

    it("should return Tier 3 for scores 20-49", () => {
      expect(getTierForEngagementScore(20)).toBe(3);
      expect(getTierForEngagementScore(49)).toBe(3);
      expect(getTierForEngagementScore(35)).toBe(3);
    });

    it("should return null for scores below 20", () => {
      expect(getTierForEngagementScore(19)).toBeNull();
      expect(getTierForEngagementScore(0)).toBeNull();
      expect(getTierForEngagementScore(-10)).toBeNull();
    });
  });

  describe("isEligibleForPromotion", () => {
    it("should never allow promotion from Tier 1", () => {
      expect(isEligibleForPromotion(1, 100, 365)).toBe(false);
    });

    it("should allow promotion from Tier 2 to Tier 1 with high score and wait time", () => {
      // Needs score >= 80 and 14 days in Tier 2
      expect(isEligibleForPromotion(2, 80, 14)).toBe(true);
      expect(isEligibleForPromotion(2, 90, 30)).toBe(true);
    });

    it("should not allow promotion from Tier 2 with insufficient score", () => {
      expect(isEligibleForPromotion(2, 79, 30)).toBe(false);
      expect(isEligibleForPromotion(2, 50, 14)).toBe(false);
    });

    it("should not allow promotion from Tier 2 with insufficient wait time", () => {
      expect(isEligibleForPromotion(2, 90, 13)).toBe(false);
      expect(isEligibleForPromotion(2, 80, 0)).toBe(false);
    });

    it("should allow promotion from Tier 3 to Tier 2 immediately (0 wait days)", () => {
      // Tier 3 has promotionWaitDays: 0, so only score matters
      expect(isEligibleForPromotion(3, 50, 0)).toBe(true);
      expect(isEligibleForPromotion(3, 60, 1)).toBe(true);
    });

    it("should not allow promotion from Tier 3 with insufficient score", () => {
      expect(isEligibleForPromotion(3, 49, 30)).toBe(false);
      expect(isEligibleForPromotion(3, 30, 100)).toBe(false);
    });
  });

  describe("shouldDemote", () => {
    it("should demote Tier 1 after 30 days of inactivity", () => {
      expect(shouldDemote(1, 30)).toBe(true);
      expect(shouldDemote(1, 35)).toBe(true);
    });

    it("should not demote Tier 1 before 30 days", () => {
      expect(shouldDemote(1, 29)).toBe(false);
      expect(shouldDemote(1, 0)).toBe(false);
    });

    it("should demote Tier 2 after 60 days of inactivity", () => {
      expect(shouldDemote(2, 60)).toBe(true);
      expect(shouldDemote(2, 90)).toBe(true);
    });

    it("should not demote Tier 2 before 60 days", () => {
      expect(shouldDemote(2, 59)).toBe(false);
    });

    it("should demote Tier 3 after 90 days of inactivity", () => {
      expect(shouldDemote(3, 90)).toBe(true);
      expect(shouldDemote(3, 120)).toBe(true);
    });

    it("should not demote Tier 3 before 90 days", () => {
      expect(shouldDemote(3, 89)).toBe(false);
    });
  });

  describe("getLowerTier", () => {
    it("should return next lower tier", () => {
      expect(getLowerTier(1)).toBe(2);
      expect(getLowerTier(2)).toBe(3);
    });

    it("should return null for Tier 3 (lowest tier)", () => {
      expect(getLowerTier(3)).toBeNull();
    });
  });

  describe("getHigherTier", () => {
    it("should return next higher tier", () => {
      expect(getHigherTier(2)).toBe(1);
      expect(getHigherTier(3)).toBe(2);
    });

    it("should return null for Tier 1 (highest tier)", () => {
      expect(getHigherTier(1)).toBeNull();
    });
  });

  describe("getTotalNpcCapacity", () => {
    it("should return sum of all tier capacities", () => {
      const total = getTotalNpcCapacity();
      // 12 + 50 + 500 = 562
      expect(total).toBe(562);
    });
  });

  describe("getTierMessageGuidance", () => {
    it("should return full alpha guidance for Tier 1", () => {
      const guidance = getTierMessageGuidance(1);
      expect(guidance).toContain("TIER 1 INNER CIRCLE");
      expect(guidance).toContain("FULL ALPHA");
    });

    it("should return partial alpha guidance for Tier 2", () => {
      const guidance = getTierMessageGuidance(2);
      expect(guidance).toContain("TIER 2 COMMUNITY");
      expect(guidance).toContain("PARTIAL ALPHA");
    });

    it("should return public content guidance for Tier 3", () => {
      const guidance = getTierMessageGuidance(3);
      expect(guidance).toContain("TIER 3 FOLLOWERS");
      expect(guidance).toContain("PUBLIC-FACING");
    });

    it("should default to Tier 1 for null/legacy groups", () => {
      const guidance = getTierMessageGuidance(null);
      expect(guidance).toContain("TIER 1 INNER CIRCLE");
    });
  });

  describe("getEffectiveTierConfig", () => {
    it("should return base config when no NPC specified", () => {
      const config = getEffectiveTierConfig(1);
      expect(config.minEngagementScore).toBe(80);
      expect(config.maxMembers).toBe(12);
    });

    it("should return base config for unknown NPC", () => {
      const config = getEffectiveTierConfig(2, "unknown-npc-id");
      expect(config.minEngagementScore).toBe(50);
    });
  });

  describe("getTierForEngagementScoreWithNpc", () => {
    it("should match base getTierForEngagementScore for unknown NPC", () => {
      expect(getTierForEngagementScoreWithNpc(80)).toBe(1);
      expect(getTierForEngagementScoreWithNpc(50)).toBe(2);
      expect(getTierForEngagementScoreWithNpc(20)).toBe(3);
      expect(getTierForEngagementScoreWithNpc(10)).toBeNull();
    });
  });
});
