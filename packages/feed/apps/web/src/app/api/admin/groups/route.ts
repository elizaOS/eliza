/**
 * Admin Groups API
 *
 * @route GET /api/admin/groups - Get all group chats
 * @access Admin
 *
 * @description
 * Returns all group chats in the system for verification and debugging.
 * Supports filtering by creator and sorting by various fields. Admin only.
 *
 * @openapi
 * /api/admin/groups:
 *   get:
 *     tags:
 *       - Admin
 *     summary: Get all group chats
 *     description: Returns all group chats with filtering and sorting (admin only)
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: creator
 *         schema:
 *           type: string
 *         description: Filter by creator name
 *       - in: query
 *         name: sortBy
 *         schema:
 *           type: string
 *           enum: [createdAt, memberCount, messageCount]
 *           default: createdAt
 *         description: Sort field
 *       - in: query
 *         name: sortOrder
 *         schema:
 *           type: string
 *           enum: [asc, desc]
 *           default: desc
 *         description: Sort order
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *         description: Maximum groups to return (default 50, max 200)
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *         description: Pagination offset
 *     responses:
 *       200:
 *         description: Groups retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 groups:
 *                   type: array
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Admin access required
 *
 * @example
 * ```typescript
 * const { groups } = await fetch('/api/admin/groups?sortBy=memberCount', {
 *   headers: { 'Authorization': `Bearer ${adminToken}` }
 * }).then(r => r.json());
 * ```
 */

import {
  getClientIp,
  logAdminView,
  requireAdmin,
  withErrorHandling,
} from "@feed/api";
import {
  asc,
  asSystem,
  chatParticipants,
  chats,
  desc,
  eq,
  groups,
  inArray,
  messages,
  users,
} from "@feed/db";
import { StaticDataRegistry } from "@feed/engine";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

/**
 * GET /api/admin/groups
 * Get all group chats with filtering and sorting
 * Admin only (localhost bypass handled by requireAdmin)
 */
