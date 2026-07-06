/**
 * The app's notification inbox. It is NOT pinned on the dashboard: the home
 * stays clean and the inbox stays hidden until the user pulls the shade DOWN —
 * HomeScreen mounts this inside the NotificationsShade sheet, so this component
 * owns the inbox content (rows, open/deep-link, per-row dismiss, mark-all-read)
 * and self-hides when empty. It has no card chrome of its own — no fill, no
 * border — it floats on the shade's surface; rows carry no bulk clear-all, only
 * per-row dismissal (hover X on mouse, sideways swipe on touch, or the row's
 * long-press / right-click contextual menu).
 *
 * Rows are grouped by the VIEW they deep-link into (falling back to the
 * producer category), like a platform notification shade groups by app. The
 * list is height-capped and scrolls internally: edge fades mask the
 * clipped rows, and where scroll-driven animations are supported rows gently
 * scale/fade as they slide through the viewport edges (a notification-shade
 * depth cue). Both effects are GPU-only and fully stilled under
 * prefers-reduced-motion; browsers without view-timeline support keep the
 * static fades and plain scrolling.
 *
 * Ordering is deliberately NOT the unread-first inbox rank: rows sort by
 * priority bucket then recency, ignoring read state, so tapping a row (which
 * marks it read) never reshuffles the list under the user's finger. Groups
 * inherit the position of their highest-ranked row.
 */
import type { AgentNotification, NotificationCategory } from "@elizaos/core";
import { Check, CheckCheck, ExternalLink, X } from "lucide-react";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { haptics } from "../../bridge/capacitor-bridge";
import { cn } from "../../lib/utils";
import { tabFromPath, titleForTab } from "../../navigation";
import {
  isSafeDeepLink,
  navigateDeepLink,
} from "../../state/notifications/navigate-deep-link";
import {
  markAllNotificationsRead,
  markNotificationRead,
  removeNotification,
  useNotifications,
} from "../../state/notifications/notification-store";
import { NOTIFICATION_PRIORITY_RANK } from "../../widgets/home-priority";
import { Button } from "../ui/button";
import { RelativeTime } from "./RelativeTime";
import { WALLPAPER_TEXT } from "./wallpaper-idiom";

/**
 * Horizontal travel (px) a touch swipe must clear before the row commits to a
 * dismiss on release; below it the row springs back. Also the distance past
 * which the row is treated as thrown (fling out + remove).
 */
const SWIPE_DISMISS_PX = 88;

/** Long-press duration (ms) that opens the row's contextual menu on touch. */
const LONG_PRESS_MS = 420;

/**
 * Height cap for the scrolling list (the header stays pinned above it). Sized
 * so the dashboard keeps the widget grid visible below on a phone while still
 * showing ~4–5 rows before scrolling.
 */
const LIST_MAX_HEIGHT = "max-h-[min(45dvh,19.5rem)]";

/**
 * Upper bound on rendered rows. The store caps the inbox at 300 but painting
 * hundreds of buttons on the always-mounted home hurts low-end mobile; 100
 * matches the HTTP hydrate limit, and dismiss/clear manage volume beyond it.
 */
const MAX_RENDERED_ROWS = 100;

/**
 * Scroll polish for the capped list, in one inline block (house pattern -
 * see HOME_ENTER_CSS in HomeScreen):
 *
 *  - `.eliza-notif-scroll` carries the top/bottom edge fade masks, toggled by
 *    the `data-fade-top` / `data-fade-bottom` attributes the scroll handler
 *    maintains, so rows dissolve at the clipped edges instead of hard-cutting.
 *  - Where `animation-timeline: view()` is supported, each row also scales and
 *    fades slightly while crossing the scrollport edges - the depth cue of a
 *    platform notification shade. Progressive enhancement only; the fallback
 *    is the plain masked scroll.
 *  - New rows (live arrivals) slide in from the top.
 *
 * All of it is opacity/transform-only and disabled under reduced motion.
 */
