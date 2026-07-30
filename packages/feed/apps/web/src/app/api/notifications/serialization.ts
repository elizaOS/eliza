/**
 * Normalizes database and cache notification rows into the stable API shape.
 * The serializer lives outside the route module because Next.js route modules
 * may export only HTTP handlers and supported route configuration.
 */

import { toISO } from "@feed/shared";

export function serializeNotificationForApi(
  notification: Record<string, unknown> & {
    actor?: Record<string, unknown> | null;
  },
) {
  const toSafeString = (value: unknown): string => {
    if (value === null || value === undefined) return "";
    if (typeof value === "string") return value;
    if (typeof value === "number") return String(value);
    if (typeof value === "boolean") return String(value);
    if (typeof value === "object" && "toString" in value) {
      return (value as { toString: () => string }).toString();
    }
    return String(value);
  };

  let createdAtISO: string;
  if (notification.createdAt instanceof Date) {
    createdAtISO = toISO(notification.createdAt);
  } else if (typeof notification.createdAt === "string") {
    createdAtISO = notification.createdAt;
  } else {
    const dateValue = notification.createdAt as string | number | Date;
    createdAtISO = new Date(dateValue).toISOString();
  }

  return {
    id: toSafeString(notification.id),
    type: toSafeString(notification.type),
    title: toSafeString(notification.title),
    actorId: toSafeString(notification.actorId),
    actor: notification.actor
      ? {
          id: toSafeString(notification.actor.id),
          displayName: toSafeString(notification.actor.displayName),
          username: toSafeString(notification.actor.username),
          profileImageUrl: toSafeString(notification.actor.profileImageUrl),
        }
      : null,
    postId: notification.postId ? toSafeString(notification.postId) : null,
    commentId: notification.commentId
      ? toSafeString(notification.commentId)
      : null,
    chatId: notification.chatId ? toSafeString(notification.chatId) : null,
    groupId: notification.groupId ? toSafeString(notification.groupId) : null,
    inviteId: notification.inviteId
      ? toSafeString(notification.inviteId)
      : null,
    message: toSafeString(notification.message),
    data:
      notification.data && typeof notification.data === "object"
        ? (notification.data as Record<string, unknown>)
        : null,
    read: Boolean(notification.read),
    createdAt: createdAtISO,
  };
}
