"use client";

import { useCallback } from "react";
import { useNotificationStore, type NotificationCategory } from "@/lib/notifications";
import { browserNotifications } from "@/lib/browser-notifications";

export interface NotifyOptions {
  title: string;
  description: string;
  category: NotificationCategory;
  link?: string;
  browserNotification?: boolean;
}

export function useNotifications() {
  const notifications = useNotificationStore((s) => s.notifications);
  const browserNotificationsEnabled = useNotificationStore(
    (s) => s.browserNotificationsEnabled
  );
  const addNotification = useNotificationStore((s) => s.addNotification);
  const markRead = useNotificationStore((s) => s.markRead);
  const markAllRead = useNotificationStore((s) => s.markAllRead);
  const clearHistory = useNotificationStore((s) => s.clearHistory);

  const notify = useCallback(
    async (options: NotifyOptions) => {
      addNotification({
        title: options.title,
        description: options.description,
        category: options.category,
        link: options.link,
      });

      if (options.browserNotification && browserNotificationsEnabled) {
        await browserNotifications.send({
          title: options.title,
          body: options.description,
        });
      }
    },
    [addNotification, browserNotificationsEnabled]
  );

  const unreadCount = notifications.filter((n) => !n.read).length;

  return {
    notifications,
    unreadCount,
    notify,
    markRead,
    markAllRead,
    clearHistory,
  };
}