const NOTIF_SCROLL_CSS = `
.eliza-notif-scroll {
  scrollbar-width: none;
}
.eliza-notif-scroll::-webkit-scrollbar { display: none; }
.eliza-notif-scroll[data-fade-top] {
  mask-image: linear-gradient(to bottom, transparent 0, black 1.25rem, black 100%);
}
.eliza-notif-scroll[data-fade-bottom] {
  mask-image: linear-gradient(to bottom, black 0, black calc(100% - 1.25rem), transparent 100%);
}
.eliza-notif-scroll[data-fade-top][data-fade-bottom] {
  mask-image: linear-gradient(to bottom, transparent 0, black 1.25rem, black calc(100% - 1.25rem), transparent 100%);
}
@keyframes eliza-notif-row-in {
  from { opacity: 0; transform: translateY(-8px) scale(0.98); }
  to   { opacity: 1; transform: none; }
}
/* Mount slide-in lives on the row's INNER element; the scroll-driven edge pair
   lives on the li. Same-property animations on one element fight through their
   fill states (the later edge animations would pin opacity/transform and
   swallow the mount slide), so the two effects get separate elements. */
.eliza-notif-row-inner {
  animation: eliza-notif-row-in 260ms cubic-bezier(0.22,1,0.36,1) both;
}
@supports (animation-timeline: view()) {
  @media (prefers-reduced-motion: no-preference) {
    .eliza-notif-scroll .eliza-notif-row {
      animation:
        eliza-notif-edge-in linear both,
        eliza-notif-edge-out linear both;
      animation-timeline: view(), view();
      animation-range: entry, exit;
    }
    @keyframes eliza-notif-edge-in {
      from { opacity: 0.3; transform: scale(0.94); }
      to   { opacity: 1; transform: none; }
    }
    @keyframes eliza-notif-edge-out {
      from { opacity: 1; transform: none; }
      to   { opacity: 0.3; transform: scale(0.94); }
    }
  }
}
@media (prefers-reduced-motion: reduce) {
  .eliza-notif-row, .eliza-notif-row-inner { animation: none; }
}
`;

/**
 * Stable dashboard order: priority bucket, then recency, then id as the total
 * tiebreak. Read state styles rows but never orders them - marking a row read
 * on tap must not move it (the inbox-style unread-first rank reshuffles).
 */
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

/** Human group labels for producer categories with no in-app deep link. */
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

/**
 * The shade groups rows by the VIEW a notification opens (its in-app deepLink
 * resolved through the tab model), the way a platform shade groups by app.
 * External links and link-less rows fall back to the producer-category label.
 */
