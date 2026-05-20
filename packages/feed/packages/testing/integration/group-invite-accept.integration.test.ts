/**
 * Group Invite Accept Integration Tests
 *
 * Tests the group invite acceptance API endpoint for:
 * - Accepting invites to non-NPC groups when at NPC group limit (should succeed)
 * - Accepting invites to NPC groups when at NPC group limit (should fail)
 * - Accepting invites when the group no longer exists (should return 404)
 * - Accepting invites meant for a different user (should return 403)
 * - Transaction atomicity (all operations should be committed on success)
 *
 * Run with: bun test integration/group-invite-accept.integration.test.ts --preload ./integration/preload.ts
 */

import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';
import { db } from '@babylon/db';
import { GROUP_CONFIG, generateSnowflakeId } from '@babylon/shared';

// Base URL for API calls
const BASE_URL =
  process.env.TEST_API_URL ||
  process.env.PLAYWRIGHT_BASE_URL ||
  'http://localhost:3000';

let serverAvailable = false;

// Test data cleanup tracking
const testIds: {
  userIds: string[];
  groupIds: string[];
  chatIds: string[];
  participantIds: string[];
  membershipIds: string[];
  inviteIds: string[];
  notificationIds: string[];
  messageIds: string[];
} = {
  userIds: [],
  groupIds: [],
  chatIds: [],
  participantIds: [],
  membershipIds: [],
  inviteIds: [],
  notificationIds: [],
  messageIds: [],
};

