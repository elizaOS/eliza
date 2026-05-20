/**
 * User Alpha Group Assignment Service
 *
 * Assigns new users to default alpha groups on account creation.
 * Users start in Tier 3 (Followers) groups for immediate access to NPC content.
 *
 * Key Features:
 * - Assigns up to 3 default NPC groups per user
 * - Prioritizes NPCs the user follows (if any)
 * - Ensures diversity (different NPCs, not multiple tiers of same NPC)
 * - Uses direct membership (no pending invite required)
 * - Respects group capacity limits
 *
 * This is called after user account creation to ensure every user
 * has access to NPC insider information from day one.
 */

import {
  and,
  chatParticipants,
  chats,
  count,
  db,
  eq,
  follows,
  groupMembers,
  groups,
  isNotNull,
  users,
} from '@feed/db';
import {
  GROUP_CONFIG,
  generateSnowflakeId,
  logger,
  type TierLevel,
} from '@feed/shared';
import { StaticDataRegistry } from './static-data-registry';
import { TIER_CONFIG } from './tier-config';
import { TieredGroupService } from './tiered-group-service';

/** Default max members for Tier 3 groups (from TIER_CONFIG) */
const DEFAULT_TIER3_MAX_MEMBERS = TIER_CONFIG[3].maxMembers;

/**
 * Result of default group assignment
 */
export interface AssignmentResult {
  /** Whether at least one group was assigned */
  success: boolean;
  /** Number of groups successfully assigned */
  groupsAssigned: number;
  /** Details of each assignment */
  assignments: Array<{
    npcId: string;
    npcName: string;
    tier: TierLevel;
    groupId: string;
    chatId: string;
  }>;
  /** Any errors encountered (non-fatal) */
  errors: string[];
}

/**
 * Available group info for assignment
 */
interface AvailableGroup {
  npcId: string;
  npcName: string;
  groupId: string;
  chatId: string;
  memberCount: number;
  maxMembers: number;
  availableSlots: number;
}

export class UserAlphaGroupAssignmentService {
  /** Target number of default groups to assign (best effort), from config */
  static readonly TARGET_DEFAULT_GROUPS = GROUP_CONFIG.MIN_DEFAULT_GROUPS;

  /** Default tier for new users with no engagement history */
  static readonly DEFAULT_TIER: TierLevel = 3;

  /** Flag to ensure tier groups are only created once per process */
  private static tiersEnsuredOnce = false;

