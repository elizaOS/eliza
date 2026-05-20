/**
 * User Groups API
 *
 * @description
 * Manages user-created groups for organizing communities, trading clubs,
 * discussion groups, etc. Provides group listing, creation, and automatic
 * chat integration for each group.
 *
 * **Features:**
 * - Create custom groups
 * - Multi-member support
 * - Role-based access (owner, admin, member)
 * - Automatic chat creation for each group
 * - Group discovery
 *
 * **Group Roles (stored in GroupMember.role):**
 * - **owner:** Original group creator (full control)
 * - **admin:** Can manage group settings and members
 * - **member:** Can participate in group chat
 *
 * **Automatic Features:**
 * - Group creator automatically becomes owner
 * - Group gets dedicated chat room
 * - All members added to chat automatically
 *
 * @openapi
 * /api/groups:
 *   get:
 *     tags:
 *       - Groups
 *     summary: List user's groups
 *     description: Returns all groups where user is a member
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: User's groups
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 groups:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                       name:
 *                         type: string
 *                       description:
 *                         type: string
 *                       type:
 *                         type: string
 *                       memberCount:
 *                         type: integer
 *                       role:
 *                         type: string
 *                       isOwner:
 *                         type: boolean
 *                       createdAt:
 *                         type: string
 *                         format: date-time
 *       401:
 *         description: Unauthorized
 *   post:
 *     tags:
 *       - Groups
 *     summary: Create new group
 *     description: Creates a new group with optional initial members and automatic chat
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *             properties:
 *               name:
 *                 type: string
 *                 minLength: 1
 *                 maxLength: 100
 *                 description: Group name
 *               memberIds:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Initial member user IDs (optional)
 *     responses:
 *       200:
 *         description: Group created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 group:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: string
 *                     name:
 *                       type: string
 *                     createdAt:
 *                       type: string
 *                       format: date-time
 *                     chatId:
 *                       type: string
 *       400:
 *         description: Invalid input
 *       401:
 *         description: Unauthorized
 *
 * @example
 * ```typescript
 * // List user's groups
 * const response = await fetch('/api/groups', {
 *   headers: { 'Authorization': `Bearer ${token}` }
 * });
 * const { groups } = await response.json();
 *
 * groups.forEach(group => {
 *   console.log(`${group.name}: ${group.memberCount} members`);
 *   if (group.role === 'admin' || group.role === 'owner') {
 *     console.log('  (You can manage this group)');
 *   }
 * });
 *
 * // Create new group
 * const newGroup = await fetch('/api/groups', {
 *   method: 'POST',
 *   headers: { 'Authorization': `Bearer ${token}` },
 *   body: JSON.stringify({
 *     name: 'Trading Strategy Group',
 *     memberIds: ['user1', 'user2', 'user3']
 *   })
 * });
 *
 * const { group } = await newGroup.json();
 * console.log(`Created group: ${group.id}, Chat: ${group.chatId}`);
 * ```
 */

import {
  authenticate,
  checkProgress,
  notifyGroupMemberAdded,
  notifyUserGroupInvite,
  successResponse,
  withErrorHandling,
} from '@feed/api';
import { asUser, generateSnowflakeId, groupInvites } from '@feed/db';
import { logger } from '@feed/shared';
import { nanoid } from 'nanoid';
import type { NextRequest } from 'next/server';
import { z } from 'zod';

const CreateGroupSchema = z.object({
  name: z.string().min(1).max(100),
  memberIds: z.array(z.string()).optional().default([]),
  // Note: 'type' is intentionally NOT accepted from client.
  // User-created groups always get type: 'user'.
  // NPC groups (type: 'npc') are created by backend services.
  // Agent groups (type: 'agent') are created via MCP tools.
  requiredNftContractAddress: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid contract address format')
    .optional(),
  requiredNftTokenId: z.number().int().min(0).nullable().optional(),
  requiredNftChainId: z.number().int().positive().optional(),
});

/**
 * GET /api/groups
 * List all groups the user is a member of
 */
