/**
 * Chat Management API
 *
 * @route GET /api/chats - List user's chats
 * @route POST /api/chats - Create new chat
 * @access Authenticated
 *
 * @description
 * Manages both group chats and direct messages (DMs). Provides chat listings
 * with participant information, message counts, and last message previews.
 * Supports both user-specific chats and all game chats retrieval.
 *
 * @openapi
 * /api/chats:
 *   get:
 *     tags:
 *       - Chats
 *     summary: List user chats
 *     description: Returns all chats (group and DMs) the authenticated user participates in. Use ?all=true for public game chats.
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: all
 *         schema:
 *           type: boolean
 *         description: Get all game chats (public, no auth)
 *       - in: query
 *         name: debug
 *         schema:
 *           type: boolean
 *         description: Enable debug logging
 *     responses:
 *       200:
 *         description: Chat listings
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 groupChats:
 *                   type: array
 *                   items:
 *                     type: object
 *                 directChats:
 *                   type: array
 *                   items:
 *                     type: object
 *                 total:
 *                   type: integer
 *       401:
 *         description: Unauthorized
 *   post:
 *     tags:
 *       - Chats
 *     summary: Create new chat
 *     description: Creates a new chat (group or DM) and adds participants.
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *                 description: Chat name (optional for DMs)
 *               isGroup:
 *                 type: boolean
 *                 default: false
 *               participantIds:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Array of user IDs to add
 *     responses:
 *       201:
 *         description: Chat created
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 chat:
 *                   type: object
 *       401:
 *         description: Unauthorized
 *
 * **GET - List User's Chats**
 *
 * Returns all chats the authenticated user participates in, separated into:
 * - **Group Chats:** Multi-participant group conversations
 * - **Direct Messages:** One-on-one chats with other real users
 *
 * **Features:**
 * - Quality scoring for group chats
 * - Last message preview
 * - Message count tracking
 * - Participant metadata
 * - DM participant profile details
 * - Filters out NPC/actor DMs (only real user DMs shown)
 *
 * @query {boolean} all - Get all game chats (public, no auth required)
 * @query {boolean} debug - Enable debug logging
 *
 * **All Game Chats Mode (all=true):**
 * Returns all group chats for the game without authentication.
 * Used for public game chat discovery.
 *
 * @returns {object} Chat listings
 * @property {array} groupChats - User's group chat memberships
 * @property {array} directChats - User's direct message chats
 * @property {number} total - Total chat count
 *
 * **POST - Create New Chat**
 *
 * Creates a new chat (group or DM) and adds participants.
 * Creator is automatically added as the first participant.
 *
 * @param {string} name - Chat name (optional for DMs)
 * @param {boolean} isGroup - Whether chat is a group chat (default: false)
 * @param {array} participantIds - Array of user IDs to add (optional)
 *
 * @returns {object} Created chat
 * @property {object} chat - Created chat object
 *
 * @throws {400} Invalid input parameters
 * @throws {401} Unauthorized - authentication required
 * @throws {500} Internal server error
 *
 * @example
 * ```typescript
 * // Get user's chats
 * const chats = await fetch('/api/chats', {
 *   headers: { 'Authorization': `Bearer ${token}` }
 * });
 * const { groupChats, directChats } = await chats.json();
 *
 * // Get all game chats (public)
 * const gameChats = await fetch('/api/chats?all=true');
 * const { chats } = await gameChats.json();
 *
 * // Create group chat
 * const newGroup = await fetch('/api/chats', {
 *   method: 'POST',
 *   body: JSON.stringify({
 *     name: 'Strategy Discussion',
 *     isGroup: true,
 *     participantIds: ['user1', 'user2', 'user3']
 *   })
 * });
 *
 * // Create DM
 * const newDM = await fetch('/api/chats', {
 *   method: 'POST',
 *   body: JSON.stringify({
 *     isGroup: false,
 *     participantIds: ['otherUserId']
 *   })
 * });
 * ```
 *
 * @see {@link /lib/db/context} Database context with RLS
 * @see {@link /lib/validation/schemas} Request validation schemas
 * @see {@link /src/app/chats/page.tsx} Chat list UI
 */

