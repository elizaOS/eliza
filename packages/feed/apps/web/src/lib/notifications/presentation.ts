const SYSTEM_NOTIFICATION_TYPES = new Set([
  "system",
  "market_resolved",
  "hourly_summary",
  "daily_summary",
  "weekly_summary",
  "monthly_summary",
  "achievement_unlocked",
  "challenge_completed",
]);

export interface NotificationPresentationInput {
  type: string;
  title: string;
  message: string;
  actor: {
    displayName: string;
  } | null;
}

export interface NotificationPresentation {
  isSystemStyle: boolean;
  title: string | null;
  message: string;
}

export function getNotificationPresentation(
  notification: NotificationPresentationInput,
): NotificationPresentation {
  const isSystemStyle =
    notification.actor === null ||
    SYSTEM_NOTIFICATION_TYPES.has(notification.type);
  const title = notification.title.trim();
  const message = notification.message.trim();

  if (!isSystemStyle) {
    return {
      isSystemStyle: false,
      title: null,
      message,
    };
  }

  return {
    isSystemStyle: true,
    title: title !== message ? title : null,
    message,
  };
}
