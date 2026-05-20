/**
 * API Route: /api/chats/[id]
 * Methods: GET (get chat details and messages)
 *
 * @openapi
 * /api/chats/{id}:
 *   get:
 *     tags:
 *       - Chats
 *     summary: Get chat details and messages
 *     description: Returns chat details with paginated messages. Supports cursor-based pagination.
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Chat ID
 *       - in: query
 *         name: cursor
 *         schema:
 *           type: string
 *         description: Cursor for pagination (message ID)
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 50
 *         description: Messages per page
 *     responses:
 *       200:
 *         description: Chat details with messages
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 chat:
 *                   type: object
 *                 messages:
 *                   type: array
 *                   items:
 *                     type: object
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Chat not found
 */

import {
  AuthorizationError,
  authenticate,
  BusinessLogicError,
  NotFoundError,
  successResponse,
  withErrorHandling,
} from "@feed/api";
import { requireNftChatAccess } from "@feed/api/services/nft-chat-gating-service";
import {
  and,
  asc,
  asSystem,
  asUser,
  chatParticipants,
  chats,
  count,
  desc,
  eq,
  gt,
  inArray,
  lt,
  messageReactions,
  messages,
  users,
} from "@feed/db";
import { StaticDataRegistry } from "@feed/engine";
import {
  ChatQuerySchema,
  getChainName,
  getCurrentChainId,
  logger,
} from "@feed/shared";
import type { NextRequest } from "next/server";
import { CHAT_PAGE_SIZE } from "@/lib/constants";

/**
 * GET /api/chats/[id]
 * Get chat details and messages
 */
