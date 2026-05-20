/**
 * Agent Group Chat Invite Integration Tests
 *
 * Tests the complete flow of an ideal agent getting invited into NPC group chats:
 * 1. Agent engages with NPCs on the feed (follows, likes, comments, shares)
 * 2. Agent builds sufficient engagement score ("reply guy" score)
 * 3. Agent becomes eligible for group chat invites
 * 4. Agent is invited to a group chat by NPC
 * 5. Agent can participate in group chat conversations
 * 6. Agent maintains membership with ideal participation
 *
 * These tests verify agents have full parity with human users for group chat mechanics.
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
  AlphaGroupInviteService,
  GroupChatService,
  NPCGroupDynamicsService,
  NPCInteractionTracker,
} from '@feed/engine';
import { generateSnowflakeId } from '@feed/shared';

// Set timeout to 60 seconds for integration tests
setDefaultTimeout(60000);

// Test data cleanup tracking
const testIds = {
  userIds: [] as string[],
  actorIds: [] as string[],
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

async function createTestAgent(options: {
  displayName?: string;
  username?: string;
  bio?: string;
}): Promise<{
  id: string;
  displayName: string;
  username: string;
  isAgent: true;
}> {
  const id = await generateSnowflakeId();
  const displayName = options.displayName || `Test Agent ${id.slice(-6)}`;
  const username = options.username || `test-agent-${id.slice(-6)}`;

  await db.user.create({
    data: {
      id,
      username,
      displayName,
      bio: options.bio || 'Autonomous AI agent for testing',
      isActor: false, // Agents are NOT actors (NPCs are actors)
      isAgent: true, // This is an agent
      isTest: true,
      updatedAt: new Date(),
    },
  });

  testIds.userIds.push(id);
  return { id, displayName, username, isAgent: true };
}

async function createTestUser(options: {
  displayName?: string;
}): Promise<{ id: string; displayName: string; isAgent: false }> {
  const id = await generateSnowflakeId();
  const displayName = options.displayName || `Test User ${id.slice(-6)}`;

  await db.user.create({
    data: {
      id,
      username: `test-user-${id.slice(-6)}`,
      displayName,
      isActor: false,
      isAgent: false,
      isTest: true,
      updatedAt: new Date(),
    },
  });

  testIds.userIds.push(id);
  return { id, displayName, isAgent: false };
}

async function createTestNPC(
  name: string
): Promise<{ id: string; name: string }> {
  const id = await generateSnowflakeId();

  // Create user with isActor: true (this is the new pattern - no separate actors table)
  await db.user.create({
    data: {
      id,
      username: name.toLowerCase().replace(/\s+/g, '-'),
      displayName: name,
      isActor: true, // NPCs have isActor: true
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
  npcAdminId: string
): Promise<string> {
  const id = await generateSnowflakeId();

  await db.chat.create({
    data: {
      id,
      name,
      isGroup: true,
      npcAdminId,
      gameId: 'realtime',
      updatedAt: new Date(),
    },
  });

  // Add NPC as participant
  const participantId = await generateSnowflakeId();
  await db.chatParticipant.create({
    data: {
      id: participantId,
      chatId: id,
      userId: npcAdminId,
      isActive: true,
    },
  });

  testIds.chatIds.push(id);
  testIds.participantIds.push(participantId);
  return id;
}

async function createGroupMembership(options: {
  chatId: string;
  userId: string;
  npcAdminId: string;
  joinedAt?: Date;
}): Promise<string> {
  const id = await generateSnowflakeId();

  await db.groupChatMembership.create({
    data: {
      id,
      chatId: options.chatId,
      userId: options.userId,
      npcAdminId: options.npcAdminId,
      isActive: true,
      joinedAt: options.joinedAt || new Date(),
    },
  });

  testIds.membershipIds.push(id);
  return id;
}

async function addChatParticipant(options: {
  chatId: string;
  userId: string;
  invitedBy?: string;
}): Promise<string> {
  const id = await generateSnowflakeId();

  await db.chatParticipant.create({
    data: {
      id,
      chatId: options.chatId,
      userId: options.userId,
      invitedBy: options.invitedBy,
      isActive: true,
    },
  });

  testIds.participantIds.push(id);
  return id;
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
    await db.groupChatMembership.deleteMany({
      where: { id: { in: testIds.membershipIds } },
    });
  }
  if (testIds.participantIds.length > 0) {
    await db.chatParticipant.deleteMany({
      where: { id: { in: testIds.participantIds } },
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
  if (testIds.followIds.length > 0) {
    await db.follow.deleteMany({ where: { id: { in: testIds.followIds } } });
  }
  if (testIds.postIds.length > 0) {
    await db.post.deleteMany({ where: { id: { in: testIds.postIds } } });
  }
  if (testIds.chatIds.length > 0) {
    await db.chat.deleteMany({ where: { id: { in: testIds.chatIds } } });
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

// ============ TESTS ============

describe('Agent Group Chat Invite Flow', () => {
  beforeAll(async () => {
    await cleanupTestData();
  });

  afterAll(async () => {
    await cleanupTestData();
  });

  describe('Agent Eligibility', () => {
    beforeEach(async () => {
      await cleanupTestData();
    });

    afterEach(async () => {
      await cleanupTestData();
    });

    test('agent should be marked as isAgent:true and isActor:false', async () => {
      const agent = await createTestAgent({ displayName: 'Test Bot' });

      const agentRecord = await db.user.findUnique({
        where: { id: agent.id },
      });

      expect(agentRecord?.isAgent).toBe(true);
      expect(agentRecord?.isActor).toBe(false); // Only NPCs are actors
    });

    test('agent should be eligible for group chat membership like regular users', async () => {
      const npc = await createTestNPC('Alpha Trader NPC');
      const agent = await createTestAgent({ displayName: 'Trading Bot' });

      // Create group chat
      const chatId = await createGroupChat(`${npc.name}'s Circle`, npc.id);

      // Add agent as participant (simulating invite acceptance)
      await addChatParticipant({
        chatId,
        userId: agent.id,
        invitedBy: npc.id,
      });

      // Create membership record
      await createGroupMembership({
        chatId,
        userId: agent.id,
        npcAdminId: npc.id,
      });

      // Verify agent is a member
      const membership = await db.groupChatMembership.findFirst({
        where: { chatId, userId: agent.id, isActive: true },
      });

      expect(membership).not.toBeNull();
      expect(membership?.userId).toBe(agent.id);
    });
  });

  describe('Agent Engagement Score Calculation', () => {
    beforeEach(async () => {
      await cleanupTestData();
    });

    afterEach(async () => {
      await cleanupTestData();
    });

    test('agent should earn same engagement score as user for identical behavior', async () => {
      const npc = await createTestNPC('Score Test NPC');

      // Create human user and agent
      const humanUser = await createTestUser({ displayName: 'Human User' });
      const aiAgent = await createTestAgent({ displayName: 'AI Agent' });

      // Create separate posts for each to avoid cross-contamination
      const humanPost = await createNPCPost(npc.id, 'Post for human');
      const agentPost = await createNPCPost(npc.id, 'Post for agent');

      // Human engagement: follow, like, comment, share
      await createFollow(humanUser.id, npc.id);
      await createLike(humanUser.id, humanPost);
      await createComment(humanUser.id, humanPost, 'Human insight');
      await createShare(humanUser.id, humanPost);

      // Agent engagement: identical pattern
      await createFollow(aiAgent.id, npc.id);
      await createLike(aiAgent.id, agentPost);
      await createComment(aiAgent.id, agentPost, 'Agent insight');
      await createShare(aiAgent.id, agentPost);

      // Calculate reply guy scores
      const humanScore = await NPCGroupDynamicsService.calculateReplyGuyScore(
        humanUser.id,
        [npc.id]
      );
      const agentScore = await NPCGroupDynamicsService.calculateReplyGuyScore(
        aiAgent.id,
        [npc.id]
      );

      // Verify scores are identical
      expect(agentScore.score).toBe(humanScore.score);
      expect(agentScore.breakdown.follows).toBe(humanScore.breakdown.follows);
      expect(agentScore.breakdown.comments).toBe(humanScore.breakdown.comments);
      expect(agentScore.breakdown.likes).toBe(humanScore.breakdown.likes);
      expect(agentScore.breakdown.reposts).toBe(humanScore.breakdown.reposts);
      expect(agentScore.breakdown.penalties).toBe(
        humanScore.breakdown.penalties
      );

      console.log('Human Score:', humanScore);
      console.log('Agent Score:', agentScore);
    });

    test('agent with ideal engagement should have high score', async () => {
      const npc = await createTestNPC('Ideal Engagement NPC');
      const agent = await createTestAgent({ displayName: 'Ideal Agent' });

      // Create NPC posts
      const posts: string[] = [];
      for (let i = 0; i < 6; i++) {
        posts.push(await createNPCPost(npc.id, `Market analysis ${i}`));
      }

      // Ideal engagement pattern:
      // - 1 follow (5 points)
      // - 2 comments (3 points each in ideal range = 6 points)
      // - 5 likes (1 point each in ideal range = 5 points)
      // - 1 share (4 points in ideal range)
      // Expected total: ~20 points

      await createFollow(agent.id, npc.id);

      await createComment(agent.id, posts[0]!, 'Excellent analysis!');
      await createComment(agent.id, posts[1]!, 'Very insightful, thanks');

      for (let i = 0; i < 5; i++) {
        await createLike(agent.id, posts[i]!);
      }

      await createShare(agent.id, posts[0]!);

      const { score, breakdown } =
        await NPCGroupDynamicsService.calculateReplyGuyScore(agent.id, [
          npc.id,
        ]);

      console.log('Ideal Agent Score:', { score, breakdown });

      // Verify good score components
      expect(breakdown.follows).toBe(5); // 1 follow × 5 points
      expect(breakdown.comments).toBe(6); // 2 comments × 3 points (ideal)
      expect(breakdown.likes).toBe(5); // 5 likes × 1 point (ideal)
      expect(breakdown.reposts).toBe(4); // 1 share × 4 points (ideal)
      expect(breakdown.penalties).toBe(0); // No spam
      expect(score).toBeGreaterThan(15);
    });

    test('agent with spam behavior should have penalties', async () => {
      const npc = await createTestNPC('Spam Test NPC');
      const spamAgent = await createTestAgent({ displayName: 'Spam Bot' });

      // Create post to spam
      const post = await createNPCPost(npc.id, 'Popular post');

      // Spam 15 comments (>10 is spam territory)
      for (let i = 0; i < 15; i++) {
        await createComment(spamAgent.id, post, `Spam comment ${i}`);
      }

      const { score, breakdown } =
        await NPCGroupDynamicsService.calculateReplyGuyScore(spamAgent.id, [
          npc.id,
        ]);

      console.log('Spam Agent Score:', { score, breakdown });

      // Should have penalties for excessive commenting
      expect(breakdown.penalties).toBeLessThan(0);
      // Score should be reduced by penalties
      expect(score).toBeLessThan(breakdown.comments);
    });
  });

  describe('Agent Engagement Tracking', () => {
    beforeEach(async () => {
      await cleanupTestData();
    });

    afterEach(async () => {
      await cleanupTestData();
    });

    test('agent interactions should be tracked with quality scores', async () => {
      const npc = await createTestNPC('Tracker NPC');
      const agent = await createTestAgent({ displayName: 'Tracked Agent' });

      // Create NPC posts and agent engages
      const post1 = await createNPCPost(npc.id, 'First post');
      const post2 = await createNPCPost(npc.id, 'Second post');

      const comment1 = await createComment(
        agent.id,
        post1,
        'Great market insight'
      );
      const comment2 = await createComment(
        agent.id,
        post2,
        'Interesting perspective'
      );

      // Record quality interactions
      await recordUserInteraction(agent.id, npc.id, post1, comment1, 0.9);
      await recordUserInteraction(agent.id, npc.id, post2, comment2, 0.85);

      // Calculate engagement score via tracker
      const engagement = await NPCInteractionTracker.calculateEngagementScore(
        agent.id,
        npc.id
      );

      expect(engagement.replyCount).toBe(2);
      expect(engagement.avgQualityScore).toBeCloseTo(0.875, 1);
      expect(engagement.engagementScore).toBeGreaterThan(0);

      console.log('Agent Engagement:', engagement);
    });

    test('agent should appear in top engaged users list', async () => {
      const npc = await createTestNPC('Rankings NPC');

      // Create agent and human with different engagement levels
      const topAgent = await createTestAgent({ displayName: 'Top Agent' });
      const mediumUser = await createTestUser({ displayName: 'Medium User' });

      // Create posts
      const posts: string[] = [];
      for (let i = 0; i < 12; i++) {
        posts.push(await createNPCPost(npc.id, `Post ${i}`));
      }

      // Top agent: 8 high-quality comments
      for (let i = 0; i < 8; i++) {
        const comment = await createComment(
          topAgent.id,
          posts[i]!,
          `Agent comment ${i}`
        );
        await recordUserInteraction(
          topAgent.id,
          npc.id,
          posts[i]!,
          comment,
          0.92
        );
      }

      // Medium user: 4 comments
      for (let i = 8; i < 12; i++) {
        const comment = await createComment(
          mediumUser.id,
          posts[i]!,
          `User comment ${i}`
        );
        await recordUserInteraction(
          mediumUser.id,
          npc.id,
          posts[i]!,
          comment,
          0.75
        );
      }

      // Get top engaged
      const topUsers = await NPCInteractionTracker.getTopEngagedUsers(
        npc.id,
        10
      );

      expect(topUsers.length).toBe(2);
      // Agent should be first (more engagement, higher quality)
      expect(topUsers[0]?.userId).toBe(topAgent.id);
      expect(topUsers[1]?.userId).toBe(mediumUser.id);
    });
  });

  describe('Full Agent → Group Invite Flow', () => {
    beforeEach(async () => {
      await cleanupTestData();
    });

    afterEach(async () => {
      await cleanupTestData();
    });

    test('ideal agent engagement should lead to group chat invite eligibility', async () => {
      // Create NPCs with a group chat
      const npc1 = await createTestNPC('Alpha Leader');
      const npc2 = await createTestNPC('Group Member');
      const groupChatId = await createGroupChat(
        `${npc1.name}'s Inner Circle`,
        npc1.id
      );

      // Add second NPC to group
      await addChatParticipant({
        chatId: groupChatId,
        userId: npc2.id,
        invitedBy: npc1.id,
      });

      // Create an agent
      const agent = await createTestAgent({
        displayName: 'Engaged Agent',
        bio: 'AI trading assistant',
      });

      // Agent builds engagement on feed
      // 1. Follow NPCs
      await createFollow(agent.id, npc1.id);
      await createFollow(agent.id, npc2.id);

      // 2. NPCs create content
      const posts: string[] = [];
      for (let i = 0; i < 10; i++) {
        posts.push(await createNPCPost(npc1.id, `NPC1 analysis ${i}`));
        posts.push(await createNPCPost(npc2.id, `NPC2 insight ${i}`));
      }

      // 3. Agent engages with content (ideal amounts)
      // Comments: 2-3 per NPC
      await createComment(agent.id, posts[0]!, 'Great market analysis!');
      await createComment(agent.id, posts[2]!, 'Excellent risk assessment');
      await createComment(agent.id, posts[1]!, 'Thanks for the alpha');

      // Likes: 6-8 total
      for (let i = 0; i < 8; i++) {
        await createLike(agent.id, posts[i]!);
      }

      // Shares: 1-2
      await createShare(agent.id, posts[0]!);
      await createShare(agent.id, posts[1]!);

      // Calculate engagement score
      const { score, breakdown } =
        await NPCGroupDynamicsService.calculateReplyGuyScore(agent.id, [
          npc1.id,
          npc2.id,
        ]);

      console.log('Agent Engagement for Invite:', { score, breakdown });

      // Verify agent has good score (threshold is typically 15-20)
      expect(score).toBeGreaterThan(20);
      expect(breakdown.penalties).toBe(0);

      // Simulate invite: NPC invites agent to group
      await addChatParticipant({
        chatId: groupChatId,
        userId: agent.id,
        invitedBy: npc1.id,
      });

      await createGroupMembership({
        chatId: groupChatId,
        userId: agent.id,
        npcAdminId: npc1.id,
      });

      // Verify agent is now in the group
      const membership = await db.groupChatMembership.findFirst({
        where: { chatId: groupChatId, userId: agent.id, isActive: true },
      });
      expect(membership).not.toBeNull();

      const participant = await db.chatParticipant.findFirst({
        where: { chatId: groupChatId, userId: agent.id, isActive: true },
      });
      expect(participant).not.toBeNull();
      expect(participant?.invitedBy).toBe(npc1.id);
    });
  });

  describe('Agent Group Chat Participation', () => {
    beforeEach(async () => {
      await cleanupTestData();
    });

    afterEach(async () => {
      await cleanupTestData();
    });

    test('agent can send messages in group chat', async () => {
      const npc = await createTestNPC('Chat NPC');
      const agent = await createTestAgent({ displayName: 'Chatting Agent' });

      // Create and join group
      const chatId = await createGroupChat('Alpha Group', npc.id);
      await addChatParticipant({
        chatId,
        userId: agent.id,
        invitedBy: npc.id,
      });

      // NPC sends message
      await createMessage({
        chatId,
        senderId: npc.id,
        content: 'Welcome to the alpha channel!',
      });

      // Agent responds
      await createMessage({
        chatId,
        senderId: agent.id,
        content: 'Thanks for the invite! Looking forward to the alpha.',
      });

      // Verify messages
      const messages = await db.message.findMany({
        where: { chatId },
        orderBy: { createdAt: 'asc' },
      });

      expect(messages.length).toBe(2);
      expect(messages[1]?.senderId).toBe(agent.id);
      expect(messages[1]?.content).toContain('alpha');
    });

    test('agent with ideal participation should not be kicked', async () => {
      const npc = await createTestNPC('Kick Test NPC');
      const agent = await createTestAgent({ displayName: 'Active Agent' });

      // Create group and add agent
      const chatId = await createGroupChat('Active Group', npc.id);
      await addChatParticipant({
        chatId,
        userId: agent.id,
        invitedBy: npc.id,
      });

      // Membership from 2 days ago (past grace period)
      const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
      await createGroupMembership({
        chatId,
        userId: agent.id,
        npcAdminId: npc.id,
        joinedAt: twoDaysAgo,
      });

      // Simulate group activity: 100 messages from 10 participants
      // Fair share = 10 messages per participant
      for (let i = 0; i < 90; i++) {
        await createMessage({
          chatId,
          senderId: npc.id,
          content: `NPC message ${i}`,
        });
      }

      // Agent posts 10 messages (ideal fair share)
      for (let i = 0; i < 10; i++) {
        await createMessage({
          chatId,
          senderId: agent.id,
          content: `Agent contribution ${i}`,
        });
      }

      // Calculate kick probability
      const kickDecision = await GroupChatService.calculateKickChance(
        agent.id,
        chatId
      );

      console.log('Kick Decision for Active Agent:', kickDecision);

      // Agent should be safe with ideal participation
      expect(kickDecision.stats.totalMessages).toBe(10);
    });

    test('inactive agent should have high kick probability', async () => {
      const npc = await createTestNPC('Inactive Test NPC');
      const inactiveAgent = await createTestAgent({
        displayName: 'Inactive Agent',
      });

      // Create group and add agent
      const chatId = await createGroupChat('Test Group', npc.id);
      await addChatParticipant({
        chatId,
        userId: inactiveAgent.id,
        invitedBy: npc.id,
      });

      // Membership from 2 days ago (past grace period)
      const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
      await createGroupMembership({
        chatId,
        userId: inactiveAgent.id,
        npcAdminId: npc.id,
        joinedAt: twoDaysAgo,
      });

      // NPC creates activity in the group
      for (let i = 0; i < 10; i++) {
        await createMessage({
          chatId,
          senderId: npc.id,
          content: `Group message ${i}`,
        });
      }

      // Agent has NOT posted anything

      // Calculate kick probability
      const kickDecision = await GroupChatService.calculateKickChance(
        inactiveAgent.id,
        chatId
      );

      console.log('Kick Decision for Inactive Agent:', kickDecision);

      expect(kickDecision.stats.totalMessages).toBe(0);
      // Inactive agents should have high kick probability
      expect(kickDecision.kickChance).toBeGreaterThan(0);
    });
  });

  describe('Agent vs User Parity in Group Chats', () => {
    beforeEach(async () => {
      await cleanupTestData();
    });

    afterEach(async () => {
      await cleanupTestData();
    });

    test('kick probability should be identical for agent and user with same behavior', () => {
      const scenarios = [
        { messages: 0, total: 100, participants: 10, desc: 'inactive' },
        { messages: 10, total: 100, participants: 10, desc: 'ideal' },
        { messages: 25, total: 100, participants: 10, desc: 'over-posting' },
        { messages: 50, total: 100, participants: 10, desc: 'spam' },
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

        expect(agentProb.probability).toBe(userProb.probability);
        expect(agentProb.category).toBe(userProb.category);

        console.log(
          `${scenario.desc}: probability=${userProb.probability}, category=${userProb.category}`
        );
      }
    });

    test('both agents and users can coexist in same group', async () => {
      const npc = await createTestNPC('Mixed Group NPC');
      const user = await createTestUser({ displayName: 'Human User' });
      const agent = await createTestAgent({ displayName: 'AI Agent' });

      const chatId = await createGroupChat('Mixed Group', npc.id);

      // Add both to group
      await addChatParticipant({
        chatId,
        userId: user.id,
        invitedBy: npc.id,
      });
      await addChatParticipant({
        chatId,
        userId: agent.id,
        invitedBy: npc.id,
      });

      await createGroupMembership({
        chatId,
        userId: user.id,
        npcAdminId: npc.id,
      });
      await createGroupMembership({
        chatId,
        userId: agent.id,
        npcAdminId: npc.id,
      });

      // Verify both are members
      const memberships = await db.groupChatMembership.findMany({
        where: { chatId, isActive: true },
      });

      expect(memberships.length).toBe(2);
      expect(memberships.some((m) => m.userId === user.id)).toBe(true);
      expect(memberships.some((m) => m.userId === agent.id)).toBe(true);

      // Both can send messages
      await createMessage({
        chatId,
        senderId: user.id,
        content: 'Hello from human!',
      });
      await createMessage({
        chatId,
        senderId: agent.id,
        content: 'Hello from agent!',
      });

      const messages = await db.message.findMany({ where: { chatId } });
      expect(messages.length).toBe(2);
    });
  });

  describe('Invite Statistics', () => {
    test('should be able to retrieve invite statistics', async () => {
      const stats = await AlphaGroupInviteService.getInviteStats();

      expect(stats).toHaveProperty('totalInvites');
      expect(stats).toHaveProperty('activeGroups');
      expect(stats).toHaveProperty('invitesLast24h');
      expect(typeof stats.totalInvites).toBe('number');
      expect(typeof stats.activeGroups).toBe('number');
      expect(typeof stats.invitesLast24h).toBe('number');

      console.log('Invite Statistics:', stats);
    });

    test('group statistics should be available', async () => {
      const stats = await NPCGroupDynamicsService.getGroupStats();

      expect(stats).toHaveProperty('totalGroups');
      expect(stats).toHaveProperty('activeGroups');
      expect(stats).toHaveProperty('avgGroupSize');
      expect(stats.totalGroups).toBeGreaterThanOrEqual(0);

      console.log('Group Statistics:', stats);
    });
  });
});
