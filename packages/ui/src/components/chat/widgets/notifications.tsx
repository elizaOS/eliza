/**
 * Home Notifications widget: shows the most recent, highest-attention agent
 * notifications (see the `NotificationsWidget` JSDoc below), reading the shared
 * notification store directly rather than polling. Renders nothing until there
 * is real activity so the always-visible home surface stays quiet when empty.
 */
import type { AgentNotification } from "@elizaos/core";
import { Bell, ChevronRight } from "lucide-react";
import { memo, useCallback } from "react";
import { cn } from "../../../lib/utils";
import { useNow } from "../../../hooks/useNow";
import { categoryIcon } from "../../../state/notifications/category-icon";
import {
  isSafeDeepLink,
  navigateDeepLink,
} from "../../../state/notifications/navigate-deep-link";
import {
  markNotificationRead,
  useNotifications,
} from "../../../state/notifications/notification-store";
import {
  rankHomeNotifications,
  selectHomeNotifications,
} from "../../../widgets/home-priority";
import { formatRelativeTime } from "../../../utils/format";
import type { WidgetProps } from "../../../widgets/types";
import { HomeWidgetCard, useWidgetNavigation } from "./home-widget-card";
import { WidgetSection } from "./shared";

/**
 * How many home ENTRIES (single rows or grouped rows) the home notification
 * surface shows. Kept small on purpose — home is a glance, not the inbox.
 */
const MAX_HOME_NOTIFICATIONS = 4;

/** Human-facing label for a collapsed same-category group of `count` items. */
function groupTitle(category: string, count: number): string {
  return `${count} ${category} update${count === 1 ? "" : "s"}`;
}

/**
 * One scannable notification row. A whole-row button (comfortable tap target)
 * that mirrors the popover NotificationCenter's activate behavior — mark read,
 * then follow a scheme-checked deep link, else open the inbox. Unread rows
 * stand out with an accent dot + stronger title; read rows recede.
 *
 * Memoized: the widget re-renders on the shared `useNow()` 60s recency tick
 * (needed by the home slot's age-gate) and on any store change; with a stable
 * `onOpen` (see `useCallback` in the widget) the capped row list then skips
 * re-rendering every minute when nothing about a row actually changed.
 */
const NotificationRow = memo(function NotificationRow({
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
});

/**
 * Frontpage Notifications widget (#9143). A "default" home-slot widget showing
 * the most attention-worthy agent notifications, so the Launcher home surfaces
 * real activity out of the box rather than only launcher icons. Reads the
 * shared notification store directly (no per-widget polling).
 *
 * Signal, not noise: the home surface applies an aggressive quiet-threshold
 * (only unread, recent, high/urgent notifications are eligible) and collapses
 * same-category bursts into a single grouped row. The full inbox/pull-down
 * still shows everything — only THIS home surface gets the quiet + grouping.
 */
export function NotificationsWidget(props: WidgetProps) {
  const { notifications, unreadCount } = useNotifications();
  const nav = useWidgetNavigation();
  // Coarse live clock for the home recency gate. `0` on first render keeps the
  // render path deterministic (no Date.now in render); the age-gate treats
  // `now === 0` as "don't age-filter yet" so home never flashes empty on paint.
  const now = useNow();

  // Open a row: mirror NotificationCenter's row behavior exactly — mark read,
  // then navigate through the scheme-checked deep-link helper (deepLink is
  // producer/LLM-influenceable — raw pushState both broke https links and
  // skipped the safety allowlist). Unsafe/missing → inbox.
  //
  // Stable across the `useNow()` 60s recency tick (`nav` is memoized) so the
  // memoized rows don't re-render every minute just because this closure was
  // re-created.
  const openNotification = useCallback(
    (n: AgentNotification) => {
      if (!n.readAt) void markNotificationRead(n.id);
      if (n.deepLink && isSafeDeepLink(n.deepLink)) {
        navigateDeepLink(n.deepLink);
      } else {
        nav.openView("/inbox", "inbox");
      }
    },
    [nav],
  );

  // ---- HOME SLOT ----------------------------------------------------------
  // The compact tile only surfaces when a genuinely home-worthy notification
  // exists. Below the quiet threshold (read / stale / low severity) the tile
  // renders nothing at all — signal, not noise (#9226 null contract preserved).
  if (props.slot === "home") {
    const homeEntries = selectHomeNotifications(notifications, { now });
    const top = homeEntries[0];
    if (!top) return null;

    // The tile's one datum: either the lead notification's title, or a grouped
    // "N updates" summary when the top entry is a collapsed category.
    const isGroup = top.kind === "group";
    const leadNotification = isGroup ? top.lead : top.notification;
    const value = isGroup
      ? groupTitle(top.category, top.count)
      : leadNotification.title;
    const urgent = leadNotification.priority === "urgent";
    const high = leadNotification.priority === "high";
    // The lead of a group shares the group's category, so its typed
    // NotificationCategory drives the icon in both the single and group cases.
    const category = leadNotification.category;

    return (
      <div
        className={`min-w-0 ${props.spanClassName ?? "col-span-2 row-span-1"}`}
      >
        <HomeWidgetCard
          // The tile leads with the notification's own category icon (#10697)
          // so the home surface reads its kind at a glance, not a generic bell.
          icon={categoryIcon(category)}
          label="Notifications"
          value={value}
          badge={unreadCount > 0 ? unreadCount : undefined}
          tone={urgent ? "danger" : high ? "warn" : "default"}
          testId="widget-notifications"
          ariaLabel={`Notifications: ${unreadCount} unread, ${
            isGroup ? value : `latest ${value}`
          }. Open inbox.`}
          onActivate={() =>
            isGroup ? nav.openView("/inbox", "inbox") : openNotification(top.notification)
          }
        />
      </div>
    );
  }

  // ---- CHAT-SIDEBAR / DEFAULT SLOT ----------------------------------------
  // The sidebar keeps the fuller list (the inbox-adjacent surface): rank by
  // attention (unread → priority → recency), capped, so it stays useful without
  // the home surface's aggressive quiet.
  const ranked = rankHomeNotifications(notifications);
  const recent = ranked.slice(0, MAX_HOME_NOTIFICATIONS);
  const overflow = ranked.length - recent.length;

  // Render nothing until there's real activity (#9226 null contract).
  if (recent.length === 0) {
    return null;
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
