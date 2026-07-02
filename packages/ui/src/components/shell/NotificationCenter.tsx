import type { AgentNotification, NotificationCategory } from "@elizaos/core";
import { Bell, BellRing, CheckCheck, Inbox, Trash2, X } from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { cn } from "../../lib/utils";
import { useAppSelector } from "../../state";
import { categoryIcon } from "../../state/notifications/category-icon";
import { navigateDeepLink } from "../../state/notifications/navigate-deep-link";
import {
  clearNotifications,
  initNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  registerNotificationToastSink,
  removeNotification,
  useNotifications,
} from "../../state/notifications/notification-store";
import { formatRelativeTime } from "../../utils/format";
import { rankHomeNotifications } from "../../widgets/home-priority";
import { Button } from "../ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";

type NotificationSortMode = "priority" | "time";

const CATEGORY_LABEL: Record<NotificationCategory, string> = {
  reminder: "Reminders",
  task: "Tasks",
  workflow: "Workflows",
  agent: "Agents",
  approval: "Approvals",
  message: "Messages",
  health: "Health",
  system: "System",
  general: "General",
};

/** Stable display order for the category filter chips. */
const CATEGORY_ORDER: NotificationCategory[] = [
  "approval",
  "agent",
  "task",
  "workflow",
  "reminder",
  "message",
  "health",
  "system",
  "general",
];

type CategoryFilter = NotificationCategory | "all";

function NotificationRow({
  notification,
  onClose,
}: {
  notification: AgentNotification;
  onClose: () => void;
}): ReactNode {
  const unread = !notification.readAt;
  const handleOpen = useCallback(() => {
    if (unread) void markNotificationRead(notification.id);
    if (notification.deepLink) {
      navigateDeepLink(notification.deepLink);
      onClose();
    }
  }, [notification.deepLink, notification.id, onClose, unread]);

  const handleRemove = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      void removeNotification(notification.id);
    },
    [notification.id],
  );

  return (
    <li
      className={cn(
        "group relative flex items-start gap-3 rounded-sm pr-9 transition-colors hover:bg-surface",
        unread && "bg-surface/60",
      )}
    >
      <button
        type="button"
        onClick={handleOpen}
        className="flex min-w-0 flex-1 items-start gap-3 rounded-sm px-3 py-2.5 text-left"
      >
        <span
          className={cn(
            "mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-sm",
            notification.priority === "urgent"
              ? "bg-status-error/15 text-status-error"
              : notification.priority === "high"
                ? "bg-accent/15 text-accent"
                : "bg-surface text-muted-strong",
          )}
        >
          {categoryIcon(notification.category)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-txt">
              {notification.title}
            </span>
            {unread && (
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
            )}
          </span>
          {notification.body && (
            <span className="mt-0.5 line-clamp-2 block text-xs text-muted">
              {notification.body}
            </span>
          )}
          <span className="mt-1 block text-[11px] text-muted/80">
            {formatRelativeTime(notification.createdAt)}
          </span>
        </span>
      </button>
      <button
        type="button"
        aria-label="Dismiss notification"
        onClick={handleRemove}
        // Visible at rest (dimmed): on touch there is no hover, and an
        // invisible-but-hit-testable X silently deleted the notification on a
        // near-edge tap. Full opacity on hover; keyboard focus visibility is
        // the app-wide global treatment (per-component focus utilities are
        // banned by no-focus-ring-gate).
        className="absolute right-1.5 top-2.5 shrink-0 rounded-sm p-1 text-muted opacity-50 transition-opacity hover:bg-card hover:text-txt group-hover:opacity-100"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </li>
  );
}

function CategoryFilterBar({
  categories,
  active,
  onSelect,
}: {
  categories: NotificationCategory[];
  active: CategoryFilter;
  onSelect: (next: CategoryFilter) => void;
}): ReactNode {
  return (
    /* Flat — no divider line; rows separate by whitespace. */
    <div
      className="flex items-center gap-1 overflow-x-auto px-2 py-1.5"
      role="tablist"
      aria-label="Filter notifications by category"
    >
      <FilterChip
        label="All"
        active={active === "all"}
        onSelect={() => onSelect("all")}
      />
      {categories.map((category) => (
        <FilterChip
          key={category}
          label={CATEGORY_LABEL[category]}
          icon={categoryIcon(category)}
          active={active === category}
          onSelect={() => onSelect(category)}
        />
      ))}
    </div>
  );
}

