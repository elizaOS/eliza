/**
 * Group Chat Simulation Integration Tests
 *
 * End-to-end tests that simulate the complete group chat flow:
 * 1. NPCs create content
 * 2. Users/agents engage with NPC content (follows, likes, comments, shares)
 * 3. Game tick runs the alpha invite service
 * 4. Users with high engagement get invited to group chats
 * 5. Users maintain participation or get kicked
 *
 * These tests verify the actual services work together correctly.
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

// Set default timeout to 30 seconds for integration tests
setDefaultTimeout(30000);

import { db } from '@babylon/db';
import {
  AlphaGroupInviteService,
  GroupChatService,
  NPCGroupDynamicsService,
  NPCInteractionTracker,
} from '@babylon/engine';
import { generateSnowflakeId } from '@babylon/shared';

// Test data cleanup tracking
const testIds = {
  userIds: [] as string[],
  actorIds: [] as string[],
  groupIds: [] as string[],
  chatIds: [] as string[],
  postIds: [] as string[],
  reactionIds: [] as string[],
  shareIds: [] as string[],
  followIds: [] as string[],
  interactionIds: [] as string[],
  membershipIds: [] as string[],
  participantIds: [] as string[],
  messageIds: [] as string[],
};

// ============ HELPER FUNCTIONS ============

async function createTestUser(options: {
  isAgent?: boolean;
  displayName?: string;
}): Promise<{ id: string; displayName: string; isAgent: boolean }> {
  const id = await generateSnowflakeId();
  const displayName = options.displayName || `Test User ${id.slice(-6)}`;

  await db.user.create({
    data: {
      id,
      username: `test-user-${id.slice(-6)}`,
      displayName,
      isActor: false,
      isAgent: options.isAgent || false,
      isTest: true,
      updatedAt: new Date(),
    },
  });

  testIds.userIds.push(id);
  return { id, displayName, isAgent: options.isAgent || false };
}

async function createTestNPC(
  name: string
): Promise<{ id: string; name: string }> {
  const id = await generateSnowflakeId();

  // Create user with isActor: true (no separate actors table needed)
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

  // Create actorState for dynamic data
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

async function createFollow(
  followerId: string,
  followingId: string
): Promise<string> {
  const id = await generateSnowflakeId();

  await db.follow.create({
    data: {
      id,
      followerId,
      followingId,
      createdAt: new Date(),
    },
  });

  testIds.followIds.push(id);
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

async function createComment(
  userId: string,
  npcPostId: string,
  content: string
): Promise<string> {
  const id = await generateSnowflakeId();

  await db.post.create({
    data: {
      id,
      authorId: userId,
      content,
      commentOnPostId: npcPostId,
      timestamp: new Date(),
    },
  });

  testIds.postIds.push(id);
  return id;
}

async function recordUserInteraction(
  userId: string,
  npcId: string,
  postId: string,
  commentId: string,
  qualityScore = 0.8
): Promise<string> {
  const id = await generateSnowflakeId();

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

async function createGroupMembership(options: {
  groupId: string;
  userId: string;
  addedBy?: string;
  joinedAt?: Date;
  role?: 'owner' | 'admin' | 'member';
}): Promise<string> {
  const id = await generateSnowflakeId();

  await db.groupMember.create({
    data: {
      id,
      groupId: options.groupId,
      userId: options.userId,
      role: options.role || 'member',
      addedBy: options.addedBy,
      isActive: true,
      joinedAt: options.joinedAt || new Date(),
    },
  });

  testIds.membershipIds.push(id);
  return id;
}

async function createGroupChat(
  name: string,
  npcOwnerId: string
): Promise<{ chatId: string; groupId: string }> {
  const groupId = await generateSnowflakeId();
  const chatId = await generateSnowflakeId();

  // Create Group first (unified schema)
  await db.group.create({
    data: {
      id: groupId,
      name,
      type: 'npc',
      ownerId: npcOwnerId,
      createdById: npcOwnerId,
      updatedAt: new Date(),
    },
  });

  // Create Chat with groupId link
  await db.chat.create({
    data: {
      id: chatId,
      name,
      isGroup: true,
      groupId,
      gameId: 'realtime',
      updatedAt: new Date(),
    },
  });

  // Add NPC as participant
  const participantId = await generateSnowflakeId();
  await db.chatParticipant.create({
    data: {
      id: participantId,
      chatId,
      userId: npcOwnerId,
      isActive: true,
    },
  });

  testIds.groupIds.push(groupId);
  testIds.chatIds.push(chatId);
  testIds.participantIds.push(participantId);
  return { chatId, groupId };
}

async function createMessage(options: {
  chatId: string;
  senderId: string;
  content: string;
  createdAt?: Date;
}): Promise<string> {
  const id = await generateSnowflakeId();

  await db.message.create({
    data: {
      id,
      chatId: options.chatId,
      senderId: options.senderId,
      content: options.content,
      createdAt: options.createdAt || new Date(),
    },
  });

  testIds.messageIds.push(id);
  return id;
}

async function cleanupTestData(): Promise<void> {
  // Delete in reverse order of dependencies
  if (testIds.messageIds.length > 0) {
    await db.message.deleteMany({ where: { id: { in: testIds.messageIds } } });
  }
  if (testIds.membershipIds.length > 0) {
    await db.groupMember.deleteMany({
      where: { id: { in: testIds.membershipIds } },
    });
  }
  if (testIds.participantIds.length > 0) {
    await db.chatParticipant.deleteMany({
      where: { id: { in: testIds.participantIds } },
    });
  }
  if (testIds.chatIds.length > 0) {
    await db.chat.deleteMany({ where: { id: { in: testIds.chatIds } } });
  }
  if (testIds.groupIds.length > 0) {
    await db.group.deleteMany({ where: { id: { in: testIds.groupIds } } });
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
  if (testIds.followIds.length > 0) {
    await db.follow.deleteMany({ where: { id: { in: testIds.followIds } } });
  }
  if (testIds.postIds.length > 0) {
    await db.post.deleteMany({ where: { id: { in: testIds.postIds } } });
  }
  if (testIds.userIds.length > 0) {
    await db.user.deleteMany({ where: { id: { in: testIds.userIds } } });
  }
  if (testIds.actorIds.length > 0) {
    await db.actorState.deleteMany({ where: { id: { in: testIds.actorIds } } });
  }

  // Reset all tracking arrays
  Object.keys(testIds).forEach((key) => {
    (testIds as Record<string, string[]>)[key] = [];
  });
}

// ============ SIMULATION TESTS ============

describe('Group Chat Simulation - End to End Flow', () => {
  // Increase timeout for integration tests that hit the database
  const _INTEGRATION_TIMEOUT = 30000;

  beforeAll(async () => {
    await cleanupTestData();
  });

  afterAll(async () => {
    await cleanupTestData();
  });

  describe('Engagement Score Calculation', () => {
    beforeEach(async () => {
      await cleanupTestData();
    });

    afterEach(async () => {
      await cleanupTestData();
    });

    test('should calculate engagement score from user interactions', async () => {
      const npc = await createTestNPC('Alpha Trader');
      const user = await createTestUser({ displayName: 'Engaged User' });

      // User follows NPC
      await createFollow(user.id, npc.id);

      // NPC creates posts
      const posts: string[] = [];
      for (let i = 0; i < 5; i++) {
        posts.push(await createNPCPost(npc.id, `Market insight ${i}`));
      }

      // User engages with posts
      for (const postId of posts) {
        await createLike(user.id, postId);
      }

      // User comments with quality interactions
      const comment1 = await createComment(
        user.id,
        posts[0]!,
        'Great analysis, thanks for sharing!'
      );
      const comment2 = await createComment(
        user.id,
        posts[1]!,
        'This matches my research perfectly'
      );

      // Record quality interactions
      await recordUserInteraction(user.id, npc.id, posts[0]!, comment1, 0.85);
      await recordUserInteraction(user.id, npc.id, posts[1]!, comment2, 0.9);

      // Calculate engagement score
      const engagementData =
        await NPCInteractionTracker.calculateEngagementScore(user.id, npc.id);

      expect(engagementData.replyCount).toBe(2);
      expect(engagementData.avgQualityScore).toBeCloseTo(0.875, 1);
      expect(engagementData.engagementScore).toBeGreaterThan(0);
    });

    test('should rank users by engagement level', async () => {
      const npc = await createTestNPC('Market Maven');

      // Create users with different engagement levels
      const highUser = await createTestUser({ displayName: 'High Engager' });
      const medUser = await createTestUser({ displayName: 'Medium Engager' });
      const lowUser = await createTestUser({ displayName: 'Low Engager' });

      // Create posts for interactions
      const posts: string[] = [];
      for (let i = 0; i < 15; i++) {
        posts.push(await createNPCPost(npc.id, `Post ${i}`));
      }

      // High engagement: 8 quality comments
      for (let i = 0; i < 8; i++) {
        const comment = await createComment(
          highUser.id,
          posts[i]!,
          `High quality comment ${i}`
        );
        await recordUserInteraction(
          highUser.id,
          npc.id,
          posts[i]!,
          comment,
          0.9
        );
      }

      // Medium engagement: 4 comments
      for (let i = 8; i < 12; i++) {
        const comment = await createComment(
          medUser.id,
          posts[i]!,
          `Medium comment ${i}`
        );
        await recordUserInteraction(
          medUser.id,
          npc.id,
          posts[i]!,
          comment,
          0.75
        );
      }

      // Low engagement: 1 comment
      const lowComment = await createComment(
        lowUser.id,
        posts[14]!,
        'Interesting'
      );
      await recordUserInteraction(
        lowUser.id,
        npc.id,
        posts[14]!,
        lowComment,
        0.6
      );

      // Get top engaged users
      const topUsers = await NPCInteractionTracker.getTopEngagedUsers(
        npc.id,
        10
      );

      // Should find all 3 users
      expect(topUsers.length).toBe(3);

      // Verify each user is in the results
      const userIds = topUsers.map((u) => u.userId);
      expect(userIds).toContain(highUser.id);
      expect(userIds).toContain(medUser.id);
      expect(userIds).toContain(lowUser.id);

      // Find scores for each user
      const highUserScore = topUsers.find((u) => u.userId === highUser.id);
      const medUserScore = topUsers.find((u) => u.userId === medUser.id);
      const lowUserScore = topUsers.find((u) => u.userId === lowUser.id);

      // Verify engagement scores are ranked correctly (highest has most interactions)
      expect(highUserScore!.engagementScore).toBeGreaterThan(
        medUserScore!.engagementScore
      );
      expect(medUserScore!.engagementScore).toBeGreaterThan(
        lowUserScore!.engagementScore
      );
    });
  });

  describe('Reply Guy Score Calculation', () => {
    beforeEach(async () => {
      await cleanupTestData();
    });

    afterEach(async () => {
      await cleanupTestData();
    });

    test('should give combined score for ideal engagement pattern', async () => {
      const npc = await createTestNPC('Ideal Test NPC');
      const user = await createTestUser({ displayName: 'Ideal Engager' });

      // Follow
      await createFollow(user.id, npc.id);

      // Create NPC posts
      const posts: string[] = [];
      for (let i = 0; i < 5; i++) {
        posts.push(await createNPCPost(npc.id, `Content ${i}`));
      }

      // Ideal engagement: 2 comments, 5 likes, 1 share
      await createComment(user.id, posts[0]!, 'Great analysis');
      await createComment(user.id, posts[1]!, 'Thanks for sharing');

      for (const postId of posts) {
        await createLike(user.id, postId);
      }

      await createShare(user.id, posts[0]!);

      // Calculate reply guy score
      const { score, breakdown } =
        await NPCGroupDynamicsService.calculateReplyGuyScore(user.id, [npc.id]);

      // Verify breakdown
      expect(breakdown.follows).toBe(5); // 1 follow × 5 points
      expect(breakdown.comments).toBe(6); // 2 comments × 3 points (ideal range)
      expect(breakdown.likes).toBe(5); // 5 likes × 1 point (ideal range)
      expect(breakdown.reposts).toBe(4); // 1 share × 4 points (ideal range)
      expect(breakdown.penalties).toBe(0); // No spam penalties
      expect(score).toBeGreaterThan(15);
    });

    test('should penalize spam behavior', async () => {
      const npc = await createTestNPC('Spam Test NPC');
      const spammer = await createTestUser({ displayName: 'Spammy User' });

      const post = await createNPCPost(npc.id, 'Popular post');

      // Excessive comments (15+)
      for (let i = 0; i < 15; i++) {
        await createComment(spammer.id, post, `Comment spam ${i}`);
      }

      const { score, breakdown } =
        await NPCGroupDynamicsService.calculateReplyGuyScore(spammer.id, [
          npc.id,
        ]);

      // Should have penalties for excessive commenting
      expect(breakdown.penalties).toBeLessThan(0);
      // Score should be reduced
      expect(score).toBeLessThan(breakdown.comments);
    });
  });

  describe('Group Invite Service', () => {
    beforeEach(async () => {
      await cleanupTestData();
    });

    afterEach(async () => {
      await cleanupTestData();
    });

    test('should track invite statistics', async () => {
      const stats = await AlphaGroupInviteService.getInviteStats();

      expect(stats).toHaveProperty('totalInvites');
      expect(stats).toHaveProperty('activeGroups');
      expect(stats).toHaveProperty('invitesLast24h');
      expect(typeof stats.totalInvites).toBe('number');
      expect(typeof stats.activeGroups).toBe('number');
      expect(typeof stats.invitesLast24h).toBe('number');
    });

    test('should track and respect group membership limits', async () => {
      // Create 5 different NPCs - each NPC can admin one group per user
      const npcs: Array<{ id: string; name: string }> = [];
      for (let i = 0; i < 5; i++) {
        npcs.push(await createTestNPC(`Limit Test NPC ${i}`));
      }
      const user = await createTestUser({ displayName: 'Group Collector' });

      // Create 5 groups, each with a different NPC admin
      for (let i = 0; i < 5; i++) {
        const { groupId } = await createGroupChat(`Group ${i}`, npcs[i]!.id);
        await createGroupMembership({
          groupId,
          userId: user.id,
          addedBy: npcs[i]!.id,
        });
      }

      // Count user's active groups
      const activeGroups = await db.groupMember.count({
        where: { userId: user.id, isActive: true },
      });

      expect(activeGroups).toBe(5);
    });
  });

  describe('Kick Probability Mechanics', () => {
    test('inactive users should have high kick probability', () => {
      const result = NPCGroupDynamicsService.calculateKickProbability(
        0, // Never posted
        100, // Active group
        10, // 10 participants
        7 // 7 day window
      );

      expect(result.probability).toBe(0.9);
      expect(result.category).toBe('inactive');
    });

    test('ideal participation should have zero kick probability', () => {
      // Fair share = 100/10 = 10 messages
      // User with 10 messages is exactly fair share
      const result = NPCGroupDynamicsService.calculateKickProbability(
        10,
        100,
        10,
        7
      );

      expect(result.probability).toBe(0);
      expect(result.category).toBe('safe');
    });

    test('over-posting should have increasing kick probability', () => {
      const results: Array<{
        messages: number;
        prob: number;
        category: string;
      }> = [];

      for (const msgCount of [16, 20, 25, 30]) {
        const result = NPCGroupDynamicsService.calculateKickProbability(
          msgCount,
          100,
          10,
          7
        );
        results.push({
          messages: msgCount,
          prob: result.probability,
          category: result.category,
        });
      }

      // Probability should increase as messages increase
      for (let i = 1; i < results.length; i++) {
        expect(results[i]?.prob).toBeGreaterThanOrEqual(
          results[i - 1]?.prob ?? 0
        );
      }
    });

    test('spam behavior should have near-certain kick probability', () => {
      const result = NPCGroupDynamicsService.calculateKickProbability(
        50, // Way too many messages
        100,
        10,
        7
      );

      expect(result.probability).toBeGreaterThanOrEqual(0.95);
      expect(result.category).toBe('spam');
    });
  });

  describe('User vs Agent Parity', () => {
    beforeEach(async () => {
      await cleanupTestData();
    });

    afterEach(async () => {
      await cleanupTestData();
    });

    test('agents should earn same engagement score as users for same behavior', async () => {
      // Create a fresh NPC for this test
      const npc = await createTestNPC('Parity Test NPC');

      // Create human and agent users
      const humanUser = await createTestUser({
        isAgent: false,
        displayName: 'Human User',
      });
      const aiAgent = await createTestUser({
        isAgent: true,
        displayName: 'AI Agent',
      });

      // Create separate posts for each user's engagement to avoid any cross-contamination
      const humanPost = await createNPCPost(
        npc.id,
        'Post for human engagement'
      );
      const agentPost = await createNPCPost(
        npc.id,
        'Post for agent engagement'
      );

      // Human engagement
      await createFollow(humanUser.id, npc.id);
      await createLike(humanUser.id, humanPost);
      await createComment(humanUser.id, humanPost, 'Human insight');
      await createShare(humanUser.id, humanPost);

      // Agent engagement (identical pattern on different post)
      await createFollow(aiAgent.id, npc.id);
      await createLike(aiAgent.id, agentPost);
      await createComment(aiAgent.id, agentPost, 'Agent insight');
      await createShare(aiAgent.id, agentPost);

      // Calculate scores - both should have same pattern of engagement
      const humanScore = await NPCGroupDynamicsService.calculateReplyGuyScore(
        humanUser.id,
        [npc.id]
      );
      const agentScore = await NPCGroupDynamicsService.calculateReplyGuyScore(
        aiAgent.id,
        [npc.id]
      );

      // Scores should be identical since engagement pattern is the same
      // Each has: 1 follow (5pts), 1 comment (3pts in ideal range), 1 share (4pts)
      // Likes < 3 get 0.5 points each, so 1 like = 0.5pts
      expect(humanScore.breakdown.follows).toBe(agentScore.breakdown.follows);
      expect(humanScore.breakdown.comments).toBe(agentScore.breakdown.comments);
      expect(humanScore.breakdown.likes).toBe(agentScore.breakdown.likes);
      expect(humanScore.breakdown.reposts).toBe(agentScore.breakdown.reposts);
      expect(humanScore.score).toBe(agentScore.score);
    });

    test('both users and agents can be members of NPC groups', async () => {
      const npc = await createTestNPC('Inclusive NPC');
      const user = await createTestUser({
        isAgent: false,
        displayName: 'Regular User',
      });
      const agent = await createTestUser({
        isAgent: true,
        displayName: 'AI Agent',
      });

      const { groupId } = await createGroupChat('Mixed Group', npc.id);

      // Add both to group
      await createGroupMembership({
        groupId,
        userId: user.id,
        addedBy: npc.id,
      });
      await createGroupMembership({
        groupId,
        userId: agent.id,
        addedBy: npc.id,
      });

      // Verify both are members
      const memberships = await db.groupMember.findMany({
        where: { groupId, isActive: true },
      });

      expect(memberships.length).toBe(2);
      expect(memberships.some((m) => m.userId === user.id)).toBe(true);
      expect(memberships.some((m) => m.userId === agent.id)).toBe(true);
    });

    test('kick probability should be identical for users and agents', () => {
      const scenarios = [
        { messages: 0, total: 100, participants: 10 }, // Inactive
        { messages: 10, total: 100, participants: 10 }, // Ideal
        { messages: 25, total: 100, participants: 10 }, // Over-posting
        { messages: 50, total: 100, participants: 10 }, // Spam
      ];

      for (const scenario of scenarios) {
        const userProb = NPCGroupDynamicsService.calculateKickProbability(
          scenario.messages,
          scenario.total,
          scenario.participants,
          7
        );
        const agentProb = NPCGroupDynamicsService.calculateKickProbability(
          scenario.messages,
          scenario.total,
          scenario.participants,
          7
        );

        expect(userProb.probability).toBe(agentProb.probability);
        expect(userProb.category).toBe(agentProb.category);
      }
    });
  });

  describe('Group Chat Sweep Mechanics', () => {
    beforeEach(async () => {
      await cleanupTestData();
    });

    afterEach(async () => {
      await cleanupTestData();
    });

    test('should calculate kick chance based on user activity', async () => {
      const npc = await createTestNPC('Sweep Test NPC');
      const inactiveUser = await createTestUser({
        displayName: 'Inactive User',
      });
      const activeUser = await createTestUser({ displayName: 'Active User' });

      const { chatId, groupId } = await createGroupChat(
        'Activity Test Group',
        npc.id
      );

      // Add participant records
      const inactiveParticipantId = await generateSnowflakeId();
      await db.chatParticipant.create({
        data: {
          id: inactiveParticipantId,
          chatId,
          userId: inactiveUser.id,
          isActive: true,
          invitedBy: npc.id,
        },
      });
      testIds.participantIds.push(inactiveParticipantId);

      const activeParticipantId = await generateSnowflakeId();
      await db.chatParticipant.create({
        data: {
          id: activeParticipantId,
          chatId,
          userId: activeUser.id,
          isActive: true,
          invitedBy: npc.id,
        },
      });
      testIds.participantIds.push(activeParticipantId);

      // Create memberships - joinedAt needs to be > 24 hours ago for kick logic to apply
      // INACTIVITY_GRACE_PERIOD_TICKS = 1440 minutes = 24 hours
      const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);

      // For inactive user: create membership directly with old joinedAt
      const inactiveMembershipId = await generateSnowflakeId();
      await db.groupMember.create({
        data: {
          id: inactiveMembershipId,
          groupId,
          userId: inactiveUser.id,
          role: 'member',
          addedBy: npc.id,
          isActive: true,
          joinedAt: twoDaysAgo,
        },
      });
      testIds.membershipIds.push(inactiveMembershipId);

      // For active user: create membership with old joinedAt too
      const activeMembershipId = await generateSnowflakeId();
      await db.groupMember.create({
        data: {
          id: activeMembershipId,
          groupId,
          userId: activeUser.id,
          role: 'member',
          addedBy: npc.id,
          isActive: true,
          joinedAt: twoDaysAgo,
        },
      });
      testIds.membershipIds.push(activeMembershipId);

      // Active user posts messages
      await createMessage({
        chatId,
        senderId: activeUser.id,
        content: 'Hello everyone!',
      });
      await createMessage({
        chatId,
        senderId: activeUser.id,
        content: 'Great insights here',
      });

      // NPC posts
      await createMessage({
        chatId,
        senderId: npc.id,
        content: 'Welcome to the group!',
      });

      // Calculate kick chances
      const inactiveDecision = await GroupChatService.calculateKickChance(
        inactiveUser.id,
        chatId
      );
      const activeDecision = await GroupChatService.calculateKickChance(
        activeUser.id,
        chatId
      );

      // Verify the stats are collected correctly
      expect(inactiveDecision.stats.totalMessages).toBe(0);
      expect(activeDecision.stats.totalMessages).toBe(2);

      // Inactive user should have higher kick chance since they haven't posted
      // (after grace period of 24 hours has passed)
      expect(inactiveDecision.kickChance).toBeGreaterThan(
        activeDecision.kickChance
      );
    });
  });

  describe('Group Statistics', () => {
    test('should return valid group statistics', async () => {
      const stats = await NPCGroupDynamicsService.getGroupStats();

      expect(stats).toHaveProperty('totalGroups');
      expect(stats).toHaveProperty('activeGroups');
      expect(stats).toHaveProperty('avgGroupSize');
      expect(typeof stats.totalGroups).toBe('number');
      expect(typeof stats.activeGroups).toBe('number');
      expect(typeof stats.avgGroupSize).toBe('number');
      expect(stats.totalGroups).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Edge Cases', () => {
    test('should handle brand new group with no messages', () => {
      const result = NPCGroupDynamicsService.calculateKickProbability(
        0, // No messages
        0, // Empty group
        5, // 5 participants
        7
      );

      // Still inactive since user hasn't contributed
      expect(result.category).toBe('inactive');
      expect(result.probability).toBeGreaterThanOrEqual(0);
      expect(result.probability).toBeLessThanOrEqual(1);
    });

    test('should never return probability outside 0-1 range', () => {
      const extremeCases = [
        { messages: 0, total: 0, participants: 1 },
        { messages: 1000, total: 10, participants: 5 },
        { messages: 1, total: 10000, participants: 100 },
        { messages: 50, total: 50, participants: 1 },
      ];

      for (const scenario of extremeCases) {
        const result = NPCGroupDynamicsService.calculateKickProbability(
          scenario.messages,
          scenario.total,
          scenario.participants,
          7
        );

        expect(result.probability).toBeGreaterThanOrEqual(0);
        expect(result.probability).toBeLessThanOrEqual(1);
      }
    });
  });

  describe('Quality Score Management', () => {
    beforeEach(async () => {
      await cleanupTestData();
    });

    afterEach(async () => {
      await cleanupTestData();
    });

    test('should update quality score when message is sent', async () => {
      const npc = await createTestNPC('Quality Test NPC');
      const user = await createTestUser({ displayName: 'Quality User' });

      const { chatId, groupId } = await createGroupChat(
        'Quality Test Group',
        npc.id
      );

      // Create membership
      const membershipId = await generateSnowflakeId();
      await db.groupMember.create({
        data: {
          id: membershipId,
          groupId,
          userId: user.id,
          role: 'member',
          addedBy: npc.id,
          isActive: true,
          qualityScore: 1.0, // Start at 1.0
          messageCount: 0,
        },
      });
      testIds.membershipIds.push(membershipId);

      // Update quality score for a message
      await GroupChatService.updateQualityScore(user.id, chatId, 0.8);

      // Verify the score was updated
      const membership = await db.groupMember.findFirst({
        where: { userId: user.id, groupId },
      });

      expect(membership).not.toBeNull();
      expect(membership?.messageCount).toBe(1);
      // First message with 0.8 quality: (1.0 * 0 + 0.8) / 1 = 0.8
      expect(membership?.qualityScore).toBeCloseTo(0.8, 1);
    });

    test('should calculate running average quality score', async () => {
      const npc = await createTestNPC('Avg Quality NPC');
      const user = await createTestUser({ displayName: 'Avg Quality User' });

      const { chatId, groupId } = await createGroupChat(
        'Avg Quality Group',
        npc.id
      );

      // Create membership with some existing messages
      const membershipId = await generateSnowflakeId();
      await db.groupMember.create({
        data: {
          id: membershipId,
          groupId,
          userId: user.id,
          role: 'member',
          addedBy: npc.id,
          isActive: true,
          qualityScore: 0.8, // Existing average
          messageCount: 4, // 4 prior messages
        },
      });
      testIds.membershipIds.push(membershipId);

      // Add a new message with 1.0 quality
      await GroupChatService.updateQualityScore(user.id, chatId, 1.0);

      // Verify running average: (0.8 * 4 + 1.0) / 5 = 4.2 / 5 = 0.84
      const membership = await db.groupMember.findFirst({
        where: { userId: user.id, groupId },
      });

      expect(membership?.messageCount).toBe(5);
      expect(membership?.qualityScore).toBeCloseTo(0.84, 2);
    });
  });

  describe('Group Chat Invite Criteria', () => {
    beforeEach(async () => {
      await cleanupTestData();
    });

    afterEach(async () => {
      await cleanupTestData();
    });

    test('should require minimum engagement score for invite eligibility', async () => {
      const npc = await createTestNPC('Criteria Test NPC');
      const lowEngagedUser = await createTestUser({
        displayName: 'Low Engaged',
      });

      // Create minimal engagement (below threshold)
      const post = await createNPCPost(npc.id, 'Test post');
      await createLike(lowEngagedUser.id, post);

      // Calculate engagement - should be below MIN_ENGAGEMENT_SCORE (40)
      const engagement = await NPCInteractionTracker.calculateEngagementScore(
        lowEngagedUser.id,
        npc.id
      );

      // Low engagement users shouldn't be eligible
      expect(engagement.engagementScore).toBeLessThan(40);
      expect(engagement.isEligibleForInvite).toBe(false);
    });

    test('should track invite eligibility reasons', async () => {
      const npc = await createTestNPC('Reasons Test NPC');
      const user = await createTestUser({ displayName: 'Reasons User' });

      // Create some engagement but not enough
      const post = await createNPCPost(npc.id, 'Test content');
      await createLike(user.id, post);

      const engagement = await NPCInteractionTracker.calculateEngagementScore(
        user.id,
        npc.id
      );

      // Should have reasons explaining why not eligible
      expect(engagement.eligibilityReasons).toBeDefined();
      expect(Array.isArray(engagement.eligibilityReasons)).toBe(true);
    });
  });

  describe('Database Constraints', () => {
    beforeEach(async () => {
      await cleanupTestData();
    });

    afterEach(async () => {
      await cleanupTestData();
    });

    test('should enforce unique membership per user per group', async () => {
      const npc = await createTestNPC('Unique Constraint NPC');
      const user = await createTestUser({ displayName: 'Unique User' });

      const { groupId } = await createGroupChat('Unique Test Group', npc.id);

      // Create first membership
      const membershipId1 = await generateSnowflakeId();
      await db.groupMember.create({
        data: {
          id: membershipId1,
          groupId,
          userId: user.id,
          role: 'member',
          addedBy: npc.id,
          isActive: true,
        },
      });
      testIds.membershipIds.push(membershipId1);

      // Attempt to create duplicate should fail
      const membershipId2 = await generateSnowflakeId();
      let duplicateError = false;
      try {
        await db.groupMember.create({
          data: {
            id: membershipId2,
            groupId,
            userId: user.id, // Same user
            role: 'member',
            addedBy: npc.id,
            isActive: true,
          },
        });
      } catch {
        duplicateError = true;
      }

      expect(duplicateError).toBe(true);
    });

    test('should allow same user in different groups', async () => {
      const npc1 = await createTestNPC('Multi Chat NPC 1');
      const npc2 = await createTestNPC('Multi Chat NPC 2');
      const user = await createTestUser({ displayName: 'Multi Chat User' });

      const { groupId: groupId1 } = await createGroupChat('Chat 1', npc1.id);
      const { groupId: groupId2 } = await createGroupChat('Chat 2', npc2.id);

      // Add to first group
      await createGroupMembership({
        groupId: groupId1,
        userId: user.id,
        addedBy: npc1.id,
      });

      // Add to second group (different group, should work)
      await createGroupMembership({
        groupId: groupId2,
        userId: user.id,
        addedBy: npc2.id,
      });

      // Count should be 2
      const membershipCount = await db.groupMember.count({
        where: { userId: user.id, isActive: true },
      });

      expect(membershipCount).toBe(2);
    });
  });
});
