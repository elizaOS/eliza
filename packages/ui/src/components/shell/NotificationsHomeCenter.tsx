/**
 * The app's notification inbox, mounted INLINE on the home column (HomeScreen)
 * directly beneath the time/weather header — the same layer as the widgets, in
 * the band between the header and the floating chat. It owns the inbox content
 * (rows, open/deep-link, per-row dismiss, mark-all-read) and self-hides when
 * empty, fading in Apple-style when the first notification arrives. It has no
 * card chrome and no "Notifications" header of its own — the view-group
 * eyebrows carry the structure; the only pinned control is the icon-only
 * priority ⇄ time sort toggle (default priority, persisted). At rest the shade
 * shows ONLY interrupt-tier (high/urgent) rows — triage, not a log — with a
 * quiet "N more" / "Show less" affordance to expand/compress the rest.
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
 * Acknowledgement is the platform-shade model (iOS lock screen / Android
 * shade) with an expand step: tap opens the row's contextual option strip
 * (Suggest a reply / Review / Open / Dismiss — see notificationRowOptions);
 * acting on an option clears the row. Horizontal drag (mouse or touch)
 * dismisses. There is no read/unread bookkeeping, no dots, no corner X. Both
 * sort orders are stable total orders, so live arrivals never reshuffle
 * existing rows under the user's finger; groups inherit the position of
 * their highest-ranked row.
 */
import type { AgentNotification, NotificationCategory } from "@elizaos/core";
import { tierForPriority } from "@elizaos/core";
import { logger } from "@elizaos/logger";
import { ChevronDown, ChevronUp, Clock, Flag } from "lucide-react";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { haptics } from "../../bridge/capacitor-bridge";
import { dispatchChatPrefill } from "../../events";
import { cn } from "../../lib/utils";
import { tabFromPath, titleForTab } from "../../navigation";
import {
  isSafeDeepLink,
  navigateDeepLink,
} from "../../state/notifications/navigate-deep-link";
import {
  removeNotification,
  useNotifications,
} from "../../state/notifications/notification-store";
import { NOTIFICATION_PRIORITY_RANK } from "../../widgets/home-priority";
import { RelativeTime } from "./RelativeTime";

/**
 * Horizontal travel (px) a touch swipe must clear before the row commits to a
 * dismiss on release; below it the row springs back. Also the distance past
 * which the row is treated as thrown (fling out + remove).
 */
const SWIPE_DISMISS_PX = 88;

/** Long-press duration (ms) that expands the row's options on touch. */
const LONG_PRESS_MS = 420;

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
/* Apple-style entrance: the whole inbox fades + rises a touch the moment it
   first appears in the home column (empty → first notification), so it settles
   in rather than popping. Opacity/transform only; stilled under reduced motion. */
@keyframes eliza-notif-center-in {
  from { opacity: 0; transform: translateY(6px); }
  to   { opacity: 1; transform: none; }
}
.eliza-notif-center-in {
  animation: eliza-notif-center-in 320ms cubic-bezier(0.22,1,0.36,1) both;
}
@media (prefers-reduced-motion: reduce) {
  .eliza-notif-center-in { animation: none; }
}
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

/** The two triage orders the shade's sort toggle flips between. */
export type NotificationSortMode = "priority" | "time";

/** localStorage key persisting the sort toggle across sessions. */
const SORT_MODE_STORAGE_KEY = "eliza:notifications:sort-mode";

function loadSortMode(): NotificationSortMode {
  try {
    if (typeof window === "undefined") return "priority";
    return window.localStorage.getItem(SORT_MODE_STORAGE_KEY) === "time"
      ? "time"
      : "priority";
  } catch {
    return "priority";
  }
}

function storeSortMode(mode: NotificationSortMode): void {
  try {
    window.localStorage.setItem(SORT_MODE_STORAGE_KEY, mode);
  } catch (err) {
    // error-policy:J6 best-effort UI persistence — a failed write (private
    // mode / quota) just means the sort toggle won't survive reload; the
    // in-memory state still works. Keep it observable rather than silent.
    logger.debug(
      `[NotificationsHomeCenter] sort-mode persist skipped: ${String(err)}`,
    );
  }
}

