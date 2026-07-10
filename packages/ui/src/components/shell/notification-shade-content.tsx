/**
 * Stable notification ordering, producer grouping, and interactive row
 * rendering for the home shade. The coordinator owns shade-level gestures;
 * this module keeps row-local swipe state isolated and memoized.
 */
import type { AgentNotification, NotificationCategory } from "@elizaos/core";
import { tierForPriority } from "@elizaos/core";
import { X } from "lucide-react";
import { type JSX, memo, useCallback, useRef, useState } from "react";
import { cn } from "../../lib/utils";
import { NOTIFICATION_PRIORITY_RANK } from "../../widgets/home-priority";
import {
  getChatSourceMeta,
  hasChatSourceMeta,
  normalizeChatSourceKey,
} from "../composites/chat/chat-source.helpers";
import { notificationPullRevealStyle } from "./notification-shade-presentation";
import { RelativeTime } from "./RelativeTime";

const SWIPE_DISMISS_PX = 88;

/** Stable shade order: priority, recency, then id as a total tiebreak. */
export function orderDashboardNotifications(
  notifications: readonly AgentNotification[],
): AgentNotification[] {
  return [...notifications].sort((a, b) => {
    const byPriority =
      (NOTIFICATION_PRIORITY_RANK[b.priority] ?? 1) -
      (NOTIFICATION_PRIORITY_RANK[a.priority] ?? 1);
    if (byPriority !== 0) return byPriority;
    if (b.createdAt !== a.createdAt) return b.createdAt - a.createdAt;
    return a.id.localeCompare(b.id);
  });
}

/** Only interrupt-tier notifications remain visible before expansion. */
export function isInterruptPriority(notification: AgentNotification): boolean {
  return tierForPriority(notification.priority) === "interrupt";
}

const CATEGORY_GROUP_LABELS: Record<NotificationCategory, string> = {
  reminder: "Reminders",
  task: "Tasks",
  workflow: "Workflows",
  agent: "Agents",
  approval: "Needs response",
  message: "Messages",
  health: "Health",
  system: "System",
  general: "General",
};

/** Stable producer identity for an Apple-style notification stack. */
export function notificationGroupKey(notification: AgentNotification): string {
  return (
    normalizeChatSourceKey(notification.source) ??
    `category:${notification.category}`
  );
}

/** Accessible producer label for a source-grouped notification stack. */
export function notificationGroupLabel(
  notification: AgentNotification,
): string {
  const source = normalizeChatSourceKey(notification.source);
  if (source) return getChatSourceMeta(source).label;
  return (
    CATEGORY_GROUP_LABELS[notification.category] ??
    CATEGORY_GROUP_LABELS.general
  );
}

/** Group priority-ordered rows by normalized producer identity. */
export function groupDashboardNotifications(
  notifications: readonly AgentNotification[],
): Array<{ key: string; label: string; rows: AgentNotification[] }> {
  const groups = new Map<
    string,
    { label: string; rows: AgentNotification[] }
  >();
  for (const notification of orderDashboardNotifications(notifications)) {
    const key = notificationGroupKey(notification);
    const group = groups.get(key);
    if (group) group.rows.push(notification);
    else {
      groups.set(key, {
        label: notificationGroupLabel(notification),
        rows: [notification],
      });
    }
  }
  return [...groups.entries()].map(([key, group]) => ({ key, ...group }));
}

export function ClearConfirmationContent({
  confirming,
}: {
  confirming: boolean;
}): JSX.Element {
  return (
    <span className="relative flex h-full w-full items-center justify-center">
      <X
        aria-hidden
        className={cn(
          "eliza-notif-control-transition absolute h-3.5 w-3.5 transition-[opacity,transform] duration-200 ease-out",
          confirming ? "scale-75 opacity-0" : "scale-100 opacity-100",
        )}
      />
      <span
        aria-hidden={!confirming}
        className={cn(
          "eliza-notif-control-transition absolute transition-[opacity,transform] duration-200 ease-out",
          confirming
            ? "translate-y-0 scale-100 opacity-100"
            : "translate-y-0.5 scale-95 opacity-0",
        )}
      >
        Clear
      </span>
    </span>
  );
}