import {
  authenticate,
  ReputationService,
  successResponse,
  withErrorHandling,
} from '@babylon/api';
import {
  canAccessNftChatGate,
  getNftChatGatingConfig,
  reconcileNftChatMembershipForUser,
} from '@babylon/api/services/nft-chat-gating-service';
// Import from new Drizzle client
import {
  and,
  asSystem,
  asUser,
  chatParticipants,
  chats,
  count,
  desc,
  eq,
  groupMembers,
  groups,
  inArray,
  messages,
  users,
} from '@babylon/db';
import {
  ChatCreateSchema,
  ChatQuerySchema,
  generateSnowflakeId,
  getChainName,
  getCurrentChainId,
  logger,
} from '@babylon/shared';
import type { NextRequest } from 'next/server';

/**
 * GET /api/chats
 * Get all chats for the authenticated user
 */
export const GET = withErrorHandling(async (request: NextRequest) => {
  logger.info('GET /api/chats - Request received', undefined, 'ChatsRoute');

  // Validate query parameters
  const { searchParams } = new URL(request.url);
  const query: Record<string, string> = {};

  const all = searchParams.get('all');
  const debug = searchParams.get('debug');

  if (all) query.all = all;
  if (debug) query.debug = debug;

  const validatedQuery =
    Object.keys(query).length > 0
      ? ChatQuerySchema.parse(query)
      : { all: undefined, debug: undefined };

  const getAllChats = validatedQuery.all === 'true';

  if (getAllChats) {
    // Return all game chats (no auth required for read-only game data)
    const gameChats = await asSystem(async (dbClient) => {
      // Get chats
      const chatList = await dbClient
        .select()
        .from(chats)
        .where(and(eq(chats.isGroup, true), eq(chats.gameId, 'continuous')))
        .orderBy(chats.createdAt);

      // Get message counts and latest messages for each chat
      const chatIds = chatList.map((c) => c.id);

      // Get message counts using aggregation
      const messageCountResults = await dbClient
        .select({
          chatId: messages.chatId,
          count: count(messages.id),
        })
        .from(messages)
        .where(inArray(messages.chatId, chatIds))
        .groupBy(messages.chatId);

      const countMap = new Map(
        messageCountResults.map((mc) => [mc.chatId, mc.count])
      );

      // Get latest messages - need to do this per-chat since we need latest per chat
      const latestMessages = await Promise.all(
        chatIds.map(async (chatId) => {
          const msgs = await dbClient
            .select()
            .from(messages)
            .where(eq(messages.chatId, chatId))
            .orderBy(desc(messages.createdAt))
            .limit(1);
          return { chatId, messages: msgs };
        })
      );

      const messagesMap = new Map(
        latestMessages.map(({ chatId, messages: msgs }) => [chatId, msgs])
      );

      return chatList.map((chat) => ({
        ...chat,
        _messageCount: countMap.get(chat.id) ?? 0,
        _latestMessages: messagesMap.get(chat.id) || [],
      }));
    });

    logger.info(
      'All game chats fetched',
      { count: gameChats.length },
      'GET /api/chats'
    );

    return successResponse({
      chats: gameChats.map((chat) => {
        const latestMessages =
          (
            chat as typeof chat & {
              _latestMessages?: Array<{
                id: string;
                content: string;
                createdAt: Date;
                senderId: string;
              }>;
            }
          )._latestMessages || [];
        return {
          id: chat.id,
          name: chat.name,
          isGroup: chat.isGroup,
          messageCount: chat._messageCount,
          lastMessage: latestMessages[0] || null,
        };
      }),
    });
  }

  const user = await authenticate(request);

  // Best-effort reconciliation: grant/revoke gated chat membership based on the
  // latest access check (on-chain when available; falls back when degraded).
  if (user.dbUserId) {
    try {
      await reconcileNftChatMembershipForUser({
        dbUserId: user.dbUserId,
        isAgent: user.isAgent,
      });
    } catch (error) {
      logger.warn(
        'NFT chat reconciliation failed',
        { error, userId: user.userId, dbUserId: user.dbUserId },
        'GET /api/chats'
      );
    }
  }
  const nftChatGatingConfig = getNftChatGatingConfig();
  const gatedChatId = nftChatGatingConfig.chatId;
  const canAccessNftGatedChat =
    !nftChatGatingConfig.enabled ||
    !gatedChatId ||
    (await canAccessNftChatGate(user.dbUserId ?? user.userId, gatedChatId));

  logger.info(
    'Fetching chats for user',
    {
      userId: user.userId,
      privyId: user.privyId,
      dbUserId: user.dbUserId,
      fullUser: user,
    },
    'GET /api/chats'
  );

  // Get user's chats with proper RLS context
  const { groupChats, directChats } = await asUser(user, async (dbClient) => {
    // Get ALL user's Agents groups to exclude from regular chat list
    // (handles edge case of duplicate team groups from race conditions)
    // Agents is managed separately at /agents/team
    const teamGroups = await dbClient
      .select({ id: groups.id })
      .from(groups)
      .where(and(eq(groups.type, 'team'), eq(groups.ownerId, user.userId)));
    const teamGroupIds = new Set(teamGroups.map((g) => g.id));

    // Get user's group memberships
    const memberships = await dbClient
      .select()
      .from(groupMembers)
      .where(
        and(
          eq(groupMembers.userId, user.userId),
          eq(groupMembers.isActive, true)
        )
      )
      .orderBy(desc(groupMembers.lastMessageAt));

    const gatedChatGroupId =
      gatedChatId && canAccessNftGatedChat === false
        ? (
            await dbClient
              .select({ groupId: chats.groupId })
              .from(chats)
              .where(eq(chats.id, gatedChatId))
              .limit(1)
          )[0]?.groupId
        : undefined;
    const filteredMemberships =
      gatedChatGroupId && canAccessNftGatedChat === false
        ? memberships.filter((m) => m.groupId !== gatedChatGroupId)
        : memberships;

    // Get chat IDs via Chat.groupId relationship
    const groupIds = filteredMemberships.map((m) => m.groupId);
    const groupChatsWithGroupId =
      groupIds.length > 0
        ? await dbClient
            .select()
            .from(chats)
            .where(inArray(chats.groupId, groupIds))
        : [];

    // Filter out Agents chats (all chats linked to any team group)
    const filteredGroupChats =
      teamGroupIds.size > 0
        ? groupChatsWithGroupId.filter(
            (c) => !c.groupId || !teamGroupIds.has(c.groupId)
          )
        : groupChatsWithGroupId;
    const filteredGroupChatsForAccess =
      gatedChatId && canAccessNftGatedChat === false
        ? filteredGroupChats.filter((c) => c.id !== gatedChatId)
        : filteredGroupChats;
    const groupChatIds = filteredGroupChatsForAccess.map((c) => c.id);
    // Map groupId -> chatId for lookup
    const groupIdToChatId = new Map(
      filteredGroupChatsForAccess.map((c) => [c.groupId, c.id])
    );
    // Map chatId -> chat details
    const chatDetailsMap = new Map(
      filteredGroupChatsForAccess.map((c) => [c.id, c])
    );

    // Get last messages for group chats
    const groupChatMessages = await Promise.all(
      groupChatIds.map(async (chatId) => {
        const msgs = await dbClient
          .select()
          .from(messages)
          .where(eq(messages.chatId, chatId))
          .orderBy(desc(messages.createdAt))
          .limit(1);
        return { chatId, messages: msgs };
      })
    );
    const groupMessagesMap = new Map(
      groupChatMessages.map(({ chatId, messages }) => [chatId, messages])
    );

    // Get DM chats the user participates in
    const dmParticipantsList = await dbClient
      .select()
      .from(chatParticipants)
      .where(eq(chatParticipants.userId, user.userId));

    logger.info(
      'Found DM participants',
      {
        userId: user.userId,
        count: dmParticipantsList.length,
      },
      'GET /api/chats'
    );

    const dmChatIds = dmParticipantsList.map((p) => p.chatId);
    const dmChatsDetails = await dbClient
      .select()
      .from(chats)
      .where(and(inArray(chats.id, dmChatIds), eq(chats.isGroup, false)));

    // Get participants and messages separately
    const [allParticipants, allMessages] = await Promise.all([
      dbClient
        .select()
        .from(chatParticipants)
        .where(inArray(chatParticipants.chatId, dmChatIds)),
      Promise.all(
        dmChatIds.map(async (chatId) => {
          const msgs = await dbClient
            .select()
            .from(messages)
            .where(eq(messages.chatId, chatId))
            .orderBy(desc(messages.createdAt))
            .limit(1);
          return { chatId, messages: msgs };
        })
      ),
    ]);

    const participantsByChatId = new Map<string, typeof allParticipants>();
    allParticipants.forEach((p) => {
      if (!participantsByChatId.has(p.chatId)) {
        participantsByChatId.set(p.chatId, []);
      }
      participantsByChatId.get(p.chatId)!.push(p);
    });

    const messagesByChatId = new Map<
      string,
      (typeof allMessages)[number]['messages']
    >();
    allMessages.forEach(({ chatId, messages }) => {
      messagesByChatId.set(chatId, messages);
    });

    // Format group chats - use groupId -> chatId mapping
    const formattedGroupChats = filteredMemberships
      .map((membership) => {
        // Get the chatId from groupId
        const chatId = groupIdToChatId.get(membership.groupId);
        if (!chatId) return null;
        const chat = chatDetailsMap.get(chatId);
        if (!chat) return null;
        const lastMessage = groupMessagesMap.get(chatId)?.[0] || null;
        const result: {
          id: string;
          name: string;
          isGroup: boolean;
          lastMessage: typeof lastMessage;
          messageCount: number;
          qualityScore: number | null;
          lastMessageAt: Date | null;
          updatedAt: Date;
          nftRequirement?: {
            contractAddress: string;
            tokenId: number | null;
            chainId: number;
            chainName: string;
          };
        } = {
          id: chatId,
          name: chat.name || 'Unnamed Group',
          isGroup: true,
          lastMessage,
          messageCount: membership.messageCount,
          qualityScore: membership.qualityScore,
          lastMessageAt: membership.lastMessageAt,
          updatedAt: chat.updatedAt,
        };

        if (chat.nftGated && chat.requiredNftContractAddress) {
          const chainId = chat.requiredNftChainId ?? getCurrentChainId();
          result.nftRequirement = {
            contractAddress: chat.requiredNftContractAddress,
            tokenId: chat.requiredNftTokenId,
            chainId,
            chainName: getChainName(chainId),
          };
        }

        return result;
      })
      .filter((c) => c !== null);

    // Format DM chats - get the other participant's name and details
    const directChatsList = await Promise.all(
      dmChatsDetails.map(async (chat) => {
        const chatParticipantsList = participantsByChatId.get(chat.id) || [];
        // Find the other participant (not the current user)
        const otherParticipant = chatParticipantsList.find(
          (p) => p.userId !== user.userId
        );
        let chatName = chat.name || 'Direct Message';
        let otherUserDetails = null;

        if (otherParticipant) {
          // Try to get user details (real users only, not actors)
          // Include isAgent and managedBy to detect if this is the user's own agent
          const [otherUser] = await dbClient
            .select({
              id: users.id,
              displayName: users.displayName,
              username: users.username,
              profileImageUrl: users.profileImageUrl,
              isActor: users.isActor,
              isAgent: users.isAgent,
              managedBy: users.managedBy,
            })
            .from(users)
            .where(eq(users.id, otherParticipant.userId))
            .limit(1);

          if (otherUser && !otherUser.isActor) {
            chatName = otherUser.displayName || otherUser.username || 'Unknown';
            otherUserDetails = {
              id: otherUser.id,
              displayName: otherUser.displayName,
              username: otherUser.username,
              profileImageUrl: otherUser.profileImageUrl,
              isAgent: otherUser.isAgent,
              managedBy: otherUser.managedBy,
            };
          }
        }

        // Only return DMs with real users (not NPCs)
        if (!otherUserDetails) {
          return null;
        }

        // Filter out DMs with the user's own agents
        // These legacy conversations should be hidden - agent-owner communication
        // now happens through the team chat at /agents/team
        if (
          otherUserDetails.isAgent &&
          otherUserDetails.managedBy === user.userId
        ) {
          return null;
        }

        // Get last message for this chat
        const lastMessage = messagesByChatId.get(chat.id)?.[0] || null;

        return {
          id: chat.id,
          name: chatName,
          isGroup: false,
          lastMessage: lastMessage,
          participants: chatParticipantsList.length,
          updatedAt: chat.updatedAt,
          otherUser: otherUserDetails,
        };
      })
    ).then((chatsList) => chatsList.filter((c) => c !== null));

    return { groupChats: formattedGroupChats, directChats: directChatsList };
  });

  logger.info(
    'User chats fetched successfully',
    {
      userId: user.userId,
      groupChats: groupChats.length,
      directChats: directChats.length,
    },
    'GET /api/chats'
  );

  return successResponse({
    groupChats,
    directChats,
    total: groupChats.length + directChats.length,
  });
});