export function notificationGroupLabel(n: AgentNotification): string {
  const link = n.deepLink;
  if (link?.startsWith("/")) {
    const tab = tabFromPath(link.split(/[?#]/)[0] ?? link);
    if (tab) {
      const title = titleForTab(tab);
      if (title) return title;
    }
  }
  return CATEGORY_GROUP_LABELS[n.category] ?? CATEGORY_GROUP_LABELS.general;
}

/**
 * Dashboard rows grouped by view. Rows keep the stable priority→recency order;
 * a group sits where its highest-ranked row would (Map insertion order), so
 * the most urgent view stacks first — priority-sorted groups, newest inside.
 */
export function groupDashboardNotifications(
  notifications: readonly AgentNotification[],
): Array<{ label: string; rows: AgentNotification[] }> {
  const groups = new Map<string, AgentNotification[]>();
  for (const n of orderDashboardNotifications(notifications)) {
    const label = notificationGroupLabel(n);
    const rows = groups.get(label);
    if (rows) rows.push(n);
    else groups.set(label, [n]);
  }
  return [...groups.entries()].map(([label, rows]) => ({ label, rows }));
}

/**
 * One notification row: a whole-row open button (mark read + scheme-checked
 * deep link). The row carries no fill or border of its own — it floats on the
 * shade's field, spacing separates turns. Dismissal is pointer-idiomatic: a
 * mouse reveals an X on hover; touch throws the row left or right past
 * {@link SWIPE_DISMISS_PX} to dismiss (springs back below it). A long-press
 * (touch) or right-click (mouse) opens a contextual menu — open / mark read /
 * dismiss — so tap stays a single clean "open the view" action.
 *
 * Memoized (binding pattern, spec §C.4): the relative timestamp now lives in a
 * `<RelativeTime>` leaf that owns the minute tick, so the row no longer has to
 * re-render every minute to keep "5m ago" honest. With time rendering out of
 * the row's render path, a stable-props memo is correct - it re-renders only
 * when the row's actual content changes, and `arePropsEqual` compares the
 * identity fields that drive its markup: `id`, `readAt` (unread styling),
 * `priority` (rail), `title`, `body`, `data.count`, plus the two callbacks (stable via the
 * parent's `useCallback`). `createdAt` is intentionally NOT compared: it feeds
 * only the leaf, which subscribes to the tick itself.
 */
export function rowPropsEqual(
  prev: NotificationRowProps,
  next: NotificationRowProps,
): boolean {
  const a = prev.notification;
  const b = next.notification;
  return (
    a.id === b.id &&
    a.readAt === b.readAt &&
    a.priority === b.priority &&
    a.title === b.title &&
    a.body === b.body &&
    a.deepLink === b.deepLink &&
    a.data?.count === b.data?.count &&
    prev.onOpen === next.onOpen &&
    prev.onDismiss === next.onDismiss &&
    prev.onMarkRead === next.onMarkRead
  );
}

export interface NotificationRowProps {
  notification: AgentNotification;
  onOpen: (n: AgentNotification) => void;
  onDismiss: (id: string) => void;
  onMarkRead: (id: string) => void;
}

let notificationRowRenderObserverForTests: (() => void) | null = null;
let notificationsHomeCenterRenderObserverForTests: (() => void) | null = null;

export function __setNotificationRowRenderObserverForTests(
  observer: (() => void) | null,
): void {
  notificationRowRenderObserverForTests = observer;
}

export function __setNotificationsHomeCenterRenderObserverForTests(
  observer: (() => void) | null,
): void {
  notificationsHomeCenterRenderObserverForTests = observer;
}

const NotificationRow = memo(function NotificationRow({
  notification,
  onOpen,
  onDismiss,
  onMarkRead,
}: NotificationRowProps): React.JSX.Element {
  notificationRowRenderObserverForTests?.();
  const unread = !notification.readAt;
  const urgent = notification.priority === "urgent";
  const high = notification.priority === "high";

  // Touch swipe-to-dismiss + long-press menu. `swipeX` drives the live drag
  // transform; `menuOpen` is the contextual menu. Refs hold the in-flight
  // gesture so the memoized row never needs the parent to re-render mid-drag.
  const [swipeX, setSwipeX] = useState(0);
  const [dismissing, setDismissing] = useState<"left" | "right" | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const gesture = useRef<{
    id: number;
    startX: number;
    startY: number;
    axis: "none" | "x" | "y";
    longPress: number | null;
    moved: boolean;
  } | null>(null);
  // Set true by a completed swipe / long-press so the synthetic click the same
  // gesture emits doesn't also fire "open".
  const suppressClick = useRef(false);

  const clearGesture = useCallback(() => {
    const g = gesture.current;
    if (g?.longPress != null) window.clearTimeout(g.longPress);
    gesture.current = null;
  }, []);

  const commitDismiss = useCallback(
    (dir: "left" | "right") => {
      suppressClick.current = true;
      setDismissing(dir);
      // Let the fling-out transition paint before the store removes the row.
      window.setTimeout(() => onDismiss(notification.id), 180);
    },
    [notification.id, onDismiss],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (menuOpen) return;
      suppressClick.current = false;
      const longPress =
        e.pointerType !== "mouse"
          ? window.setTimeout(() => {
              suppressClick.current = true;
              setMenuOpen(true);
              void haptics.light();
            }, LONG_PRESS_MS)
          : null;
      gesture.current = {
        id: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        axis: "none",
        longPress,
        moved: false,
      };
    },
    [menuOpen],
  );

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const g = gesture.current;
    if (!g || g.id !== e.pointerId) return;
    const dx = e.clientX - g.startX;
    const dy = e.clientY - g.startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) g.moved = true;
    // Lock the axis on first real movement: a vertical drag belongs to the
    // list scroller, only a horizontal one is a dismiss swipe. Touch only —
    // a mouse drag must never hijack text selection or the scrollbar.
    if (g.axis === "none" && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) {
      g.axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
      // Any committed drag cancels the pending long-press.
      if (g.longPress != null) {
        window.clearTimeout(g.longPress);
        g.longPress = null;
      }
    }
    if (g.axis !== "x" || e.pointerType === "mouse") return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setSwipeX(dx);
  }, []);

  const onPointerEnd = useCallback(
    (e: React.PointerEvent) => {
      const g = gesture.current;
      if (!g || g.id !== e.pointerId) {
        clearGesture();
        return;
      }
      clearGesture();
      if (g.axis === "x") {
        const dx = e.clientX - g.startX;
        if (Math.abs(dx) >= SWIPE_DISMISS_PX) {
          commitDismiss(dx < 0 ? "left" : "right");
          return;
        }
      }
      setSwipeX(0);
    },
    [clearGesture, commitDismiss],
  );

  // Close the contextual menu on an OUTSIDE pointer / Escape while it is open.
  // The containment check is what lets a click LAND on a menu item: a blanket
  // "close on any pointerdown" would unmount the menu on the item's own
  // pointerdown, swallowing the click before it fires.
  useEffect(() => {
    if (!menuOpen) return undefined;
    const onPointer = (ev: PointerEvent) => {
      const target = ev.target as Node | null;
      if (menuRef.current && target && menuRef.current.contains(target)) return;
      setMenuOpen(false);
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") setMenuOpen(false);
    };
    // Defer one tick so the opening long-press/right-click isn't the "outside".
    const id = window.setTimeout(() => {
      window.addEventListener("pointerdown", onPointer);
      window.addEventListener("keydown", onKey);
    }, 0);
    return () => {
      window.clearTimeout(id);
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  // §C.3 count-aware coalescing: a superseding same-groupKey notification carries
  // data.count so the row reads "3 new files" via a small chip instead of the
  // inbox silently keeping only the last of the batch. Only surfaced for N > 1.
  const rawCount = notification.data?.count;
  const count = typeof rawCount === "number" && rawCount > 1 ? rawCount : null;
  // Lock-screen restraint: NO per-row icon chip (a box inside a box inside the
  // card). Priority is carried by a hairline accent rail on the leading edge -
  // present only for urgent/high - and an unread state by a single dot, so a
  // quiet normal notification is just its line + time, like an iOS lock note.
  const accent = urgent || high ? "bg-white/75" : null;
  const dragging = swipeX !== 0 && !dismissing;
  return (
    <li
      // Lifted above sibling rows while the menu is open so the menu — which
      // overflows past this row's box — is never painted over (each row's swipe
      // transform makes its own stacking context, so a later row would other-
      // wise cover the menu and swallow its clicks).
      className={cn("eliza-notif-row relative", menuOpen && "z-30")}
      data-notif-row
      onContextMenu={(e) => {
        e.preventDefault();
        setMenuOpen(true);
      }}
    >
      <div
        data-testid="notification-row-swipe"
        style={{
          // Only apply a transform while actually swiping/dismissing: a resting
          // `translateX(0)` still creates a stacking context on every row, which
          // is what buries an open menu behind the next row.
          transform: dismissing
            ? `translateX(${dismissing === "left" ? "-120%" : "120%"})`
            : swipeX
              ? `translateX(${swipeX}px)`
              : undefined,
          opacity: dismissing ? 0 : Math.max(0, 1 - Math.abs(swipeX) / 220),
          transition: dragging
            ? "none"
            : "transform 180ms cubic-bezier(0.22,1,0.36,1), opacity 180ms linear",
          touchAction: "pan-y",
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        className={cn(
          // No fill, no border of its own — the row floats on the shade field;
          // a hover wash is the only rest→hover chrome. Unread keeps a faint tint.
          "eliza-notif-row-inner group relative flex items-stretch overflow-hidden rounded-xl transition-colors duration-150 hover:bg-white/10",
          unread && "bg-white/8",
        )}
      >
        {/* Priority rail: a 2px edge tint, urgent/high only. The row without
            it reads as ordinary - restraint over decoration. */}
        {accent ? (
          <span
            aria-hidden
            data-testid="notification-row-accent"
            className={cn(
              "absolute inset-y-1.5 left-0 w-0.5 rounded-full",
              accent,
            )}
          />
        ) : null}
        <button
          type="button"
          data-testid="notification-row"
          data-unread={unread ? "true" : undefined}
          aria-label={`${notification.title}${
            notification.body ? `. ${notification.body}` : ""
          }${unread ? ". Unread." : ""}`}
          onClick={(e) => {
            // A swipe / long-press synthesizes a click on release; swallow it so
            // the gesture doesn't also open the notification.
            if (suppressClick.current) {
              suppressClick.current = false;
              e.preventDefault();
              return;
            }
            onOpen(notification);
          }}
          className="flex min-h-touch min-w-0 flex-1 flex-col gap-0.5 rounded-xl px-3 py-2 pr-9 text-left active:scale-[0.99] motion-reduce:active:scale-100 pointer-coarse:pr-3"
        >
          <span className="flex items-baseline gap-1.5">
            {unread ? (
              <span
                aria-hidden
                data-testid="notification-unread-dot"
                className={cn(
                  "mb-px h-1.5 w-1.5 shrink-0 self-center rounded-full",
                  "bg-white",
                )}
              />
            ) : null}
            <span
              className={cn(
                "truncate text-sm",
                unread
                  ? "font-semibold text-white"
                  : "font-medium text-white/78",
              )}
            >
              {notification.title}
            </span>
            {count ? (
              <span
                data-testid="notification-count-chip"
                className={cn(
                  "shrink-0 rounded-full px-1.5 text-2xs font-semibold tabular-nums leading-[1.15rem]",
                  unread
                    ? "bg-white/18 text-white"
                    : "bg-white/10 text-white/70",
                )}
              >
                {count}
                <span className="sr-only"> grouped notifications</span>
              </span>
            ) : null}
            <RelativeTime
              ts={notification.createdAt}
              className="ml-auto shrink-0 pl-2 text-2xs tabular-nums text-white/60"
              data-testid="notification-row-time"
            />
          </span>
          {notification.body ? (
            <span className="line-clamp-2 text-xs leading-snug text-white/62">
              {notification.body}
            </span>
          ) : null}
        </button>
        {/* Mouse-only dismiss: hidden at rest, revealed on row hover or keyboard
            focus. Touch has no hover — it throws the row sideways to dismiss (or
            long-presses for the menu), so the X is `pointer-coarse:hidden` to
            keep touch rows clean and reclaim the trailing space. */}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Dismiss notification"
          data-testid="notification-row-dismiss"
          onClick={() => onDismiss(notification.id)}
          className="absolute right-1 top-1.5 h-auto w-auto shrink-0 rounded-full p-1.5 text-white/55 opacity-0 transition-opacity hover:bg-white/10 hover:text-white focus-visible:opacity-100 group-hover:opacity-100 pointer-coarse:hidden"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
      {menuOpen ? (
        <div
          ref={menuRef}
          role="menu"
          aria-label="Notification actions"
          data-testid="notification-row-menu"
          // Anchored to the trailing edge over the row. The outside-close
          // listener skips pointerdowns inside this subtree (containment check)
          // so a menu-item click is never swallowed.
          className="absolute right-2 top-full z-10 mt-0.5 flex min-w-40 flex-col overflow-hidden rounded-xl border border-white/12 bg-black/80 py-1 text-sm text-white shadow-lg backdrop-blur-md"
        >
          {notification.deepLink && isSafeDeepLink(notification.deepLink) ? (
            <button
              type="button"
              role="menuitem"
              data-testid="notification-menu-open"
              onClick={() => {
                setMenuOpen(false);
                onOpen(notification);
              }}
              className="flex items-center gap-2 px-3 py-2 text-left hover:bg-white/10"
            >
              <ExternalLink className="h-4 w-4 shrink-0 text-white/70" />
              Open
            </button>
          ) : null}
          {unread ? (
            <button
              type="button"
              role="menuitem"
              data-testid="notification-menu-mark-read"
              onClick={() => {
                setMenuOpen(false);
                onMarkRead(notification.id);
              }}
              className="flex items-center gap-2 px-3 py-2 text-left hover:bg-white/10"
            >
              <Check className="h-4 w-4 shrink-0 text-white/70" />
              Mark as read
            </button>
          ) : null}
          <button
            type="button"
            role="menuitem"
            data-testid="notification-menu-dismiss"
            onClick={() => {
              setMenuOpen(false);
              onDismiss(notification.id);
            }}
            className="flex items-center gap-2 px-3 py-2 text-left hover:bg-white/10"
          >
            <X className="h-4 w-4 shrink-0 text-white/70" />
            Dismiss
          </button>
        </div>
      ) : null}
    </li>
  );
}, rowPropsEqual);
NotificationRow.displayName = "NotificationRow";

/**
 * The notification inbox card. Self-hiding: renders nothing until the inbox
 * has at least one notification. Mounted inside NotificationsShade (the home
 * pull-up sheet), never pinned on the dashboard itself.
 */
export interface NotificationsHomeCenterProps {
  /** Called after a row activates a safe in-app deep link. */
  onNavigate?: (deepLink: string) => void;
}

export function NotificationsHomeCenter({
  onNavigate,
}: NotificationsHomeCenterProps = {}): React.JSX.Element | null {
  notificationsHomeCenterRenderObserverForTests?.();
  const { notifications, unreadCount } = useNotifications();
  // No list-level clock tick here (binding pattern, spec §C.4): relative
  // timestamps live in the `<RelativeTime>` leaf inside each row, which owns the
  // shared visibility-gated ticker. The minute roll re-renders those text nodes
  // only - not this list, not the rows, not the glass surface.
  const scrollRef = useRef<HTMLUListElement | null>(null);

  // Maintain the edge-fade attributes from real scroll geometry. Runs on
  // scroll and whenever the row count changes (a dismiss can end the overflow).
  const syncEdgeFades = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const canUp = el.scrollTop > 2;
    const canDown = el.scrollTop < el.scrollHeight - el.clientHeight - 2;
    el.toggleAttribute("data-fade-top", canUp);
    el.toggleAttribute("data-fade-bottom", canDown);
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure when the row count changes
  useEffect(() => {
    syncEdgeFades();
  }, [syncEdgeFades, notifications.length]);

  const openNotification = useCallback(
    (n: AgentNotification) => {
      if (!n.readAt) void markNotificationRead(n.id);
      // deepLink is producer/LLM-influenceable - only scheme-checked links
      // navigate; anything else the tap is just "mark read".
      if (n.deepLink && isSafeDeepLink(n.deepLink)) {
        navigateDeepLink(n.deepLink);
        onNavigate?.(n.deepLink);
      }
    },
    [onNavigate],
  );
  const dismissNotification = useCallback((id: string) => {
    void removeNotification(id);
  }, []);
  const markReadNotification = useCallback((id: string) => {
    void markNotificationRead(id);
  }, []);

  if (notifications.length === 0) return null;

  // Cap rendered rows, then group by view: the cap keeps the always-cheap
  // paint budget; grouping happens on the capped slice so headers never count
  // against visible rows.
  const capped = orderDashboardNotifications(notifications).slice(
    0,
    MAX_RENDERED_ROWS,
  );
  const groups = groupDashboardNotifications(capped);

  return (
    <section
      aria-label={
        unreadCount > 0
          ? `Notifications, ${unreadCount} unread`
          : "Notifications"
      }
      data-testid="home-notification-center"
      // No card chrome: the inbox has no fill and no border of its own. It floats
      // directly on the shade's own surface (the pull-down sheet owns the
      // backdrop) — rows are separated by spacing and their hover wash, so the
      // list reads as bare lock-screen notes, not a boxed panel.
      className="flex flex-col overflow-hidden"
    >
      <style>{NOTIF_SCROLL_CSS}</style>
      {/* Pinned header: a quiet eyebrow + unread count, actions to the right.
          No boxed bell chip - the label alone names the surface. */}
      <div className="flex shrink-0 items-center gap-1.5 px-3.5 pb-1 pt-2.5">
        <span
          className={cn(
            "text-2xs font-medium uppercase tracking-[0.1em]",
            WALLPAPER_TEXT.secondary,
          )}
        >
          Notifications
        </span>
        {unreadCount > 0 ? (
          <span
            data-testid="notifications-unread-badge"
            className="text-2xs font-semibold tabular-nums leading-none text-white"
          >
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        ) : null}
        <span className="ml-auto flex items-center gap-0.5">
          {unreadCount > 0 ? (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Mark all read"
              title="Mark all read"
              data-testid="notifications-mark-all-read"
              className={cn(
                WALLPAPER_TEXT.secondary,
                "hover:bg-white/10 hover:text-white",
              )}
              onClick={() => void markAllNotificationsRead()}
            >
              <CheckCheck className="h-4 w-4" />
            </Button>
          ) : null}
        </span>
      </div>
      <ul
        ref={scrollRef}
        onScroll={syncEdgeFades}
        data-testid="home-notification-list"
        className={cn(
          "eliza-notif-scroll flex flex-col gap-0.5 overflow-y-auto overscroll-y-contain px-1.5 pb-1.5",
          LIST_MAX_HEIGHT,
        )}
      >
        {groups.map((group) => (
          <li key={group.label} className="flex flex-col gap-0.5">
            {/* View group header (Apple-shade idiom: group by destination).
                A quiet eyebrow, not a boxed section — restraint over chrome. */}
            <span
              data-testid="notification-group-label"
              className="px-2 pb-0.5 pt-2 text-2xs font-medium uppercase tracking-[0.08em] text-white/55 first:pt-1"
            >
              {group.label}
            </span>
            <ul className="flex flex-col gap-0.5">
              {group.rows.map((notification) => (
                <NotificationRow
                  key={notification.id}
                  notification={notification}
                  onOpen={openNotification}
                  onDismiss={dismissNotification}
                  onMarkRead={markReadNotification}
                />
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </section>
  );
}
