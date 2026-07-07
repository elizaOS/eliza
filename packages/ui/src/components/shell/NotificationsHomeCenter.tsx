/**
 * The app's notification inbox, mounted INLINE on the home column (HomeScreen)
 * directly beneath the time/weather header, the same layer as the widgets, in
 * the band between the header and the floating chat. It owns the inbox content
 * (rows, open/deep-link, per-row dismiss), self-hides when empty, and fades in
 * Apple-style when the first notification arrives. The inbox container has no
 * card chrome of its own; each notification is a liquid-glass card and the
 * view-group eyebrows carry the structure.
 *
 * Two shade modes, toggled by a pull gesture (no buttons):
 *
 *  - RESTED is triage, not a log: only interrupt-tier (`high`/`urgent`) rows
 *    show, and a view-group with several of them renders as a Z-stack — the
 *    highest-priority card on top, the rest peeking out beneath it (the iOS
 *    lock-screen stack idiom, stacked by priority). A quiet "N more" hint (not
 *    a button) names what's hidden.
 *  - EXPANDED fans every stack out flat and includes all priorities; the list
 *    is height-capped and scrolls internally.
 *
 *  Pulling DOWN on the shade (touch drag / mouse drag / wheel-up) while the
 *  list sits at its top toggles between the modes: at rest the pull expands;
 *  expanded, scrolling back up past the top compresses the shade again. A
 *  visually-hidden toggle button keeps the same transition reachable for
 *  keyboard and assistive tech.
 *
 * Acknowledgement is the platform-shade model (iOS lock screen / Android
 * shade) with an expand step: tap opens the row's contextual option strip
 * (Suggest a reply / Review / Open / Dismiss; see notificationRowOptions);
 * acting on an option clears the row. Only one row's strip is open at a time —
 * expanding a row collapses the others. The options are bare action text (no
 * pill fill, no border). Horizontal drag (mouse or touch) dismisses; there is
 * no read/unread bookkeeping, no dots, no corner X. The sort order is a stable
 * priority-first total order, so live arrivals never reshuffle existing rows
 * under the user's finger; groups inherit the position of their highest-ranked
 * row.
 */
import type { AgentNotification, NotificationCategory } from "@elizaos/core";
import { tierForPriority } from "@elizaos/core";
import { ChevronDown } from "lucide-react";
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
import { LIQUID_GLASS_EDGE_SHADOW, LIQUID_GLASS_SHEEN } from "./liquid-glass";
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
 * Dampened overscroll travel (px) past the list top that commits the shade
 * mode toggle on release. The raw finger/mouse travel is roughly double
 * (see dampenPull); wheel deltas accumulate against the same threshold.
 */
export const PULL_COMMIT_PX = 40;

/** Dead zone (px) before a vertical drag starts reading as a pull. */
const PULL_SLOP_PX = 8;

/** How many cards may peek out beneath a rested stack's top card. */
const MAX_STACK_PEEKS = 2;

/** Vertical offset (px) each successive peek card protrudes beneath the top. */
const STACK_PEEK_OFFSET_PX = 8;

/**
 * Rubber-band a raw downward overscroll travel into the dampened pull the
 * shade renders and commits against. Exported for the gesture tests.
 */
export function dampenPull(rawDy: number): number {
  return Math.min(Math.max(0, rawDy - PULL_SLOP_PX) * 0.5, 96);
}

