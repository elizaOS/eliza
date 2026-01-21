/**
 * Notification Service
 *
 * Helper functions for creating notifications when users interact
 */

import {
  and,
  db,
  desc,
  eq,
  gt,
  hasBlocked,
  notifications,
  users,
} from "@polyagent/db";
import { generateSnowflakeId, logger } from "@polyagent/shared";

export type NotificationType =
  | "comment"
  | "reaction"
  | "follow"
  | "mention"
  | "reply"
  | "share"
  | "system"
  | "report_evaluated"
  | "appeal_status"
  | "points_received"
  | "group_invite"
  | "nft_access_revoked";

interface CreateNotificationParams {
  userId: string; // Who receives the notification
  type: NotificationType;
  actorId?: string; // Who performed the action
  postId?: string;
  commentId?: string;
  chatId?: string; // For DM/chat message notifications
  groupId?: string; // For group-related notifications
  inviteId?: string; // For invite-related notifications
  title: string;
  message: string;
}

/**
 * Deduplication window in milliseconds for notifications
 * This prevents duplicate notifications from being created within this time window
 */
const DEDUP_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Check if a similar notification already exists within the deduplication window
 * Returns true if a duplicate exists and we should skip creation
 */
async function isDuplicateNotification(
  params: CreateNotificationParams,
): Promise<boolean> {
  // Only deduplicate for notification types that could have duplicates from the same actor
  // System notifications and some others don't have actorId and are handled differently
  const typesToDeduplicate: NotificationType[] = [
    "follow",
    "reaction",
    "comment",
    "reply",
    "share",
    "mention",
  ];

  if (!typesToDeduplicate.includes(params.type) || !params.actorId) {
    return false;
  }

  const cutoffTime = new Date(Date.now() - DEDUP_WINDOW_MS);

  // Build conditions for duplicate check
  const conditions = [
    eq(notifications.userId, params.userId),
    eq(notifications.type, params.type),
    eq(notifications.actorId, params.actorId),
    gt(notifications.createdAt, cutoffTime),
  ];

  // For post/comment-related notifications, also check the specific content
  if (params.postId) {
    conditions.push(eq(notifications.postId, params.postId));
  }
  if (params.commentId) {
    conditions.push(eq(notifications.commentId, params.commentId));
  }

  const [existingNotification] = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(and(...conditions))
    .orderBy(desc(notifications.createdAt))
    .limit(1);

  return !!existingNotification;
}

/**
 * Create a notification
 */
export async function createNotification(
  params: CreateNotificationParams,
): Promise<void> {
  // Verify that the userId exists in the User table before creating notification
  // This prevents foreign key constraint errors
  const userExists = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, params.userId))
    .limit(1);

  if (userExists.length === 0) {
    logger.warn(
      `Skipping notification creation: userId ${params.userId} does not exist in User table (may be an Actor)`,
      undefined,
      "NotificationService",
    );
    return;
  }

  // Check if users have blocked each other (if actorId is provided)
  if (params.actorId) {
    const [isBlocked, hasBlockedMe] = await Promise.all([
      hasBlocked(params.userId, params.actorId),
      hasBlocked(params.actorId, params.userId),
    ]);

    if (isBlocked || hasBlockedMe) {
      logger.debug(
        "Skipping notification creation: users have blocked each other",
        { userId: params.userId, actorId: params.actorId },
        "NotificationService",
      );
      return;
    }
  }

  // Check for duplicate notifications within the deduplication window
  const isDuplicate = await isDuplicateNotification(params);
  if (isDuplicate) {
    logger.debug(
      "Skipping duplicate notification",
      { userId: params.userId, type: params.type, actorId: params.actorId },
      "NotificationService",
    );
    return;
  }

  await db.insert(notifications).values({
    id: await generateSnowflakeId(),
    userId: params.userId,
    type: params.type,
    actorId: params.actorId,
    postId: params.postId,
    commentId: params.commentId,
    chatId: params.chatId,
    groupId: params.groupId,
    inviteId: params.inviteId,
    title: params.title,
    message: params.message,
  });
}

/**
 * Create notification for comment on user's post
 */
