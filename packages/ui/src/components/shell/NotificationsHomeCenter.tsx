/**
 * The dashboard notification center: a home-surface widget pinned directly
 * below the time/weather base that IS the app's notification inbox. It replaced
 * the pull-down sheet/panel shells - notifications live on the dashboard, not
 * behind a gesture - so this card renders the full inbox with its actions
 * (open/deep-link, dismiss, mark-all-read, clear) and self-hides when empty.
 *
 * The list is height-capped and scrolls internally: edge fades mask the
 * clipped rows, and where scroll-driven animations are supported rows gently
 * scale/fade as they slide through the viewport edges (a notification-shade
 * depth cue). Both effects are GPU-only and fully stilled under
 * prefers-reduced-motion; browsers without view-timeline support keep the
 * static fades and plain scrolling.
 *
 * Ordering is deliberately NOT the unread-first inbox rank: rows sort by
 * priority bucket then recency, ignoring read state, so tapping a row (which
 * marks it read) never reshuffles the list under the user's finger.
 */
import type { AgentNotification } from "@elizaos/core";
import { CheckCheck, Trash2, X } from "lucide-react";
import { memo, useCallback, useEffect, useRef } from "react";
import { cn } from "../../lib/utils";
import {
  isSafeDeepLink,
  navigateDeepLink,
} from "../../state/notifications/navigate-deep-link";
import {
  clearNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  removeNotification,
  useNotifications,
} from "../../state/notifications/notification-store";
import { NOTIFICATION_PRIORITY_RANK } from "../../widgets/home-priority";
import { Button } from "../ui/button";
import { HOME_GLASS_CLASS } from "./home-glass";
import { RelativeTime } from "./RelativeTime";

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

/**
 * One notification row: a whole-row open button (mark read + scheme-checked
 * deep link) plus an always-visible dismiss X sized to the touch token on
 * coarse pointers.
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
    prev.onDismiss === next.onDismiss
  );
}

export interface NotificationRowProps {
  notification: AgentNotification;
  onOpen: (n: AgentNotification) => void;
  onDismiss: (id: string) => void;
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
}: NotificationRowProps): React.JSX.Element {
  notificationRowRenderObserverForTests?.();
  const unread = !notification.readAt;
  const urgent = notification.priority === "urgent";
  const high = notification.priority === "high";
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
  return (
    <li className="eliza-notif-row" data-notif-row>
      <div
        className={cn(
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
          onClick={() => onOpen(notification)}
          className="flex min-h-touch min-w-0 flex-1 flex-col gap-0.5 rounded-xl px-3 py-2 pr-9 text-left active:scale-[0.99] motion-reduce:active:scale-100 pointer-coarse:pr-11"
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
        {/* Visible at rest (dimmed) - on touch there is no hover, and an
            invisible dismiss silently ate near-edge taps in the old center. */}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Dismiss notification"
          data-testid="notification-row-dismiss"
          onClick={() => onDismiss(notification.id)}
          className="absolute right-1 top-1.5 h-auto w-auto shrink-0 rounded-full p-1.5 text-white/55 opacity-60 transition-opacity pointer-coarse:min-h-touch pointer-coarse:min-w-touch hover:bg-white/10 hover:text-white group-hover:opacity-100"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
    </li>
  );
}, rowPropsEqual);
NotificationRow.displayName = "NotificationRow";

/**
 * The dashboard notification center card. Self-hiding: renders nothing until
 * the inbox has at least one notification, so a quiet home stays just the
 * clock/weather base. Mounted once by HomeScreen below DefaultHomeWidgets.
 */
export function NotificationsHomeCenter(): React.JSX.Element | null {
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

  const openNotification = useCallback((n: AgentNotification) => {
    if (!n.readAt) void markNotificationRead(n.id);
    // deepLink is producer/LLM-influenceable - only scheme-checked links
    // navigate; anything else the tap is just "mark read".
    if (n.deepLink && isSafeDeepLink(n.deepLink)) {
      navigateDeepLink(n.deepLink);
    }
  }, []);
  const dismissNotification = useCallback((id: string) => {
    void removeNotification(id);
  }, []);

  if (notifications.length === 0) return null;

  const rows = orderDashboardNotifications(notifications).slice(
    0,
    MAX_RENDERED_ROWS,
  );

  return (
    <section
      aria-label={
        unreadCount > 0
          ? `Notifications, ${unreadCount} unread`
          : "Notifications"
      }
      data-testid="home-notification-center"
      // The card owns its gap from the editorial header above (mt-4) so a
      // hidden widget (null render) leaves no dead spacer in the column.
      //
      // Lock-screen glass, not a chrome box: a single shared recipe owns the
      // entire home backdrop-filter budget. Ranked widgets stay solid token
      // tiles, so adding residents never adds more blur surfaces.
      className={HOME_GLASS_CLASS}
    >
      <style>{NOTIF_SCROLL_CSS}</style>
      {/* Pinned header: a quiet eyebrow + unread count, actions to the right.
          No boxed bell chip - the label alone names the surface. */}
      <div className="flex shrink-0 items-center gap-1.5 px-3.5 pb-1 pt-2.5">
        <span className="text-2xs font-medium uppercase tracking-[0.1em] text-white/70">
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
              className="text-white/70 hover:bg-white/10 hover:text-white"
              onClick={() => void markAllNotificationsRead()}
            >
              <CheckCheck className="h-4 w-4" />
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Clear all notifications"
            title="Clear all"
            data-testid="notifications-clear-all"
            className="text-white/70 hover:bg-white/10 hover:text-white"
            onClick={() => void clearNotifications()}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
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
        {rows.map((notification) => (
          <NotificationRow
            key={notification.id}
            notification={notification}
            onOpen={openNotification}
            onDismiss={dismissNotification}
          />
        ))}
      </ul>
    </section>
  );
}
