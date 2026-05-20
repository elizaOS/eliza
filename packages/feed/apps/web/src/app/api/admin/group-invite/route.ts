/**
 * Admin Group Invite API
 *
 * @route POST /api/admin/group-invite - Send NPC group invite
 * @access Admin
 *
 * @description
 * Sends a group chat invite on behalf of an NPC to a user. Admin only.
 * Used for game mechanics and NPC interactions.
 *
 * @openapi
 * /api/admin/group-invite:
 *   post:
 *     tags:
 *       - Admin
 *     summary: Send NPC group invite
 *     description: Sends group chat invite from NPC to user (admin only)
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - npcId
 *               - userId
 *               - chatId
 *               - chatName
 *             properties:
 *               npcId:
 *                 type: string
 *                 description: NPC actor ID
 *               userId:
 *                 type: string
 *                 description: Target user ID
 *               chatId:
 *                 type: string
 *                 description: Chat ID
 *               chatName:
 *                 type: string
 *                 description: Chat name
 *     responses:
 *       200:
 *         description: Invite sent successfully
 *       400:
 *         description: Invalid input
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Admin access required
 *
 * @example
 * ```typescript
 * await fetch('/api/admin/group-invite', {
 *   method: 'POST',
 *   headers: { 'Authorization': `Bearer ${adminToken}` },
 *   body: JSON.stringify({
 *     npcId: 'npc-id',
 *     userId: 'user-id',
 *     chatId: 'chat-id',
 *     chatName: 'Group Chat'
 *   })
 * });
 * ```
 */

import {
  getClientIp,
  logAdminModify,
  notifyGroupChatInvite,
  requireAdmin,
  withErrorHandling,
} from '@feed/api';
import {
  asSystem,
  chatParticipants,
  chats,
  generateSnowflakeId,
  groupMembers,
  groups,
  sql,
} from '@feed/db';
import { StaticDataRegistry } from '@feed/engine';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

/**
 * Generate a deterministic group ID from a chat ID.
 * This ensures idempotency - same chatId always produces same groupId.
 * Uses a hash-based approach to generate a consistent snowflake-like ID.
 */