function NotificationSourceIcon({
  count,
  source,
}: {
  count?: number;
  source: string;
}): JSX.Element {
  const meta = getChatSourceMeta(source);
  const Icon = meta.Icon;
  const registered = hasChatSourceMeta(source);
  return (
    <span
      data-testid="notification-source-icon"
      data-source={normalizeChatSourceKey(source) ?? undefined}
      role="img"
      aria-label={
        count && count > 1
          ? `${meta.label}, ${count} notifications`
          : meta.label
      }
      title={meta.label}
      className={cn(
        "relative flex h-10 w-10 shrink-0 items-center justify-center rounded-[9px] border border-white/15 bg-black/30",
        registered && meta.iconClassName,
      )}
    >
      {registered ? (
        <Icon className="h-5 w-5" />
      ) : (
        <span aria-hidden className="text-sm font-semibold text-white/85">
          {meta.label.trim().charAt(0).toUpperCase() || "E"}
        </span>
      )}
      {count && count > 1 ? (
        <span
          data-testid="notification-source-count"
          aria-hidden
          className="absolute -right-2 -top-2 flex h-5 min-w-5 items-center justify-center rounded-full bg-white/90 px-1.5 text-center text-[11px] font-semibold leading-none tabular-nums text-black shadow-[0_0_0_2px_rgba(0,0,0,0.7),0_1px_4px_rgba(0,0,0,0.45)]"
        >
          {count > 99 ? "99+" : count}
        </span>
      ) : null}
    </span>
  );
}

export interface NotificationRowProps {
  notification: AgentNotification;
  stackKey?: string;
  stackCount?: number;
  pullRevealProgress?: number;
  shadeVisibility?: number;
  onExpandStack?: (key: string) => void;
  onOpen: (notification: AgentNotification) => void;
  onDismiss: (id: string) => void;
}

export function rowPropsEqual(
  previous: NotificationRowProps,
  next: NotificationRowProps,
): boolean {
  const a = previous.notification;
  const b = next.notification;
  return (
    a.id === b.id &&
    a.title === b.title &&
    a.body === b.body &&
    a.deepLink === b.deepLink &&
    a.source === b.source &&
    previous.stackKey === next.stackKey &&
    previous.stackCount === next.stackCount &&
    previous.pullRevealProgress === next.pullRevealProgress &&
    previous.shadeVisibility === next.shadeVisibility &&
    previous.onExpandStack === next.onExpandStack &&
    previous.onOpen === next.onOpen &&
    previous.onDismiss === next.onDismiss
  );
}

let notificationRowRenderObserverForTests: (() => void) | null = null;

export function __setNotificationRowRenderObserverForTests(
  observer: (() => void) | null,
): void {
  notificationRowRenderObserverForTests = observer;
}

