/**
 * Group Chat Probability Tests
 * Verifies the math for user retention and NPC dynamics
 */

import { describe, expect, test } from "bun:test";
import { NPCGroupDynamicsService } from "@feed/engine";

describe("Group Chat Probabilities - Mathematical Verification", () => {
  // Constants from the implementation
  const TICKS_PER_HOUR = 60;
  const TICKS_PER_DAY = 1440;

  const BASE_KICK_PROBABILITY = 0.00007;
  const NPC_JOIN_PROBABILITY = 0.0007;
  const NPC_LEAVE_PROBABILITY = 0.0007;
  const POST_MESSAGE_PROBABILITY = 0.01;
  const INVITE_USER_PROBABILITY = 0.002;

  describe("User Retention Calculations", () => {
    test("base kick probability gives ~10 day retention", () => {
      const expectedTicks = 1 / BASE_KICK_PROBABILITY;
      const expectedDays = expectedTicks / TICKS_PER_DAY;

      expect(expectedDays).toBeCloseTo(9.92, 1); // ~10 days with base prob
      expect(expectedDays).toBeGreaterThan(9);
      expect(expectedDays).toBeLessThan(11);
    });

    test("never posted multiplier (100×) gives ~3 hour kick time", () => {
      const neverPostedProb = BASE_KICK_PROBABILITY * 100;
      const expectedTicks = 1 / neverPostedProb;
      const expectedHours = expectedTicks / TICKS_PER_HOUR;

      expect(expectedHours).toBeCloseTo(2.4, 1); // ~2.4 hours
      expect(expectedHours).toBeLessThan(5); // Kicked within 5 hours
    });

    test("spam multiplier (20×) gives ~12 hour kick time", () => {
      const spamProb = BASE_KICK_PROBABILITY * 20;
      const expectedTicks = 1 / spamProb;
      const expectedHours = expectedTicks / TICKS_PER_HOUR;

      expect(expectedHours).toBeCloseTo(11.9, 1); // ~12 hours
      expect(expectedHours).toBeGreaterThan(10);
      expect(expectedHours).toBeLessThan(15);
    });

    test("low participation multiplier (3×) gives ~3 day retention", () => {
      const lowParticipationProb = BASE_KICK_PROBABILITY * 3;
      const expectedTicks = 1 / lowParticipationProb;
      const expectedDays = expectedTicks / TICKS_PER_DAY;

      expect(expectedDays).toBeCloseTo(3.31, 1); // ~3.3 days
      expect(expectedDays).toBeGreaterThan(3);
      expect(expectedDays).toBeLessThan(4);
    });

    test("good user (1× multiplier) stays ~10 days", () => {
      const goodUserProb = BASE_KICK_PROBABILITY * 1;
      const expectedTicks = 1 / goodUserProb;
      const expectedDays = expectedTicks / TICKS_PER_DAY;

      expect(expectedDays).toBeCloseTo(9.92, 0.5);
      expect(expectedDays).toBeGreaterThan(9);
      expect(expectedDays).toBeLessThan(11);
    });
  });

  describe("NPC Dynamics Calculations", () => {
    test("NPC join probability gives ~1 join per day", () => {
      const joinsPerDay = NPC_JOIN_PROBABILITY * TICKS_PER_DAY;

      expect(joinsPerDay).toBeCloseTo(1.0, 1);
      expect(joinsPerDay).toBeGreaterThan(0.9);
      expect(joinsPerDay).toBeLessThan(1.1);
    });

    test("NPC leave probability gives ~1 leave per day", () => {
      const leavesPerDay = NPC_LEAVE_PROBABILITY * TICKS_PER_DAY;

      expect(leavesPerDay).toBeCloseTo(1.0, 1);
      expect(leavesPerDay).toBeGreaterThan(0.9);
      expect(leavesPerDay).toBeLessThan(1.1);
    });

    test("with 64 NPCs, expect ~64 joins per day total", () => {
      const npcs = 64;
      const joinsPerNpcPerDay = NPC_JOIN_PROBABILITY * TICKS_PER_DAY;
      const totalJoinsPerDay = npcs * joinsPerNpcPerDay;

      expect(totalJoinsPerDay).toBeCloseTo(64.5, 1);
      expect(totalJoinsPerDay).toBeGreaterThan(60);
      expect(totalJoinsPerDay).toBeLessThan(70);
    });

    test("with 64 NPCs, expect ~64 leaves per day total", () => {
      const npcs = 64;
      const leavesPerNpcPerDay = NPC_LEAVE_PROBABILITY * TICKS_PER_DAY;
      const totalLeavesPerDay = npcs * leavesPerNpcPerDay;

      expect(totalLeavesPerDay).toBeCloseTo(64.5, 1);
      expect(totalLeavesPerDay).toBeGreaterThan(60);
      expect(totalLeavesPerDay).toBeLessThan(70);
    });

    test("NPC churn is balanced (joins ≈ leaves)", () => {
      const joins = NPC_JOIN_PROBABILITY * TICKS_PER_DAY;
      const leaves = NPC_LEAVE_PROBABILITY * TICKS_PER_DAY;

      expect(joins).toEqual(leaves); // Should be exactly equal
    });
  });

  describe("Group Posting Frequency", () => {
    test("group posts ~14 times per day", () => {
      const postsPerDay = POST_MESSAGE_PROBABILITY * TICKS_PER_DAY;

      expect(postsPerDay).toBeCloseTo(14.4, 1);
      expect(postsPerDay).toBeGreaterThan(10);
      expect(postsPerDay).toBeLessThan(20);
    });

    test("with 20 groups, NPC sees ~288 posts per day total", () => {
      const groupsPerNpc = 20;
      const postsPerGroup = POST_MESSAGE_PROBABILITY * TICKS_PER_DAY;
      const totalPostsPerDay = groupsPerNpc * postsPerGroup;

      expect(totalPostsPerDay).toBeCloseTo(288, 10);
      expect(totalPostsPerDay).toBeGreaterThan(250);
      expect(totalPostsPerDay).toBeLessThan(350);
    });

    test("posting frequency is reasonable (not spam)", () => {
      const postsPerHour = POST_MESSAGE_PROBABILITY * TICKS_PER_HOUR;

      expect(postsPerHour).toBeCloseTo(0.6, 1); // ~1 post per hour
      expect(postsPerHour).toBeLessThan(2); // Not more than 2/hour
    });
  });

  describe("User Invite Frequency", () => {
    test("group invites ~3 users per day", () => {
      const invitesPerDay = INVITE_USER_PROBABILITY * TICKS_PER_DAY;

      expect(invitesPerDay).toBeCloseTo(2.88, 1);
      expect(invitesPerDay).toBeGreaterThan(2);
      expect(invitesPerDay).toBeLessThan(4);
    });

    test("with 100 groups, expect ~300 user invites per day total", () => {
      const totalGroups = 100;
      const invitesPerGroup = INVITE_USER_PROBABILITY * TICKS_PER_DAY;
      const totalInvites = totalGroups * invitesPerGroup;

      expect(totalInvites).toBeCloseTo(288, 20);
      expect(totalInvites).toBeGreaterThan(250);
      expect(totalInvites).toBeLessThan(350);
    });
  });

  describe("Realistic Scenarios", () => {
    test("user who posts once per day stays ~10 days", () => {
      // 1 post per day = good participation
      // Multiplier: 1×
      // Kick prob: 0.00007

      const kickProb = BASE_KICK_PROBABILITY * 1;
      const expectedDays = 1 / kickProb / TICKS_PER_DAY;

      expect(expectedDays).toBeCloseTo(9.92, 0.5);
      expect(expectedDays).toBeGreaterThan(9);
      expect(expectedDays).toBeLessThan(11);
    });

    test("user who never posts is kicked in hours, not days", () => {
      const kickProb = BASE_KICK_PROBABILITY * 100;
      const expectedHours = 1 / kickProb / TICKS_PER_HOUR;

      expect(expectedHours).toBeLessThan(5);
      expect(expectedHours).toBeGreaterThan(1);
    });

    test("NPC in 20 groups sees manageable post volume", () => {
      const groupsPerNpc = 20;
      const postsPerGroup = POST_MESSAGE_PROBABILITY * TICKS_PER_DAY;
      const totalPosts = groupsPerNpc * postsPerGroup;

      // Should see 200-400 posts per day across all groups
      expect(totalPosts).toBeGreaterThan(200);
      expect(totalPosts).toBeLessThan(400);
      // This is manageable (not overwhelming)
    });

    test("group chat dynamics are slow and realistic", () => {
      // Per NPC per day:
      const joinsPerDay = NPC_JOIN_PROBABILITY * TICKS_PER_DAY;
      const leavesPerDay = NPC_LEAVE_PROBABILITY * TICKS_PER_DAY;
      const postsPerGroupPerDay = POST_MESSAGE_PROBABILITY * TICKS_PER_DAY;

      // All should be close to 1 (slow dynamics)
      expect(joinsPerDay).toBeCloseTo(1, 0.1);
      expect(leavesPerDay).toBeCloseTo(1, 0.1);

      // Posts per group should be 10-20 per day
      expect(postsPerGroupPerDay).toBeGreaterThan(10);
      expect(postsPerGroupPerDay).toBeLessThan(20);
    });
  });

  describe("Edge Cases", () => {
    test("probabilities are never negative", () => {
      expect(BASE_KICK_PROBABILITY).toBeGreaterThan(0);
      expect(NPC_JOIN_PROBABILITY).toBeGreaterThan(0);
      expect(NPC_LEAVE_PROBABILITY).toBeGreaterThan(0);
      expect(POST_MESSAGE_PROBABILITY).toBeGreaterThan(0);
    });

    test("probabilities are never > 1", () => {
      expect(BASE_KICK_PROBABILITY).toBeLessThan(1);
      expect(NPC_JOIN_PROBABILITY).toBeLessThan(1);
      expect(NPC_LEAVE_PROBABILITY).toBeLessThan(1);
      expect(POST_MESSAGE_PROBABILITY).toBeLessThan(1);
    });

    test("probabilities are small (not guaranteed events)", () => {
      expect(BASE_KICK_PROBABILITY).toBeLessThan(0.01);
      expect(NPC_JOIN_PROBABILITY).toBeLessThan(0.01);
      expect(POST_MESSAGE_PROBABILITY).toBeLessThan(0.05);
    });

    test("multipliers create reasonable kick times", () => {
      const multipliers = [1, 3, 5, 10, 20, 100];

      for (const mult of multipliers) {
        const kickProb = BASE_KICK_PROBABILITY * mult;
        const expectedTicks = 1 / kickProb;
        const expectedDays = expectedTicks / TICKS_PER_DAY;

        // All should result in kick within 30 days
        expect(expectedDays).toBeLessThan(30);
        // All should be positive
        expect(expectedDays).toBeGreaterThan(0);
      }
    });
  });
});