function deterministicGroupId(chatId: string): string {
  // Create a deterministic hash from chatId
  // Use a simple but consistent hash that produces a snowflake-like ID
  let hash = 0;
  for (let i = 0; i < chatId.length; i++) {
    const char = chatId.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  // Combine with a fixed prefix to ensure uniqueness and snowflake-like format
  // Use absolute value and pad to ensure consistent length
  const absHash = Math.abs(hash);
  return `grp_${chatId}_${absHash.toString().padStart(10, '0')}`;
}

/**
 * POST /api/admin/group-invite
 * Send a group chat invite from an NPC to a user
 * Admin only
 */
export const POST = withErrorHandling(async (request: NextRequest) => {
  const admin = await requireAdmin(request);

  const body = await request.json();
  const { npcId, userId, chatId, chatName } = body;

  // Audit log the invite
  logAdminModify({
    adminId: admin.userId,
    ipAddress: getClientIp(request.headers) ?? undefined,
    resourceType: 'group_invite',
    metadata: { action: 'send_group_invite', npcId, userId, chatId },
  });

  // Validate inputs
  if (!npcId || !userId) {
    return NextResponse.json(
      { error: 'npcId and userId are required' },
      { status: 400 }
    );
  }

  // Verify NPC exists
  const staticActor = StaticDataRegistry.getActor(npcId);
  const npc = staticActor
    ? { id: staticActor.id, name: staticActor.name }
    : await asSystem(async (db) => {
        return await db.user.findUnique({
          where: { id: npcId, isActor: true },
          select: { id: true, displayName: true, username: true },
        });
      });

  if (!npc) {
    return NextResponse.json({ error: 'NPC not found' }, { status: 404 });
  }

  // Verify user exists
  const targetUser = await asSystem(async (db) => {
    return await db.user.findUnique({
      where: { id: userId },
      select: { id: true, username: true, displayName: true },
    });
  });

  if (!targetUser) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 });
  }

  // Check if user is already a member
  const finalChatIdCheck = chatId || `${npcId}-owned-chat`;
  const existingMembership = await asSystem(async (db) => {
    // First find the group for this chat
    const chat = await db.chat.findUnique({
      where: { id: finalChatIdCheck },
      select: { groupId: true },
    });
    if (!chat?.groupId) return null;

    return await db.groupMember.findFirst({
      where: {
        groupId: chat.groupId,
        userId,
        isActive: true,
      },
    });
  });

  if (existingMembership) {
    return NextResponse.json(
      { error: 'User is already a member of this group' },
      { status: 400 }
    );
  }

  // Check if user is at the NPC group limit (consistent with regular accept flow)
  const npcGroupCount = await asSystem(async (db) => {
    const memberships = await db.groupMember.findMany({
      where: {
        userId,
        isActive: true,
      },
      select: { groupId: true },
    });
    const groupIds = memberships.map((m) => m.groupId);
    if (groupIds.length === 0) return 0;
    const npcGroups = await db.group.count({
      where: {
        id: { in: groupIds },
        type: 'npc',
      },
    });
    return npcGroups;
  });

  const { GROUP_CONFIG } = await import('@feed/shared');
  if (npcGroupCount >= GROUP_CONFIG.MAX_ACTIVE_USER_GROUPS) {
    return NextResponse.json(
      {
        error: `User is already in ${GROUP_CONFIG.MAX_ACTIVE_USER_GROUPS} NPC groups. They must leave a group first.`,
      },
      { status: 400 }
    );
  }

  // Generate chat ID and name if not provided
  const finalChatId = chatId || `${npcId}-owned-chat`;
  const npcName =
    'name' in npc ? npc.name : npc.displayName || npc.username || 'Unknown';
  const finalChatName = chatName || `${npcName}'s Inner Circle`;

  // Use deterministic groupId to prevent race conditions when creating groups
  // Same chatId will always produce the same groupId
  const deterministicGrpId = deterministicGroupId(finalChatId);

  // Record the invite using atomic upsert operations to prevent race conditions
  const groupId = await asSystem(async (db) => {
    // Use transaction for atomicity
    return await db.transaction(async (tx) => {
      const now = new Date();

      // Step 1: Upsert the Group (INSERT ... ON CONFLICT DO NOTHING)
      // Using deterministic ID ensures same group is used even with concurrent requests
      await tx
        .insert(groups)
        .values({
          id: deterministicGrpId,
          name: finalChatName,
          type: 'npc',
          ownerId: npcId,
          createdById: npcId,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing({ target: groups.id });

      // Step 2: Upsert the Chat (INSERT ... ON CONFLICT DO UPDATE to set groupId)
      await tx
        .insert(chats)
        .values({
          id: finalChatId,
          name: finalChatName,
          isGroup: true,
          gameId: 'realtime',
          groupId: deterministicGrpId,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: chats.id,
          set: {
            groupId: deterministicGrpId,
            updatedAt: now,
          },
        });

      // Step 3: Upsert ChatParticipant
      const participantId = await generateSnowflakeId();
      await tx
        .insert(chatParticipants)
        .values({
          id: participantId,
          chatId: finalChatId,
          userId,
          joinedAt: now,
          isActive: true,
        })
        .onConflictDoUpdate({
          target: [chatParticipants.chatId, chatParticipants.userId],
          set: {
            isActive: true,
            joinedAt: now,
          },
        });

      // Step 4: Upsert GroupMember using full unique constraint
      const memberId = await generateSnowflakeId();
      await tx
        .insert(groupMembers)
        .values({
          id: memberId,
          groupId: deterministicGrpId,
          userId,
          role: 'member',
          addedBy: npcId,
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
            addedBy: npcId,
            joinedAt: now,
            kickedAt: sql`NULL`,
            kickReason: sql`NULL`,
          },
        });

      return deterministicGrpId;
    });
  });

  // Send notification to user (admin adds are immediate, no inviteId needed)
  await notifyGroupChatInvite(userId, npcId, groupId, finalChatName);

  return NextResponse.json({
    success: true,
    message: `Invited ${targetUser.displayName || targetUser.username} to ${finalChatName}`,
    data: {
      chatId: finalChatId,
      chatName: finalChatName,
      npcId,
      npcName,
      userId,
    },
  });
});
