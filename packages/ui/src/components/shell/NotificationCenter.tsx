import type { AgentNotification, NotificationCategory } from "@elizaos/core";
import {
  Bell,
  BellRing,
  Bot,
  Check,
  CheckCheck,
  CircleAlert,
  Clock,
  FileWarning,
  HeartPulse,
  Inbox,
  MessageSquare,
  Settings2,
  Trash2,
  Workflow,
  X,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect } from "react";
import { cn } from "../../lib/utils";
import { useApp } from "../../state";
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
import { Button } from "../ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";

const CATEGORY_ICON: Record<NotificationCategory, ReactNode> = {
  reminder: <Clock className="h-4 w-4" />,
  task: <Check className="h-4 w-4" />,
  workflow: <Workflow className="h-4 w-4" />,
  agent: <Bot className="h-4 w-4" />,
  approval: <FileWarning className="h-4 w-4" />,
  message: <MessageSquare className="h-4 w-4" />,
  health: <HeartPulse className="h-4 w-4" />,
  system: <Settings2 className="h-4 w-4" />,
  general: <CircleAlert className="h-4 w-4" />,
};

function categoryIcon(category: NotificationCategory): ReactNode {
  return CATEGORY_ICON[category] ?? CATEGORY_ICON.general;
}

/** Best-effort navigation for a notification deep link. */
function navigateDeepLink(deepLink: string): void {
  if (typeof window === "undefined") return;
  if (/^https?:\/\//i.test(deepLink)) {
    window.open(deepLink, "_blank", "noopener,noreferrer");
    return;
  }
  if (deepLink.startsWith("/")) {
    const viewId = deepLink.slice(1).split("/")[0] || undefined;
    window.dispatchEvent(
      new CustomEvent("eliza:navigate:view", {
        detail: { viewId, viewPath: deepLink },
      }),
    );
  }
}

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
        className="absolute right-1.5 top-2.5 shrink-0 rounded-sm p-1 text-muted opacity-0 transition-opacity hover:bg-card hover:text-txt focus-visible:opacity-100 group-hover:opacity-100"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </li>
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
 */
export function NotificationCenter({
  className,
  headless = false,
}: {
  className?: string;
  headless?: boolean;
}): ReactNode {
  const { notifications, unreadCount } = useNotifications();
  const { setActionNotice } = useApp();

  // Boot the notification store (hydrate + subscribe to the live stream) and
  // route its interrupt toasts through the shell's ActionNotice. Idempotent —
  // the store guards against re-init; the toast sink is re-pointed on remount.
  useEffect(() => {
    initNotifications();
    registerNotificationToastSink(setActionNotice);
    return () => registerNotificationToastSink(null);
  }, [setActionNotice]);

  const handleMarkAll = useCallback(() => {
    void markAllNotificationsRead();
  }, []);
  const handleClear = useCallback(() => {
    void clearNotifications();
  }, []);

  const hasUnread = unreadCount > 0;

  // Hidden for now: keep the store + toast routing live (the effect above) but
  // render no bell. Drop the `headless` prop to bring the button back.
  if (headless) return null;

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
            <span className="absolute -right-0.5 -top-0.5 flex min-w-[16px] items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold leading-4 text-accent-foreground">
              {unreadCount > 99 ? "99+" : unreadCount}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={8}
        className="w-[min(360px,calc(100vw-1.5rem))] p-0"
      >
        <div className="flex items-center justify-between border-b border-border px-3 py-2.5">
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
          </div>
        </div>
        {notifications.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
            <Inbox className="h-7 w-7 text-muted/70" />
            <span className="text-sm text-muted">You're all caught up</span>
          </div>
        ) : (
          <ul className="max-h-[min(440px,60vh)] overflow-y-auto p-1.5">
            {notifications.map((notification) => (
              <NotificationRow
                key={notification.id}
                notification={notification}
                onClose={() => {
                  /* popover closes on navigation via deep-link below */
                }}
              />
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}

export default NotificationCenter;
