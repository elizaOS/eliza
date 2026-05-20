/**
 * Tier Configuration Unit Tests
 *
 * Tests for tier configuration functions:
 * - TIER_CONFIG constants verification
 * - isValidTier function
 * - getTierForEngagementScoreWithNpc
 * - isEligibleForPromotion
 * - shouldDemote
 * - getLowerTier and getHigherTier
 * - getTierGroupName
 */

import { describe, expect, it } from "bun:test";

import {
  ALL_TIERS,
  getHigherTier,
  getLowerTier,
  getTierConfig,
  getTierForEngagementScoreWithNpc,
  getTierGroupName,
  isEligibleForPromotion,
  isValidTier,
  shouldDemote,
  TIER_CONFIG,
} from "@feed/engine";

describe("Tier Configuration", () => {
  describe("TIER_CONFIG constants", () => {
    it("should have all three tiers defined", () => {
      expect(ALL_TIERS).toEqual([1, 2, 3]);
      expect(TIER_CONFIG[1]).toBeDefined();
      expect(TIER_CONFIG[2]).toBeDefined();
      expect(TIER_CONFIG[3]).toBeDefined();
    });

    it("should have increasing minEngagementScore from tier 3 to tier 1", () => {
      expect(TIER_CONFIG[1].minEngagementScore).toBeGreaterThan(
        TIER_CONFIG[2].minEngagementScore,
      );
      expect(TIER_CONFIG[2].minEngagementScore).toBeGreaterThan(
        TIER_CONFIG[3].minEngagementScore,
      );
    });

    it("should have decreasing inviteProbability from tier 3 to tier 1", () => {
      // Tier 3 should be easiest to invite (highest probability)
      expect(TIER_CONFIG[3].inviteProbability).toBeGreaterThan(
        TIER_CONFIG[2].inviteProbability,
      );
      expect(TIER_CONFIG[2].inviteProbability).toBeGreaterThan(
        TIER_CONFIG[1].inviteProbability,
      );
    });

    it("should have tier 3 with 10% invite probability", () => {
      expect(TIER_CONFIG[3].inviteProbability).toBe(0.1);
    });

    it("should have tier 3 with 20 minEngagementScore", () => {
      expect(TIER_CONFIG[3].minEngagementScore).toBe(20);
    });

    it("should have distinct names and suffixes for each tier", () => {
      const names = [
        TIER_CONFIG[1].name,
        TIER_CONFIG[2].name,
        TIER_CONFIG[3].name,
      ];
      const suffixes = [
        TIER_CONFIG[1].suffix,
        TIER_CONFIG[2].suffix,
        TIER_CONFIG[3].suffix,
      ];

      expect(new Set(names).size).toBe(3);
      expect(new Set(suffixes).size).toBe(3);
    });
  });

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
      expect(isValidTier(null)).toBe(false);
      expect(isValidTier(undefined)).toBe(false);
    });
  });

  describe("getTierConfig", () => {
    it("should return correct config for each tier", () => {
      expect(getTierConfig(1)).toEqual(TIER_CONFIG[1]);
      expect(getTierConfig(2)).toEqual(TIER_CONFIG[2]);
      expect(getTierConfig(3)).toEqual(TIER_CONFIG[3]);
    });
  });

  describe("getTierForEngagementScoreWithNpc", () => {
    it("should return tier 1 for score >= 80", () => {
      expect(getTierForEngagementScoreWithNpc(80)).toBe(1);
      expect(getTierForEngagementScoreWithNpc(90)).toBe(1);
      expect(getTierForEngagementScoreWithNpc(100)).toBe(1);
    });

    it("should return tier 2 for score >= 50 and < 80", () => {
      expect(getTierForEngagementScoreWithNpc(50)).toBe(2);
      expect(getTierForEngagementScoreWithNpc(65)).toBe(2);
      expect(getTierForEngagementScoreWithNpc(79)).toBe(2);
    });

    it("should return tier 3 for score >= 20 and < 50", () => {
      expect(getTierForEngagementScoreWithNpc(20)).toBe(3);
      expect(getTierForEngagementScoreWithNpc(35)).toBe(3);
      expect(getTierForEngagementScoreWithNpc(49)).toBe(3);
    });

    it("should return null for score < 20", () => {
      expect(getTierForEngagementScoreWithNpc(19)).toBeNull();
      expect(getTierForEngagementScoreWithNpc(10)).toBeNull();
      expect(getTierForEngagementScoreWithNpc(0)).toBeNull();
      expect(getTierForEngagementScoreWithNpc(-5)).toBeNull();
    });

    it("should handle boundary values exactly", () => {
      // Exactly at tier 1 threshold
      expect(
        getTierForEngagementScoreWithNpc(TIER_CONFIG[1].minEngagementScore),
      ).toBe(1);

      // Exactly at tier 2 threshold
      expect(
        getTierForEngagementScoreWithNpc(TIER_CONFIG[2].minEngagementScore),
      ).toBe(2);

      // Exactly at tier 3 threshold
      expect(
        getTierForEngagementScoreWithNpc(TIER_CONFIG[3].minEngagementScore),
      ).toBe(3);

      // Just below tier 3 threshold
      expect(
        getTierForEngagementScoreWithNpc(
          TIER_CONFIG[3].minEngagementScore - 0.01,
        ),
      ).toBeNull();
    });
  });

  describe("isEligibleForPromotion", () => {
    it("should return false for tier 1 (already highest)", () => {
      expect(isEligibleForPromotion(1, 100, 30)).toBe(false);
    });

    it("should require both score and time for tier 2 to 1 promotion", () => {
      const tier1Score = TIER_CONFIG[1].minEngagementScore;
      const tier2WaitDays = TIER_CONFIG[2].promotionWaitDays;

      // Score met, time not met
      expect(isEligibleForPromotion(2, tier1Score, tier2WaitDays - 1)).toBe(
        false,
      );

      // Time met, score not met
      expect(isEligibleForPromotion(2, tier1Score - 1, tier2WaitDays)).toBe(
        false,
      );

      // Both met
      expect(isEligibleForPromotion(2, tier1Score, tier2WaitDays)).toBe(true);
    });

    it("should require both score and time for tier 3 to 2 promotion", () => {
      const tier2Score = TIER_CONFIG[2].minEngagementScore;
      const tier3WaitDays = TIER_CONFIG[3].promotionWaitDays;

      // Both conditions met
      expect(isEligibleForPromotion(3, tier2Score, tier3WaitDays)).toBe(true);

      // Only time met
      expect(isEligibleForPromotion(3, tier2Score - 1, tier3WaitDays)).toBe(
        false,
      );
    });
  });

  describe("shouldDemote", () => {
    it("should return true for tier 3 when inactive (decision to remove from group)", () => {
      // Note: shouldDemote only checks if inactivity exceeds threshold
      // The caller (TieredGroupService) must check getLowerTier to know if
      // demotion is possible or if removal is needed
      const inactiveDays = TIER_CONFIG[3].demotionInactiveDays + 100;
      expect(shouldDemote(3, inactiveDays)).toBe(true);
    });

    it("should demote tier 1 member after inactivity period", () => {
      const inactiveDays = TIER_CONFIG[1].demotionInactiveDays;

      // Just below threshold
      expect(shouldDemote(1, inactiveDays - 1)).toBe(false);

      // At threshold
      expect(shouldDemote(1, inactiveDays)).toBe(true);

      // Above threshold
      expect(shouldDemote(1, inactiveDays + 10)).toBe(true);
    });

    it("should demote tier 2 member after inactivity period", () => {
      const inactiveDays = TIER_CONFIG[2].demotionInactiveDays;
      expect(shouldDemote(2, inactiveDays)).toBe(true);
    });
  });

  describe("getLowerTier and getHigherTier", () => {
    it("should return correct lower tiers", () => {
      expect(getLowerTier(1)).toBe(2);
      expect(getLowerTier(2)).toBe(3);
      expect(getLowerTier(3)).toBeNull(); // No lower tier
    });

    it("should return correct higher tiers", () => {
      expect(getHigherTier(3)).toBe(2);
      expect(getHigherTier(2)).toBe(1);
      expect(getHigherTier(1)).toBeNull(); // No higher tier
    });
  });

  describe("getTierGroupName", () => {
    it("should generate correct group names", () => {
      const npcName = "CryptoKing";

      // Note: Suffix already includes the possessive, so it's npcName + suffix
      expect(getTierGroupName(npcName, 1)).toBe(
        `${npcName}${TIER_CONFIG[1].suffix}`,
      );
      expect(getTierGroupName(npcName, 2)).toBe(
        `${npcName}${TIER_CONFIG[2].suffix}`,
      );
      expect(getTierGroupName(npcName, 3)).toBe(
        `${npcName}${TIER_CONFIG[3].suffix}`,
      );
    });
  });
});
