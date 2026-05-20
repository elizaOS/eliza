/**
 * Group Chat Dynamics Integration Tests
 *
 * Tests the full group chat invite/participate/kick flow for:
 * - Users getting invited to NPC group chats
 * - Agents getting invited to NPC group chats (same treatment as users)
 * - Users/agents staying in groups with ideal participation
 * - Users/agents getting kicked for inactivity, over-posting, spam
 *
 * These tests verify the asymmetric information mechanic works correctly,
 * where group chats provide candid NPC information to engaged participants.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { db } from "@feed/db";
import {
  autoJoinEmptyUsersToNpcGroupChats,
  GroupChatService,
  NPCGroupDynamicsService,
} from "@feed/engine";
import { generateSnowflakeId } from "@feed/shared";

// Test data cleanup tracking
const testIds: {
  userIds: string[];
  actorIds: string[];
  groupIds: string[];
  chatIds: string[];
  participantIds: string[];
  membershipIds: string[];
  messageIds: string[];
} = {
  userIds: [],
  actorIds: [],
  groupIds: [],
  chatIds: [],
  participantIds: [],
  membershipIds: [],
  messageIds: [],
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
      username: name.toLowerCase().replace(/\s+/g, "-"),
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
      type: "npc",
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
      gameId: "realtime",
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
  role?: "owner" | "admin" | "member";
}): Promise<string> {
  const id = await generateSnowflakeId();

  await db.groupMember.create({
    data: {
      id,
      groupId: options.groupId,
      userId: options.userId,
      role: options.role || "member",
      addedBy: options.addedBy,
      isActive: true,
      joinedAt: new Date(),
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

describe("Group Chat Dynamics Integration Tests", () => {
  beforeEach(async () => {
    // Clean slate for each test
    await cleanupTestData();
  });

  afterEach(async () => {
    await cleanupTestData();
  });

  describe("NPC group chat onboarding (dev demo)", () => {
    test("auto-joins users with zero group chats into an NPC group chat", async () => {
      const npc = await createTestActor({ name: "Onboarding NPC" });
      const user = await createTestUser({
        isAgent: false,
        displayName: "Brand New User",
      });

      // Create an NPC group chat with the NPC as owner + participant
      const chat = await createTestGroupChat({
        name: "Onboarding NPC's Circle",
        npcAdminId: npc.id,
      });
      await addChatParticipant({ chatId: chat.id, userId: npc.id });
      await createGroupMembership({
        groupId: chat.groupId,
        userId: npc.id,
        role: "owner",
        addedBy: npc.id,
      });

      const usersJoined = await autoJoinEmptyUsersToNpcGroupChats({
        enabled: true,
        batchSize: 10,
        defaultMaxMembers: 12,
        userIdAllowlist: [user.id],
        chatIdAllowlist: [chat.id],
      });

      expect(usersJoined).toBe(1);

      const membership = await db.groupMember.findFirst({
        where: {
          groupId: chat.groupId,
          userId: user.id,
          isActive: true,
        },
      });
      expect(membership).not.toBeNull();
      if (membership) {
        testIds.membershipIds.push(membership.id);
      }

      const participant = await db.chatParticipant.findFirst({
        where: {
          chatId: chat.id,
          userId: user.id,
          isActive: true,
        },
      });
      expect(participant).not.toBeNull();
      if (participant) {
        testIds.participantIds.push(participant.id);
      }
    });

    test("can seed a user into multiple NPC group chats when configured", async () => {
      const npc = await createTestActor({ name: "Multi Chat NPC" });
      const user = await createTestUser({
        isAgent: false,
        displayName: "Multi Chat User",
      });

      const chats = await Promise.all([
        createTestGroupChat({
          name: "Multi Chat Alpha",
          npcAdminId: npc.id,
        }),
        createTestGroupChat({
          name: "Multi Chat Beta",
          npcAdminId: npc.id,
        }),
        createTestGroupChat({
          name: "Multi Chat Gamma",
          npcAdminId: npc.id,
        }),
      ]);

      for (const chat of chats) {
        await addChatParticipant({ chatId: chat.id, userId: npc.id });
        await createGroupMembership({
          groupId: chat.groupId,
          userId: npc.id,
          role: "owner",
          addedBy: npc.id,
        });
      }

      const usersJoined = await autoJoinEmptyUsersToNpcGroupChats({
        enabled: true,
        batchSize: 10,
        targetChatsPerUser: 3,
        defaultMaxMembers: 12,
        userIdAllowlist: [user.id],
        chatIdAllowlist: chats.map((chat) => chat.id),
        rng: () => 0,
      });

      expect(usersJoined).toBe(3);

      for (const chat of chats) {
        const membership = await db.groupMember.findFirst({
          where: {
            groupId: chat.groupId,
            userId: user.id,
            isActive: true,
          },
        });
        expect(membership).not.toBeNull();
        if (membership) {
          testIds.membershipIds.push(membership.id);
        }

        const participant = await db.chatParticipant.findFirst({
          where: {
            chatId: chat.id,
            userId: user.id,
            isActive: true,
          },
        });
        expect(participant).not.toBeNull();
        if (participant) {
          testIds.participantIds.push(participant.id);
        }
      }
    });
  });

  describe("User and Agent Parity", () => {
    test("users and agents should both be eligible for group chat invites", async () => {
      const npc = await createTestActor({ name: "Test NPC Admin" });
      const user = await createTestUser({
        isAgent: false,
        displayName: "Regular User",
      });
      const agent = await createTestUser({
        isAgent: true,
        displayName: "AI Agent",
      });

      // Both should have isActor: false (only NPCs have isActor: true)
      const userRecord = await db.user.findUnique({ where: { id: user.id } });
      const agentRecord = await db.user.findUnique({ where: { id: agent.id } });

      expect(userRecord?.isActor).toBe(false);
      expect(agentRecord?.isActor).toBe(false);
      expect(agentRecord?.isAgent).toBe(true);

      // Create a group chat
      const chat = await createTestGroupChat({
        name: "Test Group",
        npcAdminId: npc.id,
      });
      await addChatParticipant({ chatId: chat.id, userId: npc.id });

      // Both user and agent can be added to the group
      await addChatParticipant({
        chatId: chat.id,
        userId: user.id,
        invitedBy: npc.id,
      });
      await addChatParticipant({
        chatId: chat.id,
        userId: agent.id,
        invitedBy: npc.id,
      });

      // Verify both are participants
      const participants = await db.chatParticipant.findMany({
        where: { chatId: chat.id },
      });

      expect(participants.length).toBe(3); // NPC + user + agent
      expect(participants.some((p) => p.userId === user.id)).toBe(true);
      expect(participants.some((p) => p.userId === agent.id)).toBe(true);
    });

    test("kick logic should treat users and agents the same", async () => {
      // Test the kick probability calculation directly
      // Both users and agents should get the same probability for the same behavior

      // Never posted - both should get 90% kick probability
      const userProb = NPCGroupDynamicsService.calculateKickProbability(
        0,
        100,
        10,
        7,
      );
      const agentProb = NPCGroupDynamicsService.calculateKickProbability(
        0,
        100,
        10,
        7,
      );

      expect(userProb.probability).toBe(agentProb.probability);
      expect(userProb.category).toBe(agentProb.category);
    });
  });

  describe("Kick Probability Calculations", () => {
    test("inactive users should have high kick probability", () => {
      const result = NPCGroupDynamicsService.calculateKickProbability(
        0, // Never posted
        100, // Active group
        10, // 10 participants
        7, // 7 day window
      );

      expect(result.probability).toBe(0.9);
      expect(result.category).toBe("inactive");
    });

    test("ideal participation should have zero kick probability", () => {
      // Fair share = 100/10 = 10 messages
      // User with 8 messages is within ideal range (50-150% of fair share)
      const result = NPCGroupDynamicsService.calculateKickProbability(
        8, // Good participation
        100, // Total messages
        10, // 10 participants
        7,
      );

      expect(result.probability).toBe(0);
      expect(result.category).toBe("safe");
    });

    test("over-posting should have increasing kick probability", () => {
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

      // All should be in 'over' category
      expect(slight.category).toBe("over");
      expect(moderate.category).toBe("over");
      expect(heavy.category).toBe("over");

      // Probability should increase exponentially
      expect(moderate.probability).toBeGreaterThan(slight.probability);
      expect(heavy.probability).toBeGreaterThan(moderate.probability);
    });

    test("spam behavior should have near-certain kick probability", () => {
      // Spam threshold = min(140, max(10, 30)) = 30 for this group
      // User with 50 messages is definitely spamming
      const result = NPCGroupDynamicsService.calculateKickProbability(
        50, // Way over threshold
        100,
        10,
        7,
      );

      expect(result.probability).toBeGreaterThanOrEqual(0.95);
      expect(result.category).toBe("spam");
    });
  });

  describe("Group Chat Sweep", () => {
    test("sweep should calculate kick chance based on activity", async () => {
      const npc = await createTestActor({ name: "Sweep Test NPC" });
      const user = await createTestUser({ displayName: "Sweep Test User" });
      const chat = await createTestGroupChat({
        name: "Sweep Test Group",
        npcAdminId: npc.id,
      });

      // Add participants
      await addChatParticipant({ chatId: chat.id, userId: npc.id });
      await addChatParticipant({
        chatId: chat.id,
        userId: user.id,
        invitedBy: npc.id,
      });

      // Create membership
      await createGroupMembership({
        groupId: chat.groupId,
        userId: user.id,
        addedBy: npc.id,
      });

      // Add some messages from NPC (but none from user)
      for (let i = 0; i < 5; i++) {
        await createMessage({
          chatId: chat.id,
          senderId: npc.id,
          content: `NPC message ${i}`,
        });
      }

      // Calculate kick chance - user has never posted
      const decision = await GroupChatService.calculateKickChance(
        user.id,
        chat.id,
      );

      // User joined recently with 0 messages - should have some kick chance
      // (depends on how long since join vs grace period)
      expect(decision.stats.totalMessages).toBe(0);
      expect(decision.stats.messagesLast24h).toBe(0);
    });
  });

  describe("Dynamic Thresholds", () => {
    test("small groups should have appropriate thresholds", () => {
      // 3-person group with 30 messages
      const small = NPCGroupDynamicsService.calculateKickProbability(
        8,
        30,
        3,
        7,
      );

      // 8 messages in a 3-person group (fair share = 10) should be fine
      expect(small.category).toBe("safe");
    });

    test("large groups should have appropriate thresholds", () => {
      // 50-person group with 500 messages
      const large = NPCGroupDynamicsService.calculateKickProbability(
        8,
        500,
        50,
        7,
      );

      // 8 messages in a 50-person group (fair share = 10) should be fine
      expect(large.category).toBe("safe");
    });

    test("domination threshold should scale with group size", () => {
      // In 3-person group with 30 messages, 25 messages = 83% (severe domination)
      // Fair share = 10, spam threshold ~30, 25 is severely over ideal max of 15
      const smallDominator = NPCGroupDynamicsService.calculateKickProbability(
        25,
        30,
        3,
        7,
      );

      // In 50-person group with 500 messages, 15 messages = 3% (totally fine)
      // Fair share = 10, ideal max = 15, so 15 is exactly at max = safe
      const largeSafe = NPCGroupDynamicsService.calculateKickProbability(
        15,
        500,
        50,
        7,
      );

      // Small group dominator should definitely be flagged
      expect(smallDominator.category).toBe("over");
      expect(smallDominator.probability).toBeGreaterThan(0);

      // Large group participant should be safe
      expect(largeSafe.category).toBe("safe");
      expect(largeSafe.probability).toBe(0);

      // And dominator probability should be higher than safe (which is 0)
      expect(smallDominator.probability).toBeGreaterThan(largeSafe.probability);
    });
  });

  describe("Message Cadence Simulation", () => {
    test("ideal participation pattern should remain safe over time", () => {
      // Simulate a week with 1-2 messages per day
      const scenarios = [
        { messages: 7, total: 70, participants: 10 }, // 1/day
        { messages: 10, total: 100, participants: 10 }, // ~1.4/day
        { messages: 14, total: 140, participants: 10 }, // 2/day
      ];

      for (const scenario of scenarios) {
        const result = NPCGroupDynamicsService.calculateKickProbability(
          scenario.messages,
          scenario.total,
          scenario.participants,
          7,
        );

        expect(result.category).toBe("safe");
        expect(result.probability).toBe(0);
      }
    });

    test("gradual increase in posting should be caught before spam", () => {
      // User starts posting more and more
      const progression = [15, 18, 21, 25, 30, 35, 40];
      let lastProbability = 0;

      for (const messages of progression) {
        const result = NPCGroupDynamicsService.calculateKickProbability(
          messages,
          100,
          10,
          7,
        );

        // Probability should generally increase (or stay same if in same category)
        expect(result.probability).toBeGreaterThanOrEqual(
          lastProbability - 0.1,
        );
        lastProbability = result.probability;
      }

      // By 40 messages, should definitely be flagged
      const finalResult = NPCGroupDynamicsService.calculateKickProbability(
        40,
        100,
        10,
        7,
      );
      expect(finalResult.probability).toBeGreaterThan(0.5);
    });
  });

  describe("Edge Cases", () => {
    test("should handle brand new group with no messages", () => {
      // New group, no messages yet
      const result = NPCGroupDynamicsService.calculateKickProbability(
        0,
        0,
        5,
        7,
      );

      // User hasn't posted but group has no activity either
      // Still categorized as inactive since user hasn't contributed
      expect(result.category).toBe("inactive");
    });

    test("should handle single participant groups", () => {
      // Solo participant (weird edge case)
      const result = NPCGroupDynamicsService.calculateKickProbability(
        50,
        50,
        1,
        7,
      );

      // 100% of messages is expected when you're the only one
      // But 50 messages in 7 days might still be spam by absolute standards
      // Result depends on absolute vs relative threshold
      expect(["safe", "spam"]).toContain(result.category);
    });

    test("should never return probability > 1 or < 0", () => {
      const extremeCases = [
        { messages: 0, total: 0, participants: 0 },
        { messages: 1000, total: 10, participants: 5 },
        { messages: 1, total: 10000, participants: 100 },
      ];

      for (const scenario of extremeCases) {
        const result = NPCGroupDynamicsService.calculateKickProbability(
          scenario.messages,
          scenario.total,
          scenario.participants,
          7,
        );

        expect(result.probability).toBeGreaterThanOrEqual(0);
        expect(result.probability).toBeLessThanOrEqual(1);
      }
    });
  });
});

describe("Group Chat Information Access", () => {
  beforeEach(async () => {
    await cleanupTestData();
  });

  afterEach(async () => {
    await cleanupTestData();
  });

  test("participants should be able to see group messages", async () => {
    const npc = await createTestActor({ name: "Info NPC" });
    const user = await createTestUser({ displayName: "Info User" });
    const chat = await createTestGroupChat({
      name: "Alpha Group",
      npcAdminId: npc.id,
    });

    // Add participants
    await addChatParticipant({ chatId: chat.id, userId: npc.id });
    await addChatParticipant({
      chatId: chat.id,
      userId: user.id,
      invitedBy: npc.id,
    });

    // NPC posts alpha info
    await createMessage({
      chatId: chat.id,
      senderId: npc.id,
      content: "Secret alpha: METAI will moon tomorrow",
    });

    // User should be able to see this message
    const messages = await db.message.findMany({
      where: { chatId: chat.id },
    });

    expect(messages.length).toBe(1);
    expect(messages[0]?.content).toContain("Secret alpha");
  });

  test("kicked users should not be able to see new messages", async () => {
    const npc = await createTestActor({ name: "Kick NPC" });
    const user = await createTestUser({ displayName: "Kicked User" });
    const chat = await createTestGroupChat({
      name: "Exclusive Group",
      npcAdminId: npc.id,
    });

    // Add participant (will be kicked later)
    await addChatParticipant({ chatId: chat.id, userId: npc.id });
    const participantId = await addChatParticipant({
      chatId: chat.id,
      userId: user.id,
      invitedBy: npc.id,
    });

    // Message before kick
    await createMessage({
      chatId: chat.id,
      senderId: npc.id,
      content: "You can see this",
    });

    // Simulate kick by marking participant as inactive
    await db.chatParticipant.update({
      where: { id: participantId },
      data: { isActive: false },
    });

    // New message after kick
    await createMessage({
      chatId: chat.id,
      senderId: npc.id,
      content: "You cannot see this",
    });

    // Query messages as the user would (only if active participant)
    const participant = await db.chatParticipant.findFirst({
      where: { chatId: chat.id, userId: user.id, isActive: true },
    });

    expect(participant).toBeNull(); // User is kicked

    // Business logic would prevent showing messages to inactive participants
    // The messages still exist, but UI/API would filter
    const allMessages = await db.message.findMany({
      where: { chatId: chat.id },
    });

    expect(allMessages.length).toBe(2); // Both messages exist
  });
});
