/**
 * Alpha Group Configuration Unit Tests
 *
 * Tests for the alpha group config system:
 * - Default values verification
 * - Environment variable parsing
 * - Boundary conditions (probabilities, positive integers)
 * - Helper functions (decay calculation, focus weights)
 */

import { describe, expect, it } from "bun:test";

import {
  ALPHA_GROUP_CONFIG,
  calculateNextEligibleDate,
  DOMAIN_FOCUS_WEIGHTS,
  getFocusWeightsForDomains,
  shouldResetDeclineCount,
} from "@feed/engine";

describe("Alpha Group Configuration", () => {
  describe("Default Values", () => {
    it("should have sensible default values for all config options", () => {
      // Invite probability
      expect(ALPHA_GROUP_CONFIG.inviteProbabilityMultiplier).toBe(1.0);
      expect(ALPHA_GROUP_CONFIG.maxInvitesPerTick).toBe(15);
      expect(ALPHA_GROUP_CONFIG.topUsersToConsider).toBe(30);

      // Engagement thresholds (lowered from original)
      expect(ALPHA_GROUP_CONFIG.minReplies).toBe(1);
      expect(ALPHA_GROUP_CONFIG.minLikes).toBe(2);
      expect(ALPHA_GROUP_CONFIG.minTotalInteractions).toBe(5);
      expect(ALPHA_GROUP_CONFIG.minQualityScore).toBe(0.5);
      expect(ALPHA_GROUP_CONFIG.maxInteractionsPerDay).toBe(50);

      // Trading activity
      expect(ALPHA_GROUP_CONFIG.tradeWeight).toBe(2.5);
      expect(ALPHA_GROUP_CONFIG.profitableTradeBonus).toBe(1.5);
      expect(ALPHA_GROUP_CONFIG.includeTradingActivity).toBe(true);

      // Fast track
      expect(ALPHA_GROUP_CONFIG.fastTrackEnabled).toBe(true);
      expect(ALPHA_GROUP_CONFIG.fastTrackMinTrades).toBe(10);
      expect(ALPHA_GROUP_CONFIG.fastTrackMinPnL).toBe(5000);
      expect(ALPHA_GROUP_CONFIG.fastTrackMinWinRate).toBe(0.55);
      expect(ALPHA_GROUP_CONFIG.fastTrackTargetTier).toBe(2);

      // Invite decay
      expect(ALPHA_GROUP_CONFIG.inviteDecayEnabled).toBe(true);
      expect(ALPHA_GROUP_CONFIG.inviteDecayBaseHours).toBe(24);
      expect(ALPHA_GROUP_CONFIG.inviteDecayMaxHours).toBe(168);
      expect(ALPHA_GROUP_CONFIG.inviteDecayMaxDeclines).toBe(5);
      expect(ALPHA_GROUP_CONFIG.inviteDecayResetDays).toBe(30);

      // Cooldowns
      expect(ALPHA_GROUP_CONFIG.inviteCooldownHours).toBe(2);

      // Feature flags
      expect(ALPHA_GROUP_CONFIG.perNpcCustomizationEnabled).toBe(true);
      expect(ALPHA_GROUP_CONFIG.grandfatheringEnabled).toBe(true);
    });

    it("should have thresholds lower than original hardcoded values", () => {
      // Original values were: MIN_REPLIES=3, MIN_LIKES=5, MIN_TOTAL=10
      expect(ALPHA_GROUP_CONFIG.minReplies).toBeLessThan(3);
      expect(ALPHA_GROUP_CONFIG.minLikes).toBeLessThan(5);
      expect(ALPHA_GROUP_CONFIG.minTotalInteractions).toBeLessThan(10);
    });
  });

  describe("calculateNextEligibleDate", () => {
    it("should calculate correct cooldown for first decline", () => {
      const now = Date.now();
      const nextEligible = calculateNextEligibleDate(1);

      // First decline: baseHours * 2^0 = 24 hours
      const expectedMs =
        ALPHA_GROUP_CONFIG.inviteDecayBaseHours * 60 * 60 * 1000;
      expect(nextEligible.getTime()).toBeGreaterThanOrEqual(
        now + expectedMs - 1000,
      );
      expect(nextEligible.getTime()).toBeLessThanOrEqual(
        now + expectedMs + 1000,
      );
    });

    it("should apply exponential backoff for subsequent declines", () => {
      const now = Date.now();

      // Decline 1: 24h, Decline 2: 48h, Decline 3: 96h
      calculateNextEligibleDate(1); // Just for verification
      const decline2 = calculateNextEligibleDate(2);
      const decline3 = calculateNextEligibleDate(3);

      const base = ALPHA_GROUP_CONFIG.inviteDecayBaseHours * 60 * 60 * 1000;

      // Each should be roughly double the previous
      expect(decline2.getTime() - now).toBeGreaterThan(base * 1.5);
      expect(decline3.getTime() - now).toBeGreaterThan(base * 3);
    });

    it("should cap cooldown at max hours", () => {
      const now = Date.now();

      // 10 declines would be 24 * 2^9 = 12288 hours, but capped at 168
      const decline10 = calculateNextEligibleDate(10);
      const maxMs = ALPHA_GROUP_CONFIG.inviteDecayMaxHours * 60 * 60 * 1000;

      expect(decline10.getTime() - now).toBeLessThanOrEqual(maxMs + 1000);
    });

    it("should handle zero or negative decline counts", () => {
      const now = Date.now();

      // Edge case: 0 declines should use base hours
      const decline0 = calculateNextEligibleDate(0);

      // Should still return a future date (using 2^-1 = 0.5)
      expect(decline0.getTime()).toBeGreaterThan(now);
    });
  });

  describe("shouldResetDeclineCount", () => {
    it("should return true for null lastDeclinedAt", () => {
      expect(shouldResetDeclineCount(null)).toBe(true);
    });

    it("should return true if decline was more than resetDays ago", () => {
      const oldDate = new Date(
        Date.now() -
          (ALPHA_GROUP_CONFIG.inviteDecayResetDays + 1) * 24 * 60 * 60 * 1000,
      );

      expect(shouldResetDeclineCount(oldDate)).toBe(true);
    });

    it("should return false if decline was recent", () => {
      const recentDate = new Date(
        Date.now() -
          (ALPHA_GROUP_CONFIG.inviteDecayResetDays - 1) * 24 * 60 * 60 * 1000,
      );

      expect(shouldResetDeclineCount(recentDate)).toBe(false);
    });

    it("should return false for today", () => {
      const today = new Date();
      expect(shouldResetDeclineCount(today)).toBe(false);
    });
  });

  describe("getFocusWeightsForDomains", () => {
    it("should return trading-focused weights for crypto domains", () => {
      const weights = getFocusWeightsForDomains(["crypto"]);
      expect(weights.trading).toBeGreaterThan(weights.social);
      expect(weights.social + weights.trading).toBeCloseTo(1, 5);
    });

    it("should return trading-focused weights for trading domains", () => {
      for (const domain of ["trading", "finance", "defi", "markets"]) {
        const weights = getFocusWeightsForDomains([domain]);
        expect(weights.trading).toBeGreaterThan(weights.social);
      }
    });

    it("should return social-focused weights for media domains", () => {
      for (const domain of ["media", "politics", "entertainment", "culture"]) {
        const weights = getFocusWeightsForDomains([domain]);
        expect(weights.social).toBeGreaterThan(weights.trading);
      }
    });

    it("should return balanced weights for tech domains", () => {
      const weights = getFocusWeightsForDomains(["tech"]);
      // Tech is slightly social-leaning
      expect(weights.social).toBeGreaterThanOrEqual(0.5);
      expect(weights.trading).toBeLessThanOrEqual(0.5);
    });

    it("should return default weights for empty domains", () => {
      const weights = getFocusWeightsForDomains([]);
      expect(weights.social).toBe(ALPHA_GROUP_CONFIG.defaultSocialWeight);
      expect(weights.trading).toBe(ALPHA_GROUP_CONFIG.defaultTradingWeight);
    });

    it("should return default weights for undefined domains", () => {
      const weights = getFocusWeightsForDomains(undefined);
      expect(weights.social).toBe(ALPHA_GROUP_CONFIG.defaultSocialWeight);
      expect(weights.trading).toBe(ALPHA_GROUP_CONFIG.defaultTradingWeight);
    });

    it("should return default weights for unknown domains", () => {
      const weights = getFocusWeightsForDomains(["unknown-domain", "random"]);
      expect(weights.social).toBe(ALPHA_GROUP_CONFIG.defaultSocialWeight);
      expect(weights.trading).toBe(ALPHA_GROUP_CONFIG.defaultTradingWeight);
    });

    it("should use first matching domain if multiple provided", () => {
      // If crypto is first, should use crypto weights
      const cryptoFirst = getFocusWeightsForDomains(["crypto", "media"]);
      expect(cryptoFirst.trading).toBeGreaterThan(cryptoFirst.social);

      // If media is first, should use media weights
      const mediaFirst = getFocusWeightsForDomains(["media", "crypto"]);
      expect(mediaFirst.social).toBeGreaterThan(mediaFirst.trading);
    });
  });

  describe("DOMAIN_FOCUS_WEIGHTS constant", () => {
    it("should have weights that sum to 1.0 for each domain", () => {
      for (const weights of Object.values(DOMAIN_FOCUS_WEIGHTS)) {
        expect(weights.social + weights.trading).toBeCloseTo(1.0, 5);
      }
    });

    it("should have all weights in 0-1 range", () => {
      for (const weights of Object.values(DOMAIN_FOCUS_WEIGHTS)) {
        expect(weights.social).toBeGreaterThanOrEqual(0);
        expect(weights.social).toBeLessThanOrEqual(1);
        expect(weights.trading).toBeGreaterThanOrEqual(0);
        expect(weights.trading).toBeLessThanOrEqual(1);
      }
    });
  });
});
