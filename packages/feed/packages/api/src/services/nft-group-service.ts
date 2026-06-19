/**
 * NFT Group Service
 *
 * @module api/services/nft-group-service
 *
 * @description
 * Shared utilities for managing NFT-gated group chats, including user removal
 * and membership management.
 */

import { and, chatParticipants, chats, db, eq, groupMembers } from "@feed/db";
import { logger } from "@feed/shared";

import { notifyNftAccessRevoked } from "./notification-service";

/**
 * Remove a user from an NFT-gated chat and optionally mark their group membership as inactive.
 * Uses a transaction to ensure atomicity of the operation.
 * Also sends a notification to the user about their removal.
 *
 * @param chatId - The ID of the chat to remove the user from
 * @param groupId - The ID of the linked group (null if no group)
 * @param userId - The ID of the user to remove
 * @param reason - The reason for removal (e.g., "No longer owns required NFT")
 */
export async function removeUserFromNftChat(
  chatId: string,
  groupId: string | null,
  userId: string,
  reason: string,
): Promise<void> {
  // Get chat name for notification before removal
  let chatName = "NFT-gated chat";
  try {
    const [chat] = await db
      .select({ name: chats.name })
      .from(chats)
      .where(eq(chats.id, chatId))
      .limit(1);
    if (chat?.name) {
      chatName = chat.name;
    }
  } catch {
    // Continue with default name if lookup fails
  }

  await db.transaction(async (tx) => {
    // Soft delete from chat participants (set isActive: false)
    // This allows reactivation if user re-acquires the NFT and rejoins
    await tx
      .update(chatParticipants)
      .set({ isActive: false })
      .where(
        and(
          eq(chatParticipants.chatId, chatId),
          eq(chatParticipants.userId, userId),
          eq(chatParticipants.isActive, true),
        ),
      );

    // If there's a linked group, mark group membership as inactive with kick reason
    if (groupId) {
      await tx
        .update(groupMembers)
        .set({
          isActive: false,
          kickedAt: new Date(),
          kickReason: reason,
        })
        .where(
          and(
            eq(groupMembers.groupId, groupId),
            eq(groupMembers.userId, userId),
            eq(groupMembers.isActive, true),
          ),
        );
    }
  });

  // Send notification to user about their removal (non-blocking)
  try {
    await notifyNftAccessRevoked(userId, chatId, chatName, reason);
  } catch (error) {
    // Log but don't fail the removal if notification fails
    logger.warn(
      "Failed to send NFT access revoked notification",
      {
        userId,
        chatId,
        error: error instanceof Error ? error.message : String(error),
      },
      "NFTGroupService",
    );
  }
}