function FilterChip({
  label,
  icon,
  active,
  onSelect,
}: {
  label: string;
  icon?: ReactNode;
  active: boolean;
  onSelect: () => void;
}): ReactNode {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onSelect}
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium transition-colors",
        active
          ? "bg-accent text-accent-foreground hover:bg-accent-hover"
          : "text-muted-strong hover:bg-surface hover:text-txt",
      )}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

/**
 * Notification center — a floating bell + unread badge that opens a panel
 * listing the agent's notifications. Self-contained: reads the notification
 * store, no props required. Mounted once in the app shell's persistent
 * overlay region so it is reachable from every view.
 *
 * `headless` boots the store + toast routing but renders no bell — used to keep
 * interrupt toasts flowing while the visible button is hidden.
 *
 * `variant="sheet"` renders the same panel as a controlled top sheet (opened by
 * the home pull-DOWN gesture, #10706) instead of the bell + popover; `open` /
 * `onOpenChange` drive it.
 */
export function NotificationCenter({
  className,
  headless = false,
  variant = "bell",
  open = false,
  onOpenChange,
}: {
  className?: string;
  headless?: boolean;
  variant?: "bell" | "sheet";
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}): ReactNode {
  const { notifications, unreadCount } = useNotifications();
  const setActionNotice = useAppSelector((s) => s.setActionNotice);
  const [activeCategory, setActiveCategory] = useState<CategoryFilter>("all");
  // Default to attention-first (unread → priority → recency); the user can flip
  // to a plain most-recent-first timeline (#10706).
  const [sortMode, setSortMode] = useState<NotificationSortMode>("priority");

  // Categories actually present in the inbox, in a stable display order. Drives
  // the filter chips — empty/single-category inboxes get no filter clutter.
  const presentCategories = useMemo(() => {
    const present = new Set(notifications.map((n) => n.category));
    return CATEGORY_ORDER.filter((category) => present.has(category));
  }, [notifications]);

  // Fall back to "all" when the active category drains (its last item was read
  // away / cleared), so the list never shows an empty filtered view by accident.
  const effectiveCategory =
    activeCategory !== "all" && !presentCategories.includes(activeCategory)
      ? "all"
      : activeCategory;

  const visibleNotifications = useMemo(() => {
    const filtered =
      effectiveCategory === "all"
        ? notifications
        : notifications.filter((n) => n.category === effectiveCategory);
    // Priority: reuse the home ranker (unread → priority → recency) so the two
    // surfaces agree. Time: a plain most-recent-first timeline. Both are pure +
    // stable, so equal items never reshuffle between renders.
    return sortMode === "priority"
      ? rankHomeNotifications(filtered)
      : [...filtered].sort((a, b) => b.createdAt - a.createdAt);
  }, [notifications, effectiveCategory, sortMode]);

  // Boot the notification store (hydrate + subscribe to the live stream) and
  // route its interrupt toasts through the shell's ActionNotice. Idempotent —
  // the store guards against re-init; the toast sink is re-pointed on remount.
  useEffect(() => {
    initNotifications();
    // Only the bell/headless owner routes interrupt toasts — the pull-down sheet
    // is a transient reader and must not hijack (or null on unmount) the single
    // shared toast sink the always-mounted headless instance owns.
    if (variant === "sheet") return;
    registerNotificationToastSink(setActionNotice);
    return () => registerNotificationToastSink(null);
  }, [setActionNotice, variant]);

  const handleMarkAll = useCallback(() => {
    void markAllNotificationsRead();
  }, []);
  const handleClear = useCallback(() => {
    void clearNotifications();
  }, []);

  // Escape closes the pull-down sheet (mirrors the popover's dismiss).
  useEffect(() => {
    if (variant !== "sheet" || !open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onOpenChange?.(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [variant, open, onOpenChange]);

  const hasUnread = unreadCount > 0;

  // Hidden for now: keep the store + toast routing live (the effect above) but
  // render no bell. Drop the `headless` prop to bring the button back.
  if (headless) return null;

  const panelBody = (
    <>
      {/* Flat — no divider lines between panel rows; whitespace separates. */}
      <div className="flex items-center justify-between px-3 py-2.5">
        <span className="text-sm font-semibold text-txt">Notifications</span>
        <div className="flex items-center gap-1">
          {hasUnread && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Mark all read"
              title="Mark all read"
              onClick={handleMarkAll}
            >
              <CheckCheck className="h-4 w-4" />
            </Button>
          )}
          {notifications.length > 0 && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Clear all"
              title="Clear all"
              onClick={handleClear}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
          {variant === "sheet" && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Close notifications"
              title="Close"
              data-testid="notification-sheet-close"
              onClick={() => onOpenChange?.(false)}
            >
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>
      {presentCategories.length > 1 && (
        <CategoryFilterBar
          categories={presentCategories}
          active={effectiveCategory}
          onSelect={setActiveCategory}
        />
      )}
      {notifications.length > 1 && (
        <div className="flex items-center gap-2 px-3 py-1.5">
          <span className="text-2xs font-medium uppercase tracking-wide text-muted">
            Sort
          </span>
          <div className="ml-auto flex items-center gap-0.5 rounded-md bg-surface p-0.5">
            {(
              [
                ["priority", "Priority"],
                ["time", "Recent"],
              ] as const
            ).map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                data-testid={`notif-sort-${mode}`}
                aria-pressed={sortMode === mode}
                onClick={() => setSortMode(mode)}
                className={cn(
                  "rounded px-2 py-0.5 text-2xs font-medium transition-colors",
                  sortMode === mode
                    ? "bg-accent/15 text-accent"
                    : "text-muted hover:text-txt",
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      )}
      {notifications.length === 0 ? (
        <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
          <Inbox className="h-7 w-7 text-muted/70" />
          <span className="text-sm text-muted">You're all caught up</span>
        </div>
      ) : (
        <ul className="max-h-[min(440px,60vh)] overflow-y-auto p-1.5">
          {visibleNotifications.map((notification) => (
            <NotificationRow
              key={notification.id}
              notification={notification}
              onClose={() =>
                variant === "sheet" ? onOpenChange?.(false) : undefined
              }
            />
          ))}
        </ul>
      )}
    </>
  );

  // Pull-down sheet: a top-anchored panel the home surface reveals with a
  // downward pull (#10706). Backdrop dismisses; a grabber hints the gesture.
  if (variant === "sheet") {
    if (!open) return null;
    return (
      <>
        <button
          type="button"
          aria-label="Dismiss notifications"
          data-testid="notification-sheet-backdrop"
          data-above-shell-overlay
          onClick={() => onOpenChange?.(false)}
          className="fixed inset-0 z-[9500] bg-black/40"
        />
        <div
          role="dialog"
          aria-label="Notifications"
          data-testid="notification-sheet"
          data-above-shell-overlay
          className={cn(
            // Floating sheet: the popover scrim + one outer edge stay (self-
            // contained contrast); shadows are flat app-wide.
            "fixed inset-x-0 top-0 z-[9501] mx-auto flex max-h-[85vh] w-[min(440px,calc(100vw-1rem))] flex-col overflow-hidden rounded-b-2xl border-x border-b border-border bg-popover",
            "pt-[var(--safe-area-top,0px)]",
            className,
          )}
        >
          {panelBody}
          <div className="flex justify-center py-1.5">
            <div className="h-1 w-9 rounded-full bg-muted/40" aria-hidden />
          </div>
        </div>
      </>
    );
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={
            hasUnread
              ? `Notifications (${unreadCount} unread)`
              : "Notifications"
          }
          className={cn(
            "relative inline-flex h-9 w-9 items-center justify-center rounded-sm text-muted-strong transition-colors hover:bg-surface hover:text-txt",
            className,
          )}
        >
          {hasUnread ? (
            <BellRing className="h-[18px] w-[18px]" />
          ) : (
            <Bell className="h-[18px] w-[18px]" />
          )}
          {hasUnread && (
            /* Unread = one dot; the exact count lives in the aria-label. */
            <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-accent" />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={8}
        className="w-[min(360px,calc(100vw-1.5rem))] p-0"
      >
        {panelBody}
      </PopoverContent>
    </Popover>
  );
}

export default NotificationCenter;