export async function notifyCommentOnPost(
  postAuthorId: string,
  commentAuthorId: string,
  postId: string,
  commentId: string,
): Promise<void> {
  // Don't notify if user commented on their own post
  if (postAuthorId === commentAuthorId) {
    return;
  }

  // Get comment author info for message
  const result = await db
    .select({
      displayName: users.displayName,
      username: users.username,
    })
    .from(users)
    .where(eq(users.id, commentAuthorId))
    .limit(1);

  const commentAuthor = result[0];
  const authorName =
    commentAuthor?.displayName || commentAuthor?.username || "Someone";
  const message = `${authorName} commented on your post`;

  await createNotification({
    userId: postAuthorId,
    type: "comment",
    actorId: commentAuthorId,
    postId,
    commentId,
    title: "New Comment",
    message,
  });
}

/**
 * Create notification for reaction on user's post
 */
export async function notifyReactionOnPost(
  postAuthorId: string,
  reactionUserId: string,
  postId: string,
  reactionType = "like",
): Promise<void> {
  // Don't notify if user reacted to their own post
  if (postAuthorId === reactionUserId) {
    return;
  }

  const result = await db
    .select({
      displayName: users.displayName,
      username: users.username,
    })
    .from(users)
    .where(eq(users.id, reactionUserId))
    .limit(1);

  const reactionUser = result[0];
  const userName =
    reactionUser?.displayName || reactionUser?.username || "Someone";
  const action = reactionType === "like" ? "liked" : reactionType;
  const message = `${userName} ${action} your post`;

  await createNotification({
    userId: postAuthorId,
    type: "reaction",
    actorId: reactionUserId,
    postId,
    title: "New Reaction",
    message,
  });
}

/**
 * Create notification for follow
 */
export async function notifyFollow(
  followedUserId: string,
  followerId: string,
): Promise<void> {
  // Don't notify if user followed themselves
  if (followedUserId === followerId) {
    return;
  }

  const result = await db
    .select({
      displayName: users.displayName,
      username: users.username,
    })
    .from(users)
    .where(eq(users.id, followerId))
    .limit(1);

  const follower = result[0];
  const userName = follower?.displayName || follower?.username || "Someone";
  const message = `${userName} started following you`;

  await createNotification({
    userId: followedUserId,
    type: "follow",
    actorId: followerId,
    title: "New Follower",
    message,
  });
}

/**
 * Create notification for reply to comment
 */
export async function notifyReplyToComment(
  commentAuthorId: string,
  replyAuthorId: string,
  postId: string,
  commentId: string,
  replyCommentId: string,
): Promise<void> {
  // Don't notify if user replied to their own comment
  if (commentAuthorId === replyAuthorId) {
    return;
  }

  // Use commentId to create notification context
  const notificationContext = {
    commentId,
    replyCommentId,
    postId,
  };

  const result = await db
    .select({
      displayName: users.displayName,
      username: users.username,
    })
    .from(users)
    .where(eq(users.id, replyAuthorId))
    .limit(1);

  const replyAuthor = result[0];
  const userName =
    replyAuthor?.displayName || replyAuthor?.username || "Someone";
  const message = `${userName} replied to your comment`;

  // Use notificationContext when creating the notification
  await createNotification({
    userId: commentAuthorId,
    type: "reply",
    actorId: replyAuthorId,
    postId: notificationContext.postId,
    commentId: notificationContext.commentId,
    title: "New Reply",
    message,
  });
}

/**
 * Create notification for share/repost
 */
export async function notifyShare(
  postAuthorId: string,
  sharerId: string,
  postId: string,
): Promise<void> {
  // Don't notify if user shared their own post
  if (postAuthorId === sharerId) {
    return;
  }

  const result = await db
    .select({
      displayName: users.displayName,
      username: users.username,
    })
    .from(users)
    .where(eq(users.id, sharerId))
    .limit(1);

  const sharer = result[0];
  const userName = sharer?.displayName || sharer?.username || "Someone";
  const message = `${userName} shared your post`;

  await createNotification({
    userId: postAuthorId,
    type: "share",
    actorId: sharerId,
    postId,
    title: "Post Shared",
    message,
  });
}

/**
 * Create notification for mention (@username)
 */
