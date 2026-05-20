/**
 * Group Management API
 *
 * @route GET /api/groups/[groupId] - Get group details
 * @route PUT /api/groups/[groupId] - Update group
 * @route DELETE /api/groups/[groupId] - Delete group
 * @access Authenticated (members/admins only)
 *
 * @description
 * Manages individual group details, settings, and lifecycle. GET returns group
 * information with members. PUT updates group name/description (admin/owner only).
 * DELETE removes the group (owner only).
 */

import {
  ApiError,
  authenticate,
  successResponse,
  withErrorHandling,
} from '@feed/api';
import { asUser } from '@feed/db';
import { logger } from '@feed/shared';
import type { NextRequest } from 'next/server';
import { z } from 'zod';

const UpdateGroupSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
});

/**
 * GET /api/groups/[groupId]
 * Get group details including members
 */
export const GET = withErrorHandling(
  async (
    request: NextRequest,
    { params }: { params: Promise<{ groupId: string }> }
  ) => {
    const user = await authenticate(request);
    const { groupId } = await params;

    const groupDetails = await asUser(user, async (db) => {
      // Fetch the group
      const group = await db.group.findUnique({
        where: { id: groupId },
      });

      if (!group) {
        throw new ApiError('Group not found', 404);
      }

      // Fetch members
      const members = await db.groupMember.findMany({
        where: { groupId, isActive: true },
      });

      // Check if user is a member
      const userMembership = members.find((m) => m.userId === user.userId);
      if (!userMembership) {
        throw new ApiError('You are not a member of this group', 403);
      }

      // Fetch member user details
      const memberIds = members.map((m) => m.userId);
      const memberUsers = await db.user.findMany({
        where: {
          id: { in: memberIds },
        },
      });

      // Get the chat for this group (Chat.groupId → Group.id)
      const groupChat = await db.chat.findFirst({
        where: { groupId },
        select: { id: true },
      });

      return {
        id: group.id,
        name: group.name,
        description: group.description,
        type: group.type,
        chatId: groupChat?.id || null,
        ownerId: group.ownerId,
        createdById: group.createdById,
        createdAt: group.createdAt,
        updatedAt: group.updatedAt,
        members: memberUsers.map((u) => {
          const membership = members.find((m) => m.userId === u.id);
          // Determine member type: NPC (isActor), Agent (isAgent), or User
          const memberType = u.isActor ? 'npc' : u.isAgent ? 'agent' : 'user';
          return {
            id: u.id,
            displayName: u.displayName,
            username: u.username,
            profileImageUrl: u.profileImageUrl,
            memberType,
            role: membership?.role ?? 'member',
            isAdmin:
              membership?.role === 'admin' || membership?.role === 'owner',
            isOwner: membership?.role === 'owner',
            joinedAt: membership?.joinedAt || new Date(),
          };
        }),
        userRole: userMembership.role,
        isAdmin:
          userMembership.role === 'admin' || userMembership.role === 'owner',
        isOwner: userMembership.role === 'owner',
      };
    });

    logger.info(
      'Group details retrieved',
      { userId: user.userId, groupId },
      'GET /api/groups/:groupId'
    );

    return successResponse({ group: groupDetails });
  }
);

/**
 * PATCH /api/groups/[groupId]
 * Update group details (admin/owner only)
 */
export const PATCH = withErrorHandling(
  async (
    request: NextRequest,
    { params }: { params: Promise<{ groupId: string }> }
  ) => {
    const user = await authenticate(request);
    const { groupId } = await params;
    const body = await request.json();
    const data = UpdateGroupSchema.parse(body);

    const updatedGroup = await asUser(user, async (db) => {
      // Check if user is admin or owner
      const membership = await db.groupMember.findFirst({
        where: {
          groupId,
          userId: user.userId,
          isActive: true,
        },
      });

      if (!membership || !['admin', 'owner'].includes(membership.role)) {
        throw new ApiError('Only group admins can update group details', 403);
      }

      // Update group
      const group = await db.group.update({
        where: { id: groupId },
        data: {
          ...data,
          updatedAt: new Date(),
        },
      });

      // Update associated chat name if name changed (Chat.groupId → Group.id)
      if (data.name) {
        await db.chat.updateMany({
          where: { groupId },
          data: {
            name: data.name,
            updatedAt: new Date(),
          },
        });
      }

      return group;
    });

    logger.info(
      'Group updated',
      { userId: user.userId, groupId },
      'PATCH /api/groups/:groupId'
    );

    return successResponse({ group: updatedGroup });
  }
);

/**
 * DELETE /api/groups/[groupId]
 * Delete a group (owner only)
 */
export const DELETE = withErrorHandling(
  async (
    request: NextRequest,
    { params }: { params: Promise<{ groupId: string }> }
  ) => {
    const user = await authenticate(request);
    const { groupId } = await params;

    await asUser(user, async (db) => {
      // Check if user is owner
      const membership = await db.groupMember.findFirst({
        where: {
          groupId,
          userId: user.userId,
          isActive: true,
        },
      });

      if (!membership || membership.role !== 'owner') {
        throw new ApiError('Only the group owner can delete the group', 403);
      }

      // Find the chat for this group (Chat.groupId → Group.id)
      const groupChat = await db.chat.findFirst({
        where: { groupId },
        select: { id: true },
      });

      // Clean up chat and related data FIRST (before deleting group)
      // This ensures we don't have orphaned chat data if group deletion succeeds
      // but chat cleanup fails
      if (groupChat) {
        // Delete messages first (foreign key constraint)
        await db.message.deleteMany({
          where: { chatId: groupChat.id },
        });

        // Delete chat participants
        await db.chatParticipant.deleteMany({
          where: { chatId: groupChat.id },
        });

        // Delete the chat itself
        await db.chat.delete({
          where: { id: groupChat.id },
        });
      }

      // Delete group members
      await db.groupMember.deleteMany({
        where: { groupId },
      });

      // Delete group invites
      await db.groupInvite.deleteMany({
        where: { groupId },
      });

      // Delete the group last
      await db.group.delete({
        where: { id: groupId },
      });
    });

    logger.info(
      'Group deleted',
      { userId: user.userId, groupId },
      'DELETE /api/groups/:groupId'
    );

    return successResponse({ success: true });
  }
);
