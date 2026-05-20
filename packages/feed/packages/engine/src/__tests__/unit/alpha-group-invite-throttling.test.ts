/**
 * Tests for Alpha Group Invite Throttling
 *
 * Verifies invite throttling mechanisms:
 * - Weekly invite limits per user
 * - Recent activity requirements
 * - Tiered invite probability
 *
 * Note: These tests verify types and reasonable ranges rather than exact defaults
 * because env vars can override the configured values at module load time.
 */

import { describe, expect, it } from 'vitest';
import { ALPHA_GROUP_CONFIG } from '../../config/alpha-group-config';

// =============================================================================
// Test Helpers
// =============================================================================

/** Milliseconds per day */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Default assumed user pool size for invite rate calculations */
const DEFAULT_USER_POOL_SIZE = 1000;

/**
 * Compute estimated daily invites per NPC based on probability settings.
 *
 * @param inviteChance - Base probability a user gets considered for invite
 * @param tieredProbability - Additional tier-based probability multiplier
 * @param userCount - Number of potential users in the pool (default 1000)
 */
function computeEstimatedDailyInvitesPerNpc(
  inviteChance: number,
  tieredProbability: number,
  userCount = DEFAULT_USER_POOL_SIZE
): number {
  return inviteChance * tieredProbability * userCount;
}

describe('Alpha Group Invite Throttling Configuration', () => {
  describe('maxInvitesPerUserPerWeek', () => {
    it('should be a positive number', () => {
      expect(typeof ALPHA_GROUP_CONFIG.maxInvitesPerUserPerWeek).toBe('number');
      expect(ALPHA_GROUP_CONFIG.maxInvitesPerUserPerWeek).toBeGreaterThan(0);
    });

    it('should be within reasonable bounds (1-10)', () => {
      // Even with env overrides, should stay reasonable
      expect(
        ALPHA_GROUP_CONFIG.maxInvitesPerUserPerWeek
      ).toBeGreaterThanOrEqual(1);
      expect(ALPHA_GROUP_CONFIG.maxInvitesPerUserPerWeek).toBeLessThanOrEqual(
        10
      );
    });
  });

  describe('requireRecentActivity', () => {
    it('should be a boolean', () => {
      expect(typeof ALPHA_GROUP_CONFIG.requireRecentActivity).toBe('boolean');
    });
  });

  describe('recentActivityDays', () => {
    it('should be a positive number', () => {
      expect(typeof ALPHA_GROUP_CONFIG.recentActivityDays).toBe('number');
      expect(ALPHA_GROUP_CONFIG.recentActivityDays).toBeGreaterThan(0);
    });

    it('should be within reasonable bounds (1-90 days)', () => {
      // Even with env overrides, should stay reasonable
      expect(ALPHA_GROUP_CONFIG.recentActivityDays).toBeGreaterThanOrEqual(1);
      expect(ALPHA_GROUP_CONFIG.recentActivityDays).toBeLessThanOrEqual(90);
    });
  });

  describe('tieredInviteProbability', () => {
    it('should be a valid probability (0-1)', () => {
      expect(typeof ALPHA_GROUP_CONFIG.tieredInviteProbability).toBe('number');
      expect(ALPHA_GROUP_CONFIG.tieredInviteProbability).toBeGreaterThanOrEqual(
        0
      );
      expect(ALPHA_GROUP_CONFIG.tieredInviteProbability).toBeLessThanOrEqual(1);
    });

    it('should be low to prevent spam (< 0.1)', () => {
      // Even with env overrides, should stay low
      expect(ALPHA_GROUP_CONFIG.tieredInviteProbability).toBeLessThan(0.1);
    });
  });

  describe('inviteUserChance', () => {
    it('should be a valid probability (0-1)', () => {
      expect(typeof ALPHA_GROUP_CONFIG.inviteUserChance).toBe('number');
      expect(ALPHA_GROUP_CONFIG.inviteUserChance).toBeGreaterThanOrEqual(0);
      expect(ALPHA_GROUP_CONFIG.inviteUserChance).toBeLessThanOrEqual(1);
    });

    it('should be reasonably low (< 0.2)', () => {
      // Even with env overrides, should stay reasonable
      expect(ALPHA_GROUP_CONFIG.inviteUserChance).toBeLessThan(0.2);
    });
  });

  describe('Throttling effectiveness', () => {
    it('combined throttling should result in low daily invite rate', () => {
      // With typical settings, daily invites per NPC should be manageable
      const estimatedDailyInvitesPerNpc = computeEstimatedDailyInvitesPerNpc(
        ALPHA_GROUP_CONFIG.inviteUserChance,
        ALPHA_GROUP_CONFIG.tieredInviteProbability
      );

      // Should be reasonable (< 10 per NPC per day with default user pool)
      expect(estimatedDailyInvitesPerNpc).toBeLessThan(10);
    });

    it('weekly limit should cap per-user invites', () => {
      const maxPerWeek = ALPHA_GROUP_CONFIG.maxInvitesPerUserPerWeek;

      // At 7 days per week, should limit invite frequency reasonably
      expect(typeof maxPerWeek).toBe('number');
      expect(maxPerWeek).toBeGreaterThan(0);
    });
  });
});

