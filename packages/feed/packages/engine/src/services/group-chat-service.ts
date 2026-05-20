/**
 * Group Chat Service
 *
 * Manages group chat invitations and membership lifecycle:
 * - Inviting players to NPC group chats based on engagement
 * - Removing players for inactivity, spam, or low quality
 * - Tracking membership quality scores
 *
 * Invites based on:
 * - Being followed by the NPC
 * - High quality interactions
 * - Consistent engagement
 *
 * Sweeps (removals) based on:
 * - Inactivity (not posting for extended periods)
 * - Over-posting (spam behavior)
 * - Low quality (average quality below threshold)
 *
 */

import {
  and,
  chats,
  db,
  desc,
  eq,
  followStatuses,
  getRawDrizzle,
  groupInvites,
  groupMembers,
  groups,
  gte,
  messages,
  userInteractions,
  users,
} from '@feed/db';
import type { GroupChat } from '@feed/shared';
import { generateSnowflakeId } from '@feed/shared';
import { notifyGroupChatInvite } from './group-chat-invite-notifier';

/**
 * Generate a deterministic group ID from a chat ID.
 * This ensures idempotency - same chatId always produces same groupId.
 */
function deterministicGroupId(chatId: string): string {
  let hash = 0;
  for (let i = 0; i < chatId.length; i++) {
    const char = chatId.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  const absHash = Math.abs(hash);
  return `grp_${chatId}_${absHash.toString().padStart(10, '0')}`;
}

// =============================================================================
// Types
// =============================================================================

/**
 * Group chat data (without messages for list views)
 */
type GroupChatData = Omit<GroupChat, 'messages'> & {
  messageCount?: number;
};

/**
 * Invite chance calculation result
 */
export interface InviteChance {
  willInvite: boolean;
  probability: number;
  chatId?: string;
  chatName?: string;
  isOwned: boolean;
  reasons: string[];
}

/**
 * Sweep decision for a user in a chat
 */
export interface SweepDecision {
  kickChance: number;
  reason?: string;
  stats: {
    hoursSinceLastMessage: number;
    messagesLast24h: number;
    averageQuality: number;
    totalMessages: number;
  };
}

// =============================================================================
// Group Chat Service
// =============================================================================

export class GroupChatService {
  // ---------------------------------------------------------------------------
  // Invite Constants
  // ---------------------------------------------------------------------------
  private static readonly MIN_FOLLOW_DURATION_HOURS = 24;
  private static readonly MIN_QUALITY_SCORE = 0.75;
  private static readonly MIN_REPLIES_SINCE_FOLLOW = 5;
  private static readonly BASE_INVITE_PROBABILITY = 0.1;
  private static readonly MAX_INVITE_PROBABILITY = 0.6;
  private static readonly OWNED_CHAT_WEIGHT = 0.7;
  private static readonly MEMBER_CHAT_WEIGHT = 0.3;

  // ---------------------------------------------------------------------------
  // Sweep Constants
  // ---------------------------------------------------------------------------
  private static readonly BASE_KICK_PROBABILITY = 0.00007;
  private static readonly INACTIVITY_GRACE_PERIOD_TICKS = 1440; // 1 day
  private static readonly INACTIVITY_MAX_TICKS = 7200; // 5 days
  private static readonly ACTIVITY_SWEET_SPOT_MIN = 1;
  private static readonly ACTIVITY_SWEET_SPOT_MAX = 3;
  private static readonly ACTIVITY_HARD_CAP = 10;

  // ---------------------------------------------------------------------------
  // Invite Methods
  // ---------------------------------------------------------------------------

  private static calculateChatTypeWeight(isOwned: boolean): number {
    return isOwned
      ? GroupChatService.OWNED_CHAT_WEIGHT
      : GroupChatService.MEMBER_CHAT_WEIGHT;
  }

  private static calculateInviteProbability(
    baseProb: number,
    isOwned: boolean
  ): number {
    const weight = GroupChatService.calculateChatTypeWeight(isOwned);
    return Math.min(baseProb * weight, GroupChatService.MAX_INVITE_PROBABILITY);
  }

  /**
   * Calculate if player should be invited to a group chat
   */
  static async calculateInviteChance(
    userId: string,
    npcId: string
  ): Promise<InviteChance> {
    // Must be followed first
    const [followStatus] = await db
      .select()
      .from(followStatuses)
      .where(
        and(eq(followStatuses.userId, userId), eq(followStatuses.npcId, npcId))
      )
      .limit(1);

    if (!followStatus || !followStatus.isActive) {
      return {
        willInvite: false,
        probability: 0,
        isOwned: false,
        reasons: ['Must be followed by NPC first'],
      };
    }

    // Check follow duration
    const hoursSinceFollow =
      (Date.now() - followStatus.followedAt.getTime()) / (1000 * 60 * 60);

    if (hoursSinceFollow < GroupChatService.MIN_FOLLOW_DURATION_HOURS) {
      return {
        willInvite: false,
        probability: 0,
        isOwned: false,
        reasons: [
          `Need ${Math.ceil(GroupChatService.MIN_FOLLOW_DURATION_HOURS - hoursSinceFollow)} more hours of being followed`,
        ],
      };
    }

    // Check if already in a group with this NPC as owner
    // Join groups with groupMembers to find active membership
    const existingMemberships = await db
      .select({
        groupId: groups.id,
        ownerId: groups.ownerId,
        isActive: groupMembers.isActive,
      })
      .from(groupMembers)
      .innerJoin(groups, eq(groupMembers.groupId, groups.id))
      .where(
        and(
          eq(groupMembers.userId, userId),
          eq(groups.ownerId, npcId),
          eq(groups.type, 'npc'),
          eq(groupMembers.isActive, true)
        )
      )
      .limit(1);

    if (existingMemberships.length > 0) {
      return {
        willInvite: false,
        probability: 0,
        isOwned: false,
        reasons: ['Already in a group chat with this NPC'],
      };
    }

    // Get interactions since follow
    const interactionsSinceFollow = await db
      .select()
      .from(userInteractions)
      .where(
        and(
          eq(userInteractions.userId, userId),
          eq(userInteractions.npcId, npcId),
          gte(userInteractions.timestamp, followStatus.followedAt)
        )
      );

    if (
      interactionsSinceFollow.length < GroupChatService.MIN_REPLIES_SINCE_FOLLOW
    ) {
      return {
        willInvite: false,
        probability: 0,
        isOwned: false,
        reasons: [
          `Need ${GroupChatService.MIN_REPLIES_SINCE_FOLLOW - interactionsSinceFollow.length} more quality replies since being followed`,
        ],
      };
    }

    // Calculate average quality since follow
    const avgQuality =
      interactionsSinceFollow.reduce((sum, i) => sum + i.qualityScore, 0) /
      interactionsSinceFollow.length;

    if (avgQuality < GroupChatService.MIN_QUALITY_SCORE) {
      return {
        willInvite: false,
        probability: 0,
        isOwned: false,
        reasons: [
          `Quality score ${(avgQuality * 100).toFixed(0)}% is below ${(GroupChatService.MIN_QUALITY_SCORE * 100).toFixed(0)}% threshold`,
        ],
      };
    }

    // Get available chats
    const ownedChatId = `${npcId}-owned-chat`;
    const ownedChatName = `${npcId}'s Inner Circle`;

    // Determine which chat type
    const isOwned = Math.random() < GroupChatService.OWNED_CHAT_WEIGHT;

    // Calculate probability based on quality and engagement
    const qualityFactor = avgQuality / GroupChatService.MIN_QUALITY_SCORE;
    const engagementFactor = Math.min(
      interactionsSinceFollow.length /
        GroupChatService.MIN_REPLIES_SINCE_FOLLOW,
      1.5
    );

    const baseProbability =
      GroupChatService.BASE_INVITE_PROBABILITY +
      (GroupChatService.MAX_INVITE_PROBABILITY -
        GroupChatService.BASE_INVITE_PROBABILITY) *
        (qualityFactor * 0.6 + engagementFactor * 0.4);

    const probability = GroupChatService.calculateInviteProbability(
      baseProbability,
      isOwned
    );

    const willInvite = Math.random() < probability;

    return {
      willInvite,
      probability,
      chatId: ownedChatId,
      chatName: ownedChatName,
      isOwned,
      reasons: [
        `High quality: ${(avgQuality * 100).toFixed(0)}%`,
        `${interactionsSinceFollow.length} quality replies since follow`,
        `${isOwned ? 'Invited to owned chat' : 'Invited to member chat'}`,
      ],
    };
  }

  /**
   * Record a group chat invite
   * Creates a pending GroupInvite that requires user acceptance.
   * Chat.groupId → Group.id relationship
   *
   * Uses atomic upserts to prevent race conditions:
   * - Deterministic groupId based on chatId ensures idempotency
   * - INSERT ON CONFLICT for group/chat creation
   * - Proper invite status handling
   */
  static async recordInvite(
    userId: string,
    npcId: string,
    chatId: string,
    chatName: string
  ): Promise<void> {
    // Use deterministic groupId to prevent race conditions
    const groupId = deterministicGroupId(chatId);
    const now = new Date();

    // Get raw Drizzle instance for transaction with upsert support
    const rawDb = getRawDrizzle();

    // Check for existing invite first (before any modifications)
    const [existingInvite] = await db
      .select()
      .from(groupInvites)
      .where(
        and(
          eq(groupInvites.groupId, groupId),
          eq(groupInvites.invitedUserId, userId)
        )
      )
      .limit(1);

    // Early return if already pending or accepted
    if (existingInvite) {
      if (existingInvite.status === 'pending') {
        return;
      }
      if (existingInvite.status === 'accepted') {
        return;
      }
    }

    let inviteId: string;

    // Use transaction with atomic upserts
    await rawDb.transaction(async (tx) => {
      // Step 1: Upsert Group (INSERT ... ON CONFLICT DO NOTHING)
      await tx
        .insert(groups)
        .values({
          id: groupId,
          name: chatName,
          type: 'npc',
          ownerId: npcId,
          createdById: npcId,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing({ target: groups.id });

      // Step 2: Upsert Chat (INSERT ... ON CONFLICT DO UPDATE to set groupId)
      await tx
        .insert(chats)
        .values({
          id: chatId,
          name: chatName,
          isGroup: true,
          gameId: 'realtime',
          groupId,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: chats.id,
          set: {
            groupId,
            updatedAt: now,
          },
        });

      // Step 3: Handle invite
      if (existingInvite) {
        // Re-invite flow for declined invites
        inviteId = existingInvite.id;
        await tx
          .update(groupInvites)
          .set({
            status: 'pending',
            invitedBy: npcId,
            invitedAt: now,
            respondedAt: null,
            message: `Join our group chat "${chatName}"!`,
          })
          .where(eq(groupInvites.id, existingInvite.id));
      } else {
        // Create new pending invite
        inviteId = await generateSnowflakeId();
        await tx.insert(groupInvites).values({
          id: inviteId,
          groupId,
          invitedUserId: userId,
          invitedBy: npcId,
          status: 'pending',
          message: `Join our group chat "${chatName}"!`,
        });
      }

      // Mark interaction as leading to invite
      await tx
        .update(userInteractions)
        .set({ wasInvitedToChat: true })
        .where(
          and(
            eq(userInteractions.userId, userId),
            eq(userInteractions.npcId, npcId)
          )
        );
    });

    // Send notification to user about the invite (with inviteId for proper linking)
    await notifyGroupChatInvite(userId, npcId, groupId, chatName, inviteId!);
  }

  /**
   * Get all group chats a user is in
   * Chat.groupId → Group.id relationship
   */
  static async getUserGroupChats(userId: string): Promise<GroupChatData[]> {
    // Query via Chat.groupId
    const memberships = await db
      .select({
        groupId: groups.id,
        chatId: chats.id,
        groupName: groups.name,
        ownerId: groups.ownerId,
        type: groups.type,
        joinedAt: groupMembers.joinedAt,
      })
      .from(groupMembers)
      .innerJoin(groups, eq(groupMembers.groupId, groups.id))
      .innerJoin(chats, eq(chats.groupId, groups.id))
      .where(
        and(eq(groupMembers.userId, userId), eq(groupMembers.isActive, true))
      )
      .orderBy(groupMembers.joinedAt);

    return memberships.map((m) => ({
      id: m.chatId,
      name: m.groupName,
      admin: m.ownerId,
      members: [userId],
      theme: 'default',
      messageCount: 0,
    }));
  }

  /**
   * Check if user is in a specific chat (by chatId).
   *
   * Supports agent inheritance: if the user is an agent (has managedBy set),
   * also checks if the agent's owner has access to the chat. This enables
   * agents to participate in their owner's group chats.
   *
   * Chat.groupId → Group.id relationship
   */
  static async isInChat(userId: string, chatId: string): Promise<boolean> {
    // First check if user is directly a member
    const [directMembership] = await db
      .select({ id: groupMembers.id })
      .from(chats)
      .innerJoin(groupMembers, eq(chats.groupId, groupMembers.groupId))
      .where(
        and(
          eq(chats.id, chatId),
          eq(groupMembers.userId, userId),
          eq(groupMembers.isActive, true)
        )
      )
      .limit(1);

    if (directMembership) {
      return true;
    }

    // If not direct member, check if this is an agent with owner membership
    // Agents inherit their owner's group access for NPC groups
    const [userRecord] = await db
      .select({ managedBy: users.managedBy, isAgent: users.isAgent })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    // If user is an agent (has managedBy), check owner's membership
    if (userRecord?.isAgent && userRecord?.managedBy) {
      const [ownerMembership] = await db
        .select({ id: groupMembers.id })
        .from(chats)
        .innerJoin(groupMembers, eq(chats.groupId, groupMembers.groupId))
        .where(
          and(
            eq(chats.id, chatId),
            eq(groupMembers.userId, userRecord.managedBy),
            eq(groupMembers.isActive, true)
          )
        )
        .limit(1);

      return !!ownerMembership;
    }

    return false;
  }

  // ---------------------------------------------------------------------------
  // Sweep Methods
  // ---------------------------------------------------------------------------

  /**
   * Calculate the probability that a user should be removed from a group chat
   * Chat.groupId → Group.id relationship
   */
  static async calculateKickChance(
    userId: string,
    chatId: string
  ): Promise<SweepDecision> {
    // Find chat to get its groupId
    const [chat] = await db
      .select()
      .from(chats)
      .where(eq(chats.id, chatId))
      .limit(1);

    const baseStats = {
      hoursSinceLastMessage: 0,
      messagesLast24h: 0,
      averageQuality: 0,
      totalMessages: 0,
    };

    if (!chat || !chat.groupId) {
      return {
        kickChance: 0,
        reason: 'Group not found',
        stats: baseStats,
      };
    }

    const [membership] = await db
      .select()
      .from(groupMembers)
      .where(
        and(
          eq(groupMembers.groupId, chat.groupId),
          eq(groupMembers.userId, userId)
        )
      )
      .limit(1);

    if (!membership || !membership.isActive) {
      return {
        kickChance: 0,
        reason: 'Not an active member',
        stats: baseStats,
      };
    }

    const allMessages = await db
      .select()
      .from(messages)
      .where(and(eq(messages.chatId, chatId), eq(messages.senderId, userId)))
      .orderBy(desc(messages.createdAt));

    const totalMessages = allMessages.length;
    const ticksSinceJoin =
      (Date.now() - membership.joinedAt.getTime()) / (1000 * 60);

    if (totalMessages === 0) {
      if (ticksSinceJoin > GroupChatService.INACTIVITY_GRACE_PERIOD_TICKS) {
        return {
          kickChance: GroupChatService.BASE_KICK_PROBABILITY * 100,
          reason: `Never posted after joining (${Math.floor(ticksSinceJoin / 60)} hours ago)`,
          stats: { ...baseStats, hoursSinceLastMessage: ticksSinceJoin / 60 },
        };
      }
      return {
        kickChance: 0,
        stats: { ...baseStats, hoursSinceLastMessage: ticksSinceJoin / 60 },
      };
    }

    const lastMessage = allMessages[0];
    if (!lastMessage) {
      return {
        kickChance: 0,
        reason: 'No messages found',
        stats: baseStats,
      };
    }

    const ticksSinceLastMessage =
      (Date.now() - lastMessage.createdAt.getTime()) / (1000 * 60);

    let inactivityMultiplier = 1;
    let reason = '';

    if (
      ticksSinceLastMessage > GroupChatService.INACTIVITY_GRACE_PERIOD_TICKS
    ) {
      const excessTicks =
        ticksSinceLastMessage - GroupChatService.INACTIVITY_GRACE_PERIOD_TICKS;
      const range =
        GroupChatService.INACTIVITY_MAX_TICKS -
        GroupChatService.INACTIVITY_GRACE_PERIOD_TICKS;
      inactivityMultiplier = 1 + Math.min(excessTicks / range, 1) * 9;
      reason = `Inactive for ${Math.floor(ticksSinceLastMessage / 60)} hours`;
    }

    let overactivityMultiplier = 1;
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const messagesLast24h = allMessages.filter(
      (m) => m.createdAt >= oneDayAgo
    ).length;

    if (messagesLast24h > GroupChatService.ACTIVITY_HARD_CAP) {
      overactivityMultiplier = 20;
      reason = `Spamming: ${messagesLast24h} messages in 24h`;
    } else if (messagesLast24h > GroupChatService.ACTIVITY_SWEET_SPOT_MAX) {
      const excess = messagesLast24h - GroupChatService.ACTIVITY_SWEET_SPOT_MAX;
      const range =
        GroupChatService.ACTIVITY_HARD_CAP -
        GroupChatService.ACTIVITY_SWEET_SPOT_MAX;
      overactivityMultiplier = 2 + (excess / range) * 3;
      reason = `Over-active: ${messagesLast24h} messages in 24h`;
    } else if (messagesLast24h < GroupChatService.ACTIVITY_SWEET_SPOT_MIN) {
      overactivityMultiplier = 3;
      reason = `Low participation: ${messagesLast24h} messages in 24h`;
    }

    const finalMultiplier = Math.max(
      inactivityMultiplier,
      overactivityMultiplier
    );
    const kickChance = Math.min(
      1,
      GroupChatService.BASE_KICK_PROBABILITY * finalMultiplier
    );

    return {
      kickChance,
      reason:
        kickChance > GroupChatService.BASE_KICK_PROBABILITY
          ? reason
          : undefined,
      stats: {
        hoursSinceLastMessage: ticksSinceLastMessage / 60,
        messagesLast24h,
        averageQuality: membership.qualityScore,
        totalMessages,
      },
    };
  }

  /**
   * Remove a user from a group chat
   * Chat.groupId → Group.id relationship
   */
  static async removeFromChat(
    userId: string,
    chatId: string,
    reason: string
  ): Promise<void> {
    // Find chat to get its groupId
    const [chat] = await db
      .select()
      .from(chats)
      .where(eq(chats.id, chatId))
      .limit(1);

    if (!chat || !chat.groupId) return;

    await db
      .update(groupMembers)
      .set({
        isActive: false,
        kickReason: reason,
        kickedAt: new Date(),
      })
      .where(
        and(
          eq(groupMembers.groupId, chat.groupId),
          eq(groupMembers.userId, userId),
          eq(groupMembers.isActive, true)
        )
      );
  }

  /**
   * Run sweep on all members of a chat
   * Chat.groupId → Group.id relationship
   */
  static async sweepChat(chatId: string): Promise<{
    checked: number;
    removed: number;
    reasons: Record<string, number>;
  }> {
    // Find chat to get its groupId
    const [chat] = await db
      .select()
      .from(chats)
      .where(eq(chats.id, chatId))
      .limit(1);

    if (!chat || !chat.groupId) {
      return { checked: 0, removed: 0, reasons: {} };
    }

    const memberships = await db
      .select()
      .from(groupMembers)
      .where(
        and(
          eq(groupMembers.groupId, chat.groupId),
          eq(groupMembers.isActive, true)
        )
      );

    let removed = 0;
    const reasons: Record<string, number> = {};

    for (const membership of memberships) {
      const decision = await GroupChatService.calculateKickChance(
        membership.userId,
        chatId
      );

      if (Math.random() < decision.kickChance && decision.reason) {
        await GroupChatService.removeFromChat(
          membership.userId,
          chatId,
          decision.reason
        );
        removed++;

        const genericReason = decision.reason.split(':')[0] || 'Unknown';
        reasons[genericReason] = (reasons[genericReason] || 0) + 1;
      }
    }

    return { checked: memberships.length, removed, reasons };
  }

  /**
   * Run sweep on all group chats
   */
  static async sweepAllChats(): Promise<{
    chatsChecked: number;
    totalRemoved: number;
    reasonsSummary: Record<string, number>;
  }> {
    const groupChats = await db
      .select({ id: chats.id })
      .from(chats)
      .where(eq(chats.isGroup, true));

    let totalRemoved = 0;
    const reasonsSummary: Record<string, number> = {};

    for (const chat of groupChats) {
      const result = await GroupChatService.sweepChat(chat.id);
      totalRemoved += result.removed;

      for (const [reason, count] of Object.entries(result.reasons)) {
        reasonsSummary[reason] = (reasonsSummary[reason] || 0) + count;
      }
    }

    return { chatsChecked: groupChats.length, totalRemoved, reasonsSummary };
  }

  /**
   * Update user's quality score in chat
   * Chat.groupId → Group.id relationship
   */
  static async updateQualityScore(
    userId: string,
    chatId: string,
    newMessageQuality: number
  ): Promise<void> {
    // Find chat to get its groupId
    const [chat] = await db
      .select()
      .from(chats)
      .where(eq(chats.id, chatId))
      .limit(1);

    if (!chat || !chat.groupId) return;

    const [membership] = await db
      .select()
      .from(groupMembers)
      .where(
        and(
          eq(groupMembers.groupId, chat.groupId),
          eq(groupMembers.userId, userId)
        )
      )
      .limit(1);

    if (!membership) return;

    const totalMessages = membership.messageCount + 1;
    const newAvgQuality =
      (membership.qualityScore * membership.messageCount + newMessageQuality) /
      totalMessages;

    await db
      .update(groupMembers)
      .set({
        messageCount: totalMessages,
        qualityScore: newAvgQuality,
        lastMessageAt: new Date(),
      })
      .where(
        and(
          eq(groupMembers.groupId, chat.groupId),
          eq(groupMembers.userId, userId)
        )
      );
  }
}