export const GET = withErrorHandling(async (request: NextRequest) => {
  const user = await authenticate(request);

  const groups = await asUser(user, async (db) => {
    // Find groups where user is a member
    const memberships = await db.groupMember.findMany({
      where: {
        userId: user.userId,
        isActive: true,
      },
    });

    if (memberships.length === 0) {
      return [];
    }

    const groupIds = memberships.map((m) => m.groupId);

    // Get the groups
    const userGroups = await db.group.findMany({
      where: {
        id: { in: groupIds },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    // Get member counts for all groups
    const memberCounts = await Promise.all(
      groupIds.map((gid) =>
        db.groupMember.count({
          where: { groupId: gid, isActive: true },
        })
      )
    );

    const memberCountMap = new Map(
      groupIds.map((gid, i) => [gid, memberCounts[i] ?? 0])
    );

    // Build role map from memberships
    const roleMap = new Map(memberships.map((m) => [m.groupId, m.role]));

    // Get chat IDs for each group (Chat.groupId → Group.id)
    const groupIdList = userGroups.map((g) => g.id);
    const groupChats = await db.chat.findMany({
      where: { groupId: { in: groupIdList } },
      select: { id: true, groupId: true },
    });
    const chatIdMap = new Map(groupChats.map((c) => [c.groupId, c.id]));

    return userGroups.map((group) => ({
      id: group.id,
      name: group.name,
      description: group.description,
      type: group.type,
      chatId: chatIdMap.get(group.id) || null,
      createdAt: group.createdAt,
      updatedAt: group.updatedAt,
      memberCount: memberCountMap.get(group.id) ?? 0,
      role: roleMap.get(group.id) ?? 'member',
      isOwner: group.ownerId === user.userId,
      isAdmin:
        roleMap.get(group.id) === 'admin' || roleMap.get(group.id) === 'owner',
    }));
  });

  logger.info(
    'Groups list retrieved',
    { userId: user.userId, groupCount: groups.length },
    'GET /api/groups'
  );

  return successResponse({ groups });
});

/**
 * POST /api/groups
 * Create a new group
 */
export const POST = withErrorHandling(async (request: NextRequest) => {
  const user = await authenticate(request);
  const body = await request.json();
  const data = CreateGroupSchema.parse(body);

  // Note: asUser wraps all operations in a database transaction,
  // ensuring atomicity for group creation + member additions
  const result = await asUser(user, async (db) => {
    // Create the group
    const groupId = nanoid();
    const newGroup = await db.group.create({
      data: {
        id: groupId,
        name: data.name,
        type: 'user', // User-created group
        ownerId: user.userId,
        createdById: user.userId,
        updatedAt: new Date(),
      },
    });

    // Create associated chat with groupId link (Chat.groupId → Group.id)
    const chatId = nanoid();
    const nftGated = !!data.requiredNftContractAddress;
    await db.chat.create({
      data: {
        id: chatId,
        name: data.name,
        isGroup: true,
        groupId, // Link Chat → Group
        createdAt: new Date(),
        updatedAt: new Date(),
        requiredNftContractAddress: data.requiredNftContractAddress || null,
        requiredNftTokenId: data.requiredNftTokenId ?? null,
        requiredNftChainId: data.requiredNftChainId ?? null,
        nftGated,
      },
    });

    // Add creator as owner
    await db.groupMember.create({
      data: {
        id: nanoid(),
        groupId,
        userId: user.userId,
        role: 'owner',
        addedBy: user.userId,
      },
    });

    // Add creator to chat participants
    await db.chatParticipant.create({
      data: {
        id: nanoid(),
        chatId,
        userId: user.userId,
        joinedAt: new Date(),
      },
    });

    // Process initial members: humans get invites, agents get direct add
    const addedMemberIds: string[] = [];
    const invitedMemberIds: string[] = [];
    // Notification work list - sent AFTER transaction commits
    const agentNotifications: string[] = [];
    const humanInviteNotifications: Array<{
      humanId: string;
      inviteId: string;
    }> = [];
    let creatorName = 'Someone';

    if (data.memberIds.length > 0) {
      const otherMembers = data.memberIds.filter((id) => id !== user.userId);

      if (otherMembers.length > 0) {
        // Verify users exist and are not banned, get their details including type
        const validMembers = await db.user.findMany({
          where: {
            id: { in: otherMembers },
            isBanned: false,
          },
          select: {
            id: true,
            displayName: true,
            username: true,
            isAgent: true,
            isActor: true,
          },
        });

        if (validMembers.length > 0) {
          // Get creator's name for messages
          const creator = await db.user.findUnique({
            where: { id: user.userId },
            select: { displayName: true, username: true },
          });
          creatorName = creator?.displayName || creator?.username || 'Someone';

          // Separate humans from agents/NPCs
          const agents = validMembers.filter((m) => m.isAgent || m.isActor);
          const humans = validMembers.filter((m) => !m.isAgent && !m.isActor);

          // AGENTS/NPCs: Direct add (they don't need to accept)
          if (agents.length > 0) {
            const agentIds = agents.map((u) => u.id);

            await db.groupMember.createMany({
              data: agentIds.map((uId) => ({
                id: nanoid(),
                groupId,
                userId: uId,
                role: 'member',
                addedBy: user.userId,
              })),
            });

            await db.chatParticipant.createMany({
              data: agentIds.map((uId) => ({
                id: nanoid(),
                chatId,
                userId: uId,
                joinedAt: new Date(),
              })),
            });

            addedMemberIds.push(...agentIds);
            agentNotifications.push(...agentIds);

            // Create system message for agents added
            const agentNames = agents.map(
              (m) => m.displayName || m.username || 'Unknown'
            );
            const agentNamesText =
              agentNames.length <= 3
                ? agentNames.join(', ')
                : `${agentNames.slice(0, 2).join(', ')} and ${agentNames.length - 2} others`;

            await db.message.create({
              data: {
                id: await generateSnowflakeId(),
                chatId,
                senderId: 'system',
                type: 'system',
                content: `${creatorName} added ${agentNamesText} to the group`,
                createdAt: new Date(),
              },
            });

            // Note: Agent notifications are sent AFTER the transaction commits (see below)
          }

          // HUMANS: Send invites (they need to accept/decline)
          if (humans.length > 0) {
            const humanIds = humans.map((u) => u.id);
            const invitedAt = new Date();

            // Create group invites for humans
            // Use onConflictDoUpdate to allow re-inviting users who previously declined
            for (const humanId of humanIds) {
              const newInviteId = await generateSnowflakeId();
              const result = await db
                .insert(groupInvites)
                .values({
                  id: newInviteId,
                  groupId,
                  invitedUserId: humanId,
                  invitedBy: user.userId,
                  status: 'pending',
                  invitedAt,
                })
                .onConflictDoUpdate({
                  target: [groupInvites.groupId, groupInvites.invitedUserId],
                  set: {
                    invitedBy: user.userId,
                    status: 'pending',
                    invitedAt,
                  },
                })
                .returning({ id: groupInvites.id });

              // Use actual ID from DB (may be existing ID on conflict, or new ID on insert)
              const actualInviteId = result[0]?.id ?? newInviteId;
              if (!result[0]?.id) {
                logger.warn(
                  'Invite returning() returned empty result, using generated ID',
                  {
                    groupId,
                    invitedUserId: humanId,
                    generatedId: newInviteId,
                  },
                  'POST /api/groups'
                );
              }
              humanInviteNotifications.push({
                humanId,
                inviteId: actualInviteId,
              });
              invitedMemberIds.push(humanId);
            }
            // Note: Human invite notifications are sent AFTER the transaction commits (see below)

            // Create system message for invites sent
            const humanNames = humans.map(
              (m) => m.displayName || m.username || 'Unknown'
            );
            const humanNamesText =
              humanNames.length <= 3
                ? humanNames.join(', ')
                : `${humanNames.slice(0, 2).join(', ')} and ${humanNames.length - 2} others`;

            await db.message.create({
              data: {
                id: await generateSnowflakeId(),
                chatId,
                senderId: 'system',
                type: 'system',
                content: `${creatorName} invited ${humanNamesText} to the group`,
                createdAt: new Date(),
              },
            });
          }
        }
      }
    }

    return {
      group: newGroup,
      chatId,
      memberCount: 1 + addedMemberIds.length, // creator + direct-added members (not invites)
      invitedCount: invitedMemberIds.length,
      // Notification work list for post-transaction dispatch
      notifications: {
        agents: agentNotifications,
        humanInvites: humanInviteNotifications,
        creatorName,
      },
    };
  });

  // Send notifications AFTER transaction commits (prevents orphan notifications on rollback)
  if (result.notifications.agents.length > 0) {
    await Promise.allSettled(
      result.notifications.agents.map((memberId) =>
        notifyGroupMemberAdded(
          memberId,
          user.userId,
          result.group.id,
          data.name,
          result.chatId,
          result.notifications.creatorName
        )
      )
    );
  }

  if (result.notifications.humanInvites.length > 0) {
    await Promise.allSettled(
      result.notifications.humanInvites.map(({ humanId, inviteId }) =>
        notifyUserGroupInvite(
          humanId,
          user.userId,
          result.group.id,
          data.name,
          inviteId,
          result.notifications.creatorName // Pass pre-fetched name to avoid N+1
        )
      )
    );
  }

  logger.info(
    'Group created',
    {
      userId: user.userId,
      groupId: result.group.id,
      chatId: result.chatId,
      memberCount: result.memberCount,
      invitedCount: result.invitedCount,
    },
    'POST /api/groups'
  );

  void checkProgress(user.userId, { type: 'group_created' });

  return successResponse({
    group: {
      id: result.group.id,
      name: result.group.name,
      type: result.group.type,
      createdAt: result.group.createdAt,
      chatId: result.chatId,
      memberCount: result.memberCount,
      invitedCount: result.invitedCount,
    },
  });
});
