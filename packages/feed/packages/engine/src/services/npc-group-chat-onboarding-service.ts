/**
 * NPC Group Chat Onboarding Service
 *
 * Ensures new / empty users are placed into at least one NPC group chat so the
 * private chat system can be demonstrated end-to-end in local development.
 *
 * This intentionally creates **membership** (GroupMember + ChatParticipant),
 * not a pending invite, because pending invites do not appear in the Messages UI.
 */

import {
  and,
  chatParticipants,
  chats,
  count,
  db,
  eq,
  groupMembers,
  groups,
  inArray,
  messages,
  sql,
  users,
} from '@babylon/db';
import { generateSnowflakeId, logger } from '@babylon/shared';
import { type RngFunction, sampleRandom } from '../utils/randomization';

function isTestEnvironment(): boolean {
  return (
    process.env.NODE_ENV === 'test' ||
    process.env.BUN_ENV === 'test' ||
    (typeof process !== 'undefined' &&
      Array.isArray(process.argv) &&
      process.argv.join(' ').includes('test'))
  );
}

export interface AutoJoinEmptyUsersToNpcGroupChatsOptions {
  enabled: boolean;
  /** Max number of users to process per tick/run */
  batchSize: number;
  /**
   * Target number of NPC group chats per eligible user.
   * Default preserves prior behavior (1 chat), but higher values seed users
   * into multiple NPC group chats to create richer cross-chat context.
   */
  targetChatsPerUser?: number;
  /** Fallback max members when Group.maxMembers is null */
  defaultMaxMembers: number;
  /** Optional: restrict onboarding to these specific user IDs (useful for tests) */
  userIdAllowlist?: string[];
  /** Optional: restrict destination chats to these specific chat IDs (useful for tests) */
  chatIdAllowlist?: string[];
  /** Optional random number generator (defaults to Math.random) */
  rng?: RngFunction;
}

export interface MultiChatSeedUser {
  userId: string;
  activeGroupCount: number;
}

export interface MultiChatSeedSlot {
  chatId: string;
  groupId: string;
  ownerId: string;
  slots: number;
}

export interface MultiChatSeedMembership {
  userId: string;
  chatId: string;
}

export interface MultiChatSeedAssignment {
  userId: string;
  chatId: string;
  groupId: string;
  invitedBy: string;
}

export interface PlanMultiChatSeedAssignmentsOptions {
  users: MultiChatSeedUser[];
  chatSlots: MultiChatSeedSlot[];
  existingMemberships?: MultiChatSeedMembership[];
  targetChatsPerUser: number;
  rng?: RngFunction;
}

export function planMultiChatSeedAssignments(
  options: PlanMultiChatSeedAssignmentsOptions
): MultiChatSeedAssignment[] {
  const targetChatsPerUser = Math.max(1, options.targetChatsPerUser);
  const rng = options.rng ?? Math.random;
  const chatSlots = options.chatSlots.map((slot) => ({ ...slot }));
  const assignments: MultiChatSeedAssignment[] = [];
  const existingMembershipMap = new Map<string, Set<string>>();

  for (const membership of options.existingMemberships ?? []) {
    const membershipSet =
      existingMembershipMap.get(membership.userId) ?? new Set<string>();
    membershipSet.add(membership.chatId);
    existingMembershipMap.set(membership.userId, membershipSet);
  }

  for (const user of options.users) {
    const alreadyJoined =
      existingMembershipMap.get(user.userId) ?? new Set<string>();
    const remainingChatsForUser =
      targetChatsPerUser - Number(user.activeGroupCount ?? 0);
    if (remainingChatsForUser <= 0) continue;

    const available = chatSlots.filter(
      (slot) => slot.slots > 0 && !alreadyJoined.has(slot.chatId)
    );
    if (available.length === 0) continue;

    const selectedChats = sampleRandom(
      available,
      Math.min(remainingChatsForUser, available.length),
      rng
    );

    for (const selected of selectedChats) {
      if (selected.slots <= 0) continue;

      assignments.push({
        userId: user.userId,
        chatId: selected.chatId,
        groupId: selected.groupId,
        invitedBy: selected.ownerId,
      });
      selected.slots -= 1;
      alreadyJoined.add(selected.chatId);
    }
  }

  return assignments;
}