/**
 * Stable dashboard order. `priority` (the default): priority bucket, then
 * recency, then id as the total tiebreak. `time`: pure recency (id tiebreak).
 * Both are total orders, so live arrivals never reshuffle existing rows.
 */
export function orderDashboardNotifications(
  notifications: readonly AgentNotification[],
  mode: NotificationSortMode = "priority",
): AgentNotification[] {
  return [...notifications].sort((a, b) => {
    if (mode === "priority") {
      const byPriority =
        (NOTIFICATION_PRIORITY_RANK[b.priority] ?? 1) -
        (NOTIFICATION_PRIORITY_RANK[a.priority] ?? 1);
      if (byPriority !== 0) return byPriority;
    }
    if (b.createdAt !== a.createdAt) return b.createdAt - a.createdAt;
    return a.id.localeCompare(b.id);
  });
}

/**
 * Whether a notification renders in the shade's rested (compressed) state.
 * Only interrupt-tier rows (`high`/`urgent`) show by default — the shade is a
 * triage surface, not a log; everything else sits behind the "more" affordance.
 */
export function isInterruptPriority(n: AgentNotification): boolean {
  return tierForPriority(n.priority) === "interrupt";
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
  mode: NotificationSortMode = "priority",
): Array<{ label: string; rows: AgentNotification[] }> {
  const groups = new Map<string, AgentNotification[]>();
  for (const n of orderDashboardNotifications(notifications, mode)) {
    const label = notificationGroupLabel(n);
    const rows = groups.get(label);
    if (rows) rows.push(n);
    else groups.set(label, [n]);
  }
  return [...groups.entries()].map(([label, rows]) => ({ label, rows }));
}

/** One inline contextual option a tapped (expanded) row offers. */
export interface NotificationRowOption {
  id: string;
  label: string;
  kind: "open" | "prefill" | "dismiss";
  /** Composer seed for `kind: "prefill"` (opens the chat, never auto-sends). */
  prefill?: string;
}

/**
 * The contextual options a row expands to on tap, derived from category +
 * deepLink. Every notification exposes at least one action plus Dismiss:
 * a message offers "Suggest a reply" (chat prefill), an approval "Review",
 * task-like categories a labeled open, anything with a safe deepLink a plain
 * Open. Acting on any option acknowledges (clears) the row.
 */
export function notificationRowOptions(
  n: AgentNotification,
): NotificationRowOption[] {
  const options: NotificationRowOption[] = [];
  const hasLink = Boolean(n.deepLink && isSafeDeepLink(n.deepLink));
  if (n.category === "message") {
    options.push({
      id: "suggest-reply",
      label: "Suggest a reply",
      kind: "prefill",
      prefill: `Suggest a reply to "${n.title}"${n.body ? ` — ${n.body}` : ""}`,
    });
  }
  if (hasLink) {
    const label =
      n.category === "approval"
        ? "Review"
        : n.category === "task" || n.category === "agent"
          ? "Open task"
          : n.category === "workflow"
            ? "View run"
            : "Open";
    options.push({ id: "open", label, kind: "open" });
  }
  options.push({ id: "dismiss", label: "Dismiss", kind: "dismiss" });
  return options;
}

/**
 * Memoized (binding pattern, spec §C.4): the relative timestamp lives in a
 * `<RelativeTime>` leaf that owns the minute tick, so the row never re-renders
 * to keep "5m" honest. `arePropsEqual` compares the identity fields that drive
 * its markup: `id`, `title`, `body`, `deepLink`, `category` (options),
 * `data.count`, plus the callbacks (stable via the parent's `useCallback`).
 * `createdAt` is intentionally NOT compared: it feeds only the leaf.
 */
