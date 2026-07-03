import type { AgentNotification } from "@elizaos/core";
import { Bell, ChevronRight } from "lucide-react";
import { cn } from "../../../lib/utils";
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
import { formatRelativeTime } from "../../../utils/format";
import type { WidgetProps } from "../../../widgets/types";
import { HomeWidgetCard, useWidgetNavigation } from "./home-widget-card";
import { WidgetSection } from "./shared";

const MAX_HOME_NOTIFICATIONS = 4;

/**
 * One scannable notification row. A whole-row button (comfortable tap target)
 * that mirrors the popover NotificationCenter's activate behavior — mark read,
 * then follow a scheme-checked deep link, else open the inbox. Unread rows
 * stand out with an accent dot + stronger title; read rows recede.
 */
function NotificationRow({
  notification,
  onOpen,
}: {
  notification: AgentNotification;
  onOpen: (notification: AgentNotification) => void;
}) {
  const unread = !notification.readAt;
  const urgent = notification.priority === "urgent";
  const high = notification.priority === "high";
  return (
    <li>
      <button
        type="button"
        data-testid="notification-row"
        data-unread={unread ? "true" : undefined}
        aria-label={`${notification.title}${
          notification.body ? `. ${notification.body}` : ""
        }${unread ? ". Unread." : ""}`}
        onClick={() => onOpen(notification)}
        className={cn(
          "group flex min-h-touch w-full items-start gap-2 rounded-md px-1.5 py-1.5 text-left",
          "transition-colors duration-150 hover:bg-bg-hover",
          "active:scale-[0.99] motion-reduce:active:scale-100",
        )}
      >
        {/* Per-category icon from the one shared map (#10697) — the same
            iconography the popover NotificationCenter uses, so the two surfaces
            never drift. Urgent/high tint the chip so severity reads instantly. */}
        <span
          className={cn(
            "mt-px inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-sm [&_svg]:h-3.5 [&_svg]:w-3.5",
            urgent
              ? "bg-destructive-subtle text-destructive"
              : high
                ? "bg-accent-subtle text-accent"
                : "bg-bg-muted text-muted",
          )}
          data-testid="notification-row-icon"
          aria-hidden
        >
          {categoryIcon(notification.category)}
        </span>

        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex items-center gap-1.5">
            {/* Unread accent dot: the primary "this needs you" signal, quiet
                enough to scan a stack of them without noise. */}
            {unread ? (
              <span
                aria-hidden
                data-testid="notification-unread-dot"
                className={cn(
                  "h-1.5 w-1.5 shrink-0 rounded-full",
                  urgent ? "bg-destructive" : "bg-accent",
                )}
              />
            ) : null}
            <span
              className={cn(
                "truncate text-xs",
                unread
                  ? "font-semibold text-txt"
                  : "font-medium text-muted-strong",
              )}
            >
              {notification.title}
            </span>
          </span>
          {notification.body ? (
            <span className="truncate text-2xs text-muted">
              {notification.body}
            </span>
          ) : null}
        </span>

        {/* Timestamp: the subtlest element, right-aligned so titles stay the
            scan column. Omitted when we have no createdAt to show. */}
        {typeof notification.createdAt === "number" ? (
          <time
            className="mt-px shrink-0 text-3xs tabular-nums text-muted"
            data-testid="notification-row-time"
          >
            {formatRelativeTime(notification.createdAt)}
          </time>
        ) : null}
      </button>
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
  const overflow = ranked.length - recent.length;

  // Render nothing until there's real activity. The always-visible home surface
  // (#9143) must not show an empty placeholder card — empty-state hints belong
  // on the dedicated view, not the home slot.
  if (recent.length === 0) {
    return null;
  }

  // Open a row: mirror NotificationCenter's row behavior exactly — mark read,
  // then navigate through the scheme-checked deep-link helper (deepLink is
  // producer/LLM-influenceable — raw pushState both broke https links and
  // skipped the safety allowlist). Unsafe/missing → inbox.
  const openNotification = (n: AgentNotification) => {
    if (!n.readAt) void markNotificationRead(n.id);
    if (n.deepLink && isSafeDeepLink(n.deepLink)) {
      navigateDeepLink(n.deepLink);
    } else {
      nav.openView("/inbox", "inbox");
    }
  };

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
          onActivate={() => openNotification(top)}
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
          <span
            className="rounded-full bg-accent-subtle px-1.5 py-0.5 text-2xs font-semibold tabular-nums text-accent"
            aria-label={`${unreadCount} unread`}
          >
            {unreadCount}
          </span>
        ) : (
          // All caught up: a quiet "read" state instead of a stray title with
          // no counterpart, so the header reads intentional at a glance.
          <span className="text-3xs font-medium uppercase tracking-[0.08em] text-muted/70">
            Caught up
          </span>
        )
      }
    >
      <ul className="flex flex-col gap-0.5">
        {recent.map((n) => (
          <NotificationRow
            key={n.id}
            notification={n}
            onOpen={openNotification}
          />
        ))}
      </ul>
      {overflow > 0 ? (
        <button
          type="button"
          data-testid="notification-overflow"
          onClick={() => nav.openView("/inbox", "inbox")}
          aria-label={`${overflow} more notification${
            overflow === 1 ? "" : "s"
          }. Open inbox.`}
          className={cn(
            "mt-0.5 flex min-h-touch w-full items-center justify-between gap-1 rounded-md px-1.5 py-1.5 text-left",
            "text-2xs font-medium text-muted transition-colors duration-150",
            "hover:bg-bg-hover hover:text-txt",
            "active:scale-[0.99] motion-reduce:active:scale-100",
          )}
        >
          <span>
            {overflow} more{" "}
            {overflow === 1 ? "notification" : "notifications"}
          </span>
          <ChevronRight className="h-3.5 w-3.5 shrink-0" aria-hidden />
        </button>
      ) : null}
    </WidgetSection>
  );
}
