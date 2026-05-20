/**
 * Group Members API
 *
 * @route POST /api/groups/[groupId]/members - Add member to group
 * @route DELETE /api/groups/[groupId]/members - Remove member from group
 * @access Authenticated (admins can add/remove, members can self-remove)
 *
 * Member addition behavior:
 * - Agents/NPCs are added directly (no invite needed)
 * - Human users receive an invite they can accept/decline
 * - NPC groups (type: 'npc') use the tiered system and cannot have members added via this API
 */

import {
  ApiError,
  authenticate,
  notifyGroupMemberAdded,
  notifyUserGroupInvite,
  successResponse,
  withErrorHandling,
} from "@feed/api";
import {
  and,
  asUser,
  chatParticipants,
  eq,
  generateSnowflakeId,
  groupInvites,
  groupMembers,
  sql,
} from "@feed/db";
import { logger } from "@feed/shared";
import type { NextRequest } from "next/server";
import { z } from "zod";

const AddMemberSchema = z.object({
  userId: z.string(),
});

/**
 * GET /api/groups/[groupId]/members
 * List active group members for an authenticated member.
 */
export const GET = withErrorHandling(
  async (
    request: NextRequest,
    { params }: { params: Promise<{ groupId: string }> },
  ) => {
    const user = await authenticate(request);
    const { groupId } = await params;

    const groupMembersList = await asUser(user, async (db) => {
      const group = await db.group.findUnique({
        where: { id: groupId },
        select: { id: true },
      });

      if (!group) {
        throw new ApiError("Group not found", 404);
      }

      const members = await db.groupMember.findMany({
        where: {
          groupId,
          isActive: true,
        },
        orderBy: {
          joinedAt: "asc",
        },
      });

      const requesterMembership = members.find(
        (member) => member.userId === user.userId,
      );
      if (!requesterMembership) {
        throw new ApiError("You are not a member of this group", 403);
      }

      const memberIds = members.map((member) => member.userId);
      const memberUsers =
        memberIds.length > 0
          ? await db.user.findMany({
              where: {
                id: { in: memberIds },
              },
              select: {
                id: true,
                displayName: true,
                username: true,
                profileImageUrl: true,
                isActor: true,
                isAgent: true,
              },
            })
          : [];
      const memberUserMap = new Map(
        memberUsers.map((memberUser) => [memberUser.id, memberUser]),
      );

      return members.map((member) => {
        const memberUser = memberUserMap.get(member.userId);
        const memberType = memberUser?.isActor
          ? "npc"
          : memberUser?.isAgent
            ? "agent"
            : "user";

        return {
          id: member.userId,
          displayName: memberUser?.displayName ?? null,
          username: memberUser?.username ?? null,
          profileImageUrl: memberUser?.profileImageUrl ?? null,
          memberType,
          role: member.role,
          isAdmin: member.role === "admin" || member.role === "owner",
          isOwner: member.role === "owner",
          joinedAt: member.joinedAt,
        };
      });
    });

    logger.info(
      "Group members retrieved",
      { userId: user.userId, groupId, count: groupMembersList.length },
      "GET /api/groups/:groupId/members",
    );

    return successResponse({
      groupId,
      members: groupMembersList,
    });
  },
);

/**
 * POST /api/groups/[groupId]/members
 * Add a member to the group (admin only)
 *
 * - Agents/NPCs are added directly (no invite needed)
 * - Human users receive an invite they can accept/decline
 * - NPC groups use the tiered system and cannot be modified via this API
 */
