/**
 * Tests for Tiered Group Service
 *
 * Unit tests for TieredGroupService type definitions and exports.
 * Integration tests are in tiered-group-system.integration.test.ts
 */

import { describe, expect, it } from 'vitest';
import { getTierForEngagementScore } from '../../services/tier-config';
import type {
  MembershipStatus,
  TierInfo,
  UserTierStatus,
} from '../../services/tiered-group-service';
import { TieredGroupService } from '../../services/tiered-group-service';

describe('TieredGroupService Types', () => {
  describe('TierInfo', () => {
    it('should have correct structure', () => {
      const tierInfo: TierInfo = {
        tier: 1,
        groupId: 'group-123',
        chatId: 'chat-123',
        groupName: "Test NPC's Inner Circle",
        memberCount: 5,
        maxMembers: 12,
        isFull: false,
      };

      expect(tierInfo.tier).toBe(1);
      expect(tierInfo.groupId).toBeTruthy();
      expect(tierInfo.maxMembers).toBe(12);
      expect(tierInfo.isFull).toBe(false);
    });

    it('should allow null chatId', () => {
      const tierInfo: TierInfo = {
        tier: 2,
        groupId: 'group-456',
        chatId: null,
        groupName: "Test NPC's Community",
        memberCount: 0,
        maxMembers: 50,
        isFull: false,
      };

      expect(tierInfo.chatId).toBeNull();
    });
  });

  describe('UserTierStatus', () => {
    it('should represent member status', () => {
      const status: UserTierStatus = {
        userId: 'user-123',
        npcId: 'npc-456',
        currentTier: 2,
        groupId: 'group-789',
        joinedAt: new Date(),
        engagementScore: 55,
        eligibleTier: 2,
        canBePromoted: false,
        promotionBlockedReason: 'Need 14 more days in current tier',
      };

      expect(status.currentTier).toBe(2);
      expect(status.canBePromoted).toBe(false);
    });

    it('should represent non-member status', () => {
      const status: UserTierStatus = {
        userId: 'user-123',
        npcId: 'npc-456',
        currentTier: null,
        groupId: null,
        joinedAt: null,
        engagementScore: 15,
        eligibleTier: null,
        canBePromoted: false,
        promotionBlockedReason: null,
      };

      expect(status.currentTier).toBeNull();
      expect(status.groupId).toBeNull();
    });
  });

  describe('MembershipStatus', () => {
    it('should have comprehensive member info', () => {
      const status: MembershipStatus = {
        isMember: true,
        tier: 1,
        groupId: 'group-123',
        joinedAt: new Date(),
        daysInTier: 45,
        isGrandfathered: false,
        grandfatheredAt: null,
        engagementScore: 85,
        socialScore: 50,
        tradingScore: 35,
        eligibleTier: 1,
        canBePromoted: false,
        promotionBlockedReason: 'Already at highest tier',
        shouldBeDemoted: false,
        daysSinceLastActivity: 2,
      };

      expect(status.isMember).toBe(true);
      expect(status.tier).toBe(1);
      expect(status.engagementScore).toBe(85);
      expect(status.shouldBeDemoted).toBe(false);
    });

    it('should track grandfathered status', () => {
      const status: MembershipStatus = {
        isMember: true,
        tier: 2,
        groupId: 'group-456',
        joinedAt: new Date('2024-01-01'),
        daysInTier: 365,
        isGrandfathered: true,
        grandfatheredAt: new Date('2024-06-01'),
        engagementScore: 45,
        socialScore: 30,
        tradingScore: 15,
        eligibleTier: 3,
        canBePromoted: false,
        promotionBlockedReason: 'Grandfathered: need score 50+ to promote',
        shouldBeDemoted: false,
        daysSinceLastActivity: 10,
      };

      expect(status.isGrandfathered).toBe(true);
      expect(status.grandfatheredAt).toBeTruthy();
    });
  });
});

describe('TieredGroupService Methods', () => {
  describe('Static method availability', () => {
    it('should have ensureAllTiersExist', () => {
      expect(typeof TieredGroupService.ensureAllTiersExist).toBe('function');
    });

    it('should have getNpcTiers', () => {
      expect(typeof TieredGroupService.getNpcTiers).toBe('function');
    });

    it('should have getMembershipStatus', () => {
      expect(typeof TieredGroupService.getMembershipStatus).toBe('function');
    });

    it('should have getUserTierStatus', () => {
      expect(typeof TieredGroupService.getUserTierStatus).toBe('function');
    });

    it('should have inviteUserToTier', () => {
      expect(typeof TieredGroupService.inviteUserToTier).toBe('function');
    });

    it('should have promoteUser', () => {
      expect(typeof TieredGroupService.promoteUser).toBe('function');
    });

    it('should have processAllPromotions', () => {
      expect(typeof TieredGroupService.processAllPromotions).toBe('function');
    });

    it('should have processAllDemotions', () => {
      expect(typeof TieredGroupService.processAllDemotions).toBe('function');
    });

    it('should have getGlobalAnalytics', () => {
      expect(typeof TieredGroupService.getGlobalAnalytics).toBe('function');
    });
  });
});

