import { createNotification } from "@feed/api";
import { and, chatParticipants, chats, db, eq, users } from "@feed/db";
import { logger } from "@feed/shared";

interface NotifyTeamChatMessageParams {
  chatId: string;
  messageId: string;
  senderId: string;
  messagePreview: string;
}

/**
 * Team chat notifications only target human participants and dedupe per
 * persisted message ID so retries do not create duplicate unread items.
 */
export async function notifyTeamChatMessage({
  chatId,
  messageId,
  senderId,
  messagePreview,
}: NotifyTeamChatMessageParams): Promise<void> {
  try {
    const [senderRows, participantRows, chatRows] = await Promise.all([
      db
        .select({
          displayName: users.displayName,
          username: users.username,
        })
        .from(users)
        .where(eq(users.id, senderId))
        .limit(1),
      db
        .select({
          userId: chatParticipants.userId,
          isAgent: users.isAgent,
        })
        .from(chatParticipants)
        .innerJoin(users, eq(chatParticipants.userId, users.id))
        .where(
          and(
            eq(chatParticipants.chatId, chatId),
            eq(chatParticipants.isActive, true),
          ),
        ),
      db
        .select({ name: chats.name })
        .from(chats)
        .where(eq(chats.id, chatId))
        .limit(1),
    ]);

    const recipientUserIds = participantRows
      .filter((participant) => !participant.isAgent)
      .map((participant) => participant.userId)
      .filter((userId) => userId !== senderId);

    if (recipientUserIds.length === 0) {
      return;
    }

    const sender = senderRows[0];
    const senderName = sender?.displayName || sender?.username || "Someone";
    const preview =
      messagePreview.length > 50
        ? `${messagePreview.substring(0, 50)}...`
        : messagePreview;
    const chatName = chatRows[0]?.name || "Agents";
    const message = `${senderName} in "${chatName}": ${preview}`;

    await Promise.all(
      recipientUserIds.map((userId) =>
        createNotification({
          userId,
          type: "system",
          actorId: senderId,
          chatId,
          title: "New Group Message",
          message,
          dedupeKey: `team-chat-message:${messageId}:${userId}`,
        }),
      ),
    );
  } catch (error) {
    logger.warn(
      "Failed to notify team chat message",
      {
        chatId,
        messageId,
        senderId,
        error: error instanceof Error ? error.message : String(error),
      },
      "TeamChatNotifications",
    );
  }
}