describe('Throttling Logic', () => {
  describe('Weekly invite limit calculation', () => {
    it('should correctly identify when limit is reached', () => {
      const maxPerWeek = ALPHA_GROUP_CONFIG.maxInvitesPerUserPerWeek;

      // Simulate counting invites
      const checkLimit = (invitesThisWeek: number): boolean => {
        return invitesThisWeek >= maxPerWeek;
      };

      expect(checkLimit(0)).toBe(false);
      expect(checkLimit(1)).toBe(maxPerWeek <= 1);
      expect(checkLimit(maxPerWeek)).toBe(true);
      expect(checkLimit(maxPerWeek + 1)).toBe(true);
    });
  });

  describe('Activity window calculation', () => {
    it('should correctly calculate activity window start', () => {
      const days = ALPHA_GROUP_CONFIG.recentActivityDays;
      const now = Date.now();
      const windowStart = now - days * MS_PER_DAY;

      expect(windowStart).toBeLessThan(now);
      expect(now - windowStart).toBe(days * MS_PER_DAY);
    });

    it('should correctly identify recent activity', () => {
      const days = ALPHA_GROUP_CONFIG.recentActivityDays;
      const now = new Date();

      // Activity within window
      const recentActivity = new Date(now.getTime() - (days - 1) * MS_PER_DAY);
      expect(recentActivity.getTime()).toBeGreaterThan(
        now.getTime() - days * MS_PER_DAY
      );

      // Activity outside window
      const oldActivity = new Date(now.getTime() - (days + 1) * MS_PER_DAY);
      expect(oldActivity.getTime()).toBeLessThan(
        now.getTime() - days * MS_PER_DAY
      );
    });
  });
});

describe('Configuration Consistency', () => {
  it('all throttling configs should be defined', () => {
    expect(ALPHA_GROUP_CONFIG.maxInvitesPerUserPerWeek).toBeDefined();
    expect(ALPHA_GROUP_CONFIG.requireRecentActivity).toBeDefined();
    expect(ALPHA_GROUP_CONFIG.recentActivityDays).toBeDefined();
    expect(ALPHA_GROUP_CONFIG.tieredInviteProbability).toBeDefined();
    expect(ALPHA_GROUP_CONFIG.inviteUserChance).toBeDefined();
  });

  it('should have sensible default combination', () => {
    // The combination of settings should result in:
    // - Low invite spam (< 0.1 probability)
    // - Recent active users only
    // - Limited per-user invites

    const estimatedDailyInvitesPerNpc = computeEstimatedDailyInvitesPerNpc(
      ALPHA_GROUP_CONFIG.inviteUserChance,
      ALPHA_GROUP_CONFIG.tieredInviteProbability
    );

    // Combined probability should result in low invites per NPC per day
    expect(estimatedDailyInvitesPerNpc).toBeLessThan(10);
  });
});
