/**
 * Stable notification ordering, producer grouping, and interactive row
 * rendering for the home shade. The coordinator owns shade-level gestures;
 * this module keeps row-local swipe state isolated and memoized.
 */
import type { AgentNotification, NotificationCategory } from "@elizaos/core";
import { tierForPriority } from "@elizaos/core";
import {
  type JSX,
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { cn } from "../../lib/utils";
import { NOTIFICATION_PRIORITY_RANK } from "../../widgets/home-priority";
import {
  getChatSourceMeta,
  hasChatSourceMeta,
  normalizeChatSourceKey,
} from "../composites/chat/chat-source.helpers";
import { RelativeTime } from "./RelativeTime";

const SWIPE_DISMISS_PX = 88;
export const STACK_FAN_GESTURE_PX = 48;
const STACK_WHEEL_IDLE_MS = 220;

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
  const wheelDistance = useRef(0);
  const wheelResetTimer = useRef<number | null>(null);

  const clearGesture = useCallback(() => {
    gesture.current = null;
  }, []);

  useEffect(
    () => () => {
      if (wheelResetTimer.current !== null) {
        window.clearTimeout(wheelResetTimer.current);
      }
    },
    [],
  );

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

  const onPointerMove = useCallback(
    (event: React.PointerEvent) => {
      const current = gesture.current;
      if (!current || current.id !== event.pointerId) return;
      const dx = event.clientX - current.startX;
      const dy = event.clientY - current.startY;
      if (current.axis === "none" && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) {
        current.axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
      }
      if (current.axis === "x") {
        event.currentTarget.setPointerCapture?.(event.pointerId);
        setSwipeX(dx);
        return;
      }
      if (current.axis !== "y" || !stackKey || !onExpandStack) return;
      // A vertical drag on a folded producer belongs to that producer, never to
      // the whole inbox. Mark it non-clicking as soon as the axis commits, then
      // fan once the deliberate-drag threshold is crossed.
      suppressClick.current = true;
      if (Math.abs(dy) < STACK_FAN_GESTURE_PX) return;
      clearGesture();
      onExpandStack(stackKey);
    },
    [clearGesture, onExpandStack, stackKey],
  );

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

  const onWheel = useCallback(
    (event: React.WheelEvent) => {
      if (!stackKey || !onExpandStack) return;
      // A Mac trackpad's two-finger gesture is a WheelEvent. Only a
      // vertical-dominant run over a folded producer is consumed; horizontal
      // movement remains available to the shell pager and a fanned producer
      // immediately returns all later momentum to the native list scroller.
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      event.preventDefault();
      event.stopPropagation();
      const scale =
        event.deltaMode === 1
          ? 16
          : event.deltaMode === 2
            ? window.innerHeight
            : 1;
      wheelDistance.current += Math.abs(event.deltaY) * scale;
      if (wheelResetTimer.current !== null) {
        window.clearTimeout(wheelResetTimer.current);
      }
      wheelResetTimer.current = window.setTimeout(() => {
        wheelDistance.current = 0;
        wheelResetTimer.current = null;
      }, STACK_WHEEL_IDLE_MS);
      if (wheelDistance.current < STACK_FAN_GESTURE_PX) return;
      wheelDistance.current = 0;
      if (wheelResetTimer.current !== null) {
        window.clearTimeout(wheelResetTimer.current);
        wheelResetTimer.current = null;
      }
      onExpandStack(stackKey);
    },
    [onExpandStack, stackKey],
  );

  const dragging = swipeX !== 0 && !dismissing;
  return (
    <li className="eliza-notif-row relative" data-notif-row>
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
        onWheel={onWheel}
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
