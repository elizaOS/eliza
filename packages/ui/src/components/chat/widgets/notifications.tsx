import type { AgentNotification } from "@elizaos/core";
import { Bell } from "lucide-react";
import { useNotifications } from "../../../state/notifications/notification-store";
import { rankHomeNotifications } from "../../../widgets/home-priority";
import type { WidgetProps } from "../../../widgets/types";
import { HomeWidgetCard, useWidgetNavigation } from "./home-widget-card";
import { WidgetSection } from "./shared";

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
export function NotificationsWidget(props: WidgetProps) {
  const { notifications, unreadCount } = useNotifications();
  const nav = useWidgetNavigation();
  // Rank by attention (unread → priority → recency) so an urgent notification
  // surfaces ahead of a newer low-priority one, not merely the newest few.
  const ranked = rankHomeNotifications(notifications);
  const recent = ranked.slice(0, MAX_HOME_NOTIFICATIONS);

  // Render nothing until there's real activity. The always-visible home surface
  // (#9143) must not show an empty placeholder card — empty-state hints belong
  // on the dedicated view, not the home slot.
  if (recent.length === 0) {
    return null;
  }

  // Home slot: a single compact, icon-first, whole-card-clickable tile —
  // the top (highest-priority, unread-first) notification as the one datum,
  // unread count as the badge, urgent → danger. Tapping opens the notification's
  // own deep link if it has one, else the inbox. The sidebar keeps the list.
  if (props.slot === "home") {
    const top = recent[0];
    const urgent = top.priority === "urgent";
    return (
      <HomeWidgetCard
        icon={<Bell />}
        label="Notifications"
        value={top.title}
        badge={unreadCount > 0 ? unreadCount : undefined}
        tone={urgent ? "danger" : top.priority === "high" ? "warn" : "default"}
        testId="widget-notifications"
        ariaLabel={`Notifications: ${unreadCount} unread, latest ${top.title}. Open inbox.`}
        onActivate={() =>
          top.deepLink
            ? nav.openView(top.deepLink, "inbox")
            : nav.openView("/inbox", "inbox")
        }
      />
    );
  }

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
      <ul className="flex flex-col gap-0.5">
        {recent.map((n) => (
          <NotificationRow key={n.id} notification={n} />
        ))}
      </ul>
    </WidgetSection>
  );
}
