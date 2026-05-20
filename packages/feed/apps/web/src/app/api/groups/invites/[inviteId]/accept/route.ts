/**
 * Group Invite Accept API
 *
 * @route POST /api/groups/invites/[inviteId]/accept - Accept group invite
 * @access Authenticated
 */

import {
  ApiError,
  authenticate,
  checkProgress,
  successResponse,
  withErrorHandling,
} from '@babylon/api';
import {
  asUser,
  chatParticipants,
  generateSnowflakeId,
  groupMembers,
  sql,
} from '@babylon/db';
import { GROUP_CONFIG, logger } from '@babylon/shared';
import type { NextRequest } from 'next/server';

/**
 * POST /api/groups/invites/[inviteId]/accept
 * Accept a group invitation
 */
export const POST = withErrorHandling(
  async (
    request: NextRequest,
    { params }: { params: Promise<{ inviteId: string }> }
  ) => {
    const user = await authenticate(request);
    const { inviteId } = await params;

    const result = await asUser(user, async (db) => {
      // Get the invite
      const invite = await db.groupInvite.findUnique({
        where: { id: inviteId },
      });

      if (!invite) {
        throw new ApiError('Invite not found', 404);
      }

      if (invite.invitedUserId !== user.userId) {
        throw new ApiError('This invite is not for you', 403);
      }

      if (invite.status !== 'pending') {
        throw new ApiError('This invite has already been processed', 400);
      }

      // Check if the invited group exists and get its type
      const invitedGroup = await db.group.findUnique({
        where: { id: invite.groupId },
        select: { type: true },
      });

      if (!invitedGroup) {
        throw new ApiError('Group not found', 404);
      }

      // Only check NPC group limit if the invited group is an NPC group
      if (invitedGroup.type === 'npc') {
        const activeMemberships = await db.groupMember.findMany({
          where: {
            userId: user.userId,
            isActive: true,
          },
        });

        // Fetch all groups in one query to avoid N+1
        const groupIds = activeMemberships.map((m) => m.groupId);
        const memberGroups =
          groupIds.length > 0
            ? await db.group.findMany({
                where: { id: { in: groupIds } },
                select: { id: true, type: true },
              })
            : [];

        // Count NPC groups
        const npcGroupCount = memberGroups.filter(
          (g) => g.type === 'npc'
        ).length;

        if (npcGroupCount >= GROUP_CONFIG.MAX_ACTIVE_USER_GROUPS) {
          throw new ApiError(
            `You can only be in ${GROUP_CONFIG.MAX_ACTIVE_USER_GROUPS} NPC groups at a time. Leave a group first.`,
            400
          );
        }
      }

      // Check if user is already an active member (fail fast, no race condition here)
      const existingActiveMember = await db.groupMember.findFirst({
        where: {
          groupId: invite.groupId,
          userId: user.userId,
          isActive: true,
        },
      });

      if (existingActiveMember) {
        throw new ApiError('You are already a member of this group', 400);
      }

      // Find the chat for this group (Chat.groupId → Group.id)
      const groupChat = await db.chat.findFirst({
        where: { groupId: invite.groupId },
        select: { id: true },
      });

      const now = new Date();
      const memberId = await generateSnowflakeId();

      // Upsert GroupMember - use drizzle's onConflictDoUpdate
      // Note: asUser already wraps this in a transaction, so no need for nested transaction
      await db
        .insert(groupMembers)
        .values({
          id: memberId,
          groupId: invite.groupId,
          userId: user.userId,
          role: 'member',
          addedBy: invite.invitedBy,
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
            addedBy: invite.invitedBy,
            joinedAt: now,
            kickedAt: sql`NULL`,
            kickReason: sql`NULL`,
          },
        });

      // Upsert ChatParticipant if chat exists
      if (groupChat) {
        const participantId = await generateSnowflakeId();
        await db
          .insert(chatParticipants)
          .values({
            id: participantId,
            chatId: groupChat.id,
            userId: user.userId,
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
      }

      // Get user's display name for system message
      const joiningUser = await db.user.findUnique({
        where: { id: user.userId },
        select: { displayName: true, username: true },
      });
      const joinerName =
        joiningUser?.displayName || joiningUser?.username || 'Someone';

      // Create system message for joining
      if (groupChat) {
        await db.message.create({
          data: {
            id: await generateSnowflakeId(),
            chatId: groupChat.id,
            senderId: 'system',
            type: 'system',
            content: `${joinerName} joined the group`,
            createdAt: now,
          },
        });
      }

      // Update invite status
      await db.groupInvite.update({
        where: { id: inviteId },
        data: {
          status: 'accepted',
          respondedAt: new Date(),
        },
      });

      // Mark only this specific invite's notification as read
      await db.notification.updateMany({
        where: {
          userId: user.userId,
          type: 'group_invite',
          inviteId: inviteId,
        },
        data: {
          read: true,
        },
      });

      return {
        groupId: invite.groupId,
        chatId: groupChat?.id || null,
      };
    });

    logger.info(
      'Group invite accepted',
      { userId: user.userId, inviteId },
      'POST /api/groups/invites/:inviteId/accept'
    );

    void checkProgress(user.userId, { type: 'group_joined' });

    return successResponse({
      success: true,
      ...result,
    });
  }
);