/**
 * Scroll + glass polish for the shade, in one inline block (house pattern —
 * see HOME_ENTER_CSS in HomeScreen):
 *
 *  - `.eliza-notif-glass` is the liquid-glass card recipe every notification
 *    (and stack peek) carries: frosted translucent fill, the shared specular
 *    sheen + inset edge stack from ./liquid-glass, hover as a neutral lighten.
 *  - `.eliza-notif-scroll` carries the top/bottom edge fade masks, toggled by
 *    the `data-fade-top` / `data-fade-bottom` attributes the scroll handler
 *    maintains, so rows dissolve at the clipped edges instead of hard-cutting.
 *  - Where `animation-timeline: view()` is supported, each row also scales and
 *    fades slightly while crossing the scrollport edges — the depth cue of a
 *    platform notification shade. Progressive enhancement only; the fallback
 *    is the plain masked scroll.
 *  - New rows (live arrivals) slide in from the top.
 *
 * All of it is opacity/transform/color-only and disabled under reduced motion.
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
.eliza-notif-glass {
  background-color: rgb(12 12 14 / 34%);
  background-image: ${LIQUID_GLASS_SHEEN};
  box-shadow: ${LIQUID_GLASS_EDGE_SHADOW};
  -webkit-backdrop-filter: blur(16px) saturate(1.4);
  backdrop-filter: blur(16px) saturate(1.4);
  transition: background-color 150ms linear;
}
.eliza-notif-glass:hover {
  background-color: rgb(38 38 42 / 42%);
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

/**
 * Stable shade order: priority bucket, then recency, then id as the total
 * tiebreak. A total order, so live arrivals never reshuffle existing rows.
 * The shade has exactly one order — priority triage; there is no user-facing
 * sort mode.
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
 * Whether a notification renders in the shade's rested (compressed) state.
 * Only interrupt-tier rows (`high`/`urgent`) show by default — the shade is a
 * triage surface, not a log; everything else sits behind the pull-to-expand
 * gesture.
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
 * Shade rows grouped by view. Rows keep the stable priority→recency order;
 * a group sits where its highest-ranked row would (Map insertion order), so
 * the most urgent view stacks first — priority-sorted groups, newest inside.
 * In the rested shade each group renders as a Z-stack with `rows[0]` on top.
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
 * `data.count`, the single-open `expanded` flag, plus the callbacks (stable
 * via the parent's `useCallback`). `createdAt` is intentionally NOT compared:
 * it feeds only the leaf.
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
    prev.expanded === next.expanded &&
    prev.onToggleExpand === next.onToggleExpand &&
    prev.onOpen === next.onOpen &&
    prev.onDismiss === next.onDismiss &&
    prev.onPrefill === next.onPrefill
  );
}

export interface NotificationRowProps {
  notification: AgentNotification;
  /** Whether THIS row's option strip is open (single-open, parent-owned). */
  expanded: boolean;
  /** Toggle this row's strip; the parent collapses every other row. */
  onToggleExpand: (id: string) => void;
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
 * One liquid-glass notification card. Tap EXPANDS it into its contextual
 * options ({@link notificationRowOptions}) and collapses any sibling — the
 * option strip is single-open, owned by the parent; tap again collapses.
 * Long-press (touch) and right-click (mouse) also expand. Acting on any option
 * acknowledges the row (it clears from the shade). Dragging the row
 * horizontally off the screen — mouse or touch — past {@link SWIPE_DISMISS_PX}
 * dismisses it; there is no corner X. The card carries the shared glass
 * recipe; its options are bare action text with no fill or border.
 */