export const GET = withErrorHandling(async (request: NextRequest) => {
  // Require admin (automatically bypassed on localhost)
  const admin = await requireAdmin(request);

  // Audit log the admin access
  logAdminView({
    adminId: admin.userId,
    ipAddress: getClientIp(request.headers) ?? undefined,
    resourceType: "groups",
    metadata: { action: "list_all_groups" },
  });

  // Get query parameters
  const { searchParams } = new URL(request.url);
  const creatorFilter = searchParams.get("creator"); // Filter by creator name
  const sortBy = searchParams.get("sortBy") || "createdAt"; // createdAt, memberCount, messageCount
  const sortOrder = searchParams.get("sortOrder") || "desc";
  const limit = Math.min(
    Math.max(1, parseInt(searchParams.get("limit") || "50", 10) || 50),
    200,
  );
  const offset = Math.max(
    0,
    parseInt(searchParams.get("offset") || "0", 10) || 0,
  );

  // Get all data using asSystem in a single call to avoid nested async issues
  const { chatsList, allUsers, allActors, allUserGroups } = await asSystem(
    async (database) => {
      // Get all group chats
      const chatsList = await database
        .select()
        .from(chats)
        .where(eq(chats.isGroup, true))
        .orderBy(
          sortOrder === "asc" ? asc(chats.createdAt) : desc(chats.createdAt),
        );

      // Get all chat IDs
      const chatIds = chatsList.map((c) => c.id);

      // Get all participants for these chats
      const participantsList =
        chatIds.length > 0
          ? await database
              .select({
                chatId: chatParticipants.chatId,
                userId: chatParticipants.userId,
                joinedAt: chatParticipants.joinedAt,
              })
              .from(chatParticipants)
              .where(inArray(chatParticipants.chatId, chatIds))
          : [];

      // Get last 10 messages for each chat
      const messagesList =
        chatIds.length > 0
          ? await database
              .select({
                id: messages.id,
                chatId: messages.chatId,
                senderId: messages.senderId,
                content: messages.content,
                createdAt: messages.createdAt,
              })
              .from(messages)
              .where(inArray(messages.chatId, chatIds))
              .orderBy(desc(messages.createdAt))
          : [];

      // Get all unique participant IDs
      const allParticipantIds = [
        ...new Set(participantsList.map((p) => p.userId)),
      ];
      const allMessageSenderIds = [
        ...new Set(messagesList.map((m) => m.senderId)),
      ];
      const allUserIds = [
        ...new Set([...allParticipantIds, ...allMessageSenderIds]),
      ];

      // Get all users and actors at once
      const allUsers =
        allUserIds.length > 0
          ? await database
              .select({
                id: users.id,
                username: users.username,
                displayName: users.displayName,
                isActor: users.isActor,
                profileImageUrl: users.profileImageUrl,
              })
              .from(users)
              .where(inArray(users.id, allUserIds))
          : [];

      const allActors = allUserIds
        .map((id) => StaticDataRegistry.getActor(id))
        .filter((a): a is NonNullable<typeof a> => a !== null)
        .map((a) => ({
          id: a.id,
          name: a.name,
          profileImageUrl: a.profileImageUrl,
        }));

      // Get all groups - indexed by ID for lookup
      const allUserGroups = await database
        .select({
          id: groups.id,
          name: groups.name,
          createdById: groups.createdById,
          ownerId: groups.ownerId,
          type: groups.type,
        })
        .from(groups);

      // Group participants and messages by chat
      const participantsByChat = new Map<string, typeof participantsList>();
      participantsList.forEach((p) => {
        const list = participantsByChat.get(p.chatId) || [];
        list.push(p);
        participantsByChat.set(p.chatId, list);
      });

      const messagesByChat = new Map<string, typeof messagesList>();
      messagesList.forEach((m) => {
        const list = messagesByChat.get(m.chatId) || [];
        if (list.length < 10) {
          // Keep only last 10 messages per chat
          list.push(m);
        }
        messagesByChat.set(m.chatId, list);
      });

      // Attach participants and messages to chats
      const chatsWithRelations = chatsList.map((chat) => ({
        ...chat,
        participants: participantsByChat.get(chat.id) || [],
        messages: messagesByChat.get(chat.id) || [],
      }));

      return {
        chatsList: chatsWithRelations,
        allUsers,
        allActors,
        allUserGroups,
      };
    },
    "admin-groups",
  );

  // Create maps for quick lookup
  const usersMap = new Map(allUsers.map((u) => [u.id, u]));
  const actorsMap = new Map(allActors.map((a) => [a.id, a]));
  const groupsById = new Map(allUserGroups.map((g) => [g.id, g]));

  // Enrich with creator and participant details
  const enrichedChats = chatsList.map((chat) => {
    const participantIds = chat.participants.map((p) => p.userId);

    // Get participants from maps
    const usersInChat = participantIds
      .map((id) => usersMap.get(id))
      .filter((u): u is NonNullable<typeof u> => u !== undefined);
    const actorsInChat = participantIds
      .map((id) => actorsMap.get(id))
      .filter((a): a is NonNullable<typeof a> => a !== undefined);

    // Determine group type and creator
    const actorParticipantIds = actorsInChat.map((a) => a.id);
    const hasNPCs = actorParticipantIds.length > 0;
    const hasUsers = usersInChat.filter((u) => !u.isActor).length > 0;

    let groupType = "unknown";
    let creatorName = "Unknown";
    let creatorId: string | null = null;

    // First, try to get type from Group schema (authoritative)
    const linkedGroup = chat.groupId ? groupsById.get(chat.groupId) : null;

    if (linkedGroup) {
      // Use authoritative type from Group table
      groupType = linkedGroup.type; // 'user' | 'npc' | 'agent'
      const ownerId = linkedGroup.ownerId || linkedGroup.createdById;

      // Find the owner/creator
      const ownerUser = ownerId ? usersMap.get(ownerId) : null;
      const ownerActor = ownerId ? actorsMap.get(ownerId) : null;

      if (ownerActor) {
        creatorName = ownerActor.name;
        creatorId = ownerActor.id;
      } else if (ownerUser) {
        creatorName = ownerUser.displayName || ownerUser.username || "Unknown";
        creatorId = ownerUser.id;
      }
    } else {
      // Legacy chats without linked Group - infer type from participants
      if (hasNPCs && !hasUsers) {
        groupType = "npc-only";
        const creator = actorsInChat[0];
        if (creator) {
          creatorName = creator.name;
          creatorId = creator.id;
        }
      } else if (hasNPCs && hasUsers) {
        groupType = "npc-mixed";
        const creator = actorsInChat[0];
        if (creator) {
          creatorName = creator.name;
          creatorId = creator.id;
        }
      } else {
        groupType = "user";
      }
    }

    // Apply creator filter
    if (
      creatorFilter &&
      !creatorName.toLowerCase().includes(creatorFilter.toLowerCase())
    ) {
      return null;
    }

    // Combine user and actor info for participants
    const participantsFormatted = chat.participants.map((p) => {
      const user = usersInChat.find((u) => u.id === p.userId);
      const actor = actorsInChat.find((a) => a.id === p.userId);

      return {
        id: p.userId,
        name: user?.displayName || user?.username || actor?.name || "Unknown",
        username: user?.username || null,
        isNPC: !!actor || user?.isActor,
        profileImageUrl: user?.profileImageUrl || actor?.profileImageUrl,
        joinedAt: p.joinedAt,
      };
    });

    // Get message senders from maps
    const messagesWithSenders = chat.messages.map((m) => {
      const user = usersMap.get(m.senderId);
      const actor = actorsMap.get(m.senderId);

      return {
        id: m.id,
        content: m.content,
        createdAt: m.createdAt,
        sender: {
          id: m.senderId,
          name: user?.displayName || user?.username || actor?.name || "Unknown",
          isNPC: !!actor || user?.isActor,
        },
      };
    });

    return {
      id: chat.id,
      name: chat.name,
      groupType,
      creatorId,
      creatorName,
      memberCount: participantsFormatted.length,
      messageCount: chat.messages.length,
      participants: participantsFormatted,
      recentMessages: messagesWithSenders,
      createdAt: chat.createdAt,
      updatedAt: chat.updatedAt,
    };
  });

  // Filter out nulls (from filters)
  const filteredChats = enrichedChats.filter((c) => c !== null);

  // Sort if needed
  if (sortBy === "memberCount") {
    filteredChats.sort((a, b) => {
      const order = sortOrder === "asc" ? 1 : -1;
      return order * (a?.memberCount - b?.memberCount);
    });
  } else if (sortBy === "messageCount") {
    filteredChats.sort((a, b) => {
      const order = sortOrder === "asc" ? 1 : -1;
      return order * (a?.messageCount - b?.messageCount);
    });
  }

  // Apply pagination
  const total = filteredChats.length;
  const paginatedChats = filteredChats.slice(offset, offset + limit);

  return NextResponse.json({
    success: true,
    data: {
      groups: paginatedChats,
      total,
      limit,
      offset,
      hasMore: offset + limit < total,
    },
  });
});