export const GET = withErrorHandling(
  async (
    request: NextRequest,
    context: { params: Promise<{ id: string }> },
  ) => {
    const { id: chatId } = await context.params;

    // Validate query parameters
    const { searchParams } = new URL(request.url);
    const query: Record<string, string> = {};

    const all = searchParams.get("all");
    const debug = searchParams.get("debug");
    const cursor = searchParams.get("cursor"); // Cursor for pagination (message ID — loads OLDER messages)
    const after = searchParams.get("after"); // ISO timestamp — loads NEWER messages since this time
    const limitParam = searchParams.get("limit");

    if (all) query.all = all;
    if (debug) query.debug = debug;

    const validatedQuery = ChatQuerySchema.parse(query);

    // Parse pagination parameters
    const limit = limitParam ? Number.parseInt(limitParam, 10) : CHAT_PAGE_SIZE;
    const effectiveLimit = Math.min(Math.max(limit, 1), 100); // Between 1 and 100

    // Check for debug mode (localhost access to game chats)
    const debugMode = validatedQuery.debug === "true";

    logger.info(
      "GET /api/chats/[id]",
      {
        chatId,
        cursor,
        limit: effectiveLimit,
        debugMode,
      },
      "GET /api/chats/[id]",
    );

    // Get chat first to check if it's a game chat
    const [chat] = await asSystem(async (db) => {
      return await db.select().from(chats).where(eq(chats.id, chatId)).limit(1);
    }, "get-chat-by-id");

    if (!chat) {
      throw new NotFoundError("Chat", chatId);
    }

    // Allow debug access to game chats without auth
    const isGameChat = chat.isGroup && chat.gameId === "continuous";
    let userId: string | undefined;
    let authUser: Awaited<ReturnType<typeof authenticate>> | null = null;

    if (isGameChat && debugMode) {
      // Debug mode: skip authentication for game chats
      logger.info(
        `Debug mode access to game chat: ${chatId}`,
        undefined,
        "GET /api/chats/[id]",
      );
    } else {
      // Normal mode: require authentication and membership
      authUser = await authenticate(request);
      userId = authUser.userId;

      const [isMember] = await asUser(authUser, async (db) => {
        return await db
          .select()
          .from(chatParticipants)
          .where(
            and(
              eq(chatParticipants.chatId, chatId),
              eq(chatParticipants.userId, authUser?.userId),
            ),
          )
          .limit(1);
      });

      if (!isMember) {
        throw new AuthorizationError(
          "You do not have access to this chat",
          "chat",
          "read",
        );
      }

      await requireNftChatAccess(authUser, chatId);
    }

    // Get chat with messages
    const fetchChatData = async (
      db: Parameters<Parameters<typeof asSystem>[0]>[0],
    ) => {
      // Get chat participants
      const participantsList = await db
        .select()
        .from(chatParticipants)
        .where(eq(chatParticipants.chatId, chatId));

      // Build message query — three modes:
      // 1. `after` (ISO timestamp): fetch messages NEWER than this time (ASC order, for sync)
      // 2. `cursor` (message ID): fetch messages OLDER than this cursor (DESC order, for load-more)
      // 3. Neither: fetch latest messages (DESC order, initial load)
      let messagesList;
      if (after) {
        // Incremental sync: only messages after the given timestamp
        const afterDate = new Date(after);
        if (Number.isNaN(afterDate.getTime())) {
          throw new BusinessLogicError(
            "Invalid after timestamp",
            "INVALID_AFTER_TIMESTAMP",
          );
        } else {
          messagesList = await db
            .select()
            .from(messages)
            .where(
              and(
                eq(messages.chatId, chatId),
                gt(messages.createdAt, afterDate),
              ),
            )
            .orderBy(asc(messages.createdAt))
            .limit(effectiveLimit);
        }
      } else if (cursor) {
        // Load older messages: get cursor's timestamp, then fetch before it
        const [cursorMessage] = await db
          .select({ createdAt: messages.createdAt })
          .from(messages)
          .where(eq(messages.id, cursor))
          .limit(1);

        if (cursorMessage) {
          messagesList = await db
            .select()
            .from(messages)
            .where(
              and(
                eq(messages.chatId, chatId),
                lt(messages.createdAt, cursorMessage.createdAt),
              ),
            )
            .orderBy(desc(messages.createdAt))
            .limit(effectiveLimit + 1);
        } else {
          messagesList = await db
            .select()
            .from(messages)
            .where(eq(messages.chatId, chatId))
            .orderBy(desc(messages.createdAt))
            .limit(effectiveLimit + 1);
        }
      } else {
        // Initial load: latest messages
        messagesList = await db
          .select()
          .from(messages)
          .where(eq(messages.chatId, chatId))
          .orderBy(desc(messages.createdAt))
          .limit(effectiveLimit + 1);
      }

      return { chat, participants: participantsList, messages: messagesList };
    };

    const fullChat = authUser
      ? await asUser(authUser, fetchChatData)
      : await asSystem(fetchChatData, "get-chat-with-messages-debug");

    // Get participant details
    const fetchParticipantDetails = async (
      db: Parameters<Parameters<typeof asSystem>[0]>[0],
    ) => {
      const participantUserIds = fullChat.participants.map((p) => p.userId);
      const senderIds = [...new Set(fullChat.messages.map((m) => m.senderId))];

      // Combine participant IDs and sender IDs to include users who left but still have messages
      const allUserIds = [
        ...new Set([...participantUserIds, ...(senderIds as string[])]),
      ].filter((id) => id !== "system"); // Exclude system sender

      const usersList =
        allUserIds.length > 0
          ? await db
              .select({
                id: users.id,
                displayName: users.displayName,
                username: users.username,
                profileImageUrl: users.profileImageUrl,
                isAgent: users.isAgent,
                managedBy: users.managedBy,
              })
              .from(users)
              .where(inArray(users.id, allUserIds))
          : [];

      const actorsList = (senderIds as string[])
        .map((id) => StaticDataRegistry.getActor(id))
        .filter((a): a is NonNullable<typeof a> => a !== null)
        .map((a) => ({
          id: a.id,
          name: a.name,
          profileImageUrl: a.profileImageUrl,
        }));

      return { users: usersList, actors: actorsList };
    };

    const { users: usersList, actors: actorsList } = authUser
      ? await asUser(authUser, fetchParticipantDetails)
      : await asSystem(fetchParticipantDetails, "get-chat-participants-debug");

    const usersMap = new Map(usersList.map((u) => [u.id, u]));
    const actorsMap = new Map(actorsList.map((a) => [a.id, a]));

    // Get unique sender IDs from messages
    const senderIds = [...new Set(fullChat.messages.map((m) => m.senderId))];
    const participantUserIds = new Set(
      fullChat.participants.map((p) => p.userId),
    );

    // Build participants list including both active participants AND message senders
    // This ensures users who left the chat still have their names displayed on old messages
    const participantsInfo = [
      // Active participants
      ...fullChat.participants.map((p) => {
        const user = usersMap.get(p.userId);
        const actor = actorsMap.get(p.userId);
        return {
          id: p.userId,
          displayName: user?.displayName || actor?.name || "Unknown",
          username: user?.username,
          profileImageUrl: user?.profileImageUrl || actor?.profileImageUrl,
        };
      }),
      // Message senders who are no longer participants (left the chat)
      ...(senderIds as string[])
        .filter((id) => id !== "system" && !participantUserIds.has(id))
        .map((senderId) => {
          const user = usersMap.get(senderId);
          const actor = actorsMap.get(senderId);
          return {
            id: senderId,
            displayName: user?.displayName || actor?.name || "Unknown",
            username: user?.username,
            profileImageUrl: user?.profileImageUrl || actor?.profileImageUrl,
          };
        }),
    ];

    // For DMs, get the other participant's name and details
    // Include isAgent and managedBy to detect if this is the user's own agent
    let displayName = chat.name;
    let otherUser: {
      id: string;
      displayName: string | null;
      username: string | null;
      profileImageUrl: string | null;
      isAgent?: boolean;
      managedBy?: string | null;
    } | null = null;
    if (!chat.isGroup && !chat.name && userId) {
      const otherParticipant = fullChat.participants.find(
        (p) => p.userId !== userId,
      );
      if (otherParticipant) {
        const otherUserData = usersMap.get(otherParticipant.userId);
        if (otherUserData) {
          displayName =
            otherUserData.displayName || otherUserData.username || "Unknown";
          otherUser = {
            id: otherParticipant.userId,
            displayName: otherUserData.displayName,
            username: otherUserData.username,
            profileImageUrl: otherUserData.profileImageUrl,
            isAgent: otherUserData.isAgent,
            managedBy: otherUserData.managedBy,
          };
        }
      }
    }

    // Check if there are more messages.
    // For `after` queries: if we got exactly `limit` rows, there may be more
    // beyond this page. Signal hasMore so the client can paginate.
    // For cursor/initial queries: the +1 overfetch trick detects more pages.
    const isAfterQuery = !!after;
    const hasMore = isAfterQuery
      ? fullChat.messages.length >= effectiveLimit
      : fullChat.messages.length > effectiveLimit;
    const messagesList = isAfterQuery
      ? fullChat.messages
      : hasMore
        ? fullChat.messages.slice(0, effectiveLimit)
        : fullChat.messages;

    // For cursor/initial queries: reverse from DESC to chronological order.
    // For after queries: already in ASC order from the query.
    const messagesInOrder = isAfterQuery
      ? messagesList
      : [...messagesList].reverse();

    // Message reactions summary (counts + reactedByMe)
    const messageIds = messagesInOrder.map((m) => m.id);
    const reactionsByMessageId = new Map<
      string,
      { emoji: string; count: number; reactedByMe: boolean }[]
    >();
    if (messageIds.length > 0) {
      const [counts, mine] = await Promise.all([
        asSystem(async (db) => {
          return await db
            .select({
              messageId: messageReactions.messageId,
              emoji: messageReactions.emoji,
              count: count(),
            })
            .from(messageReactions)
            .where(inArray(messageReactions.messageId, messageIds))
            .groupBy(messageReactions.messageId, messageReactions.emoji);
        }, "get-message-reaction-counts"),
        authUser
          ? asSystem(async (db) => {
              return await db
                .select({
                  messageId: messageReactions.messageId,
                  emoji: messageReactions.emoji,
                })
                .from(messageReactions)
                .where(
                  and(
                    inArray(messageReactions.messageId, messageIds),
                    eq(messageReactions.userId, authUser?.userId),
                  ),
                );
            }, "get-message-reactions-mine")
          : Promise.resolve([]),
      ]);

      const mineSet = new Set(mine.map((r) => `${r.messageId}:${r.emoji}`));
      for (const row of counts) {
        const arr = reactionsByMessageId.get(row.messageId) ?? [];
        arr.push({
          emoji: row.emoji,
          count: Number(row.count ?? 0),
          reactedByMe: mineSet.has(`${row.messageId}:${row.emoji}`),
        });
        reactionsByMessageId.set(row.messageId, arr);
      }
    }

    // Resolve replied-to messages in batch
    const replyToIds = [
      ...new Set(
        messagesInOrder
          .map((m) => m.replyToMessageId)
          .filter((id): id is string => !!id),
      ),
    ];
    const replyToMessagesMap = new Map<
      string,
      { id: string; content: string; senderId: string; senderName?: string }
    >();
    if (replyToIds.length > 0) {
      const replyMessages = await asSystem(async (db) => {
        return await db
          .select({
            id: messages.id,
            content: messages.content,
            senderId: messages.senderId,
          })
          .from(messages)
          .where(
            and(inArray(messages.id, replyToIds), eq(messages.chatId, chatId)),
          );
      }, "get-reply-to-messages");

      for (const rm of replyMessages) {
        const sender = usersMap.get(rm.senderId);
        const actor = actorsMap.get(rm.senderId);
        replyToMessagesMap.set(rm.id, {
          id: rm.id,
          content: rm.content.slice(0, 200),
          senderId: rm.senderId,
          senderName: sender?.displayName || actor?.name || undefined,
        });
      }
    }

    // Get the cursor for the next page (oldest message ID in this batch)
    const nextCursor = hasMore
      ? fullChat.messages[effectiveLimit - 1]?.id
      : null;

    logger.info(
      "Chat fetched successfully",
      {
        chatId,
        isGameChat,
        isDM: !chat.isGroup,
        debugMode,
        messagesReturned: messagesList.length,
        hasMore,
        nextCursor,
      },
      "GET /api/chats/[id]",
    );

    const chatResponse: {
      id: string;
      name: string | null;
      isGroup: boolean;
      createdAt: Date;
      updatedAt: Date;
      otherUser: typeof otherUser;
      nftRequirement?: {
        contractAddress: string;
        tokenId: number | null;
        chainId: number;
        chainName: string;
      };
    } = {
      id: chat.id,
      name: displayName || chat.name,
      isGroup: chat.isGroup,
      createdAt: chat.createdAt,
      updatedAt: chat.updatedAt,
      otherUser: otherUser,
    };

    if (chat.nftGated && chat.requiredNftContractAddress) {
      const chainId = chat.requiredNftChainId ?? getCurrentChainId();
      chatResponse.nftRequirement = {
        contractAddress: chat.requiredNftContractAddress,
        tokenId: chat.requiredNftTokenId,
        chainId,
        chainName: getChainName(chainId),
      };
    }

    return successResponse({
      chat: chatResponse,
      messages: messagesInOrder.map((msg) => ({
        id: msg.id,
        content: msg.content,
        senderId: msg.senderId,
        type: msg.type,
        createdAt: msg.createdAt,
        metadata: msg.metadata,
        reactions: reactionsByMessageId.get(msg.id) ?? [],
        replyToMessageId: msg.replyToMessageId ?? null,
        replyToMessage: msg.replyToMessageId
          ? (replyToMessagesMap.get(msg.replyToMessageId) ?? null)
          : null,
      })),
      participants: participantsInfo,
      pagination: {
        hasMore,
        nextCursor,
        limit: effectiveLimit,
      },
    });
  },
);