  /**
   * Assign default alpha groups to a new user.
   *
   * Called after user account creation. Runs async/non-blocking
   * to avoid slowing signup flow.
   *
   * @param userId - The new user's ID
   * @returns Assignment results including groups assigned and any errors
   */
  static async assignDefaultGroups(userId: string): Promise<AssignmentResult> {
    const result: AssignmentResult = {
      success: false,
      groupsAssigned: 0,
      assignments: [],
      errors: [],
    };

    // 1. Verify user exists and is eligible
    const [user] = await db
      .select({
        id: users.id,
        isActor: users.isActor,
        isAgent: users.isAgent,
        isBanned: users.isBanned,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!user) {
      result.errors.push(`User ${userId} not found`);
      return result;
    }

    if (user.isActor) {
      result.errors.push('Cannot assign groups to NPC actors');
      return result;
    }

    if (user.isBanned) {
      result.errors.push('Cannot assign groups to banned users');
      return result;
    }

    // Agents inherit from their owner, don't assign directly
    if (user.isAgent) {
      result.errors.push('Agents inherit group access from their owner');
      return result;
    }

    // 2. Check existing NPC group memberships
    const [existingCount] = await db
      .select({ count: count() })
      .from(groupMembers)
      .innerJoin(groups, eq(groupMembers.groupId, groups.id))
      .where(
        and(
          eq(groupMembers.userId, userId),
          eq(groupMembers.isActive, true),
          eq(groups.type, 'npc')
        )
      );

    const currentGroups = existingCount?.count ?? 0;
    if (currentGroups >= this.TARGET_DEFAULT_GROUPS) {
      // User already has sufficient groups
      result.success = true;
      result.groupsAssigned = 0;
      logger.debug(
        'User already has sufficient NPC groups',
        { userId, currentGroups },
        'UserAlphaGroupAssignmentService'
      );
      return result;
    }

    const groupsNeeded = this.TARGET_DEFAULT_GROUPS - currentGroups;

    // 3. Get NPCs user follows (for prioritization)
    const followedNpcs = await db
      .select({ followingId: follows.followingId })
      .from(follows)
      .innerJoin(users, eq(follows.followingId, users.id))
      .where(and(eq(follows.followerId, userId), eq(users.isActor, true)))
      .limit(20);

    const followedNpcIds = new Set(followedNpcs.map((f) => f.followingId));

    // 4. Get NPCs user is already in groups with (to ensure diversity)
    const existingNpcMemberships = await db
      .select({ ownerId: groups.ownerId })
      .from(groupMembers)
      .innerJoin(groups, eq(groupMembers.groupId, groups.id))
      .where(
        and(
          eq(groupMembers.userId, userId),
          eq(groupMembers.isActive, true),
          eq(groups.type, 'npc')
        )
      );

    const excludeNpcIds = new Set(existingNpcMemberships.map((e) => e.ownerId));

    // 5. Find available Tier 3 groups with capacity
    const availableGroups = await this.findAvailableTier3Groups(
      excludeNpcIds,
      groupsNeeded * 3 // Get extra for fallback
    );

    if (availableGroups.length === 0) {
      result.errors.push('No available Tier 3 groups with capacity');
      logger.warn(
        'No available Tier 3 groups for user assignment',
        { userId, groupsNeeded },
        'UserAlphaGroupAssignmentService'
      );
      return result;
    }

    // 6. Prioritize: followed NPCs first, then by available capacity
    const sortedGroups = availableGroups.sort((a, b) => {
      const aFollowed = followedNpcIds.has(a.npcId) ? 1 : 0;
      const bFollowed = followedNpcIds.has(b.npcId) ? 1 : 0;
      if (aFollowed !== bFollowed) {
        return bFollowed - aFollowed; // Followed NPCs first
      }
      // Then by available slots (more slots = less likely to be full soon)
      return b.availableSlots - a.availableSlots;
    });

    // 7. Assign to groups (up to groupsNeeded)
    for (const group of sortedGroups.slice(0, groupsNeeded)) {
      const addResult = await this.addUserToGroup(userId, group);

      if (addResult.success) {
        result.assignments.push({
          npcId: group.npcId,
          npcName: group.npcName,
          tier: 3,
          groupId: group.groupId,
          chatId: group.chatId,
        });
        result.groupsAssigned++;
      } else if (addResult.error) {
        result.errors.push(
          `Failed to add to ${group.npcName}: ${addResult.error}`
        );
      }
    }

    result.success = result.groupsAssigned > 0;

    logger.info(
      'Assigned default alpha groups to user',
      {
        userId,
        groupsAssigned: result.groupsAssigned,
        targetGroups: groupsNeeded,
        assignments: result.assignments.map((a) => ({
          npc: a.npcName,
          tier: a.tier,
        })),
        prioritizedFollowed: result.assignments.filter((a) =>
          followedNpcIds.has(a.npcId)
        ).length,
        errors: result.errors.length > 0 ? result.errors : undefined,
      },
      'UserAlphaGroupAssignmentService'
    );

    return result;
  }

  /**
   * Find Tier 3 groups with available capacity.
   *
   * Queries all Tier 3 NPC groups and filters to those with room for new members.
   *
   * @param excludeNpcIds - NPCs to exclude (user already in their groups)
   * @param limit - Maximum groups to return
   */
  private static async findAvailableTier3Groups(
    excludeNpcIds: Set<string>,
    limit: number
  ): Promise<AvailableGroup[]> {
    // Ensure all NPCs have their tier groups created (one-time per process)
    // This is idempotent but expensive, so we only run it once.
    // In production, the bootstrap script should handle initial creation.
    if (!this.tiersEnsuredOnce) {
      const allActors = StaticDataRegistry.getAllActors().filter(
        (a) => !a.isTest
      );

      // Batch ensure tiers exist for all NPCs (parallel with limit)
      const batchSize = 10;
      for (let i = 0; i < allActors.length; i += batchSize) {
        const batch = allActors.slice(i, i + batchSize);
        await Promise.all(
          batch.map((actor) => TieredGroupService.ensureAllTiersExist(actor.id))
        );
      }
      this.tiersEnsuredOnce = true;
    }

    // Query all Tier 3 groups with their member counts
    const tier3Groups = await db
      .select({
        groupId: groups.id,
        npcId: groups.ownerId,
        maxMembers: groups.maxMembers,
        chatId: chats.id,
        memberCount: count(groupMembers.id),
      })
      .from(groups)
      .leftJoin(chats, eq(chats.groupId, groups.id))
      .leftJoin(
        groupMembers,
        and(
          eq(groupMembers.groupId, groups.id),
          eq(groupMembers.isActive, true)
        )
      )
      .where(
        and(
          eq(groups.type, 'npc'),
          eq(groups.tier, 3),
          isNotNull(chats.id) // Only groups with associated chats
        )
      )
      .groupBy(groups.id, groups.ownerId, groups.maxMembers, chats.id);

    // Filter and enrich results
    const availableGroups: AvailableGroup[] = [];

    for (const g of tier3Groups) {
      // Skip NPCs user is already with
      if (excludeNpcIds.has(g.npcId)) {
        continue;
      }

      // Default Tier 3 size - matches TIER_CONFIG.tiers[3].maxMembers
      const maxMembers = g.maxMembers ?? DEFAULT_TIER3_MAX_MEMBERS;
      const memberCount = g.memberCount ?? 0;
      const availableSlots = maxMembers - memberCount;

      // Skip full groups
      if (availableSlots <= 0) {
        continue;
      }

      // Must have a chat to participate in
      if (!g.chatId) {
        continue;
      }

      // Get NPC name from static registry
      const actor = StaticDataRegistry.getActor(g.npcId);
      if (!actor) {
        continue;
      }

      availableGroups.push({
        npcId: g.npcId,
        npcName: actor.name,
        groupId: g.groupId,
        chatId: g.chatId,
        memberCount,
        maxMembers,
        availableSlots,
      });
    }

    return availableGroups.slice(0, limit);
  }

  /**
   * Add user to a group directly (no invite required).
   *
   * Creates both GroupMember and ChatParticipant records in a transaction.
   *
   * @param userId - User to add
   * @param group - Group to add user to
   */
  private static async addUserToGroup(
    userId: string,
    group: AvailableGroup
  ): Promise<{ success: boolean; error?: string }> {
    const [memberId, participantId] = await Promise.all([
      generateSnowflakeId(),
      generateSnowflakeId(),
    ]);

    // Check if user is already a member (could be inactive from previous membership)
    const [existingMember] = await db
      .select({ id: groupMembers.id, isActive: groupMembers.isActive })
      .from(groupMembers)
      .where(
        and(
          eq(groupMembers.groupId, group.groupId),
          eq(groupMembers.userId, userId)
        )
      )
      .limit(1);

    if (existingMember) {
      if (existingMember.isActive) {
        // Already an active member
        return { success: false, error: 'Already a member' };
      }

      // Reactivate existing membership in a transaction for atomicity
      await db.$transaction(async (tx) => {
        await tx
          .update(groupMembers)
          .set({
            isActive: true,
            joinedAt: new Date(),
            kickedAt: null,
            kickReason: null,
            tier: 3,
          })
          .where(eq(groupMembers.id, existingMember.id));

        // Upsert chat participant - insert if missing, update if exists
        await tx
          .insert(chatParticipants)
          .values({
            id: participantId,
            chatId: group.chatId,
            userId,
            invitedBy: group.npcId,
            isActive: true,
            joinedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: [chatParticipants.chatId, chatParticipants.userId],
            set: {
              isActive: true,
              joinedAt: new Date(),
            },
          });
      });

      return { success: true };
    }

    // Create new membership using transaction for atomicity
    try {
      await db.$transaction(async (tx) => {
        // Re-check capacity inside transaction to prevent race conditions
        const [currentCount] = await tx
          .select({ count: count() })
          .from(groupMembers)
          .where(
            and(
              eq(groupMembers.groupId, group.groupId),
              eq(groupMembers.isActive, true)
            )
          );

        const memberCount = currentCount?.count ?? 0;
        if (memberCount >= group.maxMembers) {
          throw new Error('GROUP_FULL');
        }

        // Add to group members
        await tx.insert(groupMembers).values({
          id: memberId,
          groupId: group.groupId,
          userId,
          role: 'member',
          addedBy: group.npcId, // NPC is the one adding them
          tier: 3,
          isActive: true,
          joinedAt: new Date(),
          messageCount: 0,
          qualityScore: 1.0,
        });

        // Add to chat participants
        await tx.insert(chatParticipants).values({
          id: participantId,
          chatId: group.chatId,
          userId,
          invitedBy: group.npcId,
          isActive: true,
          joinedAt: new Date(),
        });
      });

      return { success: true };
    } catch (error) {
      if (error instanceof Error && error.message === 'GROUP_FULL') {
        return { success: false, error: 'Group is at capacity' };
      }
      throw error;
    }
  }

  /**
   * Get statistics about default group assignment capacity.
   *
   * Useful for monitoring and alerting on capacity issues.
   */
  static async getCapacityStats(): Promise<{
    totalTier3Groups: number;
    totalTier3Capacity: number;
    currentTier3Members: number;
    availableSlots: number;
    fillRate: number;
    maxUsersCanServe: number;
  }> {
    // Get all Tier 3 groups with member counts
    const tier3Stats = await db
      .select({
        groupId: groups.id,
        maxMembers: groups.maxMembers,
        memberCount: count(groupMembers.id),
      })
      .from(groups)
      .leftJoin(
        groupMembers,
        and(
          eq(groupMembers.groupId, groups.id),
          eq(groupMembers.isActive, true)
        )
      )
      .where(and(eq(groups.type, 'npc'), eq(groups.tier, 3)))
      .groupBy(groups.id, groups.maxMembers);

    let totalCapacity = 0;
    let currentMembers = 0;

    for (const g of tier3Stats) {
      const max = g.maxMembers ?? DEFAULT_TIER3_MAX_MEMBERS;
      totalCapacity += max;
      currentMembers += g.memberCount ?? 0;
    }

    const availableSlots = totalCapacity - currentMembers;
    const fillRate = totalCapacity > 0 ? currentMembers / totalCapacity : 0;
    const maxUsersCanServe = Math.floor(
      availableSlots / this.TARGET_DEFAULT_GROUPS
    );

    return {
      totalTier3Groups: tier3Stats.length,
      totalTier3Capacity: totalCapacity,
      currentTier3Members: currentMembers,
      availableSlots,
      fillRate,
      maxUsersCanServe,
    };
  }
}