export async function autoJoinEmptyUsersToNpcGroupChats(
  options: AutoJoinEmptyUsersToNpcGroupChatsOptions
): Promise<number> {
  if (!options.enabled) {
    return 0;
  }

  const targetChatsPerUser = Math.max(1, options.targetChatsPerUser ?? 1);
  const userAllowlist =
    options.userIdAllowlist && options.userIdAllowlist.length > 0
      ? options.userIdAllowlist
      : null;

  // Find real (non-actor), non-banned users with fewer active group memberships
  // than the configured target. DMs don't count as group membership.
  // IMPORTANT: In test environments, scope to test users only to avoid polluting
  // shared/dev databases with unintended memberships.
  const baseUserFilter = and(
    eq(users.isActor, false),
    eq(users.isBanned, false)
  );
  const userFilter = isTestEnvironment()
    ? and(baseUserFilter, eq(users.isTest, true))
    : baseUserFilter;
  const finalUserFilter = userAllowlist
    ? and(userFilter, inArray(users.id, userAllowlist))
    : userFilter;

  const userMembershipCounts = await db
    .select({
      userId: users.id,
      activeGroupCount: sql<number>`count(${groupMembers.id})`,
    })
    .from(users)
    .leftJoin(
      groupMembers,
      and(eq(users.id, groupMembers.userId), eq(groupMembers.isActive, true))
    )
    .where(finalUserFilter)
    .groupBy(users.id)
    .limit(options.batchSize);

  const eligibleUsers = userMembershipCounts.filter(
    (row) => Number(row.activeGroupCount ?? 0) < targetChatsPerUser
  );
  const userIds = eligibleUsers.map((u) => u.userId);
  if (userIds.length === 0) {
    return 0;
  }

  // Candidate NPC group chats (exclude NFT-gated chats so new users aren't stuck).
  const chatAllowlist =
    options.chatIdAllowlist && options.chatIdAllowlist.length > 0
      ? options.chatIdAllowlist
      : null;

  const candidateChats = await db
    .select({
      chatId: chats.id,
      groupId: groups.id,
      groupOwnerId: groups.ownerId,
      groupMaxMembers: groups.maxMembers,
    })
    .from(chats)
    .innerJoin(groups, eq(groups.id, chats.groupId))
    .where(
      and(
        eq(chats.isGroup, true),
        eq(groups.type, 'npc'),
        eq(chats.nftGated, false),
        ...(chatAllowlist ? [inArray(chats.id, chatAllowlist)] : [])
      )
    )
    .limit(200);

  if (candidateChats.length === 0) {
    logger.warn(
      'Auto-join skipped: no NPC group chats available',
      { userCount: userIds.length },
      'NPCGroupChatOnboarding'
    );
    return 0;
  }

  // Prefer chats that already have messages (better demo UX), but fall back if none do.
  const candidateChatIds = candidateChats.map((c) => c.chatId);
  const chatsWithMessages =
    candidateChatIds.length > 0
      ? await db
          .select({ chatId: messages.chatId })
          .from(messages)
          .where(inArray(messages.chatId, candidateChatIds))
          .groupBy(messages.chatId)
      : [];

  const chatsWithMessagesSet = new Set(chatsWithMessages.map((r) => r.chatId));
  const preferredChats =
    chatsWithMessagesSet.size > 0
      ? candidateChats.filter((c) => chatsWithMessagesSet.has(c.chatId))
      : candidateChats;

  // Compute active participant counts so we don't overfill chats.
  const preferredChatIds = preferredChats.map((c) => c.chatId);
  const participantCounts =
    preferredChatIds.length > 0
      ? await db
          .select({ chatId: chatParticipants.chatId, count: count() })
          .from(chatParticipants)
          .where(
            and(
              inArray(chatParticipants.chatId, preferredChatIds),
              eq(chatParticipants.isActive, true)
            )
          )
          .groupBy(chatParticipants.chatId)
      : [];

  const participantCountMap = new Map(
    participantCounts.map((row) => [row.chatId, row.count])
  );

  const existingMemberships = await db
    .select({
      userId: groupMembers.userId,
      chatId: chats.id,
    })
    .from(groupMembers)
    .innerJoin(groups, eq(groups.id, groupMembers.groupId))
    .innerJoin(chats, eq(chats.groupId, groups.id))
    .where(
      and(
        eq(groupMembers.isActive, true),
        inArray(groupMembers.userId, userIds)
      )
    );

  type ChatSlot = {
    chatId: string;
    groupId: string;
    ownerId: string;
    slots: number;
  };

  const chatSlots: ChatSlot[] = [];
  for (const chat of preferredChats) {
    const currentCount = participantCountMap.get(chat.chatId) ?? 0;
    const maxMembers =
      typeof chat.groupMaxMembers === 'number' && chat.groupMaxMembers > 0
        ? chat.groupMaxMembers
        : options.defaultMaxMembers;
    const slots = Math.max(0, maxMembers - currentCount);
    if (slots > 0) {
      chatSlots.push({
        chatId: chat.chatId,
        groupId: chat.groupId,
        ownerId: chat.groupOwnerId,
        slots,
      });
    }
  }

  if (chatSlots.length === 0) {
    logger.warn(
      'Auto-join skipped: all NPC group chats are full',
      { userCount: userIds.length },
      'NPCGroupChatOnboarding'
    );
    return 0;
  }

  const assignments = planMultiChatSeedAssignments({
    users: eligibleUsers.map((user) => ({
      userId: user.userId,
      activeGroupCount: Number(user.activeGroupCount ?? 0),
    })),
    chatSlots,
    existingMemberships,
    targetChatsPerUser,
    rng: options.rng,
  });

  if (assignments.length === 0) {
    return 0;
  }

  const now = new Date();

  // Upsert membership + participant rows (idempotent)
  for (const a of assignments) {
    await db
      .insert(groupMembers)
      .values({
        id: await generateSnowflakeId(),
        groupId: a.groupId,
        userId: a.userId,
        role: 'member',
        addedBy: a.invitedBy,
        joinedAt: now,
        isActive: true,
        messageCount: 0,
        qualityScore: 1.0,
      })
      .onConflictDoUpdate({
        target: [groupMembers.groupId, groupMembers.userId],
        set: {
          isActive: true,
          role: 'member',
          addedBy: a.invitedBy,
          joinedAt: now,
          kickedAt: sql`NULL`,
          kickReason: sql`NULL`,
        },
      });

    await db
      .insert(chatParticipants)
      .values({
        id: await generateSnowflakeId(),
        chatId: a.chatId,
        userId: a.userId,
        joinedAt: now,
        invitedBy: a.invitedBy,
        isActive: true,
      })
      .onConflictDoUpdate({
        target: [chatParticipants.chatId, chatParticipants.userId],
        set: {
          isActive: true,
          joinedAt: now,
          invitedBy: a.invitedBy,
        },
      });
  }

  logger.info(
    'Auto-joined users into NPC group chats (dev demo)',
    {
      membershipsCreated: assignments.length,
      targetChatsPerUser,
      batchSize: options.batchSize,
    },
    'NPCGroupChatOnboarding'
  );

  return assignments.length;
}