/**
 * POST /api/chats
 * Create a new chat
 */
export const POST = withErrorHandling(async (request: NextRequest) => {
  const user = await authenticate(request);

  // Validate request body
  const body = await request.json();
  const {
    name,
    isGroup,
    participantIds,
    requiredNftContractAddress,
    requiredNftTokenId,
    requiredNftChainId,
  } = ChatCreateSchema.parse(body);

  // Create the chat with RLS
  const chat = await asUser(user, async (dbClient) => {
    // Create the chat
    const now = new Date();
    const nftGated = !!requiredNftContractAddress;
    const [newChat] = await dbClient
      .insert(chats)
      .values({
        id: await generateSnowflakeId(),
        name: name || null,
        isGroup: isGroup || false,
        createdAt: now,
        updatedAt: now,
        requiredNftContractAddress: requiredNftContractAddress || null,
        requiredNftTokenId: requiredNftTokenId ?? null,
        requiredNftChainId: requiredNftChainId ?? null,
        nftGated,
      })
      .returning();

    if (!newChat) {
      throw new Error('Failed to create chat');
    }

    // Add creator as participant
    await dbClient.insert(chatParticipants).values({
      id: await generateSnowflakeId(),
      chatId: newChat.id,
      userId: user.userId,
    });

    // Add other participants if provided
    if (participantIds && Array.isArray(participantIds)) {
      for (const participantId of participantIds) {
        await dbClient.insert(chatParticipants).values({
          id: await generateSnowflakeId(),
          chatId: newChat.id,
          userId: participantId,
        });
      }
    }

    return newChat;
  });

  if (!chat) {
    throw new Error('Failed to create chat');
  }

  // Award points for creating a private channel (group chat created directly, not through Group)
  if (isGroup && !chat.groupId) {
    await ReputationService.awardPrivateChannelCreate(
      user.userId,
      chat.id
    ).catch((error: unknown) => {
      // Log error but don't fail chat creation if points award fails
      logger.error(
        'Failed to award points for private channel creation',
        { error, userId: user.userId, chatId: chat.id },
        'POST /api/chats'
      );
    });
  }

  logger.info(
    'Chat created successfully',
    {
      chatId: chat.id,
      userId: user.userId,
      isGroup,
      participantCount: (participantIds?.length || 0) + 1,
    },
    'POST /api/chats'
  );

  return successResponse({ chat }, 201);
});