const NotificationRow = memo(function NotificationRow({
  notification,
  expanded,
  onToggleExpand,
  onOpen,
  onDismiss,
  onPrefill,
}: NotificationRowProps): React.JSX.Element {
  notificationRowRenderObserverForTests?.();

  // Swipe-to-dismiss state. `swipeX` drives the live drag transform; refs hold
  // the in-flight gesture so the memoized row never needs the parent to
  // re-render mid-drag.
  const [swipeX, setSwipeX] = useState(0);
  const [dismissing, setDismissing] = useState<"left" | "right" | null>(null);
  const gesture = useRef<{
    id: number;
    startX: number;
    startY: number;
    axis: "none" | "x" | "y";
    longPress: number | null;
    moved: boolean;
  } | null>(null);
  // Set true by a completed swipe / drag / long-press so the synthetic click
  // the same gesture emits doesn't also toggle the options.
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
      suppressClick.current = false;
      const longPress =
        e.pointerType !== "mouse"
          ? window.setTimeout(() => {
              suppressClick.current = true;
              onToggleExpand(notification.id);
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
    [notification.id, onToggleExpand],
  );

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const g = gesture.current;
    if (!g || g.id !== e.pointerId) return;
    const dx = e.clientX - g.startX;
    const dy = e.clientY - g.startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) g.moved = true;
    // Lock the axis on first real movement: a vertical drag belongs to the
    // list scroller (or the shade's pull gesture), only a horizontal one is a
    // dismiss swipe. Mouse and touch both swipe — the rows are buttons (no
    // text selection to hijack), and the 8px lock threshold keeps ordinary
    // clicks from starting a drag.
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
      // A committed drag on either axis never doubles as a tap: a horizontal
      // one is a swipe (may spring back), a vertical one belongs to the
      // scroller/pull gesture — neither may toggle the options on release.
      if (g.axis !== "none") suppressClick.current = true;
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

  // §C.3 count-aware coalescing: a superseding same-groupKey notification carries
  // data.count so the row reads "3 new files" via a small chip instead of the
  // inbox silently keeping only the last of the batch. Only surfaced for N > 1.
  const rawCount = notification.data?.count;
  const count = typeof rawCount === "number" && rawCount > 1 ? rawCount : null;
  // Lock-screen restraint: no per-row icon chip, no accent rail — a
  // notification is its glass card, line + time, like an iOS lock note.
  const dragging = swipeX !== 0 && !dismissing;
  const options = notificationRowOptions(notification);
  return (
    <li
      className="eliza-notif-row relative"
      data-notif-row
      onContextMenu={(e) => {
        e.preventDefault();
        onToggleExpand(notification.id);
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
          // The liquid-glass card surface (fill/sheen/edge live in the shared
          // .eliza-notif-glass recipe; hover is its neutral lighten).
          "eliza-notif-row-inner eliza-notif-glass group relative flex flex-col overflow-hidden rounded-2xl",
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
            // A swipe / drag / long-press synthesizes a click on release;
            // swallow it so the gesture doesn't also toggle the options.
            if (suppressClick.current) {
              suppressClick.current = false;
              e.preventDefault();
              return;
            }
            onToggleExpand(notification.id);
          }}
          className="flex min-h-touch min-w-0 flex-col gap-0.5 rounded-2xl px-3 py-2 text-left active:scale-[0.99] motion-reduce:active:scale-100"
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
          <fieldset
            aria-label="Notification actions"
            data-testid="notification-row-options"
            className="m-0 flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 border-0 px-3 pb-2.5 pt-0.5"
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
                  // Bare action text: no fill, no border, no pill — the label
                  // IS the affordance; hover only brightens the text.
                  "min-h-touch py-2 text-xs font-medium transition-colors",
                  option.kind === "dismiss"
                    ? "text-white/60 hover:text-white"
                    : "text-white/90 hover:text-white",
                )}
              >
                {option.label}
              </button>
            ))}
          </fieldset>
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
  // Shade mode: rested (priority triage, stacked groups) vs expanded (all
  // rows, flat). Toggled by the pull gesture — there are no more/less buttons.
  const [shadeExpanded, setShadeExpanded] = useState(false);
  // Single-open option strip: expanding one row collapses the others.
  const [expandedRowId, setExpandedRowId] = useState<string | null>(null);
  // Dampened live pull (px). State drives the rubber-band transform; the ref
  // mirrors it for the native touch listeners' commit path.
  const [pullPx, setPullPxState] = useState(0);
  const pullPxRef = useRef(0);
  // No list-level clock tick here (binding pattern, spec §C.4): relative
  // timestamps live in the `<RelativeTime>` leaf inside each row, which owns the
  // shared visibility-gated ticker. The minute roll re-renders those text nodes
  // only - not this list, not the rows, not the glass surface.
  const scrollRef = useRef<HTMLUListElement | null>(null);
  const pointerPull = useRef<{
    id: number;
    startX: number;
    startY: number;
    axis: "none" | "x" | "y";
  } | null>(null);
  const wheelPull = useRef(0);
  const wheelCooldownUntil = useRef(0);
  // Mirrors whether the shade currently has more to reveal (rested) — the
  // native touch listeners read it without re-binding on every data change.
  const canExpandRef = useRef(false);

  const setPullPx = useCallback((px: number) => {
    pullPxRef.current = px;
    setPullPxState(px);
  }, []);

  const toggleShade = useCallback(() => {
    setShadeExpanded((v) => !v);
    setExpandedRowId(null);
    // Both modes start reading from the top of the shade.
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, []);

  const commitPull = useCallback(() => {
    if (pullPxRef.current >= PULL_COMMIT_PX) toggleShade();
    setPullPx(0);
  }, [setPullPx, toggleShade]);

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

  // The pull gesture's TOUCH path binds native listeners: the list is a real
  // `touch-action: pan-y` scroller, so the browser claims a downward pan for
  // scrolling the moment it starts — a React (passive) touchmove can't take it
  // back. A non-passive touchmove that preventDefault()s only the at-top
  // downward overscroll is the one way to own the pull without breaking
  // ordinary scrolling (see reference: pan-y pull gestures are dead on arrival
  // without this). `hasNotifications` re-runs the bind when the inbox goes
  // empty↔populated — the empty inbox renders nothing, so on first arrival the
  // list element only exists after that re-render.
  const hasNotifications = notifications.length > 0;
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !hasNotifications) return;
    let start: { x: number; y: number } | null = null;
    const onTouchStart = (e: TouchEvent) => {
      const t = e.touches[0];
      start =
        e.touches.length === 1 && t ? { x: t.clientX, y: t.clientY } : null;
    };
    const onTouchMove = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!start || !t) return;
      const dx = t.clientX - start.x;
      const dy = t.clientY - start.y;
      // A horizontal gesture belongs to the row swipe; hand it off for good.
      if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > PULL_SLOP_PX) {
        start = null;
        return;
      }
      if (el.scrollTop <= 0 && dy > PULL_SLOP_PX && canExpandRef.current) {
        e.preventDefault();
        setPullPx(dampenPull(dy));
      }
    };
    const onTouchEnd = () => {
      start = null;
      commitPull();
    };
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd);
    el.addEventListener("touchcancel", onTouchEnd);
    return () => {
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("touchcancel", onTouchEnd);
    };
  }, [commitPull, setPullPx, hasNotifications]);

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
  const toggleRowExpand = useCallback((id: string) => {
    // Single-open: expanding a row collapses whichever other row was open.
    setExpandedRowId((current) => (current === id ? null : id));
  }, []);

  // An emptied-out inbox resets the shade so the next arrival starts rested.
  useEffect(() => {
    if (notifications.length === 0) {
      setShadeExpanded(false);
      setExpandedRowId(null);
    }
  }, [notifications.length]);

  // useCallback keeps the clock read inside a deferred (handler) context for
  // the UI-determinism gate — the wheel handler only ever runs on user input,
  // never during render — and gives the scroller a stable handler identity.
  // Hook placement: MUST stay above the empty-inbox early return below.
  const onListWheel = useCallback(
    (e: React.WheelEvent) => {
      const el = scrollRef.current;
      if (!el || !canExpandRef.current) return;
      const now = Date.now();
      if (now < wheelCooldownUntil.current) return;
      // Wheel-up while the list already sits at its top is the desktop pull.
      if (el.scrollTop > 0 || e.deltaY >= 0) {
        wheelPull.current = 0;
        return;
      }
      wheelPull.current += -e.deltaY;
      if (wheelPull.current >= PULL_COMMIT_PX) {
        wheelPull.current = 0;
        // Swallow trailing momentum so one flick doesn't double-toggle.
        wheelCooldownUntil.current = now + 500;
        toggleShade();
      }
    },
    [toggleShade],
  );

  if (notifications.length === 0) return null;

  // Cap rendered rows, filter to the rested (interrupt-tier) slice unless
  // expanded, then group by view: the cap keeps the always-cheap paint budget;
  // grouping happens on the shown slice so headers never count against rows.
  const capped = orderDashboardNotifications(notifications).slice(
    0,
    MAX_RENDERED_ROWS,
  );
  const shown = shadeExpanded ? capped : capped.filter(isInterruptPriority);
  const groups = groupDashboardNotifications(shown);
  // Rested, only each group's TOP card is fully visible (the rest peek from
  // the stack), so "more" counts everything the rest of the shade is hiding:
  // sub-interrupt rows plus the stacked-behind cards.
  const hiddenCount = shadeExpanded ? 0 : capped.length - groups.length;
  const canExpand = !shadeExpanded && hiddenCount > 0;
  canExpandRef.current = canExpand || shadeExpanded;

  const onListPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType !== "mouse" || !e.isPrimary) return;
    pointerPull.current = {
      id: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      axis: "none",
    };
  };
  const onListPointerMove = (e: React.PointerEvent) => {
    const g = pointerPull.current;
    const el = scrollRef.current;
    if (!g || g.id !== e.pointerId || !el) return;
    const dx = e.clientX - g.startX;
    const dy = e.clientY - g.startY;
    if (g.axis === "none" && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) {
      g.axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
    }
    if (g.axis !== "y") return;
    if (el.scrollTop <= 0 && dy > PULL_SLOP_PX && canExpandRef.current) {
      setPullPx(dampenPull(dy));
    } else if (pullPxRef.current !== 0) {
      setPullPx(0);
    }
  };
  const onListPointerEnd = (e: React.PointerEvent) => {
    const g = pointerPull.current;
    if (!g || g.id !== e.pointerId) return;
    pointerPull.current = null;
    commitPull();
  };
  return (
    <section
      aria-label="Notifications"
      data-testid="home-notification-center"
      // No card chrome on the CONTAINER: the inbox has no fill and no border of
      // its own — the glass lives on each notification card. It sits inline on
      // the home field directly under the time/weather header.
      // `eliza-notif-center-in` fades the whole inbox in (Apple-style) the
      // moment it first appears. `min-h-0 flex-1` lets it fill the home column
      // down to the chat when the parent grows it.
      className="eliza-notif-center-in flex min-h-0 flex-1 flex-col overflow-hidden"
    >
      <style>{NOTIF_SCROLL_CSS}</style>
      {/* No "Notifications" header, no sort toggle, no more/less buttons; the
          inbox is always priority-triaged, the view-group eyebrows carry the
          only structure, and the pull gesture owns expand/collapse. */}
      <ul
        ref={scrollRef}
        onScroll={syncEdgeFades}
        onPointerDown={onListPointerDown}
        onPointerMove={onListPointerMove}
        onPointerUp={onListPointerEnd}
        onPointerCancel={onListPointerEnd}
        onWheel={onListWheel}
        data-testid="home-notification-list"
        data-shade-mode={shadeExpanded ? "expanded" : "rested"}
        style={{
          // Rubber-band while pulling; springs back (or into the new mode)
          // on release. Transform-only, so the glass never repaints.
          transform: pullPx ? `translateY(${pullPx}px)` : undefined,
          transition: pullPx
            ? "none"
            : "transform 200ms cubic-bezier(0.22,1,0.36,1)",
        }}
        className={cn(
          "eliza-notif-scroll flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto overscroll-y-contain px-1.5 pb-1.5",
        )}
      >
        {groups.map((group) => {
          const stacked = !shadeExpanded && group.rows.length > 1;
          const peeks = stacked ? group.rows.slice(1, 1 + MAX_STACK_PEEKS) : [];
          const rows = stacked
            ? [group.rows[0] as AgentNotification]
            : group.rows;
          return (
            <li key={group.label} className="flex flex-col gap-1">
              {/* View group header (Apple-shade idiom: group by destination).
                  A quiet eyebrow, not a boxed section — restraint over chrome. */}
              <span
                data-testid="notification-group-label"
                className="px-2 pb-0.5 pt-2 text-2xs font-medium uppercase tracking-[0.08em] text-white/55 first:pt-1"
              >
                {group.label}
                {stacked ? (
                  <span
                    data-testid="notification-stack-count"
                    className="pl-1.5 normal-case tracking-normal text-white/40 tabular-nums"
                  >
                    {group.rows.length}
                  </span>
                ) : null}
              </span>
              {stacked ? (
                // The Z-stack: the group's highest-priority card on top, the
                // next cards peeking out beneath it — depth in Z, ordered by
                // the same priority→recency order the fanned list uses.
                <div
                  data-testid="notification-stack"
                  className="relative"
                  style={{
                    paddingBottom: peeks.length * STACK_PEEK_OFFSET_PX,
                  }}
                >
                  <ul className="relative z-[2] flex flex-col">
                    <NotificationRow
                      notification={rows[0] as AgentNotification}
                      expanded={expandedRowId === rows[0]?.id}
                      onToggleExpand={toggleRowExpand}
                      onOpen={openNotification}
                      onDismiss={dismissNotification}
                      onPrefill={prefillNotification}
                    />
                  </ul>
                  {peeks.map((peek, i) => (
                    <div
                      key={peek.id}
                      aria-hidden
                      data-testid="notification-stack-peek"
                      className="eliza-notif-glass pointer-events-none absolute inset-0 rounded-2xl"
                      style={{
                        zIndex: 1 - i,
                        opacity: 0.75 - i * 0.25,
                        transform: `translateY(${(i + 1) * STACK_PEEK_OFFSET_PX}px) scale(${
                          1 - (i + 1) * 0.045
                        })`,
                      }}
                    />
                  ))}
                </div>
              ) : (
                <ul className="flex flex-col gap-1">
                  {rows.map((notification) => (
                    <NotificationRow
                      key={notification.id}
                      notification={notification}
                      expanded={expandedRowId === notification.id}
                      onToggleExpand={toggleRowExpand}
                      onOpen={openNotification}
                      onDismiss={dismissNotification}
                      onPrefill={prefillNotification}
                    />
                  ))}
                </ul>
              )}
            </li>
          );
        })}
        {/* The rested shade names what it is hiding with a quiet hint — NOT a
            button; the pull gesture owns the transition. A visually-hidden
            toggle keeps the same transition reachable for keyboard/AT. */}
        {canExpand ? (
          <li
            aria-hidden
            data-testid="notifications-pull-hint"
            className="pointer-events-none flex items-center justify-center gap-1 px-3 py-2 text-2xs font-medium text-white/50"
          >
            <ChevronDown
              className={cn(
                "h-3 w-3 transition-transform",
                pullPx >= PULL_COMMIT_PX && "rotate-180",
              )}
            />
            {hiddenCount} more
          </li>
        ) : null}
        {canExpand || shadeExpanded ? (
          <li>
            <button
              type="button"
              data-testid="notifications-expand-toggle"
              className="sr-only"
              onClick={toggleShade}
            >
              {shadeExpanded
                ? "Show fewer notifications"
                : `Show ${hiddenCount} more notifications`}
            </button>
          </li>
        ) : null}
      </ul>
    </section>
  );
}
