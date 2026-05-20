/**
 * Direct Message (DM) Chat API
 *
 * @route POST /api/chats/dm
 * @access Authenticated
 *
 * @description
 * Creates or retrieves a direct message chat between two users. Implements
 * idempotent chat creation with consistent ID generation based on participant
 * user IDs. Includes validation to prevent self-DMing and NPC interactions.
 *
 * @openapi
 * /api/chats/dm:
 *   post:
 *     tags:
 *       - Chats
 *     summary: Create or get DM chat
 *     description: Creates or retrieves a direct message chat between two users. Idempotent - same chat returned for same participants.
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - userId
 *             properties:
 *               userId:
 *                 type: string
 *                 description: Target user ID to DM
 *     responses:
 *       200:
 *         description: DM chat created or retrieved
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 chat:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: string
 *                     isGroup:
 *                       type: boolean
 *                     otherUser:
 *                       type: object
 *       400:
 *         description: Missing userId or self-DM attempt
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Target is NPC actor
 *       404:
 *         description: Target user not found
 *
 * **DM Chat Features:**
 * - Idempotent creation (same chat for same participants)
 * - Consistent chat ID format: `dm-{userId1}-{userId2}` (sorted)
 * - Automatic participant addition
 * - Real user validation (no NPCs/actors)
 * - Self-DM prevention
 * - Event tracking for analytics
 *
 * **Business Rules:**
 * - Cannot DM yourself
 * - Cannot DM NPC actors (use group chats instead)
 * - Target user must exist
 * - Both participants automatically added
 *
 * **Chat ID Generation:**
 * Chat IDs are deterministic based on sorted participant IDs:
 * ```typescript
 * const sortedIds = [userId1, userId2].sort();
 * const chatId = `dm-${sortedIds.join('-')}`;
 * ```
 * This ensures the same chat is always returned for the same two users.
 *
 * **POST /api/chats/dm - Create or Get DM Chat**
 *
 * @param {string} userId - Target user ID to DM (required)
 *
 * @returns {object} DM chat response
 * @property {object} chat - Chat object
 * @property {string} chat.id - Chat ID (deterministic)
 * @property {string} chat.name - Chat name (null for DMs)
 * @property {boolean} chat.isGroup - Always false for DMs
 * @property {object} chat.otherUser - Target user profile
 * @property {string} chat.otherUser.id - User ID
 * @property {string} chat.otherUser.displayName - Display name
 * @property {string} chat.otherUser.username - Username
 * @property {string} chat.otherUser.profileImageUrl - Profile image
 *
 * @throws {400} Bad Request - Missing userId or self-DM attempt
 * @throws {401} Unauthorized - Not authenticated
 * @throws {403} Forbidden - Target is NPC actor
 * @throws {404} Not Found - Target user doesn't exist
 * @throws {500} Internal Server Error
 *
 * @example
 * ```typescript
 * // Create or get DM with user
 * const response = await fetch('/api/chats/dm', {
 *   method: 'POST',
 *   headers: {
 *     'Authorization': `Bearer ${token}`,
 *     'Content-Type': 'application/json'
 *   },
 *   body: JSON.stringify({ userId: 'target-user-id' })
 * });
 *
 * const { chat } = await response.json();
 * console.log(`DM with ${chat.otherUser.displayName}`);
 * console.log(`Chat ID: ${chat.id}`);
 *
 * // Navigate to chat
 * router.push(`/chats/${chat.id}`);
 * ```
 *
 * @see {@link /lib/db/context} RLS context management
 * @see {@link /lib/posthog/server} Analytics tracking
 * @see {@link /src/app/chats/page.tsx} Chat list UI
 * @see {@link /src/app/chats/[id]/page.tsx} Chat room UI
 */

import {
  authenticate,
  BusinessLogicError,
  NotFoundError,
  successResponse,
  withErrorHandling,
} from "@feed/api";
import { asUser, hasBlocked } from "@feed/db";
import { DMChatCreateSchema, generateSnowflakeId, logger } from "@feed/shared";
import type { NextRequest } from "next/server";
import { trackServerEvent } from "@/lib/posthog/server";

/**
 * POST /api/chats/dm
 * Create or get a DM chat with another user
 */