/** One notification card with tap/open and horizontal dismiss behavior. */
export const NotificationRow = memo(function NotificationRow({
  notification,
  stackKey,
  stackCount,
  pullRevealProgress,
  shadeVisibility,
  onExpandStack,
  onOpen,
  onDismiss,
}: NotificationRowProps): JSX.Element {
  notificationRowRenderObserverForTests?.();
  const [swipeX, setSwipeX] = useState(0);
  const [dismissing, setDismissing] = useState<"left" | "right" | null>(null);
  const gesture = useRef<{
    id: number;
    startX: number;
    startY: number;
    axis: "none" | "x" | "y";
  } | null>(null);
  const suppressClick = useRef(false);

  const clearGesture = useCallback(() => {
    gesture.current = null;
  }, []);

  const commitDismiss = useCallback(
    (direction: "left" | "right") => {
      suppressClick.current = true;
      setDismissing(direction);
      window.setTimeout(() => onDismiss(notification.id), 180);
    },
    [notification.id, onDismiss],
  );

  const onPointerDown = useCallback((event: React.PointerEvent) => {
    suppressClick.current = false;
    gesture.current = {
      id: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      axis: "none",
    };
  }, []);

  const onPointerMove = useCallback((event: React.PointerEvent) => {
    const current = gesture.current;
    if (!current || current.id !== event.pointerId) return;
    const dx = event.clientX - current.startX;
    const dy = event.clientY - current.startY;
    if (current.axis === "none" && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) {
      current.axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
    }
    if (current.axis !== "x") return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setSwipeX(dx);
  }, []);

  const onPointerEnd = useCallback(
    (event: React.PointerEvent) => {
      const current = gesture.current;
      if (!current || current.id !== event.pointerId) {
        clearGesture();
        return;
      }
      clearGesture();
      if (current.axis !== "none") suppressClick.current = true;
      if (current.axis === "x") {
        const dx = event.clientX - current.startX;
        if (Math.abs(dx) >= SWIPE_DISMISS_PX) {
          commitDismiss(dx < 0 ? "left" : "right");
          return;
        }
      }
      setSwipeX(0);
    },
    [clearGesture, commitDismiss],
  );

  const dragging = swipeX !== 0 && !dismissing;
  return (
    <li
      className={cn(
        "eliza-notif-row relative",
        pullRevealProgress !== undefined &&
          "eliza-notif-pull-reveal pointer-events-none",
        shadeVisibility !== undefined && "eliza-notif-shade-transition grid",
      )}
      data-notification-pull-reveal={
        pullRevealProgress !== undefined ? "" : undefined
      }
      data-notification-disposable-row={
        shadeVisibility !== undefined ? "" : undefined
      }
      aria-hidden={shadeVisibility === 0 ? true : undefined}
      inert={
        pullRevealProgress !== undefined || shadeVisibility === 0
          ? true
          : undefined
      }
      style={
        pullRevealProgress !== undefined
          ? notificationPullRevealStyle(pullRevealProgress)
          : shadeVisibility !== undefined
            ? {
                gridTemplateRows: `${shadeVisibility}fr`,
                opacity: shadeVisibility,
                transform: `translate3d(0, ${(1 - shadeVisibility) * -8}px, 0)`,
              }
            : undefined
      }
      data-notif-row
    >
      <div
        data-testid="notification-row-swipe"
        data-swipe-dragging={dragging ? "" : undefined}
        style={{
          transform: dismissing
            ? `translateX(${dismissing === "left" ? "-120%" : "120%"})`
            : swipeX
              ? `translateX(${swipeX}px)`
              : undefined,
          opacity: dismissing ? 0 : Math.max(0, 1 - Math.abs(swipeX) / 220),
          touchAction: "pan-y",
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        className="eliza-notif-row-inner eliza-notif-glass group relative flex min-h-0 flex-col overflow-hidden rounded-2xl"
      >
        <button
          type="button"
          data-testid="notification-row"
          aria-label={`${notification.title}${
            stackKey && stackCount
              ? `. Show all ${stackCount} ${getChatSourceMeta(notification.source).label} notifications`
              : notification.body
                ? `. ${notification.body}`
                : ""
          }`}
          onClick={(event) => {
            if (suppressClick.current) {
              suppressClick.current = false;
              event.preventDefault();
              return;
            }
            if (stackKey && onExpandStack) onExpandStack(stackKey);
            else onOpen(notification);
          }}
          className="flex min-h-touch min-w-0 items-center gap-3 rounded-2xl px-3 py-2 text-left active:scale-[0.99] motion-reduce:active:scale-100"
        >
          <NotificationSourceIcon
            source={notification.source}
            count={stackCount}
          />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="flex items-baseline gap-1.5">
              <span className="truncate text-sm font-semibold text-white">
                {notification.title}
              </span>
              <RelativeTime
                ts={notification.createdAt}
                short
                className="ml-auto shrink-0 pl-2 text-2xs tabular-nums text-white/60"
                data-testid="notification-row-time"
              />
            </span>
            {notification.body ? (
              <span className="line-clamp-2 text-xs leading-snug text-white/60">
                {notification.body}
              </span>
            ) : null}
          </span>
        </button>
      </div>
    </li>
  );
}, rowPropsEqual);

NotificationRow.displayName = "NotificationRow";
