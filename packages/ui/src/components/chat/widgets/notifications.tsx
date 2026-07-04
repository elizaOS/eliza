/**
 * Home Notifications widget: shows the most recent, highest-attention agent
 * notifications (see the `NotificationsWidget` JSDoc below), reading the shared
 * notification store directly rather than polling. Renders nothing until there
 * is real activity so the always-visible home surface stays quiet when empty.
 */
import type { AgentNotification } from "@elizaos/core";
import { Bell } from "lucide-react";
import { categoryIcon } from "../../../state/notifications/category-icon";
import {
  isSafeDeepLink,
  navigateDeepLink,
} from "../../../state/notifications/navigate-deep-link";
import {
  markNotificationRead,
  useNotifications,
} from "../../../state/notifications/notification-store";
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
    <li className="flex items-start gap-1.5 px-1 py-1">
      {/* Per-category icon from the one shared map (#10697) — the same iconography
          the popover NotificationCenter uses, so the two surfaces never drift. */}
      <span
        className="mt-0.5 shrink-0 text-muted [&_svg]:h-3.5 [&_svg]:w-3.5"
        data-testid="notification-row-icon"
        aria-hidden
      >
        {categoryIcon(notification.category)}
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="truncate text-xs font-medium text-txt">
          {notification.title}
        </span>
        {notification.body ? (
          <span className="truncate text-2xs text-muted">
            {notification.body}
          </span>
        ) : null}
      </span>
    </li>
  );
}

/**
 * Frontpage Notifications widget (#9143). A "default" home-slot widget showing
 * the most recent agent notifications, so the Launcher home surfaces real
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
      <div
        className={`min-w-0 ${props.spanClassName ?? "col-span-2 row-span-1"}`}
      >
        <HomeWidgetCard
          // The tile leads with the top notification's own category icon (#10697)
          // so the home surface reads its kind at a glance, not a generic bell.
          icon={categoryIcon(top.category)}
          label="Notifications"
          value={top.title}
          badge={unreadCount > 0 ? unreadCount : undefined}
          tone={
            urgent ? "danger" : top.priority === "high" ? "warn" : "default"
          }
          testId="widget-notifications"
          ariaLabel={`Notifications: ${unreadCount} unread, latest ${top.title}. Open inbox.`}
          onActivate={() => {
            // Mirror NotificationCenter's row behavior exactly: mark read, then
            // navigate through the scheme-checked deep-link helper (deepLink is
            // producer/LLM-influenceable — raw pushState both broke https links
            // and skipped the safety allowlist). Unsafe/missing → inbox.
            if (!top.readAt) void markNotificationRead(top.id);
            if (top.deepLink && isSafeDeepLink(top.deepLink)) {
              navigateDeepLink(top.deepLink);
            } else {
              nav.openView("/inbox", "inbox");
            }
          }}
        />
      </div>
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
