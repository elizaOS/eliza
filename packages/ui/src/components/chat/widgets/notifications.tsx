import { Bell } from "lucide-react";
import { useEffect } from "react";
import {
  initNotifications,
  useNotifications,
} from "../../../state/notifications/notification-store";
import type { WidgetProps } from "../../../widgets/types";
import { EmptyWidgetState, WidgetSection } from "./shared";

const MAX_VISIBLE_NOTIFICATIONS = 5;

function relativeTime(ts: number): string {
  const delta = Math.max(0, Date.now() - ts);
  const seconds = Math.floor(delta / 1000);
  if (seconds < 10) return "now";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function NotificationsWidget(_props: WidgetProps) {
  const { notifications, hydrated, unreadCount } = useNotifications();

  useEffect(() => {
    initNotifications();
  }, []);

  const visible = notifications.slice(0, MAX_VISIBLE_NOTIFICATIONS);

  return (
    <WidgetSection
      title={
        unreadCount > 0 ? `Notifications (${unreadCount})` : "Notifications"
      }
      icon={<Bell className="h-4 w-4" />}
      testId="chat-widget-notifications"
    >
      {!hydrated && visible.length === 0 ? (
        <div className="py-3 text-xs text-muted">Refreshing notifications…</div>
      ) : visible.length === 0 ? (
        <EmptyWidgetState
          icon={<Bell className="h-8 w-8" />}
          title="No notifications"
        />
      ) : (
        <div className="flex flex-col gap-2">
          {visible.map((notification) => (
            <div
              key={notification.id}
              className="rounded-sm border border-border/50 bg-bg/70 p-3"
            >
              <div className="flex items-start gap-2">
                <span
                  className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
                    notification.readAt ? "bg-muted" : "bg-accent"
                  }`}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-2">
                    <span className="min-w-0 truncate text-xs font-semibold text-txt">
                      {notification.title}
                    </span>
                    <span className="shrink-0 text-3xs tabular-nums text-muted">
                      {relativeTime(notification.createdAt)}
                    </span>
                  </div>
                  {notification.body ? (
                    <p className="mt-1 line-clamp-2 text-xs-tight leading-5 text-muted">
                      {notification.body}
                    </p>
                  ) : null}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </WidgetSection>
  );
}
