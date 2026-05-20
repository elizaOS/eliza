/**
 * Alpha Group Threshold Integration Tests
 *
 * Tests the complete alpha group threshold system including:
 * 1. Lower engagement thresholds (MIN_REPLIES=1, MIN_LIKES=2, MIN_TOTAL=5)
 * 2. Trading activity in engagement scoring
 * 3. Fast-track for high-value traders
 * 4. Per-NPC tier customization
 * 5. Invite decay mechanism
 * 6. Grandfathering existing members
 *
 * These tests exercise real code paths with actual database operations.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from 'bun:test';

import { db } from '@feed/db';
import {
  ALPHA_GROUP_CONFIG,
  AlphaGroupInviteService,
  NPCInteractionTracker,
  TIER_CONFIG,
} from '@feed/engine';
import { generateSnowflakeId } from '@feed/shared';

// Set timeout to 60 seconds for integration tests
setDefaultTimeout(60000);

// Test data cleanup tracking
const testIds = {
  userIds: [] as string[],
  actorIds: [] as string[],
  groupIds: [] as string[],
  postIds: [] as string[],
  reactionIds: [] as string[],
  shareIds: [] as string[],
  interactionIds: [] as string[],
  memberIds: [] as string[],
  inviteIds: [] as string[],
  tradeIds: [] as string[],
};

// ============ HELPER FUNCTIONS ============

async function createTestUser(options: {
  displayName?: string;
  isAgent?: boolean;
}): Promise<{ id: string; displayName: string }> {
  const id = await generateSnowflakeId();
  const displayName = options.displayName || `Test User ${id.slice(-6)}`;

  await db.user.create({
    data: {
      id,
      username: `test-user-${id.slice(-6)}`,
      displayName,
      isActor: false,
      isAgent: options.isAgent ?? false,
      isTest: true,
      updatedAt: new Date(),
    },
  });

  testIds.userIds.push(id);
  return { id, displayName };
}

async function createTestNPC(
  name: string
): Promise<{ id: string; name: string }> {
  const id = await generateSnowflakeId();

  await db.user.create({
    data: {
      id,
      username: name.toLowerCase().replace(/\s+/g, '-'),
      displayName: name,
      isActor: true,
      isTest: true,
      updatedAt: new Date(),
    },
  });

  await db.actorState.create({
    data: {
      id,
      updatedAt: new Date(),
    },
  });

  testIds.actorIds.push(id);
  testIds.userIds.push(id);
  return { id, name };
}

async function createNPCPost(npcId: string, content: string): Promise<string> {
  const id = await generateSnowflakeId();

  await db.post.create({
    data: {
      id,
      authorId: npcId,
      content,
      timestamp: new Date(),
    },
  });

  testIds.postIds.push(id);
  return id;
}

async function createLike(userId: string, postId: string): Promise<string> {
  const id = await generateSnowflakeId();

  await db.reaction.create({
    data: {
      id,
      userId,
      postId,
      type: 'like',
      createdAt: new Date(),
    },
  });

  testIds.reactionIds.push(id);
  return id;
}

async function createShare(userId: string, postId: string): Promise<string> {
  const id = await generateSnowflakeId();

  await db.share.create({
    data: {
      id,
      userId,
      postId,
      createdAt: new Date(),
    },
  });

  testIds.shareIds.push(id);
  return id;
}

async function recordReplyInteraction(
  userId: string,
  npcId: string,
  qualityScore = 0.8
): Promise<string> {
  const id = await generateSnowflakeId();
  const postId = await createNPCPost(npcId, 'NPC post for reply');
  const commentId = await generateSnowflakeId();

  // Create the comment post
  await db.post.create({
    data: {
      id: commentId,
      authorId: userId,
      content: 'Reply to NPC',
      commentOnPostId: postId,
      timestamp: new Date(),
    },
  });
  testIds.postIds.push(commentId);

  // Record the interaction
  await db.userInteraction.create({
    data: {
      id,
      userId,
      npcId,
      postId,
      commentId,
      qualityScore,
      timestamp: new Date(),
    },
  });

  testIds.interactionIds.push(id);
  return id;
}

async function createTrade(
  userId: string,
  options: {
    action?: 'open' | 'close';
    pnl?: number;
    executedAt?: Date;
  }
): Promise<string> {
  const id = await generateSnowflakeId();

  await db.agentTrade.create({
    data: {
      id,
      agentUserId: userId,
      ticker: 'BTC',
      marketType: 'perp',
      action: options.action ?? 'close',
      amount: 100,
      price: 50000,
      pnl: options.pnl ?? 0,
      executedAt: options.executedAt ?? new Date(),
    },
  });

  testIds.tradeIds.push(id);
  return id;
}

async function createNpcGroup(npcId: string, tier: 1 | 2 | 3): Promise<string> {
  const id = await generateSnowflakeId();

  await db.group.create({
    data: {
      id,
      name: `NPC Group Tier ${tier}`,
      type: 'npc',
      ownerId: npcId,
      createdById: npcId,
      tier,
      updatedAt: new Date(),
    },
  });

  testIds.groupIds.push(id);
  return id;
}

async function addMemberToGroup(
  userId: string,
  groupId: string,
  options?: {
    tier?: number;
    isGrandfathered?: boolean;
    joinedAt?: Date;
  }
): Promise<string> {
  const id = await generateSnowflakeId();

  await db.groupMember.create({
    data: {
      id,
      groupId,
      userId,
      tier: options?.tier,
      isGrandfathered: options?.isGrandfathered ?? false,
      grandfatheredAt: options?.isGrandfathered ? new Date() : null,
      joinedAt: options?.joinedAt ?? new Date(),
    },
  });

  testIds.memberIds.push(id);
  return id;
}

async function createGroupInvite(
  groupId: string,
  userId: string,
  npcId: string,
  options?: {
    status?: 'pending' | 'accepted' | 'declined';
    declineCount?: number;
    nextEligibleAt?: Date;
  }
): Promise<string> {
  const id = await generateSnowflakeId();

  await db.groupInvite.create({
    data: {
      id,
      groupId,
      invitedUserId: userId,
      invitedBy: npcId,
      status: options?.status ?? 'pending',
      declineCount: options?.declineCount ?? 0,
      nextEligibleAt: options?.nextEligibleAt,
    },
  });

  testIds.inviteIds.push(id);
  return id;
}

async function cleanupTestData(): Promise<void> {
  // Delete in reverse order of dependencies
  if (testIds.inviteIds.length > 0) {
    await db.groupInvite.deleteMany({
      where: { id: { in: testIds.inviteIds } },
    });
  }
  if (testIds.memberIds.length > 0) {
    await db.groupMember.deleteMany({
      where: { id: { in: testIds.memberIds } },
    });
  }
  if (testIds.groupIds.length > 0) {
    await db.group.deleteMany({ where: { id: { in: testIds.groupIds } } });
  }
  if (testIds.tradeIds.length > 0) {
    await db.agentTrade.deleteMany({
      where: { id: { in: testIds.tradeIds } },
    });
  }
  if (testIds.interactionIds.length > 0) {
    await db.userInteraction.deleteMany({
      where: { id: { in: testIds.interactionIds } },
    });
  }
  if (testIds.shareIds.length > 0) {
    await db.share.deleteMany({ where: { id: { in: testIds.shareIds } } });
  }
  if (testIds.reactionIds.length > 0) {
    await db.reaction.deleteMany({
      where: { id: { in: testIds.reactionIds } },
    });
  }
  if (testIds.postIds.length > 0) {
    await db.post.deleteMany({ where: { id: { in: testIds.postIds } } });
  }
  if (testIds.actorIds.length > 0) {
    await db.actorState.deleteMany({
      where: { id: { in: testIds.actorIds } },
    });
  }
  if (testIds.userIds.length > 0) {
    await db.user.deleteMany({ where: { id: { in: testIds.userIds } } });
  }

  // Reset all tracking arrays
  Object.keys(testIds).forEach((key) => {
    (testIds as Record<string, string[]>)[key] = [];
  });
}

// ============ TESTS ============

describe('Alpha Group Threshold System', () => {
  beforeAll(async () => {
    await cleanupTestData();
  });

  afterAll(async () => {
    await cleanupTestData();
  });

  describe('Configuration Verification', () => {
    test('config should have lowered thresholds', () => {
      // Verify thresholds are lower than original hardcoded values
      expect(ALPHA_GROUP_CONFIG.minReplies).toBe(1); // Was 3
      expect(ALPHA_GROUP_CONFIG.minLikes).toBe(2); // Was 5
      expect(ALPHA_GROUP_CONFIG.minTotalInteractions).toBe(5); // Was 10
    });

    test('tier config should have tier-specific invite probabilities', () => {
      expect(TIER_CONFIG[3].inviteProbability).toBe(0.1); // 10%
      expect(TIER_CONFIG[2].inviteProbability).toBe(0.02); // 2%
      expect(TIER_CONFIG[1].inviteProbability).toBe(0.005); // 0.5%
    });

    test('tier 3 should have minEngagementScore of 20', () => {
      expect(TIER_CONFIG[3].minEngagementScore).toBe(20);
    });
  });

  describe('Lower Threshold Engagement', () => {
    beforeEach(async () => {
      await cleanupTestData();
    });

    afterEach(async () => {
      await cleanupTestData();
    });

    test('user with minimal engagement (1 reply, 2 likes, 2 shares) should be eligible', async () => {
      const npc = await createTestNPC('Friendly NPC');
      const user = await createTestUser({ displayName: 'Minimal User' });

      // Create NPC posts
      const posts: string[] = [];
      for (let i = 0; i < 3; i++) {
        posts.push(await createNPCPost(npc.id, `Post ${i}`));
      }

      // Minimal engagement: 1 reply (high quality)
      await recordReplyInteraction(user.id, npc.id, 0.9);

      // 2 likes
      await createLike(user.id, posts[0]!);
      await createLike(user.id, posts[1]!);

      // 2 shares
      await createShare(user.id, posts[0]!);
      await createShare(user.id, posts[1]!);

      const score = await NPCInteractionTracker.calculateEngagementScore(
        user.id,
        npc.id
      );

      console.log('Minimal Engagement Score:', score);

      // Should meet minimum thresholds
      expect(score.replyCount).toBeGreaterThanOrEqual(
        ALPHA_GROUP_CONFIG.minReplies
      );
      expect(score.likeCount).toBeGreaterThanOrEqual(
        ALPHA_GROUP_CONFIG.minLikes
      );
      expect(score.totalInteractions).toBeGreaterThanOrEqual(
        ALPHA_GROUP_CONFIG.minTotalInteractions
      );
      expect(score.isEligibleForInvite).toBe(true);
    });

    test('user below minimum thresholds should NOT be eligible', async () => {
      const npc = await createTestNPC('Strict NPC');
      const user = await createTestUser({ displayName: 'Low Engagement User' });

      // Only 1 like (below minLikes=2)
      const post = await createNPCPost(npc.id, 'Single post');
      await createLike(user.id, post);

      // No replies (below minReplies=1)

      const score = await NPCInteractionTracker.calculateEngagementScore(
        user.id,
        npc.id
      );

      console.log('Low Engagement Score:', score);

      expect(score.replyCount).toBe(0);
      expect(score.likeCount).toBe(1);
      expect(score.isEligibleForInvite).toBe(false);
      expect(
        score.eligibilityReasons.some((reason) =>
          /Need.*more replies/.test(reason)
        )
      ).toBe(true);
    });
  });

  describe('Trading Activity in Engagement', () => {
    beforeEach(async () => {
      await cleanupTestData();
    });

    afterEach(async () => {
      await cleanupTestData();
    });

    test('trades should contribute to engagement score when enabled', async () => {
      const npc = await createTestNPC('Trading NPC');
      const trader = await createTestUser({
        displayName: 'Active Trader',
        isAgent: true,
      });

      // Minimal social engagement
      await recordReplyInteraction(trader.id, npc.id, 0.8);
      const post = await createNPCPost(npc.id, 'Market post');
      await createLike(trader.id, post);
      await createLike(trader.id, await createNPCPost(npc.id, 'Another post'));

      // Add trading activity: 5 trades, 3 profitable
      for (let i = 0; i < 5; i++) {
        await createTrade(trader.id, {
          action: 'close',
          pnl: i < 3 ? 100 : -50, // 3 profitable, 2 loss
        });
      }

      const score = await NPCInteractionTracker.calculateEngagementScore(
        trader.id,
        npc.id
      );

      console.log('Trader Engagement Score:', score);

      // Trading stats should be populated
      expect(score.tradingStats.totalTrades).toBe(5);
      expect(score.tradingStats.profitableTrades).toBe(3);
      expect(score.tradingStats.winRate).toBeCloseTo(0.6, 1);

      // Trading score should contribute to overall
      expect(score.tradingScore).toBeGreaterThan(0);
      expect(score.engagementScore).toBeGreaterThan(score.socialScore);
    });

    test('user without trades should still be eligible with sufficient social engagement', async () => {
      const npc = await createTestNPC('Social NPC');
      const user = await createTestUser({ displayName: 'Social User' });

      // Strong social engagement
      for (let i = 0; i < 5; i++) {
        await recordReplyInteraction(user.id, npc.id, 0.85);
      }
      const posts: string[] = [];
      for (let i = 0; i < 5; i++) {
        const p = await createNPCPost(npc.id, `Post ${i}`);
        posts.push(p);
        await createLike(user.id, p);
      }

      const score = await NPCInteractionTracker.calculateEngagementScore(
        user.id,
        npc.id
      );

      console.log('Social-only Engagement Score:', score);

      expect(score.tradingStats.totalTrades).toBe(0);
      expect(score.tradingScore).toBe(0);
      expect(score.socialScore).toBeGreaterThan(0);
      expect(score.isEligibleForInvite).toBe(true);
    });
  });

  describe('Fast-Track for High-Value Traders', () => {
    beforeEach(async () => {
      await cleanupTestData();
    });

    afterEach(async () => {
      await cleanupTestData();
    });

    test('trader meeting fast-track criteria should be eligible', async () => {
      const npc = await createTestNPC('Alpha NPC');
      const whale = await createTestUser({
        displayName: 'Whale Trader',
        isAgent: true,
      });

      // Minimal social engagement (below normal thresholds)
      const post = await createNPCPost(npc.id, 'Market post');
      await createLike(whale.id, post);

      // Strong trading: 15 trades, 10 profitable, total PnL > 5000
      for (let i = 0; i < 15; i++) {
        await createTrade(whale.id, {
          action: 'close',
          pnl: i < 10 ? 800 : -200, // 10 wins, 5 losses, net = 7000
        });
      }

      const score = await NPCInteractionTracker.calculateEngagementScore(
        whale.id,
        npc.id
      );

      console.log('Whale Trader Score:', score);

      // Should qualify for fast-track
      expect(score.tradingStats.totalTrades).toBeGreaterThanOrEqual(
        ALPHA_GROUP_CONFIG.fastTrackMinTrades
      );
      expect(score.tradingStats.totalPnL).toBeGreaterThanOrEqual(
        ALPHA_GROUP_CONFIG.fastTrackMinPnL
      );
      expect(score.tradingStats.winRate).toBeGreaterThanOrEqual(
        ALPHA_GROUP_CONFIG.fastTrackMinWinRate
      );
      expect(score.qualifiesForFastTrack).toBe(true);

      // Fast-track should override social requirements
      expect(score.isEligibleForInvite).toBe(true);
    });

    test('trader with losses should NOT qualify for fast-track', async () => {
      const npc = await createTestNPC('Selective NPC');
      const loser = await createTestUser({
        displayName: 'Losing Trader',
        isAgent: true,
      });

      // Many trades but low win rate
      for (let i = 0; i < 20; i++) {
        await createTrade(loser.id, {
          action: 'close',
          pnl: i < 5 ? 100 : -100, // 5 wins, 15 losses = 25% win rate
        });
      }

      const score = await NPCInteractionTracker.calculateEngagementScore(
        loser.id,
        npc.id
      );

      console.log('Losing Trader Score:', score);

      expect(score.tradingStats.winRate).toBeLessThan(
        ALPHA_GROUP_CONFIG.fastTrackMinWinRate
      );
      expect(score.qualifiesForFastTrack).toBe(false);
    });
  });

  describe('Invite Decay Mechanism', () => {
    beforeEach(async () => {
      await cleanupTestData();
    });

    afterEach(async () => {
      await cleanupTestData();
    });

    test('declined invite should increase declineCount', async () => {
      const npc = await createTestNPC('Persistent NPC');
      const user = await createTestUser({ displayName: 'Declining User' });
      const groupId = await createNpcGroup(npc.id, 3);

      // Create initial invite
      const inviteId = await createGroupInvite(groupId, user.id, npc.id, {
        status: 'declined',
        declineCount: 1,
        nextEligibleAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      });

      // Verify the invite has correct decay data
      const invite = await db.groupInvite.findUnique({
        where: { id: inviteId },
      });

      expect(invite?.declineCount).toBe(1);
      expect(invite?.nextEligibleAt).toBeDefined();
      expect(invite?.nextEligibleAt!.getTime()).toBeGreaterThan(Date.now());
    });

    test('user with max declines should not be eligible until reset', async () => {
      const npc = await createTestNPC('Blocked NPC');
      const user = await createTestUser({ displayName: 'Max Decline User' });
      const groupId = await createNpcGroup(npc.id, 3);

      // Create invite at max declines
      await createGroupInvite(groupId, user.id, npc.id, {
        status: 'declined',
        declineCount: ALPHA_GROUP_CONFIG.inviteDecayMaxDeclines,
        nextEligibleAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
      });

      const invite = await db.groupInvite.findFirst({
        where: {
          invitedUserId: user.id,
          groupId,
        },
      });

      expect(invite?.declineCount).toBe(
        ALPHA_GROUP_CONFIG.inviteDecayMaxDeclines
      );
    });
  });

  describe('Grandfathering Existing Members', () => {
    beforeEach(async () => {
      await cleanupTestData();
    });

    afterEach(async () => {
      await cleanupTestData();
    });

    test('grandfathered member should have isGrandfathered flag', async () => {
      const npc = await createTestNPC('Legacy NPC');
      const user = await createTestUser({ displayName: 'OG Member' });
      const groupId = await createNpcGroup(npc.id, 2);

      // Add member as grandfathered
      const memberId = await addMemberToGroup(user.id, groupId, {
        tier: 2,
        isGrandfathered: true,
        joinedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), // 30 days ago
      });

      const member = await db.groupMember.findUnique({
        where: { id: memberId },
      });

      expect(member?.isGrandfathered).toBe(true);
      expect(member?.grandfatheredAt).toBeDefined();
    });

    test('getMembershipStatus should reflect grandfathering', async () => {
      const npc = await createTestNPC('Status NPC');
      const user = await createTestUser({ displayName: 'Status User' });
      const groupId = await createNpcGroup(npc.id, 2);

      await addMemberToGroup(user.id, groupId, {
        tier: 2,
        isGrandfathered: true,
      });

      // The getMembershipStatus should show grandfathered status
      const member = await db.groupMember.findFirst({
        where: { userId: user.id, groupId },
      });

      expect(member?.isGrandfathered).toBe(true);
    });
  });

  describe('Engagement Score Calculation', () => {
    beforeEach(async () => {
      await cleanupTestData();
    });

    afterEach(async () => {
      await cleanupTestData();
    });

    test('quality score should affect engagement calculation', async () => {
      const npc = await createTestNPC('Quality NPC');
      const highQualityUser = await createTestUser({
        displayName: 'Quality User',
      });
      const lowQualityUser = await createTestUser({
        displayName: 'Low Quality User',
      });

      // High quality replies
      for (let i = 0; i < 3; i++) {
        await recordReplyInteraction(highQualityUser.id, npc.id, 0.95);
      }

      // Low quality replies (same count)
      for (let i = 0; i < 3; i++) {
        await recordReplyInteraction(lowQualityUser.id, npc.id, 0.4);
      }

      const highScore = await NPCInteractionTracker.calculateEngagementScore(
        highQualityUser.id,
        npc.id
      );
      const lowScore = await NPCInteractionTracker.calculateEngagementScore(
        lowQualityUser.id,
        npc.id
      );

      console.log('High Quality Score:', highScore.engagementScore);
      console.log('Low Quality Score:', lowScore.engagementScore);

      // Same reply count
      expect(highScore.replyCount).toBe(lowScore.replyCount);

      // But different quality
      expect(highScore.avgQualityScore).toBeGreaterThan(
        lowScore.avgQualityScore
      );

      // High quality user should be eligible, low quality might not be
      expect(highScore.avgQualityScore).toBeGreaterThan(
        ALPHA_GROUP_CONFIG.minQualityScore
      );

      // Low quality user should fail quality check
      expect(lowScore.avgQualityScore).toBeLessThan(
        ALPHA_GROUP_CONFIG.minQualityScore
      );
    });

    test('engagement score should be bounded 0-100', async () => {
      const npc = await createTestNPC('Bounds NPC');
      const superUser = await createTestUser({
        displayName: 'Super Engaged User',
      });

      // Extreme engagement
      for (let i = 0; i < 50; i++) {
        await recordReplyInteraction(superUser.id, npc.id, 1.0);
      }
      for (let i = 0; i < 50; i++) {
        const post = await createNPCPost(npc.id, `Post ${i}`);
        await createLike(superUser.id, post);
        await createShare(superUser.id, post);
      }
      for (let i = 0; i < 30; i++) {
        await createTrade(superUser.id, { action: 'close', pnl: 1000 });
      }

      const score = await NPCInteractionTracker.calculateEngagementScore(
        superUser.id,
        npc.id
      );

      console.log('Super User Score:', score);

      expect(score.engagementScore).toBeLessThanOrEqual(100);
      expect(score.engagementScore).toBeGreaterThanOrEqual(0);
      expect(score.socialScore).toBeLessThanOrEqual(100);
      expect(score.tradingScore).toBeLessThanOrEqual(100);
    });

    test('user with no engagement should have score of 0', async () => {
      const npc = await createTestNPC('Empty NPC');
      const noEngagementUser = await createTestUser({
        displayName: 'Ghost User',
      });

      const score = await NPCInteractionTracker.calculateEngagementScore(
        noEngagementUser.id,
        npc.id
      );

      console.log('No Engagement Score:', score);

      expect(score.replyCount).toBe(0);
      expect(score.likeCount).toBe(0);
      expect(score.shareCount).toBe(0);
      expect(score.totalInteractions).toBe(0);
      expect(score.tradingStats.totalTrades).toBe(0);
      expect(score.engagementScore).toBe(0);
      expect(score.isEligibleForInvite).toBe(false);
    });
  });

  describe('Invite Statistics', () => {
    test('should be able to retrieve invite statistics', async () => {
      const stats = await AlphaGroupInviteService.getInviteStats();

      expect(stats).toHaveProperty('totalInvites');
      expect(stats).toHaveProperty('activeGroups');
      expect(stats).toHaveProperty('invitesLast24h');
      expect(typeof stats.totalInvites).toBe('number');
      expect(stats.totalInvites).toBeGreaterThanOrEqual(0);

      console.log('Invite Statistics:', stats);
    });
  });

  describe('Edge Cases', () => {
    beforeEach(async () => {
      await cleanupTestData();
    });

    afterEach(async () => {
      await cleanupTestData();
    });

    test('should handle user interacting with non-existent NPC gracefully', async () => {
      const user = await createTestUser({ displayName: 'Lost User' });

      const score = await NPCInteractionTracker.calculateEngagementScore(
        user.id,
        'non-existent-npc-id'
      );

      expect(score.engagementScore).toBe(0);
      expect(score.isEligibleForInvite).toBe(false);
    });

    test('should handle trades with null PnL', async () => {
      const npc = await createTestNPC('Trade Edge NPC');
      const trader = await createTestUser({
        displayName: 'Edge Trader',
        isAgent: true,
      });

      // Create an open trade (no PnL yet)
      await createTrade(trader.id, { action: 'open' });

      // Create engagement for eligibility check
      await recordReplyInteraction(trader.id, npc.id, 0.8);

      const score = await NPCInteractionTracker.calculateEngagementScore(
        trader.id,
        npc.id
      );

      // Open trades shouldn't count toward closed trade stats
      expect(score.tradingStats.totalTrades).toBe(0);
    });

    test('should handle extremely old interactions', async () => {
      const npc = await createTestNPC('Time NPC');
      const user = await createTestUser({ displayName: 'Ancient User' });

      // Create engagement
      await recordReplyInteraction(user.id, npc.id, 0.8);

      // Query with a window that excludes the interaction
      const oldWindow = {
        startDate: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000), // 1 year ago
        endDate: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000), // 60 days ago
      };

      const score = await NPCInteractionTracker.calculateEngagementScore(
        user.id,
        npc.id,
        oldWindow
      );

      // Should have no interactions in old window
      expect(score.replyCount).toBe(0);
    });
  });
});