export async function notifyMention(
  mentionedUserId: string,
  mentionerUserId: string,
  postId?: string,
  commentId?: string,
): Promise<void> {
  // Don't notify if user mentioned themselves
  if (mentionedUserId === mentionerUserId) {
    return;
  }

  const result = await db
    .select({
      displayName: users.displayName,
      username: users.username,
    })
    .from(users)
    .where(eq(users.id, mentionerUserId))
    .limit(1);

  const mentioner = result[0];
  const mentionerName =
    mentioner?.displayName || mentioner?.username || "Someone";
  const message = commentId
    ? `${mentionerName} mentioned you in a comment`
    : `${mentionerName} mentioned you in a post`;

  await createNotification({
    userId: mentionedUserId,
    type: "mention",
    actorId: mentionerUserId,
    postId,
    commentId,
    title: "Mention",
    message,
  });
}

/**
 * Create system notification for new account creation
 */
export async function notifyNewAccount(userId: string): Promise<void> {
  const message =
    "🎉 Welcome to Polyagent! Edit your profile details to earn free points and unlock rewards.";

  await createNotification({
    userId,
    type: "system",
    title: "Welcome to Polyagent",
    message,
  });
}

/**
 * Create system notification for profile completion
 */
export async function notifyProfileComplete(
  userId: string,
  pointsAwarded: number,
): Promise<void> {
  const message = `🎊 Congratulations! You've completed your profile and earned ${pointsAwarded} points!`;

  await createNotification({
    userId,
    type: "system",
    title: "Profile Complete",
    message,
  });
}

/**
 * Create notification for reaction on user's comment
 */
export async function notifyReactionOnComment(
  commentAuthorId: string,
  reactionUserId: string,
  commentId: string,
  postId: string,
  reactionType = "like",
): Promise<void> {
  // Don't notify if user reacted to their own comment
  if (commentAuthorId === reactionUserId) {
    return;
  }

  const result = await db
    .select({
      displayName: users.displayName,
      username: users.username,
    })
    .from(users)
    .where(eq(users.id, reactionUserId))
    .limit(1);

  const reactionUser = result[0];
  const userName =
    reactionUser?.displayName || reactionUser?.username || "Someone";
  const action = reactionType === "like" ? "liked" : reactionType;
  const message = `${userName} ${action} your comment`;

  await createNotification({
    userId: commentAuthorId,
    type: "reaction",
    actorId: reactionUserId,
    postId,
    commentId,
    title: "New Reaction",
    message,
  });
}

/**
 * Create notification for group chat invite
 * groupId is optional for user-to-user chats that don't have a Group record
 */
export async function notifyGroupChatInvite(
  userId: string,
  inviterId: string,
  groupId: string | null | undefined,
  chatName: string,
  inviteId?: string,
): Promise<void> {
  // Don't notify if user invited themselves (shouldn't happen but safety check)
  if (userId === inviterId) {
    return;
  }

  const result = await db
    .select({
      displayName: users.displayName,
      username: users.username,
    })
    .from(users)
    .where(eq(users.id, inviterId))
    .limit(1);

  const inviter = result[0];
  const inviterName = inviter?.displayName || inviter?.username || "Someone";
  const message = `${inviterName} invited you to "${chatName}"`;

  // Create notification with groupId and inviteId for proper linking
  await db.insert(notifications).values({
    id: await generateSnowflakeId(),
    userId,
    type: "group_invite",
    actorId: inviterId,
    title: "Group Chat Invite",
    message,
    groupId: groupId ?? undefined,
    inviteId,
  });
}

/**
 * Create notification for user group invite
 *
 * Uses createNotification for proper safety checks (user existence, blocked users, deduplication).
 *
 * @param inviterName - Optional pre-fetched inviter name to avoid N+1 queries when called in bulk
 */
export async function notifyUserGroupInvite(
  userId: string,
  inviterId: string,
  groupId: string,
  groupName: string,
  inviteId?: string,
  inviterName?: string,
): Promise<void> {
  // Don't notify if user invited themselves
  if (userId === inviterId) {
    return;
  }

  let finalInviterName = inviterName;
  if (!finalInviterName) {
    const result = await db
      .select({
        displayName: users.displayName,
        username: users.username,
      })
      .from(users)
      .where(eq(users.id, inviterId))
      .limit(1);

    const inviter = result[0];
    finalInviterName = inviter?.displayName || inviter?.username || "Someone";
  }

  const message = `${finalInviterName} invited you to join ${groupName}`;

  // Use createNotification for proper safety checks (user existence, blocked users)
  await createNotification({
    userId,
    type: "group_invite",
    actorId: inviterId,
    title: "Group Invitation",
    message,
    groupId,
    inviteId,
  });
}

