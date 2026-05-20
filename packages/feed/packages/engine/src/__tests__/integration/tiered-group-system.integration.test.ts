/**
 * Tiered Group System Integration Tests
 *
 * Tests the complete tiered group system including:
 * - Tier group creation for NPCs
 * - User assignment to tiers based on engagement
 * - Default group assignment for new users
 * - Agent inheritance of owner's group access
 * - Promotion and demotion mechanics
 *
 * These tests verify the full user journey from signup to tier progression.
 *
 * NOTE: These tests use real NPCs from StaticDataRegistry because TieredGroupService
 * validates NPCs against the registry. Test users are created in the database.
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
  GroupChatService,
  StaticDataRegistry,
  TieredGroupService,
  UserAlphaGroupAssignmentService,
} from '@feed/engine';
import { GROUP_CONFIG, generateSnowflakeId } from '@feed/shared';

// Set timeout to 60 seconds for integration tests
setDefaultTimeout(60000);

// Test data cleanup tracking
const testIds = {
  userIds: [] as string[],
  membershipIds: [] as string[],
  participantIds: [] as string[],
};

// Get a real NPC from the static registry for testing
function getTestNpc(): { id: string; name: string } {
  const actors = StaticDataRegistry.getAllActors();
  if (actors.length === 0) {
    throw new Error(
      'No actors in StaticDataRegistry - cannot run integration tests'
    );
  }
  // Use the first non-test actor; fail fast if none found
  const actor = actors.find((a) => !a.isTest);
  if (!actor) {
    throw new Error(
      'No non-test actors available in StaticDataRegistry - cannot run integration tests. ' +
        'Ensure real NPC data is loaded before running integration tests.'
    );
  }
  return { id: actor.id, name: actor.name };
}

// ============ HELPER FUNCTIONS ============

async function createTestUser(options: {
  displayName?: string;
  isAgent?: boolean;
  managedBy?: string;
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
      managedBy: options.managedBy,
      isTest: true,
      updatedAt: new Date(),
    },
  });

  testIds.userIds.push(id);
  return { id, displayName };
}

async function cleanupTestData(): Promise<void> {
  // Delete in reverse order of dependencies
  // Only clean up user-created test data, not NPC tier groups
  if (testIds.participantIds.length > 0) {
    await db.chatParticipant.deleteMany({
      where: { id: { in: testIds.participantIds } },
    });
  }
  if (testIds.membershipIds.length > 0) {
    await db.groupMember.deleteMany({
      where: { id: { in: testIds.membershipIds } },
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

describe('Tiered Group System', () => {
  beforeAll(async () => {
    await cleanupTestData();
  });

  afterAll(async () => {
    await cleanupTestData();
  });

  describe('TieredGroupService.ensureAllTiersExist', () => {
    test('should create all 3 tier groups for a real NPC', async () => {
      const npc = getTestNpc();

      const tiers = await TieredGroupService.ensureAllTiersExist(npc.id);

      expect(tiers).toHaveLength(3);

      // Verify tier 1 (Inner Circle)
      const tier1 = tiers.find((t) => t.tier === 1);
      expect(tier1).toBeDefined();
      expect(tier1!.groupName).toContain('Inner Circle');
      expect(tier1!.maxMembers).toBe(12);

      // Verify tier 2 (Community)
      const tier2 = tiers.find((t) => t.tier === 2);
      expect(tier2).toBeDefined();
      expect(tier2!.groupName).toContain('Community');
      expect(tier2!.maxMembers).toBe(50);

      // Verify tier 3 (Followers)
      const tier3 = tiers.find((t) => t.tier === 3);
      expect(tier3).toBeDefined();
      expect(tier3!.groupName).toContain('Followers');
      expect(tier3!.maxMembers).toBe(500);

      // All should have associated chats
      for (const tier of tiers) {
        expect(tier.chatId).toBeTruthy();
      }
    });

    test('should be idempotent - not create duplicates', async () => {
      const npc = getTestNpc();

      // Create tiers twice
      const tiers1 = await TieredGroupService.ensureAllTiersExist(npc.id);
      const tiers2 = await TieredGroupService.ensureAllTiersExist(npc.id);

      // Should have same IDs
      expect(tiers1.map((t) => t.groupId).sort()).toEqual(
        tiers2.map((t) => t.groupId).sort()
      );
    });

    test('should return empty array for unknown NPC', async () => {
      const tiers =
        await TieredGroupService.ensureAllTiersExist('unknown-npc-id');
      expect(tiers).toHaveLength(0);
    });
  });

  describe('TieredGroupService.getNpcTiers', () => {
    test('should return all tier groups for an NPC', async () => {
      const npc = getTestNpc();
      await TieredGroupService.ensureAllTiersExist(npc.id);

      const tiers = await TieredGroupService.getNpcTiers(npc.id);

      expect(tiers).toHaveLength(3);
      expect(tiers.map((t) => t.tier).sort()).toEqual([1, 2, 3]);
    });

    test('should return sorted tiers (1, 2, 3)', async () => {
      const npc = getTestNpc();
      await TieredGroupService.ensureAllTiersExist(npc.id);

      const tiers = await TieredGroupService.getNpcTiers(npc.id);

      expect(tiers[0]!.tier).toBe(1);
      expect(tiers[1]!.tier).toBe(2);
      expect(tiers[2]!.tier).toBe(3);
    });
  });

  describe('TieredGroupService.inviteUserToTier', () => {
    afterEach(async () => {
      await cleanupTestData();
    });

    test('should reject user with no engagement (below Tier 3 threshold)', async () => {
      const npc = getTestNpc();
      const user = await createTestUser({
        displayName: 'New User No Engagement',
      });
      await TieredGroupService.ensureAllTiersExist(npc.id);

      // User with 0 engagement should NOT be invited (min score is 20 for Tier 3)
      const result = await TieredGroupService.inviteUserToTier(user.id, npc.id);

      // Should fail because engagement score is 0 (below min 20 for Tier 3)
      expect(result.success).toBe(false);
      expect(result.reason).toContain('No available tier');
    });

    test('should fail for invalid NPC ID', async () => {
      const user = await createTestUser({
        displayName: 'User for Invalid NPC',
      });

      const result = await TieredGroupService.inviteUserToTier(
        user.id,
        'invalid-npc-id'
      );

      expect(result.success).toBe(false);
      expect(result.reason).toContain('Invalid NPC ID');
    });
  });

  describe('TieredGroupService.getGlobalAnalytics', () => {
    test('should return tier analytics structure', async () => {
      const analytics = await TieredGroupService.getGlobalAnalytics();

      expect(analytics).toHaveProperty('totalNpcs');
      expect(analytics).toHaveProperty('totalGroups');
      expect(analytics).toHaveProperty('totalMembers');
      expect(analytics).toHaveProperty('totalCapacity');
      expect(analytics).toHaveProperty('fillRate');
      expect(analytics).toHaveProperty('tierBreakdown');

      expect(analytics.tierBreakdown).toHaveLength(3);
      for (const breakdown of analytics.tierBreakdown) {
        expect(breakdown).toHaveProperty('tier');
        expect(breakdown).toHaveProperty('members');
        expect(breakdown).toHaveProperty('capacity');
        expect(breakdown).toHaveProperty('fillRate');
      }
    });
  });
});

describe('UserAlphaGroupAssignmentService', () => {
  beforeAll(async () => {
    await cleanupTestData();
  });

  afterAll(async () => {
    await cleanupTestData();
  });

  describe('assignDefaultGroups', () => {
    beforeEach(async () => {
      await cleanupTestData();
    });

    afterEach(async () => {
      await cleanupTestData();
    });

    test('should not assign groups to non-existent user', async () => {
      const result = await UserAlphaGroupAssignmentService.assignDefaultGroups(
        'non-existent-user-id'
      );

      expect(result.success).toBe(false);
      expect(result.groupsAssigned).toBe(0);
      expect(result.errors).toContain('User non-existent-user-id not found');
    });

    test('should not assign groups to NPC actors', async () => {
      const npc = getTestNpc();

      const result = await UserAlphaGroupAssignmentService.assignDefaultGroups(
        npc.id
      );

      expect(result.success).toBe(false);
      expect(result.errors).toContain('Cannot assign groups to NPC actors');
    });

    test('should not assign groups to agents (they inherit)', async () => {
      const owner = await createTestUser({ displayName: 'Owner' });
      const agent = await createTestUser({
        displayName: 'Agent',
        isAgent: true,
        managedBy: owner.id,
      });

      const result = await UserAlphaGroupAssignmentService.assignDefaultGroups(
        agent.id
      );

      expect(result.success).toBe(false);
      expect(result.errors).toContain(
        'Agents inherit group access from their owner'
      );
    });

    test('should return capacity stats', async () => {
      const stats = await UserAlphaGroupAssignmentService.getCapacityStats();

      expect(stats).toHaveProperty('totalTier3Groups');
      expect(stats).toHaveProperty('totalTier3Capacity');
      expect(stats).toHaveProperty('currentTier3Members');
      expect(stats).toHaveProperty('availableSlots');
      expect(stats).toHaveProperty('fillRate');
      expect(stats).toHaveProperty('maxUsersCanServe');

      expect(typeof stats.fillRate).toBe('number');
      expect(stats.fillRate).toBeGreaterThanOrEqual(0);
      expect(stats.fillRate).toBeLessThanOrEqual(1);
    });
  });
});

describe('Agent Group Inheritance', () => {
  beforeAll(async () => {
    await cleanupTestData();
  });

  afterAll(async () => {
    await cleanupTestData();
  });

  describe('GroupChatService.isInChat', () => {
    afterEach(async () => {
      await cleanupTestData();
    });

    test('should return true for direct member (via default assignment)', async () => {
      const user = await createTestUser({ displayName: 'Direct Member' });

      // Use the default assignment service (bypasses engagement requirement)
      const assignResult =
        await UserAlphaGroupAssignmentService.assignDefaultGroups(user.id);

      // Should have assigned at least one group
      expect(assignResult.success).toBe(true);
      expect(assignResult.assignments.length).toBeGreaterThan(0);

      // Check that user is in one of the assigned chats
      const firstAssignment = assignResult.assignments[0]!;
      const isInChat = await GroupChatService.isInChat(
        user.id,
        firstAssignment.chatId
      );
      expect(isInChat).toBe(true);
    });

    test('should return false for non-member', async () => {
      const npc = getTestNpc();
      const user = await createTestUser({ displayName: 'Non Member' });

      const tiers = await TieredGroupService.ensureAllTiersExist(npc.id);
      const tier3 = tiers.find((t) => t.tier === 3);

      const isInChat = await GroupChatService.isInChat(user.id, tier3!.chatId!);
      expect(isInChat).toBe(false);
    });

    test('should return true for agent when owner is member (via default assignment)', async () => {
      const owner = await createTestUser({ displayName: 'Owner User' });
      const agent = await createTestUser({
        displayName: 'Agent User',
        isAgent: true,
        managedBy: owner.id,
      });

      // Assign owner to default groups
      const assignResult =
        await UserAlphaGroupAssignmentService.assignDefaultGroups(owner.id);

      expect(assignResult.success).toBe(true);
      expect(assignResult.assignments.length).toBeGreaterThan(0);

      const firstAssignment = assignResult.assignments[0]!;

      // Owner should be in chat
      const ownerInChat = await GroupChatService.isInChat(
        owner.id,
        firstAssignment.chatId
      );
      expect(ownerInChat).toBe(true);

      // Agent should inherit owner's access
      const agentInChat = await GroupChatService.isInChat(
        agent.id,
        firstAssignment.chatId
      );
      expect(agentInChat).toBe(true);
    });

    test('should return false for agent when owner is not member', async () => {
      const npc = getTestNpc();
      const owner = await createTestUser({ displayName: 'Non-member Owner' });
      const agent = await createTestUser({
        displayName: 'Agent of Non-member',
        isAgent: true,
        managedBy: owner.id,
      });

      const tiers = await TieredGroupService.ensureAllTiersExist(npc.id);
      const tier3 = tiers.find((t) => t.tier === 3);

      // Owner is NOT assigned - should not be in chat
      const ownerInChat = await GroupChatService.isInChat(
        owner.id,
        tier3!.chatId!
      );
      expect(ownerInChat).toBe(false);

      // Agent should NOT inherit access
      const agentInChat = await GroupChatService.isInChat(
        agent.id,
        tier3!.chatId!
      );
      expect(agentInChat).toBe(false);
    });
  });
});

describe('Tier Capacity and Fill Rate', () => {
  test('isFull should reflect actual capacity', async () => {
    const npc = getTestNpc();
    const tiers = await TieredGroupService.ensureAllTiersExist(npc.id);

    // All tiers should not be full (capacity far exceeds member count)
    for (const tier of tiers) {
      expect(tier.isFull).toBe(false);
      expect(tier.memberCount).toBeLessThan(tier.maxMembers);
    }
  });

  test('tier capacity matches configuration', async () => {
    const npc = getTestNpc();
    const tiers = await TieredGroupService.ensureAllTiersExist(npc.id);

    const tier1 = tiers.find((t) => t.tier === 1);
    const tier2 = tiers.find((t) => t.tier === 2);
    const tier3 = tiers.find((t) => t.tier === 3);

    expect(tier1!.maxMembers).toBe(12);
    expect(tier2!.maxMembers).toBe(50);
    expect(tier3!.maxMembers).toBe(500);
  });
});

describe('Minimum Group Protection', () => {
  afterEach(async () => {
    await cleanupTestData();
  });

  test('user assigned default groups should be at protection threshold', async () => {
    const user = await createTestUser({ displayName: 'Protected User' });

    // Assign default groups up to the configured minimum
    const assignResult =
      await UserAlphaGroupAssignmentService.assignDefaultGroups(user.id);

    expect(assignResult.success).toBe(true);
    // User has been assigned exactly TARGET_DEFAULT_GROUPS (the minimum/default)
    // This means they should be protected from being kicked below this threshold
    expect(assignResult.groupsAssigned).toBe(
      UserAlphaGroupAssignmentService.TARGET_DEFAULT_GROUPS
    );
  });

  test('TARGET_DEFAULT_GROUPS should match MIN_DEFAULT_GROUPS', () => {
    expect(UserAlphaGroupAssignmentService.TARGET_DEFAULT_GROUPS).toBe(
      GROUP_CONFIG.MIN_DEFAULT_GROUPS
    );
  });
});