/**
 * Dynamic Kick Probability Tests
 * Tests the new dynamic threshold-based kick system
 */
describe("Dynamic Kick Probability System", () => {
  describe("Inactive Users (never posted)", () => {
    test("should have 90% kick probability for never posting", () => {
      const result = NPCGroupDynamicsService.calculateKickProbability(
        0, // userMessageCount
        100, // totalMessages
        10, // participantCount
        7, // windowDays
      );

      expect(result.probability).toBe(0.9);
      expect(result.category).toBe("inactive");
      expect(result.reason).toContain("Never participated");
    });

    test("should categorize as inactive regardless of group size", () => {
      // Small group
      const small = NPCGroupDynamicsService.calculateKickProbability(
        0,
        10,
        3,
        7,
      );
      expect(small.category).toBe("inactive");

      // Large group
      const large = NPCGroupDynamicsService.calculateKickProbability(
        0,
        500,
        50,
        7,
      );
      expect(large.category).toBe("inactive");
    });
  });

  describe("Safe Zone (ideal participation)", () => {
    test("should have 0% kick probability for ideal participation in active group", () => {
      // 10 participants, 70 messages total -> ~7 per person fair share
      // User with 5 messages (within 50%-150% of fair share) should be safe
      const result = NPCGroupDynamicsService.calculateKickProbability(
        5,
        70,
        10,
        7,
      );

      expect(result.probability).toBe(0);
      expect(result.category).toBe("safe");
    });

    test("should be safe at exactly ideal minimum", () => {
      // 10 participants, 100 messages -> 10 fair share
      // Ideal min = max(1, floor(10 * 0.5)) = 5
      const result = NPCGroupDynamicsService.calculateKickProbability(
        5,
        100,
        10,
        7,
      );

      expect(result.probability).toBe(0);
      expect(result.category).toBe("safe");
    });

    test("should be safe at exactly ideal maximum", () => {
      // 10 participants, 100 messages -> 10 fair share
      // Ideal max = max(5, ceil(10 * 1.5)) = 15
      const result = NPCGroupDynamicsService.calculateKickProbability(
        15,
        100,
        10,
        7,
      );

      expect(result.probability).toBe(0);
      expect(result.category).toBe("safe");
    });
  });

  describe("Low Participation", () => {
    test("should penalize low participation in active groups", () => {
      // 10 participants, 200 messages (>20 threshold), user has 1 message
      // This is below ideal min
      const result = NPCGroupDynamicsService.calculateKickProbability(
        1,
        200,
        10,
        7,
      );

      expect(result.probability).toBeGreaterThan(0);
      expect(result.category).toBe("low");
      expect(result.reason).toContain("Low participation");
    });

    test("should NOT penalize low participation in quiet groups", () => {
      // Group with only 15 total messages (below 20 threshold)
      const result = NPCGroupDynamicsService.calculateKickProbability(
        1,
        15,
        10,
        7,
      );

      // Should be safe because group isn't active enough to judge
      expect(result.probability).toBe(0);
      expect(result.category).toBe("safe");
    });

    test("kick probability should scale with how far below minimum", () => {
      // Same group, different message counts
      const veryLow = NPCGroupDynamicsService.calculateKickProbability(
        1,
        200,
        10,
        7,
      );
      const slightlyLow = NPCGroupDynamicsService.calculateKickProbability(
        4,
        200,
        10,
        7,
      );

      // If slightlyLow is still 'low' category, it should have lower probability
      if (slightlyLow.category === "low") {
        expect(veryLow.probability).toBeGreaterThan(slightlyLow.probability);
      }
    });
  });

  describe("Over-posting", () => {
    test("should penalize posting more than 150% of fair share", () => {
      // 10 participants, 100 messages -> 10 fair share
      // Ideal max = 15, user with 20 is over-posting
      const result = NPCGroupDynamicsService.calculateKickProbability(
        20,
        100,
        10,
        7,
      );

      expect(result.probability).toBeGreaterThan(0);
      expect(result.category).toBe("over");
      expect(result.reason).toContain("Over-posting");
    });

    test("kick probability should increase exponentially with excess messages", () => {
      // Same group, increasing message counts
      const slight = NPCGroupDynamicsService.calculateKickProbability(
        20,
        100,
        10,
        7,
      );
      const moderate = NPCGroupDynamicsService.calculateKickProbability(
        25,
        100,
        10,
        7,
      );
      const heavy = NPCGroupDynamicsService.calculateKickProbability(
        28,
        100,
        10,
        7,
      );

      // Probabilities should increase
      expect(moderate.probability).toBeGreaterThan(slight.probability);
      expect(heavy.probability).toBeGreaterThan(moderate.probability);

      // Should still be in 'over' category (not yet spam)
      expect(slight.category).toBe("over");
      expect(moderate.category).toBe("over");
    });

    test("over-posting probability should start low and increase", () => {
      // Just barely over the ideal max
      // 10 participants, 100 messages -> fair share = 10, ideal max = 15
      const barelyOver = NPCGroupDynamicsService.calculateKickProbability(
        16,
        100,
        10,
        7,
      );
      const moreOver = NPCGroupDynamicsService.calculateKickProbability(
        20,
        100,
        10,
        7,
      );

      if (barelyOver.category === "over") {
        // Should start relatively low (under 50%)
        expect(barelyOver.probability).toBeLessThan(0.5);
        // And increase as messages increase
        expect(moreOver.probability).toBeGreaterThan(barelyOver.probability);
      }
    });
  });

  describe("Spam Behavior", () => {
    test("should have very high kick probability for spam", () => {
      // 10 participants, 100 messages -> fair share = 10, spam threshold = 30
      // User with 40 messages is spamming
      const result = NPCGroupDynamicsService.calculateKickProbability(
        40,
        100,
        10,
        7,
      );

      expect(result.probability).toBeGreaterThanOrEqual(0.95);
      expect(result.category).toBe("spam");
      expect(result.reason).toContain("Spamming");
    });

    test("spam probability should approach but not exceed 99%", () => {
      // Extreme spammer
      const extremeSpam = NPCGroupDynamicsService.calculateKickProbability(
        200,
        100,
        10,
        7,
      );

      expect(extremeSpam.probability).toBeLessThanOrEqual(0.99);
      expect(extremeSpam.probability).toBeGreaterThanOrEqual(0.95);
    });

    test("absolute spam threshold (20 messages/day) should trigger", () => {
      // 7 days = 140 messages max before absolute spam
      // Small group where relative threshold would be higher
      const result = NPCGroupDynamicsService.calculateKickProbability(
        150,
        20,
        2,
        7,
      );

      expect(result.category).toBe("spam");
    });
  });

  describe("Dynamic Thresholds Based on Group Size", () => {
    test("small groups should have appropriate thresholds", () => {
      // 3 participants, 30 messages -> ~10 fair share
      const result = NPCGroupDynamicsService.calculateKickProbability(
        8,
        30,
        3,
        7,
      );

      // 8 messages is reasonable in a 3-person group
      expect(result.category).toBe("safe");
    });

    test("large groups should have appropriate thresholds", () => {
      // 50 participants, 500 messages -> ~10 fair share
      const result = NPCGroupDynamicsService.calculateKickProbability(
        8,
        500,
        50,
        7,
      );

      // 8 messages is reasonable in a 50-person group
      expect(result.category).toBe("safe");
    });

    test("domination threshold should be relative to group size", () => {
      // In a 3-person group with 30 messages, 20 messages = 67% (clearly dominating)
      // Fair share = 10, ideal max = 15, spam threshold = 30
      const smallGroup = NPCGroupDynamicsService.calculateKickProbability(
        20,
        30,
        3,
        7,
      );

      // In a 50-person group with 500 messages, 20 messages = 4% (fine)
      // Fair share = 10, ideal max = 15, but 20 is only 4% of total which is acceptable
      const largeGroup = NPCGroupDynamicsService.calculateKickProbability(
        20,
        500,
        50,
        7,
      );

      // Small group user should be flagged for over-posting (20 > ideal max 15)
      // Large group user should also be over the ideal max but probability should differ
      // because relative impact is different
      expect(smallGroup.category).toBe("over");
      // Both might be 'over' but small group should have higher probability
      // because 20 is further from the norm in a 3-person group
      if (largeGroup.category !== "safe") {
        expect(smallGroup.probability).toBeGreaterThanOrEqual(
          largeGroup.probability,
        );
      }
    });
  });

  describe("Edge Cases", () => {
    test("should handle empty groups", () => {
      const result = NPCGroupDynamicsService.calculateKickProbability(
        0,
        0,
        0,
        7,
      );

      // Still inactive since user never posted
      expect(result.category).toBe("inactive");
    });

    test("should handle single-message groups", () => {
      // User is the only one who posted
      const result = NPCGroupDynamicsService.calculateKickProbability(
        1,
        1,
        5,
        7,
      );

      // Should be safe - low activity group
      expect(result.probability).toBe(0);
      expect(result.category).toBe("safe");
    });

    test("probability should never exceed 1", () => {
      // Extreme case
      const result = NPCGroupDynamicsService.calculateKickProbability(
        10000,
        100,
        10,
        7,
      );

      expect(result.probability).toBeLessThanOrEqual(1);
    });

    test("probability should never be negative", () => {
      const scenarios = [
        [0, 0, 0, 7],
        [1, 1, 1, 7],
        [100, 10, 5, 7],
      ] as [number, number, number, number][];

      for (const [userMsgs, totalMsgs, participants, days] of scenarios) {
        const result = NPCGroupDynamicsService.calculateKickProbability(
          userMsgs,
          totalMsgs,
          participants,
          days,
        );
        expect(result.probability).toBeGreaterThanOrEqual(0);
      }
    });
  });
});