export function rowPropsEqual(
  prev: NotificationRowProps,
  next: NotificationRowProps,
): boolean {
  const a = prev.notification;
  const b = next.notification;
  return (
    a.id === b.id &&
    a.title === b.title &&
    a.body === b.body &&
    a.deepLink === b.deepLink &&
    a.category === b.category &&
    a.data?.count === b.data?.count &&
    prev.onOpen === next.onOpen &&
    prev.onDismiss === next.onDismiss &&
    prev.onPrefill === next.onPrefill
  );
}

export interface NotificationRowProps {
  notification: AgentNotification;
  onOpen: (n: AgentNotification) => void;
  onDismiss: (id: string) => void;
  onPrefill: (n: AgentNotification, text: string) => void;
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

/**
 * One notification row. Tap EXPANDS it into its contextual options
 * ({@link notificationRowOptions}) — tap again collapses; long-press (touch)
 * and right-click (mouse) also expand. Acting on any option acknowledges the
 * row (it clears from the shade). Dragging the row horizontally off the
 * screen — mouse or touch — past {@link SWIPE_DISMISS_PX} dismisses it; there
 * is no corner X. The row carries no fill or border of its own; a hover wash
 * is the only rest→hover chrome.
 */
const NotificationRow = memo(function NotificationRow({
  notification,
  onOpen,
  onDismiss,
  onPrefill,
}: NotificationRowProps): React.JSX.Element {
  notificationRowRenderObserverForTests?.();

  // Swipe-to-dismiss + expand state. `swipeX` drives the live drag transform;
  // `expanded` is the inline option strip. Refs hold the in-flight gesture so
  // the memoized row never needs the parent to re-render mid-drag.
  const [swipeX, setSwipeX] = useState(0);
  const [dismissing, setDismissing] = useState<"left" | "right" | null>(null);
  const [expanded, setExpanded] = useState(false);
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

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    suppressClick.current = false;
    const longPress =
      e.pointerType !== "mouse"
        ? window.setTimeout(() => {
            suppressClick.current = true;
            setExpanded(true);
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
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const g = gesture.current;
    if (!g || g.id !== e.pointerId) return;
    const dx = e.clientX - g.startX;
    const dy = e.clientY - g.startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) g.moved = true;
    // Lock the axis on first real movement: a vertical drag belongs to the
    // list scroller, only a horizontal one is a dismiss swipe. Mouse and touch
    // both swipe — the rows are buttons (no text selection to hijack), and the
    // 8px lock threshold keeps ordinary clicks from starting a drag.
    if (g.axis === "none" && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) {
      g.axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
      // Any committed drag cancels the pending long-press.
      if (g.longPress != null) {
        window.clearTimeout(g.longPress);
        g.longPress = null;
      }
    }
    if (g.axis !== "x") return;
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
        // A horizontal drag never doubles as a tap, even when it springs back.
        suppressClick.current = true;
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

  // §C.3 count-aware coalescing: a superseding same-groupKey notification carries
  // data.count so the row reads "3 new files" via a small chip instead of the
  // inbox silently keeping only the last of the batch. Only surfaced for N > 1.
  const rawCount = notification.data?.count;
  const count = typeof rawCount === "number" && rawCount > 1 ? rawCount : null;
  // Lock-screen restraint: no per-row icon chip, no accent rail, no fill —
  // a notification is just its line + time, like an iOS lock note.
  const dragging = swipeX !== 0 && !dismissing;
  const options = notificationRowOptions(notification);
  return (
    <li
      className="eliza-notif-row relative"
      data-notif-row
      onContextMenu={(e) => {
        e.preventDefault();
        setExpanded((v) => !v);
      }}
    >
      <div
        data-testid="notification-row-swipe"
        style={{
          // Only apply a transform while actually swiping/dismissing: a resting
          // `translateX(0)` would create a stacking context on every row.
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
          // a hover wash is the only rest→hover chrome. Expanded keeps a faint
          // wash so the option strip reads as part of the row.
          "eliza-notif-row-inner group relative flex flex-col overflow-hidden rounded-xl transition-colors duration-150 hover:bg-white/10",
          expanded && "bg-white/8",
        )}
      >
        <button
          type="button"
          data-testid="notification-row"
          aria-expanded={expanded}
          aria-label={`${notification.title}${
            notification.body ? `. ${notification.body}` : ""
          }`}
          onClick={(e) => {
            // A swipe / long-press synthesizes a click on release; swallow it
            // so the gesture doesn't also toggle the options.
            if (suppressClick.current) {
              suppressClick.current = false;
              e.preventDefault();
              return;
            }
            setExpanded((v) => !v);
          }}
          className="flex min-h-touch min-w-0 flex-col gap-0.5 rounded-xl px-3 py-2 text-left active:scale-[0.99] motion-reduce:active:scale-100"
        >
          <span className="flex items-baseline gap-1.5">
            <span className="truncate text-sm font-semibold text-white">
              {notification.title}
            </span>
            {count ? (
              <span
                data-testid="notification-count-chip"
                className="shrink-0 rounded-full bg-white/14 px-1.5 text-2xs font-semibold tabular-nums leading-[1.15rem] text-white"
              >
                {count}
                <span className="sr-only"> grouped notifications</span>
              </span>
            ) : null}
            <RelativeTime
              ts={notification.createdAt}
              short
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
        {expanded ? (
          <div
            role="group"
            aria-label="Notification actions"
            data-testid="notification-row-options"
            className="flex flex-wrap items-center gap-1.5 px-3 pb-2.5 pt-0.5"
          >
            {options.map((option) => (
              <button
                key={option.id}
                type="button"
                data-testid={`notification-option-${option.id}`}
                onClick={() => {
                  if (option.kind === "open") onOpen(notification);
                  else if (option.kind === "prefill" && option.prefill)
                    onPrefill(notification, option.prefill);
                  else onDismiss(notification.id);
                }}
                className={cn(
                  "rounded-full px-3 py-1 text-xs font-medium transition-colors",
                  option.kind === "dismiss"
                    ? "bg-white/8 text-white/65 hover:bg-white/14 hover:text-white"
                    : "bg-white/14 text-white hover:bg-white/22",
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </li>
  );
}, rowPropsEqual);
NotificationRow.displayName = "NotificationRow";

/**
 * The notification inbox. Self-hiding: renders nothing until the inbox has at
 * least one notification. Mounted inline on the home column (HomeScreen),
 * directly beneath the time/weather header — the same layer as the widgets.
 */
export function NotificationsHomeCenter(): React.JSX.Element | null {
  notificationsHomeCenterRenderObserverForTests?.();
  const { notifications } = useNotifications();
  // Sort toggle (priority ⇄ time), persisted; priority is the default. The
  // rested shade shows only interrupt-tier rows (`showAll` expands to all).
  const [sortMode, setSortMode] = useState<NotificationSortMode>(loadSortMode);
  const [showAll, setShowAll] = useState(false);
  const changeSortMode = useCallback((mode: NotificationSortMode) => {
    setSortMode(mode);
    storeSortMode(mode);
  }, []);
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
    // Platform-shade acknowledgement (iOS/Android): tapping a notification
    // acts on it AND removes it from the shade — no lingering "read" restyle.
    // deepLink is producer/LLM-influenceable - only scheme-checked links
    // navigate; anything else the tap just clears the row.
    if (n.deepLink && isSafeDeepLink(n.deepLink)) {
      navigateDeepLink(n.deepLink);
    }
    void removeNotification(n.id);
  }, []);
  const dismissNotification = useCallback((id: string) => {
    void removeNotification(id);
  }, []);
  const prefillNotification = useCallback(
    (n: AgentNotification, text: string) => {
      // "Suggest a reply"-class options: open the chat with the ask staged for
      // review (never auto-sent), then acknowledge the row.
      dispatchChatPrefill({ text });
      void removeNotification(n.id);
    },
    [],
  );

  if (notifications.length === 0) return null;

  // Cap rendered rows, filter to the rested (interrupt-tier) slice unless
  // expanded, then group by view: the cap keeps the always-cheap paint budget;
  // grouping happens on the shown slice so headers never count against rows.
  const capped = orderDashboardNotifications(notifications, sortMode).slice(
    0,
    MAX_RENDERED_ROWS,
  );
  const shown = showAll ? capped : capped.filter(isInterruptPriority);
  const hiddenCount = capped.length - shown.length;
  const groups = groupDashboardNotifications(shown, sortMode);

  return (
    <section
      aria-label="Notifications"
      data-testid="home-notification-center"
      // No card chrome: the inbox has no fill and no border of its own. It sits
      // inline on the home field directly under the time/weather header — rows
      // are separated by spacing and their hover wash, so the list reads as bare
      // lock-screen notes, not a boxed panel. `eliza-notif-center-in` fades the
      // whole inbox in (Apple-style) the moment it first appears. `min-h-0 flex-1`
      // lets it fill the home column down to the chat when the parent grows it.
      className="eliza-notif-center-in flex min-h-0 flex-1 flex-col overflow-hidden"
    >
      <style>{NOTIF_SCROLL_CSS}</style>
      {/* No "Notifications" header — the view-group eyebrows carry the
          structure. The only pinned control is the icon-only sort toggle
          (priority ⇄ time), right-aligned in the band the header occupied. */}
      <div className="flex shrink-0 items-center justify-end gap-0.5 px-2.5 pb-0.5 pt-2">
        {(
          [
            { mode: "priority", Icon: Flag, label: "Sort by priority" },
            { mode: "time", Icon: Clock, label: "Sort by time" },
          ] as const
        ).map(({ mode, Icon, label }) => (
          <button
            key={mode}
            type="button"
            aria-label={label}
            title={label}
            aria-pressed={sortMode === mode}
            data-testid={`notifications-sort-${mode}`}
            onClick={() => changeSortMode(mode)}
            className={cn(
              "rounded-full p-1.5 transition-colors",
              sortMode === mode
                ? "bg-white/12 text-white"
                : "text-white/45 hover:bg-white/8 hover:text-white/80",
            )}
          >
            <Icon className="h-3.5 w-3.5" />
          </button>
        ))}
      </div>
      <ul
        ref={scrollRef}
        onScroll={syncEdgeFades}
        data-testid="home-notification-list"
        className={cn(
          "eliza-notif-scroll flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto overscroll-y-contain px-1.5 pb-1.5",
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
                  onPrefill={prefillNotification}
                />
              ))}
            </ul>
          </li>
        ))}
        {/* Compression affordance: the rested shade is interrupt-tier only
            (information triage, not a log). "N more" pulls the full list up;
            "Show less" compresses back to high-priority. */}
        {!showAll && hiddenCount > 0 ? (
          <li>
            <button
              type="button"
              data-testid="notifications-show-all"
              onClick={() => setShowAll(true)}
              className="flex w-full items-center justify-center gap-1 rounded-xl px-3 py-1.5 text-2xs font-medium text-white/55 transition-colors hover:bg-white/8 hover:text-white/85"
            >
              <ChevronDown className="h-3.5 w-3.5" />
              {hiddenCount} more
            </button>
          </li>
        ) : null}
        {showAll && capped.some((n) => !isInterruptPriority(n)) ? (
          <li>
            <button
              type="button"
              data-testid="notifications-show-less"
              onClick={() => setShowAll(false)}
              className="flex w-full items-center justify-center gap-1 rounded-xl px-3 py-1.5 text-2xs font-medium text-white/55 transition-colors hover:bg-white/8 hover:text-white/85"
            >
              <ChevronUp className="h-3.5 w-3.5" />
              Show less
            </button>
          </li>
        ) : null}
      </ul>
    </section>
  );
}