export const POST = withErrorHandling(
  async (
    request: NextRequest,
    { params }: { params: Promise<{ groupId: string }> },
  ) => {
    const user = await authenticate(request);
    const { groupId } = await params;
    const body = await request.json();
    const data = AddMemberSchema.parse(body);

    let groupName = "Unknown";
    let chatId: string | null = null;

    // Note: asUser wraps all operations in a database transaction,
    // ensuring atomicity for member addition + chat participant + notifications
    const result = await asUser(user, async (db) => {
      // Get group details first to check type
      const group = await db.group.findUnique({
        where: { id: groupId },
        select: { name: true, type: true },
      });

      if (!group) {
        throw new ApiError("Group not found", 404);
      }

      groupName = group.name || "Unknown";

      // NPC groups use the tiered system, cannot add members directly
      if (group.type === "npc") {
        throw new ApiError(
          "Cannot directly add members to NPC groups. NPC groups use the tiered invitation system.",
          403,
        );
      }

      // Check if user is admin or owner
      const membership = await db.groupMember.findFirst({
        where: {
          groupId,
          userId: user.userId,
          isActive: true,
        },
      });

      if (!membership || !["admin", "owner"].includes(membership.role)) {
        throw new ApiError("Only group admins can add members", 403);
      }

      // Verify the user to add exists and is not banned, get type info
      const userToAdd = await db.user.findUnique({
        where: { id: data.userId },
        select: {
          id: true,
          isBanned: true,
          displayName: true,
          username: true,
          isAgent: true,
          isActor: true,
        },
      });

      if (!userToAdd) {
        throw new ApiError("User not found", 404);
      }

      if (userToAdd.isBanned) {
        throw new ApiError("Cannot add banned users to groups", 400);
      }

      // Check if user is already a member
      const existingMember = await db.groupMember.findFirst({
        where: {
          groupId,
          userId: data.userId,
          isActive: true,
        },
      });

      if (existingMember) {
        throw new ApiError("User is already a member of this group", 400);
      }

      // Check if there's already an invite for this user
      const existingInvite = await db.groupInvite.findFirst({
        where: {
          groupId,
          invitedUserId: data.userId,
        },
        select: { id: true, status: true },
      });

      if (existingInvite && existingInvite.status === "pending") {
        throw new ApiError(
          "User already has a pending invite to this group",
          400,
        );
      }
      // Note: If status is 'declined' or 'accepted', we allow re-inviting by updating the existing invite

      // Find the chat for this group
      const groupChat = await db.chat.findFirst({
        where: { groupId },
        select: { id: true },
      });

      chatId = groupChat?.id || null;

      // Get adder's name for messages
      const adder = await db.user.findUnique({
        where: { id: user.userId },
        select: { displayName: true, username: true },
      });
      const adderName = adder?.displayName || adder?.username || "Someone";
      const addedUserName =
        userToAdd.displayName || userToAdd.username || "Someone";

      const now = new Date();
      const isAgentOrNpc = userToAdd.isAgent || userToAdd.isActor;

      if (isAgentOrNpc) {
        // AGENT/NPC: Add directly (no invite needed)
        const memberId = await generateSnowflakeId();

        await db
          .insert(groupMembers)
          .values({
            id: memberId,
            groupId,
            userId: data.userId,
            role: "member",
            addedBy: user.userId,
            joinedAt: now,
            isActive: true,
            messageCount: 0,
            qualityScore: 1.0,
          })
          .onConflictDoUpdate({
            target: [groupMembers.groupId, groupMembers.userId],
            set: {
              isActive: true,
              role: "member",
              addedBy: user.userId,
              joinedAt: now,
              kickedAt: sql`NULL`,
              kickReason: sql`NULL`,
            },
          });

        // Add to chat participants
        if (groupChat) {
          const participantId = await generateSnowflakeId();
          await db
            .insert(chatParticipants)
            .values({
              id: participantId,
              chatId: groupChat.id,
              userId: data.userId,
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

          // System message for direct add
          await db.message.create({
            data: {
              id: await generateSnowflakeId(),
              chatId: groupChat.id,
              senderId: "system",
              type: "system",
              content: `${adderName} added ${addedUserName} to the group`,
              createdAt: now,
            },
          });
        }

        return { added: true, invited: false, adderName, inviteId: null };
      } else {
        // HUMAN: Send invite (they need to accept)
        // Reuse existing invite ID if re-inviting, otherwise generate new one
        const inviteId = existingInvite?.id ?? (await generateSnowflakeId());

        if (existingInvite) {
          // Re-invite: update existing invite back to pending
          await db
            .update(groupInvites)
            .set({
              invitedBy: user.userId,
              status: "pending",
              invitedAt: now,
              respondedAt: sql`NULL`,
            })
            .where(
              and(
                eq(groupInvites.groupId, groupId),
                eq(groupInvites.invitedUserId, data.userId),
              ),
            );
        } else {
          // New invite
          await db.insert(groupInvites).values({
            id: inviteId,
            groupId,
            invitedUserId: data.userId,
            invitedBy: user.userId,
            status: "pending",
            invitedAt: now,
          });
        }

        // System message for invite
        if (groupChat) {
          await db.message.create({
            data: {
              id: await generateSnowflakeId(),
              chatId: groupChat.id,
              senderId: "system",
              type: "system",
              content: `${adderName} invited ${addedUserName} to the group`,
              createdAt: now,
            },
          });
        }

        return { added: false, invited: true, adderName, inviteId };
      }
    });

    // Send appropriate notification (don't fail request if notification fails)
    if (result.added) {
      // Agent/NPC was directly added
      try {
        await notifyGroupMemberAdded(
          data.userId,
          user.userId,
          groupId,
          groupName,
          chatId || undefined,
          result.adderName,
        );
      } catch (notifyError) {
        logger.error(
          "Failed to send group member added notification",
          { userId: data.userId, groupId, error: notifyError },
          "POST /api/groups/:groupId/members",
        );
      }

      logger.info(
        "Agent/NPC added to group",
        { userId: user.userId, groupId, addedUserId: data.userId },
        "POST /api/groups/:groupId/members",
      );

      return successResponse({ success: true, added: true, invited: false });
    } else {
      // Human was invited
      try {
        await notifyUserGroupInvite(
          data.userId,
          user.userId,
          groupId,
          groupName,
          result.inviteId || undefined,
          result.adderName, // Pass pre-fetched name to avoid N+1
        );
      } catch (notifyError) {
        logger.error(
          "Failed to send group invite notification",
          { userId: data.userId, groupId, error: notifyError },
          "POST /api/groups/:groupId/members",
        );
      }

      logger.info(
        "User invited to group",
        { userId: user.userId, groupId, invitedUserId: data.userId },
        "POST /api/groups/:groupId/members",
      );

      return successResponse({ success: true, added: false, invited: true });
    }
  },
);

/**
 * DELETE /api/groups/[groupId]/members
 * Remove a member from the group (admin only or self)
 */
export const DELETE = withErrorHandling(
  async (
    request: NextRequest,
    { params }: { params: Promise<{ groupId: string }> },
  ) => {
    const user = await authenticate(request);
    const { groupId } = await params;
    const { searchParams } = new URL(request.url);
    const userIdToRemove = searchParams.get("userId");

    if (!userIdToRemove) {
      throw new ApiError("userId parameter is required", 400);
    }

    await asUser(user, async (db) => {
      // Check if user is admin/owner or removing themselves
      const userMembership = await db.groupMember.findFirst({
        where: {
          groupId,
          userId: user.userId,
          isActive: true,
        },
      });

      const isSelf = user.userId === userIdToRemove;
      const isAdmin =
        userMembership && ["admin", "owner"].includes(userMembership.role);

      if (!isAdmin && !isSelf) {
        throw new ApiError("Only group admins can remove members", 403);
      }

      // Get target member
      const targetMembership = await db.groupMember.findFirst({
        where: {
          groupId,
          userId: userIdToRemove,
          isActive: true,
        },
      });

      if (!targetMembership) {
        throw new ApiError("User is not a member of this group", 404);
      }

      // Cannot remove the owner
      if (targetMembership.role === "owner") {
        throw new ApiError("Cannot remove the group owner", 400);
      }

      // Mark member as inactive (soft delete)
      await db.groupMember.update({
        where: { id: targetMembership.id },
        data: {
          isActive: false,
          kickedAt: new Date(),
          kickReason: isSelf ? "left" : "removed by admin",
        },
      });

      // Find chat for this group (Chat.groupId → Group.id)
      const groupChat = await db.chat.findFirst({
        where: { groupId },
        select: { id: true },
      });

      // Remove from associated chat and add system message
      if (groupChat) {
        await db.chatParticipant.deleteMany({
          where: {
            chatId: groupChat.id,
            userId: userIdToRemove,
          },
        });

        // Get names for system message
        const removedUser = await db.user.findUnique({
          where: { id: userIdToRemove },
          select: { displayName: true, username: true },
        });
        const removedName =
          removedUser?.displayName || removedUser?.username || "Someone";

        if (isSelf) {
          // User left on their own
          await db.message.create({
            data: {
              id: await generateSnowflakeId(),
              chatId: groupChat.id,
              senderId: "system",
              type: "system",
              content: `${removedName} left the group`,
              createdAt: new Date(),
            },
          });
        } else {
          // User was removed by admin
          const admin = await db.user.findUnique({
            where: { id: user.userId },
            select: { displayName: true, username: true },
          });
          const adminName = admin?.displayName || admin?.username || "Someone";

          await db.message.create({
            data: {
              id: await generateSnowflakeId(),
              chatId: groupChat.id,
              senderId: "system",
              type: "system",
              content: `${adminName} removed ${removedName} from the group`,
              createdAt: new Date(),
            },
          });
        }
      }
    });

    logger.info(
      "Member removed from group",
      { userId: user.userId, groupId, removedUserId: userIdToRemove },
      "DELETE /api/groups/:groupId/members",
    );

    return successResponse({ success: true });
  },
);