/**
 * Create notification when a user is directly added to a group
 * (without requiring invite acceptance)
 *
 * Uses createNotification for proper safety checks (user existence, blocked users, deduplication).
 *
 * @param adderName - Optional pre-fetched adder name to avoid N+1 queries when called in bulk
 */
export async function notifyGroupMemberAdded(
  userId: string,
  addedById: string,
  groupId: string,
  groupName: string,
  chatId?: string,
  adderName?: string,
): Promise<void> {
  // Don't notify if user added themselves
  if (userId === addedById) {
    return;
  }

  // Use provided adderName or fetch it (for backwards compatibility)
  let resolvedAdderName = adderName;
  if (!resolvedAdderName) {
    const result = await db
      .select({
        displayName: users.displayName,
        username: users.username,
      })
      .from(users)
      .where(eq(users.id, addedById))
      .limit(1);

    const adder = result[0];
    resolvedAdderName = adder?.displayName || adder?.username || "Someone";
  }

  const message = `${resolvedAdderName} added you to ${groupName}`;

  // Use createNotification for proper safety checks (user existence, blocked users)
  await createNotification({
    userId,
    type: "group_invite", // Reuse type for notification grouping in UI
    actorId: addedById,
    title: "Added to Group",
    message,
    groupId,
    chatId,
  });
}

/**
 * Create notification for new DM message
 */
export async function notifyDMMessage(
  recipientUserId: string,
  senderUserId: string,
  chatId: string,
  messagePreview: string,
): Promise<void> {
  // Don't notify if user sent message to themselves
  if (recipientUserId === senderUserId) {
    return;
  }

  const result = await db
    .select({
      displayName: users.displayName,
      username: users.username,
    })
    .from(users)
    .where(eq(users.id, senderUserId))
    .limit(1);

  const sender = result[0];
  const senderName = sender?.displayName || sender?.username || "Someone";

  // Truncate message preview to 50 characters
  const preview =
    messagePreview.length > 50
      ? `${messagePreview.substring(0, 50)}...`
      : messagePreview;

  const message = `${senderName}: ${preview}`;

  await createNotification({
    userId: recipientUserId,
    type: "system",
    actorId: senderUserId,
    chatId,
    title: "New Message",
    message,
  });
}

/**
 * Create notification for new group chat message
 */
export async function notifyGroupChatMessage(
  recipientUserIds: string[],
  senderUserId: string,
  chatId: string,
  chatName: string,
  messagePreview: string,
): Promise<void> {
  const result = await db
    .select({
      displayName: users.displayName,
      username: users.username,
    })
    .from(users)
    .where(eq(users.id, senderUserId))
    .limit(1);

  const sender = result[0];
  const senderName = sender?.displayName || sender?.username || "Someone";

  // Truncate message preview to 50 characters
  const preview =
    messagePreview.length > 50
      ? `${messagePreview.substring(0, 50)}...`
      : messagePreview;

  const message = `${senderName} in "${chatName}": ${preview}`;

  // Send notification to all participants except the sender
  const notificationPromises = recipientUserIds
    .filter((userId) => userId !== senderUserId)
    .map((userId) =>
      createNotification({
        userId,
        type: "system",
        actorId: senderUserId,
        chatId,
        title: "New Group Message",
        message,
      }),
    );

  await Promise.all(notificationPromises);
}

/**
 * Create notification when user is removed from an NFT-gated chat
 * This happens when the user no longer owns the required NFT
 */
export async function notifyNftAccessRevoked(
  userId: string,
  chatId: string,
  chatName: string,
  reason: string,
): Promise<void> {
  const message =
    reason === "No wallet connected"
      ? `You were removed from "${chatName}" because your wallet was disconnected`
      : `You were removed from "${chatName}" because you no longer own the required NFT`;

  await createNotification({
    userId,
    type: "nft_access_revoked",
    chatId,
    title: "NFT Access Revoked",
    message,
  });
}
