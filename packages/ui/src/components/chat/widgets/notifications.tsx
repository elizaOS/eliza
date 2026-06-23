import type { AgentNotification } from "@elizaos/core";
import { Bell } from "lucide-react";
import { useNotifications } from "../../../state/notifications/notification-store";
import type { WidgetProps } from "../../../widgets/types";
import { EmptyWidgetState, WidgetSection } from "./shared";

const MAX_HOME_NOTIFICATIONS = 4;

function NotificationRow({
  notification,
}: {
  notification: AgentNotification;
}) {
  return (
    <li className="flex flex-col gap-0.5 px-1 py-1">
      <span className="truncate text-xs font-medium text-txt">
        {notification.title}
      </span>
      {notification.body ? (
        <span className="truncate text-2xs text-muted">
          {notification.body}
        </span>
      ) : null}
    </li>
  );
}

/**
 * Frontpage Notifications widget (#9143). A "default" home-slot widget showing
 * the most recent agent notifications, so the Springboard home surfaces real
 * activity out of the box rather than only launcher icons. Reads the shared
 * notification store directly (no per-widget polling).
 */
export function NotificationsWidget(_props: WidgetProps) {
  const { notifications, unreadCount } = useNotifications();
  const recent = notifications.slice(0, MAX_HOME_NOTIFICATIONS);

  return (
    <WidgetSection
      title="Notifications"
      icon={<Bell />}
      testId="widget-notifications"
      action={
        unreadCount > 0 ? (
          <span className="rounded-full bg-accent-subtle px-1.5 text-2xs font-medium text-accent">
            {unreadCount}
          </span>
        ) : undefined
      }
    >
      {recent.length === 0 ? (
        <EmptyWidgetState
          icon={<Bell />}
          title="No notifications yet"
          description="Agent activity and reminders show up here."
        />
      ) : (
        <ul className="flex flex-col gap-0.5">
          {recent.map((n) => (
            <NotificationRow key={n.id} notification={n} />
          ))}
        </ul>
      )}
    </WidgetSection>
  );
}
