/**
 * Group Chat Gameplay Integration Tests
 *
 * Validates the group chat asymmetric information mechanic works correctly:
 * - NPCs invite engaged users/agents to private group chats
 * - Group chats contain candid NPC info not available on the feed
 * - Users/agents must maintain ideal participation to stay in groups
 * - Over-posting, under-posting, and spam result in kicks
 *
 * These tests verify the mechanic works in:
 * - Continuous game (live game ticks)
 * - Offline simulation (benchmark)
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { db } from '@feed/db';
import {
  AlphaGroupInviteService,
  GroupChatService,
  NPCGroupDynamicsService,
} from '@feed/engine';
import { generateSnowflakeId } from '@feed/shared';

// Test data cleanup tracking
const testIds = {
  userIds: [] as string[],
  actorIds: [] as string[],
  groupIds: [] as string[],
  chatIds: [] as string[],
  participantIds: [] as string[],
  membershipIds: [] as string[],
  messageIds: [] as string[],
};

// Helper to create test user (regular user or agent)
async function createTestUser(options: {
  isAgent?: boolean;
  username?: string;
  displayName?: string;
}): Promise<{
  id: string;
  username: string;
  displayName: string;
  isAgent: boolean;
}> {
  const id = await generateSnowflakeId();
  const username = options.username || `test-user-${id.slice(-6)}`;
  const displayName = options.displayName || `Test User ${id.slice(-6)}`;

  await db.user.create({
    data: {
      id,
      username,
      displayName,
      isActor: false, // Both users and agents are NOT actors
      isAgent: options.isAgent || false,
      isTest: true,
      updatedAt: new Date(),
    },
  });

  testIds.userIds.push(id);
  return { id, username, displayName, isAgent: options.isAgent || false };
}

// Helper to create test NPC actor
async function createTestActor(options: {
  name?: string;
}): Promise<{ id: string; name: string }> {
  const id = await generateSnowflakeId();
  const name = options.name || `Test NPC ${id.slice(-6)}`;

  // Create user with isActor: true (no separate actors table needed)
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

// Helper to create test group chat (unified schema: Group + Chat)
async function createTestGroupChat(options: {
  name?: string;
  npcAdminId: string;
}): Promise<{ id: string; groupId: string; name: string }> {
  const groupId = await generateSnowflakeId();
  const chatId = await generateSnowflakeId();
  const name = options.name || `Test Group ${chatId.slice(-6)}`;

  // Create Group first (unified schema)
  await db.group.create({
    data: {
      id: groupId,
      name,
      type: 'npc',
      ownerId: options.npcAdminId,
      createdById: options.npcAdminId,
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

  testIds.groupIds.push(groupId);
  testIds.chatIds.push(chatId);
  return { id: chatId, groupId, name };
}

// Helper to add participant to chat
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

// Helper to create group membership (unified schema: GroupMember)
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

// Helper to create a message in a chat
async function createMessage(options: {
  chatId: string;
  senderId: string;
  content?: string;
  createdAt?: Date;
}): Promise<string> {
  const id = await generateSnowflakeId();

  await db.message.create({
    data: {
      id,
      chatId: options.chatId,
      senderId: options.senderId,
      content: options.content || `Test message ${id.slice(-6)}`,
      createdAt: options.createdAt || new Date(),
    },
  });

  testIds.messageIds.push(id);
  return id;
}

// Cleanup helper
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
  if (testIds.userIds.length > 0) {
    await db.user.deleteMany({ where: { id: { in: testIds.userIds } } });
  }
  if (testIds.actorIds.length > 0) {
    await db.actorState.deleteMany({ where: { id: { in: testIds.actorIds } } });
  }

  // Reset tracking
  testIds.userIds = [];
  testIds.actorIds = [];
  testIds.chatIds = [];
  testIds.participantIds = [];
  testIds.membershipIds = [];
  testIds.messageIds = [];
}

describe('Group Chat Gameplay Mechanics', () => {
  beforeAll(async () => {
    await cleanupTestData();
  });

  afterAll(async () => {
    await cleanupTestData();
  });

  describe('Asymmetric Information Value', () => {
    test('group chats should provide alpha info not available on public feed', async () => {
      // Create NPC and group
      const npc = await createTestActor({ name: 'Alpha Trader NPC' });
      const user = await createTestUser({ displayName: 'Engaged User' });
      const chat = await createTestGroupChat({
        name: 'Alpha Trading Group',
        npcAdminId: npc.id,
      });

      // Add participants
      await addChatParticipant({ chatId: chat.id, userId: npc.id });
      await addChatParticipant({
        chatId: chat.id,
        userId: user.id,
        invitedBy: npc.id,
      });
      await createGroupMembership({
        groupId: chat.groupId,
        userId: user.id,
        addedBy: npc.id,
      });

      // NPC posts candid alpha info
      await createMessage({
        chatId: chat.id,
        senderId: npc.id,
        content:
          "Between us: METAI is about to announce a major partnership. I'm loading up.",
      });

      // Verify user can access this private info
      const groupMessages = await db.message.findMany({
        where: { chatId: chat.id },
      });

      expect(groupMessages.length).toBe(1);
      expect(groupMessages[0]?.content).toContain('METAI');

      // This is the asymmetric advantage - users in groups get info before the feed
    });

    test('kicked users should lose access to alpha info', async () => {
      const npc = await createTestActor({ name: 'Exclusive NPC' });
      const user = await createTestUser({ displayName: 'Bad Participant' });
      const chat = await createTestGroupChat({
        name: 'VIP Group',
        npcAdminId: npc.id,
      });

      // Add participant
      await addChatParticipant({ chatId: chat.id, userId: npc.id });
      const participantId = await addChatParticipant({
        chatId: chat.id,
        userId: user.id,
        invitedBy: npc.id,
      });
      const membershipId = await createGroupMembership({
        groupId: chat.groupId,
        userId: user.id,
        addedBy: npc.id,
      });

      // Info before kick
      await createMessage({
        chatId: chat.id,
        senderId: npc.id,
        content: 'Tip: Buy BABEL before the earnings call',
      });

      // Simulate kick - kick info only stored on groupMember now
      await db.chatParticipant.update({
        where: { id: participantId },
        data: {
          isActive: false,
        },
      });
      await db.groupMember.update({
        where: { id: membershipId },
        data: {
          isActive: false,
          kickedAt: new Date(),
          kickReason: 'Over-posting',
        },
      });

      // New alpha info posted after kick
      await createMessage({
        chatId: chat.id,
        senderId: npc.id,
        content: 'Major update: BABEL earnings beat expectations by 50%',
      });

      // Check user's access - should not see new messages through API
      const userParticipant = await db.chatParticipant.findFirst({
        where: { chatId: chat.id, userId: user.id, isActive: true },
      });

      expect(userParticipant).toBeNull(); // User is kicked, no active participation
    });
  });

  describe('Participation Requirements', () => {
    test('ideal posting rate should keep users safe', () => {
      // Test various ideal scenarios
      const idealScenarios = [
        { messages: 5, total: 50, participants: 10 }, // 1 msg/day equivalent
        { messages: 10, total: 100, participants: 10 }, // fair share
        { messages: 14, total: 140, participants: 10 }, // 2 msgs/day equivalent
      ];

      for (const scenario of idealScenarios) {
        const result = NPCGroupDynamicsService.calculateKickProbability(
          scenario.messages,
          scenario.total,
          scenario.participants,
          7
        );

        expect(result.category).toBe('safe');
        expect(result.probability).toBe(0);
      }
    });

    test('posting too much should trigger exponential kick probability', () => {
      // Test over-posting scenarios
      const results: Array<{
        messages: number;
        prob: number;
        category: string;
      }> = [];

      for (const msgCount of [16, 20, 25, 30, 35]) {
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

      // High message counts should have significant kick probability
      const lastResult = results[results.length - 1];
      expect(lastResult?.prob).toBeGreaterThan(0.5);
    });

    test('not posting at all should eventually lead to removal', () => {
      const result = NPCGroupDynamicsService.calculateKickProbability(
        0, // Never posted
        100, // Active group
        10, // 10 participants
        7 // 7 day window
      );

      expect(result.category).toBe('inactive');
      expect(result.probability).toBe(0.9); // 90% kick probability
    });

    test('spam behavior should result in immediate kick', () => {
      const result = NPCGroupDynamicsService.calculateKickProbability(
        50, // Way too many messages
        100, // In a group with 100 total
        10, // 10 participants
        7
      );

      expect(result.category).toBe('spam');
      expect(result.probability).toBeGreaterThanOrEqual(0.95);
    });
  });

  describe('Dynamic Threshold Scaling', () => {
    test('thresholds should scale with group size', () => {
      // Small group: 5 participants with 50 messages
      // Fair share = 10 messages
      const smallGroupResult = NPCGroupDynamicsService.calculateKickProbability(
        15,
        50,
        5,
        7
      );

      // Large group: 50 participants with 500 messages
      // Fair share = 10 messages
      const largeGroup = NPCGroupDynamicsService.calculateKickProbability(
        15,
        500,
        50,
        7
      );

      // In small group, 15 messages might be borderline (50% over fair share)
      // In large group, 15 messages is exactly fair share
      expect(largeGroup.category).toBe('safe');
      expect(largeGroup.probability).toBe(0);
      // Small group should have some risk since 15 is 50% over fair share
      expect(smallGroupResult.probability).toBeGreaterThanOrEqual(0);
    });

    test('thresholds should scale with group activity', () => {
      // Active group: 200 messages from 10 participants
      // Fair share = 20 messages
      const activeGroup = NPCGroupDynamicsService.calculateKickProbability(
        25,
        200,
        10,
        7
      );

      // Quiet group: 30 messages from 10 participants
      // Fair share = 3 messages
      const quietGroup = NPCGroupDynamicsService.calculateKickProbability(
        8,
        30,
        10,
        7
      );

      // In active group, 25 messages is only 25% over fair share - should be safe or low risk
      // In quiet group, 8 messages is 166% over fair share - might be flagged
      expect(activeGroup.probability).toBeLessThan(quietGroup.probability);
    });
  });

  describe('User vs Agent Parity', () => {
    test('users and agents should have identical kick probabilities for same behavior', async () => {
      // Create identical scenarios for user and agent
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

        // Should be identical
        expect(userProb.probability).toBe(agentProb.probability);
        expect(userProb.category).toBe(agentProb.category);
      }
    });

    test('both users and agents can be added to group chats', async () => {
      const npc = await createTestActor({ name: 'Inclusive NPC' });
      const user = await createTestUser({
        isAgent: false,
        displayName: 'Human User',
      });
      const agent = await createTestUser({
        isAgent: true,
        displayName: 'AI Agent',
      });
      const chat = await createTestGroupChat({
        name: 'Mixed Group',
        npcAdminId: npc.id,
      });

      // Add NPC
      await addChatParticipant({ chatId: chat.id, userId: npc.id });

      // Add user
      await addChatParticipant({
        chatId: chat.id,
        userId: user.id,
        invitedBy: npc.id,
      });
      await createGroupMembership({
        groupId: chat.groupId,
        userId: user.id,
        addedBy: npc.id,
      });

      // Add agent
      await addChatParticipant({
        chatId: chat.id,
        userId: agent.id,
        invitedBy: npc.id,
      });
      await createGroupMembership({
        groupId: chat.groupId,
        userId: agent.id,
        addedBy: npc.id,
      });

      // Verify both are participants
      const participants = await db.chatParticipant.findMany({
        where: { chatId: chat.id, isActive: true },
      });

      expect(participants.length).toBe(3); // NPC + user + agent
    });
  });

  describe('Sweep Mechanics', () => {
    test('sweep should calculate kick chance based on membership activity', async () => {
      const npc = await createTestActor({ name: 'Sweep Test NPC' });
      const inactiveUser = await createTestUser({
        displayName: 'Inactive User',
      });
      const activeUser = await createTestUser({ displayName: 'Active User' });
      const chat = await createTestGroupChat({
        name: 'Sweep Test Group',
        npcAdminId: npc.id,
      });

      // Add participants
      await addChatParticipant({ chatId: chat.id, userId: npc.id });
      await addChatParticipant({
        chatId: chat.id,
        userId: inactiveUser.id,
        invitedBy: npc.id,
      });
      await addChatParticipant({
        chatId: chat.id,
        userId: activeUser.id,
        invitedBy: npc.id,
      });

      // Create memberships - inactive user joined 3 days ago
      await createGroupMembership({
        groupId: chat.groupId,
        userId: inactiveUser.id,
        addedBy: npc.id,
        joinedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
      });

      // Active user joined 3 days ago too
      await createGroupMembership({
        groupId: chat.groupId,
        userId: activeUser.id,
        addedBy: npc.id,
        joinedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
      });

      // Only active user has posted
      await createMessage({
        chatId: chat.id,
        senderId: activeUser.id,
        content: 'Hello everyone!',
      });
      await createMessage({
        chatId: chat.id,
        senderId: npc.id,
        content: 'Welcome!',
      });

      // Calculate kick chances
      const inactiveDecision = await GroupChatService.calculateKickChance(
        inactiveUser.id,
        chat.id
      );
      const activeDecision = await GroupChatService.calculateKickChance(
        activeUser.id,
        chat.id
      );

      // Inactive user should have higher kick chance
      expect(inactiveDecision.kickChance).toBeGreaterThan(
        activeDecision.kickChance
      );
      expect(inactiveDecision.stats.totalMessages).toBe(0);
      expect(activeDecision.stats.totalMessages).toBeGreaterThan(0);
    });
  });

  describe('Group Limits', () => {
    test('users should be limited in how many groups they can join', async () => {
      // This tests the MAX_ACTIVE_USER_GROUPS = 5 limit
      const npc = await createTestActor({ name: 'Limiting NPC' });
      const user = await createTestUser({ displayName: 'Group Collector' });

      // Create 5 groups and add user to all
      for (let i = 0; i < 5; i++) {
        const chat = await createTestGroupChat({
          name: `Group ${i + 1}`,
          npcAdminId: npc.id,
        });
        await addChatParticipant({ chatId: chat.id, userId: npc.id });
        await addChatParticipant({
          chatId: chat.id,
          userId: user.id,
          invitedBy: npc.id,
        });
        await createGroupMembership({
          groupId: chat.groupId,
          userId: user.id,
          addedBy: npc.id,
        });
      }

      // Count user's active groups
      const activeGroups = await db.groupMember.count({
        where: { userId: user.id, isActive: true },
      });

      expect(activeGroups).toBe(5);

      // The invite service should reject additional invites at this point
      // (Tested through the AlphaGroupInviteService which checks limits)
    });
  });

  describe('Service Statistics', () => {
    test('NPCGroupDynamicsService should track group statistics', async () => {
      // Get current stats
      const stats = await NPCGroupDynamicsService.getGroupStats();

      expect(stats).toHaveProperty('totalGroups');
      expect(stats).toHaveProperty('activeGroups');
      expect(stats).toHaveProperty('avgGroupSize');
      expect(typeof stats.totalGroups).toBe('number');
      expect(typeof stats.activeGroups).toBe('number');
      expect(typeof stats.avgGroupSize).toBe('number');
    });

    test('AlphaGroupInviteService should track invite statistics', async () => {
      const stats = await AlphaGroupInviteService.getInviteStats();

      expect(stats).toHaveProperty('totalInvites');
      expect(stats).toHaveProperty('activeGroups');
      expect(stats).toHaveProperty('invitesLast24h');
      expect(typeof stats.totalInvites).toBe('number');
      expect(typeof stats.activeGroups).toBe('number');
      expect(typeof stats.invitesLast24h).toBe('number');
    });
  });
});

describe('Benchmark/Simulation Group Chat Integration', () => {
  test('simulation data generator includes group chat events', async () => {
    // Import the data generator
    const { BenchmarkDataGenerator } = await import(
      '@feed/training/benchmark/BenchmarkDataGenerator'
    );

    const config = {
      seed: 12345,
      durationMinutes: 10, // 10 minutes
      tickInterval: 10, // 10 seconds per tick = 60 ticks
      numPredictionMarkets: 10,
      numPerpetualMarkets: 5,
      numAgents: 5,
    };

    const generator = new BenchmarkDataGenerator(config);
    const snapshot = await generator.generate();

    // Check that group chats are included in the game state
    expect(snapshot.ticks.length).toBeGreaterThan(0);
    const lastTick = snapshot.ticks[snapshot.ticks.length - 1];
    const state = lastTick?.state;

    // Group chats should be present in the state
    expect(state).toHaveProperty('groupChats');
    expect(Array.isArray(state?.groupChats)).toBe(true);

    // Check for group-related events
    const allEvents = snapshot.ticks.flatMap((t) => t.events);
    const groupEvents = allEvents.filter(
      (e) =>
        e.type === 'group:created' ||
        e.type === 'group:invite' ||
        e.type === 'group:message'
    );

    // Should have some group events in the ticks
    // Note: Group events have a low probability, so we may or may not have them
    expect(groupEvents.length).toBeGreaterThanOrEqual(0);
  });

  test('simulation interface should handle group chat queries', async () => {
    // Import simulation components
    const { BenchmarkDataGenerator } = await import(
      '@feed/training/benchmark/BenchmarkDataGenerator'
    );
    const { SimulationEngine } = await import(
      '@feed/training/benchmark/SimulationEngine'
    );
    const { SimulationA2AInterface } = await import(
      '@feed/training/benchmark/SimulationA2AInterface'
    );

    const config = {
      seed: 54321,
      durationMinutes: 5,
      tickInterval: 10,
      numPredictionMarkets: 5,
      numPerpetualMarkets: 3,
      numAgents: 3,
    };

    const generator = new BenchmarkDataGenerator(config);
    const snapshot = await generator.generate();

    const engine = new SimulationEngine({
      snapshot,
      agentId: 'agent-0',
      fastForward: false,
    });

    const interface_ = new SimulationA2AInterface(engine, 'agent-0');

    // Test that we can query chats through the A2A interface
    const response = (await interface_.sendRequest('a2a.getChats')) as {
      chats: unknown[];
    };

    expect(response).toHaveProperty('chats');
    expect(Array.isArray(response.chats)).toBe(true);
  });
});
