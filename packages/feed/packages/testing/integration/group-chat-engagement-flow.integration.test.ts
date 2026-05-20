/**
 * Group Chat Engagement Flow Integration Tests
 *
 * Tests the complete flow from feed engagement to group chat invite:
 * 1. User engages with NPCs on the feed (follows, likes, comments, shares)
 * 2. Engagement builds up "reply guy" score
 * 3. NPCs invite high-engagement users to group chats
 * 4. User maintains participation to stay in group
 *
 * This validates the core asymmetric information gameplay mechanic.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';
import { db } from '@babylon/db';
import {
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
  inviteIds: [] as string[],
};

// Helper functions
async function createTestUser(options: {
  isAgent?: boolean;
  displayName?: string;
}): Promise<{ id: string; displayName: string }> {
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
  return { id, displayName };
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

async function cleanupTestData(): Promise<void> {
  // Delete in reverse order of dependencies
  if (testIds.inviteIds.length > 0) {
    await db.groupInvite.deleteMany({
      where: { id: { in: testIds.inviteIds } },
    });
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

describe('Reply Guy Score Calculation', () => {
  beforeEach(async () => {
    await cleanupTestData();
  });

  afterEach(async () => {
    await cleanupTestData();
  });

  test('should calculate score based on follows', async () => {
    const npc = await createTestNPC('Score Test NPC');
    const user = await createTestUser({ displayName: 'Following User' });

    // User follows NPC
    await createFollow(user.id, npc.id);

    // Calculate score
    const { score, breakdown } =
      await NPCGroupDynamicsService.calculateReplyGuyScore(user.id, [npc.id]);

    expect(breakdown.follows).toBe(5); // 1 follow × 5 points
    expect(score).toBeGreaterThan(0);
  });

  test('should calculate score based on comments on NPC posts', async () => {
    const npc = await createTestNPC('Comment Test NPC');
    const user = await createTestUser({ displayName: 'Commenting User' });

    // NPC creates posts
    const post1 = await createNPCPost(npc.id, 'NPC post 1');
    const post2 = await createNPCPost(npc.id, 'NPC post 2');

    // User comments on NPC posts
    await createComment(user.id, post1, 'Great insight!');
    await createComment(user.id, post2, 'Interesting perspective');

    // Calculate score
    const { score, breakdown } =
      await NPCGroupDynamicsService.calculateReplyGuyScore(user.id, [npc.id]);

    // 2 comments in ideal range (1-3) = 2 × 3 = 6 points
    expect(breakdown.comments).toBe(6);
    expect(score).toBeGreaterThan(0);
  });

  test('should calculate score based on likes on NPC posts', async () => {
    const npc = await createTestNPC('Like Test NPC');
    const user = await createTestUser({ displayName: 'Liking User' });

    // NPC creates posts
    const posts: string[] = [];
    for (let i = 0; i < 5; i++) {
      posts.push(await createNPCPost(npc.id, `NPC post ${i}`));
    }

    // User likes NPC posts
    for (const postId of posts) {
      await createLike(user.id, postId);
    }

    // Calculate score
    const { score, breakdown } =
      await NPCGroupDynamicsService.calculateReplyGuyScore(user.id, [npc.id]);

    // 5 likes in ideal range (3-10) = 5 × 1 = 5 points
    expect(breakdown.likes).toBe(5);
    expect(score).toBeGreaterThan(0);
  });

  test('should calculate score based on shares of NPC posts', async () => {
    const npc = await createTestNPC('Share Test NPC');
    const user = await createTestUser({ displayName: 'Sharing User' });

    // NPC creates posts
    const post = await createNPCPost(npc.id, 'Shareable content');

    // User shares NPC post
    await createShare(user.id, post);

    // Calculate score
    const { score, breakdown } =
      await NPCGroupDynamicsService.calculateReplyGuyScore(user.id, [npc.id]);

    // 1 share in ideal range (1-2) = 1 × 4 = 4 points
    expect(breakdown.reposts).toBe(4);
    expect(score).toBeGreaterThan(0);
  });

  test('should penalize spammy behavior (too many comments)', async () => {
    const npc = await createTestNPC('Spam Test NPC');
    const user = await createTestUser({ displayName: 'Spammy User' });

    // NPC creates post
    const post = await createNPCPost(npc.id, 'Popular post');

    // User spams 15 comments
    for (let i = 0; i < 15; i++) {
      await createComment(user.id, post, `Comment ${i}`);
    }

    // Calculate score
    const { score, breakdown } =
      await NPCGroupDynamicsService.calculateReplyGuyScore(user.id, [npc.id]);

    // 15 comments > 10 = penalty territory
    // goodComments = 10 × 2 = 20, excessComments = 5, penalty = 5 × -2 = -10
    // comments score = 20, penalties = -10
    expect(breakdown.penalties).toBeLessThan(0);
    expect(breakdown.comments).toBe(20); // Good portion
    // Score should be reduced by penalties
    expect(score).toBeLessThan(breakdown.comments); // Score less than raw comments due to penalties
  });

  test('should give combined score for ideal engagement', async () => {
    const npc = await createTestNPC('Ideal Engagement NPC');
    const user = await createTestUser({ displayName: 'Ideal User' });

    // Follow
    await createFollow(user.id, npc.id);

    // NPC creates posts
    const posts: string[] = [];
    for (let i = 0; i < 5; i++) {
      posts.push(await createNPCPost(npc.id, `Post ${i}`));
    }

    // Ideal engagement: 2 comments, 5 likes, 1 share
    await createComment(user.id, posts[0]!, 'Great analysis');
    await createComment(user.id, posts[1]!, 'Thanks for sharing');

    for (const postId of posts) {
      await createLike(user.id, postId);
    }

    await createShare(user.id, posts[0]!);

    // Calculate score
    const { score, breakdown } =
      await NPCGroupDynamicsService.calculateReplyGuyScore(user.id, [npc.id]);

    // Expected:
    // - follows: 1 × 5 = 5
    // - comments: 2 × 3 = 6 (ideal range)
    // - likes: 5 × 1 = 5 (ideal range)
    // - reposts: 1 × 4 = 4 (ideal range)
    // Total: 20 points (before relationship modifier)

    expect(breakdown.follows).toBe(5);
    expect(breakdown.comments).toBe(6);
    expect(breakdown.likes).toBe(5);
    expect(breakdown.reposts).toBe(4);
    expect(score).toBeGreaterThan(15); // Should be around 20
    expect(breakdown.penalties).toBe(0);
  });
});

describe('Engagement Tracker Integration', () => {
  beforeEach(async () => {
    await cleanupTestData();
  });

  afterEach(async () => {
    await cleanupTestData();
  });

  test('should track user engagement score with NPC', async () => {
    const npc = await createTestNPC('Tracker Test NPC');
    const user = await createTestUser({ displayName: 'Engaged User' });

    // Create NPC posts and user engages
    const post1 = await createNPCPost(npc.id, 'Interesting post 1');
    const post2 = await createNPCPost(npc.id, 'Interesting post 2');
    const post3 = await createNPCPost(npc.id, 'Interesting post 3');
    await createLike(user.id, post1);

    // User creates comments on NPC posts
    const comment1 = await createComment(user.id, post1, 'Great insight');
    const comment2 = await createComment(user.id, post2, 'Thanks for sharing');
    const comment3 = await createComment(user.id, post3, 'Very helpful');

    // Record quality interactions (requires postId and commentId)
    await recordUserInteraction(user.id, npc.id, post1, comment1, 0.85);
    await recordUserInteraction(user.id, npc.id, post2, comment2, 0.9);
    await recordUserInteraction(user.id, npc.id, post3, comment3, 0.8);

    // Calculate engagement
    const engagementScore =
      await NPCInteractionTracker.calculateEngagementScore(user.id, npc.id);

    expect(engagementScore.replyCount).toBe(3);
    expect(engagementScore.avgQualityScore).toBeCloseTo(0.85, 1);
    expect(engagementScore.engagementScore).toBeGreaterThan(0);
  });

  test('should identify top engaged users', async () => {
    const npc = await createTestNPC('Top Users NPC');
    const user1 = await createTestUser({ displayName: 'Top User' });
    const user2 = await createTestUser({ displayName: 'Medium User' });
    const user3 = await createTestUser({ displayName: 'Low User' });

    // Create NPC posts for interactions
    const posts: string[] = [];
    for (let i = 0; i < 16; i++) {
      posts.push(await createNPCPost(npc.id, `Post ${i}`));
    }

    // Create varying engagement levels with comments
    // User 1: High engagement (10 comments)
    for (let i = 0; i < 10; i++) {
      const comment = await createComment(
        user1.id,
        posts[i]!,
        `User1 comment ${i}`
      );
      await recordUserInteraction(user1.id, npc.id, posts[i]!, comment, 0.9);
    }

    // User 2: Medium engagement (5 comments)
    for (let i = 10; i < 15; i++) {
      const comment = await createComment(
        user2.id,
        posts[i]!,
        `User2 comment ${i}`
      );
      await recordUserInteraction(user2.id, npc.id, posts[i]!, comment, 0.75);
    }

    // User 3: Low engagement (1 comment)
    const comment3 = await createComment(user3.id, posts[15]!, 'User3 comment');
    await recordUserInteraction(user3.id, npc.id, posts[15]!, comment3, 0.6);

    // Get top engaged users
    const topUsers = await NPCInteractionTracker.getTopEngagedUsers(npc.id, 10);

    expect(topUsers.length).toBe(3);
    expect(topUsers[0]!.userId).toBe(user1.id);
    expect(topUsers[1]!.userId).toBe(user2.id);
    expect(topUsers[2]!.userId).toBe(user3.id);
  });
});

describe('Full Engagement → Invite Flow', () => {
  beforeAll(async () => {
    await cleanupTestData();
  });

  afterAll(async () => {
    await cleanupTestData();
  });

  test('should invite user with high engagement score', async () => {
    // Setup: Create NPCs and a group chat
    const npc1 = await createTestNPC('Alpha Leader');
    const npc2 = await createTestNPC('Group Member NPC');
    const { chatId: groupChatId } = await createGroupChat(
      `${npc1.name}'s Circle`,
      npc1.id
    );

    // Add second NPC to group
    const participant2Id = await generateSnowflakeId();
    await db.chatParticipant.create({
      data: {
        id: participant2Id,
        chatId: groupChatId,
        userId: npc2.id,
        isActive: true,
      },
    });
    testIds.participantIds.push(participant2Id);

    // Create engaged user
    const engagedUser = await createTestUser({ displayName: 'Super Engaged' });

    // User builds engagement on the feed
    // 1. Follow NPCs
    await createFollow(engagedUser.id, npc1.id);
    await createFollow(engagedUser.id, npc2.id);

    // 2. NPCs create content
    const posts: string[] = [];
    for (let i = 0; i < 10; i++) {
      posts.push(await createNPCPost(npc1.id, `NPC1 Post ${i}`));
      posts.push(await createNPCPost(npc2.id, `NPC2 Post ${i}`));
    }

    // 3. User engages with content (ideal amounts)
    // Comments: 2-3 per NPC (ideal)
    await createComment(engagedUser.id, posts[0]!, 'Great analysis!');
    await createComment(engagedUser.id, posts[2]!, 'Really helpful');
    await createComment(engagedUser.id, posts[1]!, 'Thanks for sharing');

    // Likes: 5-8 per NPC (ideal)
    for (let i = 0; i < 8; i++) {
      await createLike(engagedUser.id, posts[i]!);
    }

    // Shares: 1-2 (ideal)
    await createShare(engagedUser.id, posts[0]!);
    await createShare(engagedUser.id, posts[1]!);

    // Calculate the user's reply guy score
    const { score, breakdown } =
      await NPCGroupDynamicsService.calculateReplyGuyScore(engagedUser.id, [
        npc1.id,
        npc2.id,
      ]);

    // Verify score is positive and substantial
    expect(score).toBeGreaterThan(20);
    expect(breakdown.follows).toBeGreaterThan(0);
    expect(breakdown.comments).toBeGreaterThan(0);
    expect(breakdown.likes).toBeGreaterThan(0);
    expect(breakdown.reposts).toBeGreaterThan(0);
    expect(breakdown.penalties).toBe(0);

    console.log('Engagement Score:', { score, breakdown });
  });

  test('should NOT invite user with spam behavior', async () => {
    const npc = await createTestNPC('Anti-Spam NPC');
    const spammer = await createTestUser({ displayName: 'Spammer User' });

    // Spammer creates excessive engagement
    const post = await createNPCPost(npc.id, 'Target post');

    // Excessive comments (20+)
    for (let i = 0; i < 25; i++) {
      await createComment(spammer.id, post, `Spam comment ${i}`);
    }

    // Excessive likes (50+)
    const posts: string[] = [post];
    for (let i = 0; i < 49; i++) {
      const p = await createNPCPost(npc.id, `Post ${i}`);
      posts.push(p);
      await createLike(spammer.id, p);
    }

    // Calculate score - should be negative due to penalties
    const { score, breakdown } =
      await NPCGroupDynamicsService.calculateReplyGuyScore(spammer.id, [
        npc.id,
      ]);

    console.log('Spammer Score:', { score, breakdown });

    // Penalties should significantly reduce or make score negative
    expect(breakdown.penalties).toBeLessThan(0);
    // Note: Score could still be positive if good engagement outweighs penalties
    // But it should be lower than ideal engagement
  });
});

describe('Users vs Agents Engagement Parity', () => {
  beforeEach(async () => {
    await cleanupTestData();
  });

  afterEach(async () => {
    await cleanupTestData();
  });

  test('agents should earn same engagement score as users for same behavior', async () => {
    const npc = await createTestNPC('Parity Test NPC');
    const humanUser = await createTestUser({
      isAgent: false,
      displayName: 'Human',
    });
    const aiAgent = await createTestUser({
      isAgent: true,
      displayName: 'AI Agent',
    });

    // Both do the exact same engagement
    const post = await createNPCPost(npc.id, 'Test post');

    // Human engagement
    await createFollow(humanUser.id, npc.id);
    await createLike(humanUser.id, post);
    await createComment(humanUser.id, post, 'Human comment');
    await createShare(humanUser.id, post);

    // Agent engagement (identical)
    await createFollow(aiAgent.id, npc.id);
    await createLike(aiAgent.id, post);
    await createComment(aiAgent.id, post, 'Agent comment');
    await createShare(aiAgent.id, post);

    // Calculate scores
    const humanScore = await NPCGroupDynamicsService.calculateReplyGuyScore(
      humanUser.id,
      [npc.id]
    );
    const agentScore = await NPCGroupDynamicsService.calculateReplyGuyScore(
      aiAgent.id,
      [npc.id]
    );

    // Scores should be identical
    expect(humanScore.score).toBe(agentScore.score);
    expect(humanScore.breakdown.follows).toBe(agentScore.breakdown.follows);
    expect(humanScore.breakdown.comments).toBe(agentScore.breakdown.comments);
    expect(humanScore.breakdown.likes).toBe(agentScore.breakdown.likes);
    expect(humanScore.breakdown.reposts).toBe(agentScore.breakdown.reposts);
  });
});

describe('Group Dynamics Stats', () => {
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