describe('Tier Invite Logic', () => {
  describe('Engagement score to tier mapping', () => {
    const testCases = [
      { score: 100, expectedTier: 1, reason: 'Max score should be Tier 1' },
      { score: 80, expectedTier: 1, reason: 'Threshold should be Tier 1' },
      { score: 79, expectedTier: 2, reason: 'Just below Tier 1 threshold' },
      { score: 65, expectedTier: 2, reason: 'Mid Tier 2 range' },
      { score: 50, expectedTier: 2, reason: 'Tier 2 threshold' },
      { score: 49, expectedTier: 3, reason: 'Just below Tier 2 threshold' },
      { score: 35, expectedTier: 3, reason: 'Mid Tier 3 range' },
      { score: 20, expectedTier: 3, reason: 'Tier 3 threshold' },
      { score: 19, expectedTier: null, reason: 'Below minimum threshold' },
      { score: 0, expectedTier: null, reason: 'Zero score' },
    ];

    for (const { score, expectedTier, reason } of testCases) {
      it(`score ${score} should map to tier ${expectedTier} (${reason})`, () => {
        expect(getTierForEngagementScore(score)).toBe(expectedTier);
      });
    }
  });
});

// Note: The following tests require a database connection and are skipped in unit tests.
// They are covered by integration tests in tiered-group-system.integration.test.ts
describe('Promotion and Demotion Scheduling', () => {
  describe('processAllPromotions', () => {
    it.skip('should be async and return number (requires DB)', async () => {
      // This test requires DATABASE_URL - run integration tests instead
      const result = await TieredGroupService.processAllPromotions();
      expect(typeof result).toBe('number');
      expect(result).toBeGreaterThanOrEqual(0);
    });
  });

  describe('processAllDemotions', () => {
    it.skip('should be async and return number (requires DB)', async () => {
      // This test requires DATABASE_URL - run integration tests instead
      const result = await TieredGroupService.processAllDemotions();
      expect(typeof result).toBe('number');
      expect(result).toBeGreaterThanOrEqual(0);
    });
  });
});

// Note: These tests require a database connection and are skipped in unit tests.
// They are covered by integration tests in tiered-group-system.integration.test.ts
describe('Global Analytics', () => {
  describe('getGlobalAnalytics', () => {
    it.skip('should return complete analytics object (requires DB)', async () => {
      // This test requires DATABASE_URL - run integration tests instead
      const analytics = await TieredGroupService.getGlobalAnalytics();

      // Verify structure
      expect(analytics).toHaveProperty('totalNpcs');
      expect(analytics).toHaveProperty('totalGroups');
      expect(analytics).toHaveProperty('totalMembers');
      expect(analytics).toHaveProperty('totalCapacity');
      expect(analytics).toHaveProperty('fillRate');
      expect(analytics).toHaveProperty('tierBreakdown');

      // Verify types
      expect(typeof analytics.totalNpcs).toBe('number');
      expect(typeof analytics.totalGroups).toBe('number');
      expect(typeof analytics.totalMembers).toBe('number');
      expect(typeof analytics.totalCapacity).toBe('number');
      expect(typeof analytics.fillRate).toBe('number');
      expect(Array.isArray(analytics.tierBreakdown)).toBe(true);
    });

    it.skip('should have tier breakdown for all 3 tiers (requires DB)', async () => {
      // This test requires DATABASE_URL - run integration tests instead
      const analytics = await TieredGroupService.getGlobalAnalytics();

      expect(analytics.tierBreakdown).toHaveLength(3);

      const tiers = analytics.tierBreakdown.map((t) => t.tier);
      expect(tiers).toContain(1);
      expect(tiers).toContain(2);
      expect(tiers).toContain(3);
    });

    it.skip('should have valid fill rate (requires DB)', async () => {
      // This test requires DATABASE_URL - run integration tests instead
      const analytics = await TieredGroupService.getGlobalAnalytics();

      expect(analytics.fillRate).toBeGreaterThanOrEqual(0);
      expect(analytics.fillRate).toBeLessThanOrEqual(1);
    });

    it.skip('should have consistent member/capacity totals (requires DB)', async () => {
      // This test requires DATABASE_URL - run integration tests instead
      const analytics = await TieredGroupService.getGlobalAnalytics();

      // Members should not exceed capacity.
      // We add totalNpcs because NPC owners are auto-added to their own groups
      // but may not be counted toward maxMembers in some edge cases.
      expect(analytics.totalMembers).toBeLessThanOrEqual(
        analytics.totalCapacity + analytics.totalNpcs
      );
    });
  });
});