export const POST = withErrorHandling(async (request: NextRequest) => {
  const user = await authenticate(request);

  // Validate request body
  const body = await request.json();
  const { userId: targetUserId } = DMChatCreateSchema.parse(body);

  // Prevent DMing yourself (business rule validation)
  if (user.userId === targetUserId) {
    throw new BusinessLogicError("Cannot DM yourself", "SELF_DM_NOT_ALLOWED");
  }

  // Create or get DM chat with RLS
  const chat = await asUser(user, async (db) => {
    // Check if target user exists and is a real user (not an NPC)
    const targetUser = await db.user.findUnique({
      where: { id: targetUserId },
      select: {
        id: true,
        isActor: true,
        displayName: true,
        username: true,
        profileImageUrl: true,
      },
    });

    // Reject if target doesn't exist
    if (!targetUser) {
      throw new NotFoundError("User", targetUserId);
    }

    // Reject if target is an NPC actor
    if (targetUser.isActor) {
      throw new BusinessLogicError(
        "Cannot send direct messages to NPC actors. Use group chats to interact with NPCs.",
        "INVALID_DM_TARGET",
      );
    }

    // Check if either user has blocked the other
    const [isBlocked, hasBlockedMe] = await Promise.all([
      hasBlocked(user.userId, targetUserId),
      hasBlocked(targetUserId, user.userId),
    ]);

    if (isBlocked || hasBlockedMe) {
      throw new BusinessLogicError(
        "Cannot send messages to this user",
        "BLOCKED_USER",
      );
    }

    // Create DM chat ID (consistent format - sort IDs for consistency)
    const sortedIds = [user.userId, targetUserId].sort();
    const chatId = `dm-${sortedIds.join("-")}`;

    // Try to find existing DM chat (don't use include - query separately)
    let existingChat = await db.chat.findUnique({
      where: { id: chatId },
    });

    if (!existingChat) {
      // Create new DM chat
      await db.chat.create({
        data: {
          id: chatId,
          name: null, // DMs don't have names
          isGroup: false,
          updatedAt: new Date(),
        },
      });

      // Add both participants
      await Promise.all([
        db.chatParticipant.create({
          data: {
            id: await generateSnowflakeId(),
            chatId,
            userId: user.userId,
          },
        }),
        db.chatParticipant.create({
          data: {
            id: await generateSnowflakeId(),
            chatId,
            userId: targetUserId,
          },
        }),
      ]);

      // Reload chat
      existingChat = await db.chat.findUnique({
        where: { id: chatId },
      });
    } else {
      // Chat exists, ensure both participants are added
      const participants = await db.chatParticipant.findMany({
        where: { chatId: { equals: chatId } },
        select: { userId: true },
      });
      const participantIds = participants.map((p) => p.userId);

      if (!participantIds.includes(user.userId)) {
        await db.chatParticipant.create({
          data: {
            id: await generateSnowflakeId(),
            chatId,
            userId: user.userId,
          },
        });
      }

      if (!participantIds.includes(targetUserId)) {
        await db.chatParticipant.create({
          data: {
            id: await generateSnowflakeId(),
            chatId,
            userId: targetUserId,
          },
        });
      }
    }

    return { chat: existingChat, targetUser };
  });

  if (!chat.chat) {
    throw new Error("Chat creation failed");
  }

  const chatData = chat.chat; // Type guard - chat.chat is now guaranteed to be non-null

  logger.info(
    "DM chat created or retrieved successfully",
    { chatId: chatData.id, userId: user.userId, targetUserId },
    "POST /api/chats/dm",
  );

  // Track DM created/opened event
  // Check if chat has participants by querying separately
  const participants = await asUser(user, async (db) => {
    return await db.chatParticipant.findMany({
      where: { chatId: { equals: chatData.id } },
    });
  });
  const hasParticipants = participants.length > 0;

  trackServerEvent(user.userId, "dm_opened", {
    chatId: chatData.id,
    recipientId: targetUserId,
    isNewChat: !hasParticipants,
  }).catch((error) => {
    logger.warn("Failed to track dm_opened event", { error });
  });

  return successResponse(
    {
      chat: {
        id: chatData.id,
        name: chatData.name,
        isGroup: chatData.isGroup,
        otherUser: {
          id: chat.targetUser.id,
          displayName: chat.targetUser.displayName,
          username: chat.targetUser.username,
          profileImageUrl: chat.targetUser.profileImageUrl,
        },
      },
    },
    201,
  );
});