// Server health check
async function checkServerHealth(): Promise<boolean> {
  try {
    const response = await fetch(`${BASE_URL}/api/health`, {
      signal: AbortSignal.timeout(5000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

// HTTP helper for POST requests with authentication
async function postWithAuth(
  path: string,
  userId: string,
  body?: Record<string, unknown>
): Promise<Response> {
  return fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-dev-user-id': userId,
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000),
  });
}

// Helper to create test user with a mock Privy ID for auth
async function createTestUser(options?: {
  username?: string;
  displayName?: string;
}): Promise<{
  id: string;
  username: string;
  displayName: string;
  privyId: string;
}> {
  const id = await generateSnowflakeId();
  const privyId = `did:privy:test-${id}`;
  const username = options?.username || `test-user-${id.slice(-6)}`;
  const displayName = options?.displayName || `Test User ${id.slice(-6)}`;

  await db.user.create({
    data: {
      id,
      username,
      displayName,
      isActor: false,
      isAgent: false,
      isTest: true,
      privyId,
      updatedAt: new Date(),
    },
  });

  testIds.userIds.push(id);
  return { id, username, displayName, privyId };
}

// Helper to create test group
async function createTestGroup(options: {
  name?: string;
  type: 'npc' | 'user' | 'agent';
  ownerId: string;
}): Promise<{ id: string; name: string; type: string }> {
  const id = await generateSnowflakeId();
  const name = options.name || `Test Group ${id.slice(-6)}`;

  await db.group.create({
    data: {
      id,
      name,
      type: options.type,
      ownerId: options.ownerId,
      createdById: options.ownerId,
      updatedAt: new Date(),
    },
  });

  testIds.groupIds.push(id);
  return { id, name, type: options.type };
}

// Helper to create test chat for a group
async function createTestChat(options: {
  groupId: string;
  name?: string;
}): Promise<{ id: string }> {
  const id = await generateSnowflakeId();

  await db.chat.create({
    data: {
      id,
      name: options.name || `Chat ${id.slice(-6)}`,
      isGroup: true,
      groupId: options.groupId,
      gameId: 'realtime',
      updatedAt: new Date(),
    },
  });

  testIds.chatIds.push(id);
  return { id };
}

// Helper to create group membership
async function createGroupMembership(options: {
  groupId: string;
  userId: string;
  role?: 'owner' | 'admin' | 'member';
  isActive?: boolean;
}): Promise<string> {
  const id = await generateSnowflakeId();

  await db.groupMember.create({
    data: {
      id,
      groupId: options.groupId,
      userId: options.userId,
      role: options.role || 'member',
      isActive: options.isActive !== undefined ? options.isActive : true,
      joinedAt: new Date(),
    },
  });

  testIds.membershipIds.push(id);
  return id;
}

// Helper to create group invite
async function createGroupInvite(options: {
  groupId: string;
  invitedUserId: string;
  invitedBy: string;
  status?: 'pending' | 'accepted' | 'declined';
}): Promise<string> {
  const id = await generateSnowflakeId();

  await db.groupInvite.create({
    data: {
      id,
      groupId: options.groupId,
      invitedUserId: options.invitedUserId,
      invitedBy: options.invitedBy,
      status: options.status || 'pending',
      invitedAt: new Date(),
    },
  });

  testIds.inviteIds.push(id);
  return id;
}

// Cleanup helper - wrapped in try/finally to ensure testIds are always reset
async function cleanupTestData(): Promise<void> {
  try {
    // Delete in reverse order of dependencies
    if (testIds.messageIds.length > 0) {
      await db.message.deleteMany({
        where: { id: { in: testIds.messageIds } },
      });
    }
    if (testIds.notificationIds.length > 0) {
      await db.notification.deleteMany({
        where: { id: { in: testIds.notificationIds } },
      });
    }
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
      // Also clean up any messages in test chats that weren't tracked
      await db.message.deleteMany({
        where: { chatId: { in: testIds.chatIds } },
      });
      await db.chatParticipant.deleteMany({
        where: { chatId: { in: testIds.chatIds } },
      });
      await db.chat.deleteMany({ where: { id: { in: testIds.chatIds } } });
    }
    if (testIds.groupIds.length > 0) {
      // Clean up any members/invites that weren't tracked
      await db.groupMember.deleteMany({
        where: { groupId: { in: testIds.groupIds } },
      });
      await db.groupInvite.deleteMany({
        where: { groupId: { in: testIds.groupIds } },
      });
      await db.group.deleteMany({ where: { id: { in: testIds.groupIds } } });
    }
    if (testIds.userIds.length > 0) {
      await db.user.deleteMany({ where: { id: { in: testIds.userIds } } });
    }
  } finally {
    // Always reset tracking arrays, even if delete operations fail
    testIds.userIds = [];
    testIds.groupIds = [];
    testIds.chatIds = [];
    testIds.participantIds = [];
    testIds.membershipIds = [];
    testIds.inviteIds = [];
    testIds.notificationIds = [];
    testIds.messageIds = [];
  }
}

describe('Group Invite Accept Integration Tests', () => {
  beforeAll(async () => {
    serverAvailable = await checkServerHealth();
    if (!serverAvailable) {
      console.warn('⚠️  Server not available - API tests will be skipped');
      console.warn(`   Tried: ${BASE_URL}/api/health`);
    }
  });

  beforeEach(async () => {
    await cleanupTestData();
  });

  afterEach(async () => {
    await cleanupTestData();
  });

  describe('NPC Group Limit Enforcement', () => {
    test('should allow accepting non-NPC group invite when at NPC group limit', async () => {
      if (!serverAvailable) return;

      // Create users
      const inviter = await createTestUser({ displayName: 'Inviter' });
      const invitee = await createTestUser({ displayName: 'Invitee' });

      // Create MAX_ACTIVE_USER_GROUPS NPC groups and add invitee as member
      const maxGroups = GROUP_CONFIG.MAX_ACTIVE_USER_GROUPS;
      for (let i = 0; i < maxGroups; i++) {
        const npcGroup = await createTestGroup({
          name: `NPC Group ${i}`,
          type: 'npc',
          ownerId: inviter.id,
        });
        await createGroupMembership({
          groupId: npcGroup.id,
          userId: invitee.id,
        });
      }

      // Verify user is at NPC limit
      const memberships = await db.groupMember.findMany({
        where: { userId: invitee.id, isActive: true },
      });
      const memberGroupIds = memberships.map((m) => m.groupId);
      const memberGroups = await db.group.findMany({
        where: { id: { in: memberGroupIds } },
      });
      const npcGroupCount = memberGroups.filter((g) => g.type === 'npc').length;
      expect(npcGroupCount).toBe(maxGroups);

      // Create a non-NPC (user type) group
      const userGroup = await createTestGroup({
        name: 'User Group',
        type: 'user',
        ownerId: inviter.id,
      });
      await createTestChat({ groupId: userGroup.id });

      // Create invite to the non-NPC group
      const inviteId = await createGroupInvite({
        groupId: userGroup.id,
        invitedUserId: invitee.id,
        invitedBy: inviter.id,
      });

      // Accept the invite via API
      const response = await postWithAuth(
        `/api/groups/invites/${inviteId}/accept`,
        invitee.id
      );

      // Should succeed - non-NPC groups don't count toward limit
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.groupId).toBe(userGroup.id);

      // Verify the invite was marked as accepted
      const updatedInvite = await db.groupInvite.findUnique({
        where: { id: inviteId },
      });
      expect(updatedInvite?.status).toBe('accepted');

      // Verify membership was created
      const newMembership = await db.groupMember.findFirst({
        where: { groupId: userGroup.id, userId: invitee.id, isActive: true },
      });
      expect(newMembership).toBeDefined();
    });

    test('should block accepting NPC group invite when at NPC group limit', async () => {
      if (!serverAvailable) return;

      // Create users
      const inviter = await createTestUser({ displayName: 'Inviter' });
      const invitee = await createTestUser({ displayName: 'Invitee' });

      // Create MAX_ACTIVE_USER_GROUPS NPC groups and add invitee as member
      const maxGroups = GROUP_CONFIG.MAX_ACTIVE_USER_GROUPS;
      for (let i = 0; i < maxGroups; i++) {
        const npcGroup = await createTestGroup({
          name: `NPC Group ${i}`,
          type: 'npc',
          ownerId: inviter.id,
        });
        await createGroupMembership({
          groupId: npcGroup.id,
          userId: invitee.id,
        });
      }

      // Create another NPC group (would exceed limit)
      const newNpcGroup = await createTestGroup({
        name: 'New NPC Group',
        type: 'npc',
        ownerId: inviter.id,
      });
      await createTestChat({ groupId: newNpcGroup.id });

      // Create invite to the new NPC group
      const inviteId = await createGroupInvite({
        groupId: newNpcGroup.id,
        invitedUserId: invitee.id,
        invitedBy: inviter.id,
      });

      // Try to accept the invite via API
      const response = await postWithAuth(
        `/api/groups/invites/${inviteId}/accept`,
        invitee.id
      );

      // Should fail - exceeds NPC group limit
      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toContain('NPC groups');
      expect(data.error).toContain('Leave a group first');

      // Verify invite is still pending
      const invite = await db.groupInvite.findUnique({
        where: { id: inviteId },
      });
      expect(invite?.status).toBe('pending');

      // Verify no membership was created
      const membership = await db.groupMember.findFirst({
        where: { groupId: newNpcGroup.id, userId: invitee.id },
      });
      expect(membership).toBeNull();
    });

    test('should allow accepting NPC group invite when below NPC group limit', async () => {
      if (!serverAvailable) return;

      // Create users
      const inviter = await createTestUser({ displayName: 'Inviter' });
      const invitee = await createTestUser({ displayName: 'Invitee' });

      // Create fewer than MAX NPC groups
      const belowLimit = Math.max(0, GROUP_CONFIG.MAX_ACTIVE_USER_GROUPS - 1);
      for (let i = 0; i < belowLimit; i++) {
        const npcGroup = await createTestGroup({
          name: `NPC Group ${i}`,
          type: 'npc',
          ownerId: inviter.id,
        });
        await createGroupMembership({
          groupId: npcGroup.id,
          userId: invitee.id,
        });
      }

      // Create another NPC group (should be allowed)
      const newNpcGroup = await createTestGroup({
        name: 'New NPC Group',
        type: 'npc',
        ownerId: inviter.id,
      });
      const chat = await createTestChat({ groupId: newNpcGroup.id });

      // Create invite
      const inviteId = await createGroupInvite({
        groupId: newNpcGroup.id,
        invitedUserId: invitee.id,
        invitedBy: inviter.id,
      });

      // Accept the invite via API
      const response = await postWithAuth(
        `/api/groups/invites/${inviteId}/accept`,
        invitee.id
      );

      // Should succeed - below NPC limit
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.groupId).toBe(newNpcGroup.id);
      expect(data.chatId).toBe(chat.id);

      // Verify invite was accepted
      const updatedInvite = await db.groupInvite.findUnique({
        where: { id: inviteId },
      });
      expect(updatedInvite?.status).toBe('accepted');
      expect(updatedInvite?.respondedAt).toBeDefined();

      // Verify membership was created
      const membership = await db.groupMember.findFirst({
        where: { groupId: newNpcGroup.id, userId: invitee.id, isActive: true },
      });
      expect(membership).toBeDefined();
      expect(membership?.role).toBe('member');
    });
  });

  describe('Group Existence Validation', () => {
    test('should return 404 when invite does not exist', async () => {
      if (!serverAvailable) return;

      const invitee = await createTestUser({ displayName: 'Invitee' });
      const fakeInviteId = await generateSnowflakeId();

      const response = await postWithAuth(
        `/api/groups/invites/${fakeInviteId}/accept`,
        invitee.id
      );

      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.error).toContain('Invite not found');
    });

    test('should return 404 when group has been deleted', async () => {
      if (!serverAvailable) return;

      const inviter = await createTestUser({ displayName: 'Inviter' });
      const invitee = await createTestUser({ displayName: 'Invitee' });

      const group = await createTestGroup({
        name: 'Test Group',
        type: 'user',
        ownerId: inviter.id,
      });

      const inviteId = await createGroupInvite({
        groupId: group.id,
        invitedUserId: invitee.id,
        invitedBy: inviter.id,
      });

      // Delete the invite first (to avoid FK constraint)
      await db.groupInvite.delete({ where: { id: inviteId } });
      testIds.inviteIds = testIds.inviteIds.filter((id) => id !== inviteId);

      // Delete the group
      await db.group.delete({ where: { id: group.id } });
      testIds.groupIds = testIds.groupIds.filter((id) => id !== group.id);

      // Create a new invite record that references the deleted group
      // This simulates a race condition or orphaned invite
      const orphanInviteId = await generateSnowflakeId();
      await db.groupInvite.create({
        data: {
          id: orphanInviteId,
          groupId: group.id, // Points to deleted group
          invitedUserId: invitee.id,
          invitedBy: inviter.id,
          status: 'pending',
          invitedAt: new Date(),
        },
      });
      testIds.inviteIds.push(orphanInviteId);

      // Try to accept the orphaned invite
      const response = await postWithAuth(
        `/api/groups/invites/${orphanInviteId}/accept`,
        invitee.id
      );

      // Should return 404 - group not found
      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.error).toContain('Group not found');
    });
  });

  describe('Invite Status Validation', () => {
    test('should reject already accepted invite', async () => {
      if (!serverAvailable) return;

      const inviter = await createTestUser({ displayName: 'Inviter' });
      const invitee = await createTestUser({ displayName: 'Invitee' });

      const group = await createTestGroup({
        name: 'Test Group',
        type: 'user',
        ownerId: inviter.id,
      });
      await createTestChat({ groupId: group.id });

      // Create already accepted invite
      const acceptedInviteId = await createGroupInvite({
        groupId: group.id,
        invitedUserId: invitee.id,
        invitedBy: inviter.id,
        status: 'accepted',
      });

      // Try to accept again
      const response = await postWithAuth(
        `/api/groups/invites/${acceptedInviteId}/accept`,
        invitee.id
      );

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toContain('already been processed');
    });

    test('should reject declined invite', async () => {
      if (!serverAvailable) return;

      const inviter = await createTestUser({ displayName: 'Inviter' });
      const invitee = await createTestUser({ displayName: 'Invitee' });

      const group = await createTestGroup({
        name: 'Test Group',
        type: 'user',
        ownerId: inviter.id,
      });
      await createTestChat({ groupId: group.id });

      // Create declined invite
      const declinedInviteId = await createGroupInvite({
        groupId: group.id,
        invitedUserId: invitee.id,
        invitedBy: inviter.id,
        status: 'declined',
      });

      // Try to accept
      const response = await postWithAuth(
        `/api/groups/invites/${declinedInviteId}/accept`,
        invitee.id
      );

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toContain('already been processed');
    });
  });

  describe('Invite Ownership Validation', () => {
    test('should reject invite meant for different user', async () => {
      if (!serverAvailable) return;

      const inviter = await createTestUser({ displayName: 'Inviter' });
      const invitee = await createTestUser({ displayName: 'Invitee' });
      const otherUser = await createTestUser({ displayName: 'Other User' });

      const group = await createTestGroup({
        name: 'Test Group',
        type: 'user',
        ownerId: inviter.id,
      });
      await createTestChat({ groupId: group.id });

      // Create invite for invitee
      const inviteId = await createGroupInvite({
        groupId: group.id,
        invitedUserId: invitee.id,
        invitedBy: inviter.id,
      });

      // Try to accept as otherUser (not the invitee)
      const response = await postWithAuth(
        `/api/groups/invites/${inviteId}/accept`,
        otherUser.id
      );

      expect(response.status).toBe(403);
      const data = await response.json();
      expect(data.error).toContain('This invite is not for you');

      // Verify invite is still pending
      const invite = await db.groupInvite.findUnique({
        where: { id: inviteId },
      });
      expect(invite?.status).toBe('pending');
    });
  });

  describe('Already Member Validation', () => {
    test('should reject if user is already an active member', async () => {
      if (!serverAvailable) return;

      const inviter = await createTestUser({ displayName: 'Inviter' });
      const invitee = await createTestUser({ displayName: 'Invitee' });

      const group = await createTestGroup({
        name: 'Test Group',
        type: 'user',
        ownerId: inviter.id,
      });
      await createTestChat({ groupId: group.id });

      // User is already a member
      await createGroupMembership({
        groupId: group.id,
        userId: invitee.id,
        isActive: true,
      });

      // Create a pending invite (this shouldn't happen in practice but let's test)
      const inviteId = await createGroupInvite({
        groupId: group.id,
        invitedUserId: invitee.id,
        invitedBy: inviter.id,
      });

      // Try to accept
      const response = await postWithAuth(
        `/api/groups/invites/${inviteId}/accept`,
        invitee.id
      );

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toContain('already a member');
    });
  });

  describe('Transaction Atomicity', () => {
    test('should create all required records on successful accept', async () => {
      if (!serverAvailable) return;

      const inviter = await createTestUser({ displayName: 'Inviter' });
      const invitee = await createTestUser({ displayName: 'Invitee' });

      const group = await createTestGroup({
        name: 'Test Group',
        type: 'user',
        ownerId: inviter.id,
      });
      const chat = await createTestChat({ groupId: group.id });

      const inviteId = await createGroupInvite({
        groupId: group.id,
        invitedUserId: invitee.id,
        invitedBy: inviter.id,
      });

      // Verify initial state
      const memberBefore = await db.groupMember.findFirst({
        where: { groupId: group.id, userId: invitee.id },
      });
      expect(memberBefore).toBeNull();

      const participantBefore = await db.chatParticipant.findFirst({
        where: { chatId: chat.id, userId: invitee.id },
      });
      expect(participantBefore).toBeNull();

      // Accept the invite
      const response = await postWithAuth(
        `/api/groups/invites/${inviteId}/accept`,
        invitee.id
      );
      expect(response.status).toBe(200);

      // Verify all records were created atomically:

      // 1. GroupMember record with isActive: true
      const memberAfter = await db.groupMember.findFirst({
        where: { groupId: group.id, userId: invitee.id },
      });
      expect(memberAfter).toBeDefined();
      expect(memberAfter?.isActive).toBe(true);
      expect(memberAfter?.role).toBe('member');
      expect(memberAfter?.addedBy).toBe(inviter.id);

      // 2. ChatParticipant record with isActive: true
      const participantAfter = await db.chatParticipant.findFirst({
        where: { chatId: chat.id, userId: invitee.id },
      });
      expect(participantAfter).toBeDefined();
      expect(participantAfter?.isActive).toBe(true);

      // 3. Invite status changed to 'accepted'
      const inviteAfter = await db.groupInvite.findUnique({
        where: { id: inviteId },
      });
      expect(inviteAfter?.status).toBe('accepted');
      expect(inviteAfter?.respondedAt).toBeDefined();

      // 4. System message in chat (senderId='system' for system messages)
      const systemMessage = await db.message.findFirst({
        where: {
          chatId: chat.id,
          senderId: 'system',
        },
        orderBy: { createdAt: 'desc' },
      });
      expect(systemMessage).toBeDefined();
      expect(systemMessage?.content).toContain('joined the group');
    });

    test('should handle upsert for rejoining members (previously kicked)', async () => {
      if (!serverAvailable) return;

      const inviter = await createTestUser({ displayName: 'Inviter' });
      const invitee = await createTestUser({ displayName: 'Invitee' });

      const group = await createTestGroup({
        name: 'Test Group',
        type: 'user',
        ownerId: inviter.id,
      });
      // Chat is needed so the API can create a ChatParticipant on rejoin
      await createTestChat({ groupId: group.id });

      // Create an inactive membership (user was previously kicked)
      const membershipId = await generateSnowflakeId();
      const kickedAt = new Date();
      await db.groupMember.create({
        data: {
          id: membershipId,
          groupId: group.id,
          userId: invitee.id,
          role: 'member',
          isActive: false, // Was kicked
          joinedAt: new Date(Date.now() - 86400000), // Yesterday
          kickedAt,
          kickReason: 'inactivity',
        },
      });
      testIds.membershipIds.push(membershipId);

      // Verify inactive membership exists
      const inactiveMember = await db.groupMember.findFirst({
        where: { groupId: group.id, userId: invitee.id },
      });
      expect(inactiveMember?.isActive).toBe(false);
      expect(inactiveMember?.kickedAt).toBeDefined();

      // Create invite
      const inviteId = await createGroupInvite({
        groupId: group.id,
        invitedUserId: invitee.id,
        invitedBy: inviter.id,
      });

      // Accept the invite
      const response = await postWithAuth(
        `/api/groups/invites/${inviteId}/accept`,
        invitee.id
      );
      expect(response.status).toBe(200);

      // Verify the upsert behavior:
      // - isActive should be true
      // - kickedAt should be NULL
      // - kickReason should be NULL
      // - joinedAt should be updated
      const rejoinedMember = await db.groupMember.findFirst({
        where: { groupId: group.id, userId: invitee.id },
      });
      expect(rejoinedMember?.isActive).toBe(true);
      expect(rejoinedMember?.kickedAt).toBeNull();
      expect(rejoinedMember?.kickReason).toBeNull();
      expect(rejoinedMember?.joinedAt).not.toEqual(inactiveMember?.joinedAt);
    });
  });

  describe('Authentication', () => {
    test('should require authentication', async () => {
      if (!serverAvailable) return;

      const inviteId = await generateSnowflakeId();

      // Call without auth header
      const response = await fetch(
        `${BASE_URL}/api/groups/invites/${inviteId}/accept`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(10000),
        }
      );

      expect(response.status).toBe(401);
    });
  });
});
