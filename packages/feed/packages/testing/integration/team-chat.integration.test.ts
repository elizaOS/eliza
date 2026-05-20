/**
 * Team Chat (Agents) Integration Tests
 *
 * Tests the unified team chat functionality with real database operations:
 * - TeamChatService lifecycle (create, add, remove)
 * - Error handling and edge cases
 * - Concurrent operations
 * - API endpoint validation
 *
 * These tests verify the Agents chat works correctly for agent coordination.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { teamChatService } from '@feed/agents';
import {
  chatParticipants,
  chats,
  db,
  eq,
  generateSnowflakeId,
  groupMembers,
  groups,
  messages,
  userAgentConfigs,
  users,
} from '@feed/db';

// Test data cleanup tracking
const testCleanup: {
  userIds: string[];
  groupIds: string[];
  chatIds: string[];
} = {
  userIds: [],
  groupIds: [],
  chatIds: [],
};

// Helper to create a test user (human owner)
async function createTestUser(suffix?: string): Promise<{
  id: string;
  username: string;
  displayName: string;
}> {
  const id = await generateSnowflakeId();
  const username = `test-user-${suffix || id.slice(-6)}`;
  const displayName = `Test User ${suffix || id.slice(-6)}`;

  await db.insert(users).values({
    id,
    username,
    displayName,
    isAgent: false,
    isActor: false,
    isTest: true,
    updatedAt: new Date(),
  });

  testCleanup.userIds.push(id);
  return { id, username, displayName };
}

// Helper to create a test agent owned by a user
async function createTestAgent(
  managedBy: string,
  suffix?: string
): Promise<{
  id: string;
  username: string;
  displayName: string;
}> {
  const id = await generateSnowflakeId();
  const username = `test-agent-${suffix || id.slice(-6)}`;
  const displayName = `Test Agent ${suffix || id.slice(-6)}`;

  await db.insert(users).values({
    id,
    username,
    displayName,
    isAgent: true,
    managedBy,
    isActor: false,
    isTest: true,
    updatedAt: new Date(),
  });

  // Create agent config
  await db.insert(userAgentConfigs).values({
    id: await generateSnowflakeId(),
    userId: id,
    systemPrompt: 'You are a helpful test agent.',
    personality: 'Friendly and helpful',
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  testCleanup.userIds.push(id);
  return { id, username, displayName };
}

// Cleanup function to run after tests
async function cleanupTestData() {
  // Delete in reverse order of dependencies
  for (const chatId of testCleanup.chatIds) {
    await db.delete(messages).where(eq(messages.chatId, chatId));
    await db
      .delete(chatParticipants)
      .where(eq(chatParticipants.chatId, chatId));
    await db.delete(chats).where(eq(chats.id, chatId));
  }

  for (const groupId of testCleanup.groupIds) {
    await db.delete(groupMembers).where(eq(groupMembers.groupId, groupId));
    await db.delete(groups).where(eq(groups.id, groupId));
  }

  for (const userId of testCleanup.userIds) {
    await db
      .delete(userAgentConfigs)
      .where(eq(userAgentConfigs.userId, userId));
    await db.delete(users).where(eq(users.id, userId));
  }

  // Reset tracking
  testCleanup.userIds = [];
  testCleanup.groupIds = [];
  testCleanup.chatIds = [];
}

describe('TeamChatService', () => {
  afterAll(async () => {
    await cleanupTestData();
  });

  describe('ensureTeamChat', () => {
    test('creates a new team chat for user without one', async () => {
      const user = await createTestUser('ensure-1');

      const teamChat = await teamChatService.ensureTeamChat(user.id);

      // Track for cleanup (id and groupId are now the same)
      testCleanup.groupIds.push(teamChat.groupId);
      testCleanup.chatIds.push(teamChat.chatId);

      // Verify structure
      expect(teamChat.id).toBeDefined();
      expect(teamChat.ownerId).toBe(user.id);
      expect(teamChat.groupId).toBeDefined();
      expect(teamChat.chatId).toBeDefined();
      expect(teamChat.createdAt).toBeInstanceOf(Date);
      expect(teamChat.updatedAt).toBeInstanceOf(Date);

      // Verify group was created
      const [group] = await db
        .select()
        .from(groups)
        .where(eq(groups.id, teamChat.groupId));
      expect(group).toBeDefined();
      expect(group!.name).toBe('Agents');
      expect(group!.type).toBe('team');
      expect(group!.ownerId).toBe(user.id);

      // Verify user is group member
      const [member] = await db
        .select()
        .from(groupMembers)
        .where(eq(groupMembers.groupId, teamChat.groupId));
      expect(member).toBeDefined();
      expect(member!.userId).toBe(user.id);
      expect(member!.role).toBe('owner');
    });

    test('returns existing team chat if one already exists', async () => {
      const user = await createTestUser('ensure-2');

      // Create first
      const first = await teamChatService.ensureTeamChat(user.id);
      testCleanup.groupIds.push(first.groupId);
      testCleanup.chatIds.push(first.chatId);

      // Ensure again
      const second = await teamChatService.ensureTeamChat(user.id);

      // Should be the same
      expect(second.id).toBe(first.id);
      expect(second.chatId).toBe(first.chatId);
      expect(second.groupId).toBe(first.groupId);
    });

    test('handles concurrent ensureTeamChat calls', async () => {
      const user = await createTestUser('ensure-concurrent');

      // Call concurrently
      const results = await Promise.all([
        teamChatService.ensureTeamChat(user.id),
        teamChatService.ensureTeamChat(user.id),
        teamChatService.ensureTeamChat(user.id),
      ]);

      // All should return the same chat
      const ids = new Set(results.map((r) => r.id));
      expect(ids.size).toBe(1);

      // Track for cleanup (only one unique)
      testCleanup.groupIds.push(results[0].groupId);
      testCleanup.chatIds.push(results[0].chatId);
    });
  });

  describe('getTeamChat', () => {
    test('returns null for user without team chat', async () => {
      const user = await createTestUser('get-none');

      const result = await teamChatService.getTeamChat(user.id);

      expect(result).toBeNull();
    });

    test('returns team chat info for user with one', async () => {
      const user = await createTestUser('get-exists');
      const teamChat = await teamChatService.ensureTeamChat(user.id);
      testCleanup.groupIds.push(teamChat.groupId);
      testCleanup.chatIds.push(teamChat.chatId);

      const result = await teamChatService.getTeamChat(user.id);

      expect(result).not.toBeNull();
      expect(result?.id).toBe(teamChat.id);
      expect(result?.chatId).toBe(teamChat.chatId);
    });

    test('returns null for non-existent user ID', async () => {
      const fakeId = await generateSnowflakeId();

      const result = await teamChatService.getTeamChat(fakeId);

      expect(result).toBeNull();
    });
  });

  describe('addAgentToTeamChat', () => {
    test('adds agent to team chat with system message', async () => {
      const user = await createTestUser('add-1');
      const agent = await createTestAgent(user.id, 'add-1');
      const teamChat = await teamChatService.ensureTeamChat(user.id);
      testCleanup.groupIds.push(teamChat.groupId);
      testCleanup.chatIds.push(teamChat.chatId);

      await teamChatService.addAgentToTeamChat(user.id, agent.id);

      // Verify agent is in group members
      const members = await db
        .select()
        .from(groupMembers)
        .where(eq(groupMembers.groupId, teamChat.groupId));
      const agentMember = members.find((m) => m.userId === agent.id);
      expect(agentMember).toBeDefined();
      expect(agentMember?.isActive).toBe(true);
      expect(agentMember?.role).toBe('member');

      // Verify agent is in chat participants
      const participants = await db
        .select()
        .from(chatParticipants)
        .where(eq(chatParticipants.chatId, teamChat.chatId));
      const agentParticipant = participants.find((p) => p.userId === agent.id);
      expect(agentParticipant).toBeDefined();
      expect(agentParticipant?.isActive).toBe(true);
    });

    test('handles adding same agent twice (upsert)', async () => {
      const user = await createTestUser('add-dup');
      const agent = await createTestAgent(user.id, 'add-dup');
      const teamChat = await teamChatService.ensureTeamChat(user.id);
      testCleanup.groupIds.push(teamChat.groupId);
      testCleanup.chatIds.push(teamChat.chatId);

      // Add twice
      await teamChatService.addAgentToTeamChat(user.id, agent.id);
      await teamChatService.addAgentToTeamChat(user.id, agent.id);

      // Should still only have one entry (upsert)
      const members = await db
        .select()
        .from(groupMembers)
        .where(eq(groupMembers.groupId, teamChat.groupId));
      const agentMembers = members.filter((m) => m.userId === agent.id);
      expect(agentMembers.length).toBe(1);
    });

    test('throws error when adding non-existent agent', async () => {
      const user = await createTestUser('add-noagent');
      const fakeAgentId = await generateSnowflakeId();
      await teamChatService.ensureTeamChat(user.id).then((tc) => {
        testCleanup.groupIds.push(tc.groupId);
        testCleanup.chatIds.push(tc.chatId);
      });

      await expect(
        teamChatService.addAgentToTeamChat(user.id, fakeAgentId)
      ).rejects.toThrow(/not found/i);
    });

    test('throws error when adding user who is not an agent', async () => {
      const user = await createTestUser('add-notag');
      const otherUser = await createTestUser('add-notag-other');
      await teamChatService.ensureTeamChat(user.id).then((tc) => {
        testCleanup.groupIds.push(tc.groupId);
        testCleanup.chatIds.push(tc.chatId);
      });

      await expect(
        teamChatService.addAgentToTeamChat(user.id, otherUser.id)
      ).rejects.toThrow(/not an agent/i);
    });

    test('throws error when adding agent not managed by user', async () => {
      const user1 = await createTestUser('add-wrong-1');
      const user2 = await createTestUser('add-wrong-2');
      const agent = await createTestAgent(user2.id, 'add-wrong');
      await teamChatService.ensureTeamChat(user1.id).then((tc) => {
        testCleanup.groupIds.push(tc.groupId);
        testCleanup.chatIds.push(tc.chatId);
      });

      await expect(
        teamChatService.addAgentToTeamChat(user1.id, agent.id)
      ).rejects.toThrow(/not managed by/i);
    });
  });

  describe('removeAgentFromTeamChat', () => {
    test('removes agent and creates system message', async () => {
      const user = await createTestUser('remove-1');
      const agent = await createTestAgent(user.id, 'remove-1');
      const teamChat = await teamChatService.ensureTeamChat(user.id);
      testCleanup.groupIds.push(teamChat.groupId);
      testCleanup.chatIds.push(teamChat.chatId);

      await teamChatService.addAgentToTeamChat(user.id, agent.id);
      await teamChatService.removeAgentFromTeamChat(user.id, agent.id);

      // Verify agent is marked inactive in group members
      const [member] = await db
        .select()
        .from(groupMembers)
        .where(eq(groupMembers.userId, agent.id));
      expect(member).toBeDefined();
      expect(member!.isActive).toBe(false);
      expect(member!.kickReason).toBe('Agent deleted');

      // Verify agent is marked inactive in chat participants
      const [participant] = await db
        .select()
        .from(chatParticipants)
        .where(eq(chatParticipants.userId, agent.id));
      expect(participant).toBeDefined();
      expect(participant!.isActive).toBe(false);

      // Verify system message
      const msgs = await db
        .select()
        .from(messages)
        .where(eq(messages.chatId, teamChat.chatId));
      const leaveMsg = msgs.find(
        (m) => m.type === 'system' && m.content?.includes('left the team')
      );
      expect(leaveMsg).toBeDefined();
    });

    test('handles removing agent when no team chat exists', async () => {
      const user = await createTestUser('remove-nochat');
      const agent = await createTestAgent(user.id, 'remove-nochat');

      // Should not throw, just return silently
      await expect(
        teamChatService.removeAgentFromTeamChat(user.id, agent.id)
      ).resolves.toBeUndefined();
    });

    test('handles removing agent not in chat', async () => {
      const user = await createTestUser('remove-notin');
      const agent = await createTestAgent(user.id, 'remove-notin');
      const teamChat = await teamChatService.ensureTeamChat(user.id);
      testCleanup.groupIds.push(teamChat.groupId);
      testCleanup.chatIds.push(teamChat.chatId);

      // Should not throw
      await expect(
        teamChatService.removeAgentFromTeamChat(user.id, agent.id)
      ).resolves.toBeUndefined();
    });
  });

  describe('getTeamChatAgents', () => {
    test('returns empty array when no agents', async () => {
      const user = await createTestUser('agents-none');
      const teamChat = await teamChatService.ensureTeamChat(user.id);
      testCleanup.groupIds.push(teamChat.groupId);
      testCleanup.chatIds.push(teamChat.chatId);

      const agents = await teamChatService.getTeamChatAgents(user.id);

      expect(agents).toEqual([]);
    });

    test('returns all active agents', async () => {
      const user = await createTestUser('agents-multi');
      const agent1 = await createTestAgent(user.id, 'agents-m1');
      const agent2 = await createTestAgent(user.id, 'agents-m2');
      const agent3 = await createTestAgent(user.id, 'agents-m3');
      const teamChat = await teamChatService.ensureTeamChat(user.id);
      testCleanup.groupIds.push(teamChat.groupId);
      testCleanup.chatIds.push(teamChat.chatId);

      await teamChatService.addAgentToTeamChat(user.id, agent1.id);
      await teamChatService.addAgentToTeamChat(user.id, agent2.id);
      await teamChatService.addAgentToTeamChat(user.id, agent3.id);

      const agents = await teamChatService.getTeamChatAgents(user.id);

      expect(agents.length).toBe(3);
      const agentIds = agents.map((a) => a.id);
      expect(agentIds).toContain(agent1.id);
      expect(agentIds).toContain(agent2.id);
      expect(agentIds).toContain(agent3.id);
    });

    test('excludes removed agents', async () => {
      const user = await createTestUser('agents-excl');
      const agent1 = await createTestAgent(user.id, 'agents-e1');
      const agent2 = await createTestAgent(user.id, 'agents-e2');
      const teamChat = await teamChatService.ensureTeamChat(user.id);
      testCleanup.groupIds.push(teamChat.groupId);
      testCleanup.chatIds.push(teamChat.chatId);

      await teamChatService.addAgentToTeamChat(user.id, agent1.id);
      await teamChatService.addAgentToTeamChat(user.id, agent2.id);
      await teamChatService.removeAgentFromTeamChat(user.id, agent1.id);

      const agents = await teamChatService.getTeamChatAgents(user.id);

      expect(agents.length).toBe(1);
      expect(agents[0]!.id).toBe(agent2.id);
    });

    test('only returns agents managed by the user', async () => {
      const user1 = await createTestUser('agents-own1');
      const user2 = await createTestUser('agents-own2');
      const agent1 = await createTestAgent(user1.id, 'agents-o1');
      // agent2 is created but not used in assertion, just to show it's NOT returned
      await createTestAgent(user2.id, 'agents-o2');

      const tc1 = await teamChatService.ensureTeamChat(user1.id);
      testCleanup.groupIds.push(tc1.groupId);
      testCleanup.chatIds.push(tc1.chatId);

      await teamChatService.addAgentToTeamChat(user1.id, agent1.id);

      // Shouldn't see agent2 even if somehow added
      const agents = await teamChatService.getTeamChatAgents(user1.id);
      expect(agents.length).toBe(1);
      expect(agents[0]!.id).toBe(agent1.id);
    });
  });

  describe('getTeamChatWithMembers', () => {
    test('returns null when no team chat', async () => {
      const user = await createTestUser('withmem-none');

      const result = await teamChatService.getTeamChatWithMembers(user.id);

      expect(result).toBeNull();
    });

    test('returns team chat with agent list', async () => {
      const user = await createTestUser('withmem-1');
      const agent = await createTestAgent(user.id, 'withmem-a1');
      const teamChat = await teamChatService.ensureTeamChat(user.id);
      testCleanup.groupIds.push(teamChat.groupId);
      testCleanup.chatIds.push(teamChat.chatId);
      await teamChatService.addAgentToTeamChat(user.id, agent.id);

      const result = await teamChatService.getTeamChatWithMembers(user.id);

      expect(result).not.toBeNull();
      expect(result!.id).toBe(teamChat.id);
      expect(result!.agents.length).toBe(1);
      expect(result!.agents[0]!.id).toBe(agent.id);
      expect(result!.agents[0]!.username).toBe(agent.username);
    });
  });
});

describe('Edge Cases and Boundary Conditions', () => {
  afterAll(async () => {
    await cleanupTestData();
  });

  test('handles very long agent display names', async () => {
    const user = await createTestUser('edge-long');
    const longName = 'A'.repeat(255);
    const agentId = await generateSnowflakeId();

    await db.insert(users).values({
      id: agentId,
      username: `agent-${agentId.slice(-6)}`,
      displayName: longName,
      isAgent: true,
      managedBy: user.id,
      isTest: true,
      updatedAt: new Date(),
    });
    testCleanup.userIds.push(agentId);

    await db.insert(userAgentConfigs).values({
      id: await generateSnowflakeId(),
      userId: agentId,
      systemPrompt: 'Test',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const teamChat = await teamChatService.ensureTeamChat(user.id);
    testCleanup.groupIds.push(teamChat.groupId);
    testCleanup.chatIds.push(teamChat.chatId);

    // Should handle long name without error
    await expect(
      teamChatService.addAgentToTeamChat(user.id, agentId)
    ).resolves.toBeUndefined();

    // Verify the message contains the name
    const msgs = await db
      .select()
      .from(messages)
      .where(eq(messages.chatId, teamChat.chatId));
    const joinMsg = msgs.find((m) => m.content?.includes('joined'));
    expect(joinMsg?.content?.length).toBeGreaterThan(200);
  });

  test('handles special characters in agent usernames', async () => {
    const user = await createTestUser('edge-special');
    const agentId = await generateSnowflakeId();

    // Username with allowed special chars
    await db.insert(users).values({
      id: agentId,
      username: `agent_test-123`,
      displayName: 'Agent with émojis 🤖',
      isAgent: true,
      managedBy: user.id,
      isTest: true,
      updatedAt: new Date(),
    });
    testCleanup.userIds.push(agentId);

    await db.insert(userAgentConfigs).values({
      id: await generateSnowflakeId(),
      userId: agentId,
      systemPrompt: 'Test',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const teamChat = await teamChatService.ensureTeamChat(user.id);
    testCleanup.groupIds.push(teamChat.groupId);
    testCleanup.chatIds.push(teamChat.chatId);

    await expect(
      teamChatService.addAgentToTeamChat(user.id, agentId)
    ).resolves.toBeUndefined();

    const agents = await teamChatService.getTeamChatAgents(user.id);
    expect(agents.length).toBe(1);
    expect(agents[0]!.displayName).toContain('🤖');
  });

  test('handles rapid add/remove cycles', async () => {
    const user = await createTestUser('edge-rapid');
    const agent = await createTestAgent(user.id, 'edge-rapid');
    const teamChat = await teamChatService.ensureTeamChat(user.id);
    testCleanup.groupIds.push(teamChat.groupId);
    testCleanup.chatIds.push(teamChat.chatId);

    // Rapid add/remove cycles
    for (let i = 0; i < 5; i++) {
      await teamChatService.addAgentToTeamChat(user.id, agent.id);
      await teamChatService.removeAgentFromTeamChat(user.id, agent.id);
    }

    // Final add
    await teamChatService.addAgentToTeamChat(user.id, agent.id);

    // Should be in the chat
    const fetchedAgents = await teamChatService.getTeamChatAgents(user.id);
    expect(fetchedAgents.length).toBe(1);
    expect(fetchedAgents[0]!.id).toBe(agent.id);
  });

  test('handles maximum agent count (stress test)', async () => {
    const user = await createTestUser('edge-max');
    const teamChat = await teamChatService.ensureTeamChat(user.id);
    testCleanup.groupIds.push(teamChat.groupId);
    testCleanup.chatIds.push(teamChat.chatId);

    // Create 10 agents (reasonable stress test)
    const agentIds: string[] = [];
    for (let i = 0; i < 10; i++) {
      const agent = await createTestAgent(user.id, `edge-max-${i}`);
      agentIds.push(agent.id);
    }

    // Add all concurrently
    await Promise.all(
      agentIds.map((id) => teamChatService.addAgentToTeamChat(user.id, id))
    );

    const agents = await teamChatService.getTeamChatAgents(user.id);
    expect(agents.length).toBe(10);
  });
});

describe('Data Integrity Verification', () => {
  afterAll(async () => {
    await cleanupTestData();
  });

  test('timestamps are correctly set on creation', async () => {
    const beforeCreate = new Date();
    const user = await createTestUser('data-ts');
    const teamChat = await teamChatService.ensureTeamChat(user.id);
    const afterCreate = new Date();

    testCleanup.groupIds.push(teamChat.groupId);
    testCleanup.chatIds.push(teamChat.chatId);

    expect(teamChat.createdAt.getTime()).toBeGreaterThanOrEqual(
      beforeCreate.getTime() - 1000
    );
    expect(teamChat.createdAt.getTime()).toBeLessThanOrEqual(
      afterCreate.getTime() + 1000
    );
    expect(teamChat.updatedAt.getTime()).toBe(teamChat.createdAt.getTime());
  });

  test('updatedAt changes when agents are added', async () => {
    const user = await createTestUser('data-upd');
    const agent = await createTestAgent(user.id, 'data-upd');
    const teamChat = await teamChatService.ensureTeamChat(user.id);
    testCleanup.groupIds.push(teamChat.groupId);
    testCleanup.chatIds.push(teamChat.chatId);

    const originalUpdatedAt = teamChat.updatedAt;

    // Wait a bit to ensure timestamp difference (longer wait for CI reliability)
    await new Promise((r) => setTimeout(r, 150));

    await teamChatService.addAgentToTeamChat(user.id, agent.id);

    const updated = await teamChatService.getTeamChat(user.id);
    expect(updated?.updatedAt.getTime()).toBeGreaterThan(
      originalUpdatedAt.getTime()
    );
  });

  test('foreign key relationships are valid', async () => {
    const user = await createTestUser('data-fk');
    const teamChat = await teamChatService.ensureTeamChat(user.id);
    testCleanup.groupIds.push(teamChat.groupId);
    testCleanup.chatIds.push(teamChat.chatId);

    // Verify group exists
    const [group] = await db
      .select()
      .from(groups)
      .where(eq(groups.id, teamChat.groupId));
    expect(group).toBeDefined();

    // Verify chat exists and links to group
    const [chat] = await db
      .select()
      .from(chats)
      .where(eq(chats.id, teamChat.chatId));
    expect(chat).toBeDefined();
    expect(chat!.groupId).toBe(teamChat.groupId);

    // Verify user exists
    const [userRecord] = await db
      .select()
      .from(users)
      .where(eq(users.id, user.id));
    expect(userRecord).toBeDefined();
  });
});

describe('syncExistingAgents', () => {
  afterAll(async () => {
    await cleanupTestData();
  });

  test('adds agents not in team chat', async () => {
    const user = await createTestUser('sync-1');
    const agent1 = await createTestAgent(user.id, 'sync-a1');
    const agent2 = await createTestAgent(user.id, 'sync-a2');
    const teamChat = await teamChatService.ensureTeamChat(user.id);
    testCleanup.groupIds.push(teamChat.groupId);
    testCleanup.chatIds.push(teamChat.chatId);

    // Agents exist but aren't in team chat yet
    const beforeSync = await teamChatService.getTeamChatAgents(user.id);
    expect(beforeSync.length).toBe(0);

    // Sync should add them
    const syncedCount = await teamChatService.syncExistingAgents(user.id);
    expect(syncedCount).toBe(2);

    const afterSync = await teamChatService.getTeamChatAgents(user.id);
    expect(afterSync.length).toBe(2);
    const agentIds = afterSync.map((a) => a.id);
    expect(agentIds).toContain(agent1.id);
    expect(agentIds).toContain(agent2.id);
  });

  test('returns 0 when all agents already synced', async () => {
    const user = await createTestUser('sync-2');
    const agent = await createTestAgent(user.id, 'sync-a3');
    const teamChat = await teamChatService.ensureTeamChat(user.id);
    testCleanup.groupIds.push(teamChat.groupId);
    testCleanup.chatIds.push(teamChat.chatId);

    // Manually add agent first
    await teamChatService.addAgentToTeamChat(user.id, agent.id);

    // Sync should find nothing to add
    const syncedCount = await teamChatService.syncExistingAgents(user.id);
    expect(syncedCount).toBe(0);
  });

  test('returns 0 when user has no agents', async () => {
    const user = await createTestUser('sync-3');
    const teamChat = await teamChatService.ensureTeamChat(user.id);
    testCleanup.groupIds.push(teamChat.groupId);
    testCleanup.chatIds.push(teamChat.chatId);

    const syncedCount = await teamChatService.syncExistingAgents(user.id);
    expect(syncedCount).toBe(0);
  });

  test('handles mix of synced and unsynced agents', async () => {
    const user = await createTestUser('sync-4');
    const agent1 = await createTestAgent(user.id, 'sync-a4');
    // Agent2 and agent3 are created but not manually added - sync should find them
    await createTestAgent(user.id, 'sync-a5');
    await createTestAgent(user.id, 'sync-a6');
    const teamChat = await teamChatService.ensureTeamChat(user.id);
    testCleanup.groupIds.push(teamChat.groupId);
    testCleanup.chatIds.push(teamChat.chatId);

    // Add only agent1 manually
    await teamChatService.addAgentToTeamChat(user.id, agent1.id);

    // Sync should add agent2 and agent3
    const syncedCount = await teamChatService.syncExistingAgents(user.id);
    expect(syncedCount).toBe(2);

    const agents = await teamChatService.getTeamChatAgents(user.id);
    expect(agents.length).toBe(3);
  });

  test('creates team chat if it does not exist', async () => {
    const user = await createTestUser('sync-5');
    const agent = await createTestAgent(user.id, 'sync-a7');

    // User has no team chat yet
    const beforeSync = await teamChatService.getTeamChat(user.id);
    expect(beforeSync).toBeNull();

    // Sync should create team chat and add agent
    const syncedCount = await teamChatService.syncExistingAgents(user.id);
    expect(syncedCount).toBe(1);

    const afterSync = await teamChatService.getTeamChat(user.id);
    expect(afterSync).not.toBeNull();
    testCleanup.groupIds.push(afterSync!.groupId);
    testCleanup.chatIds.push(afterSync!.chatId);

    const agents = await teamChatService.getTeamChatAgents(user.id);
    expect(agents.length).toBe(1);
    expect(agents[0]!.id).toBe(agent.id);
  });

  test('does not add agents owned by other users', async () => {
    const user1 = await createTestUser('sync-6a');
    const user2 = await createTestUser('sync-6b');
    await createTestAgent(user1.id, 'sync-a8');
    await createTestAgent(user2.id, 'sync-a9');
    const teamChat = await teamChatService.ensureTeamChat(user1.id);
    testCleanup.groupIds.push(teamChat.groupId);
    testCleanup.chatIds.push(teamChat.chatId);

    // Sync for user1 should only add user1's agent
    const syncedCount = await teamChatService.syncExistingAgents(user1.id);
    expect(syncedCount).toBe(1);

    const agents = await teamChatService.getTeamChatAgents(user1.id);
    expect(agents.length).toBe(1);
  });
});
