/**
 * The app's notification inbox, mounted INLINE on the home column (HomeScreen)
 * directly beneath the time/weather header, the same layer as the widgets, in
 * the band between the header and the floating chat. It owns the inbox content
 * (rows, open/deep-link, per-row dismiss), stays visually quiet when empty, and
 * fades in Apple-style when the first notification arrives. Once hydration has
 * established that the inbox is empty, pulling its quiet gesture band reveals a
 * restrained "No Notifications" status instead of producing a blank shade. The
 * terminal load-failure state is a visible unavailable card with a manual retry,
 * so a broken persistence path never masquerades as loading or an empty inbox. The
 * inbox container has no
 * card chrome of its own; each notification is a liquid-glass card. Groups
 * carry NO headers or dividers — the physical gap between card clusters is the
 * only group structure (producer labels survive as grouping keys and
 * accessible names, never as rendered eyebrows).
 *
 * Two shade modes:
 *
 *  - RESTED is triage: interrupt-tier (`high`/`urgent`) producer stacks remain
 *    visible above the interactive total while quieter notifications stay folded
 *    behind the same producer's visible stack depth.
 *  - EXPANDED shows every priority and preserves each producer stack until the
 *    user fans that group out in place; the list is height-capped and scrolls
 *    internally.
 *
 * The transition is DIRECTIONAL, never a toggle: pulling DOWN (touch drag /
 * mouse drag / trackpad fingers-down wheel) while the list sits at its top only
 * EXPANDS the rested shade; pushing UP only COLLAPSES the expanded one. A
 * same-direction gesture in the state it already produced is a no-op — this is
 * what makes trackpad momentum safe (the old toggle re-fired on trailing
 * momentum deltas and snapped the shade shut moments after opening it). The
 * footer total (for example, "3 Notifications") opens the shade directly and
 * fades away during expansion, then returns during collapse. Pull/push gestures
 * provide the same directional transition from the surrounding surface.
 *
 * The pull/wheel gesture NEVER fans a stack, and a drag that starts on a stack
 * still belongs to the shade. Tapping a peek fans that producer group and
 * enters the expanded shade; folding the shade folds every fanned stack too.
 *
 * Acknowledgement follows the platform-shade model (iOS lock screen / Android
 * shade): tap opens a safe destination and clears the row; a row without a
 * destination simply clears. Horizontal drag (mouse or touch) dismisses; there
 * is no read/unread bookkeeping, no dots, no corner X. The sort order is a stable
 * priority-first total order, so live arrivals never reshuffle existing rows
 * under the user's finger; groups inherit the position of their highest-ranked
 * row.
 */
import type { AgentNotification } from "@elizaos/core";
import { ChevronDown, ChevronUp, RefreshCw } from "lucide-react";
import { motion } from "motion/react";
import {
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  getMomentumReleaseVelocity,
  getVelocityAwareSettleDuration,
  MOMENTUM_RELEASE_WINDOW_MS,
  type MomentumSample,
  shouldCommitMomentumDetent,
  useRafCoalescer,
} from "../../gestures";
import { cn } from "../../lib/utils";
import {
  isSafeDeepLink,
  navigateDeepLink,
} from "../../state/notifications/navigate-deep-link";
import {
  clearNotifications,
  removeNotification,
  removeNotifications,
  retryNotificationHydration,
  useNotifications,
} from "../../state/notifications/notification-store";
import {
  ClearConfirmationContent,
  groupDashboardNotifications,
  isInterruptPriority,
  NotificationRow,
  orderDashboardNotifications,
} from "./notification-shade-content";

export {
  __setNotificationRowRenderObserverForTests,
  groupDashboardNotifications,
  isInterruptPriority,
  type NotificationRowProps,
  notificationGroupKey,
  notificationGroupLabel,
  orderDashboardNotifications,
  rowPropsEqual,
} from "./notification-shade-content";

import {
  LIQUID_GLASS_BLUR,
  LIQUID_GLASS_EDGE_SHADOW,
  LIQUID_GLASS_REFRACTION,
  LIQUID_GLASS_SHEEN,
  LiquidGlassRefractionDefs,
  liquidGlassRimCss,
} from "./liquid-glass";
import {
  applyNotificationPullPresentation,
  dampenPull,
  notificationGroupContainerOffset,
  notificationGroupPullOffset,
  notificationGroupPullVisibility,
  notificationPullPresentation,
  notificationPullRevealProgress,
  notificationPullRevealStyle,
  PULL_COMMIT_PX,
  PULL_SLOP_PX,
  PULL_TRAVEL_PX,
  visibleNotificationGroups,
} from "./notification-shade-presentation";

export {
  dampenPull,
  notificationPullRevealProgress,
  PULL_COMMIT_PX,
} from "./notification-shade-presentation";

/**
 * Upper bound on rendered rows. The store caps the inbox at 300 but painting
 * hundreds of buttons on the always-mounted home hurts low-end mobile; 100
 * matches the HTTP hydrate limit, and dismiss/clear manage volume beyond it.
 */
const MAX_RENDERED_ROWS = 100;

/**
 * Only the first viewport's stacks participate in the live pull preview.
 * Mounting the full 100-row inbox on the first touchmove stalls the gesture on
 * mobile; the remaining stacks mount after the shade commits and are below the
 * fold.
 */
const MAX_PULL_PREVIEW_GROUPS = 6;

/** Empty feedback should latch after a normal short pull, not require a full shade drag. */
const EMPTY_PULL_COMMIT_PX = PULL_COMMIT_PX / 2;

/**
 * Bottom-edge capture for the iOS-style upward close gesture. Keeping this
 * narrow lets the rest of an overflowing list retain native vertical scroll.
 */
const SHADE_CLOSE_EDGE_PX = 40;

const INTERACTIVE_GESTURE_TARGET_SELECTOR =
  "button, a, input, textarea, select, [role='button'], [contenteditable='true']";

function isInteractiveGestureTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest(INTERACTIVE_GESTURE_TARGET_SELECTOR) !== null
  );
}

function touchWithIdentifier(
  touches: TouchList,
  identifier: number,
): Touch | undefined {
  for (let index = 0; index < touches.length; index += 1) {
    const touch = touches[index];
    if (touch?.identifier === identifier) return touch;
  }
  return undefined;
}

/**
 * Per-event cap (px) on a wheel delta's contribution toward the COLLAPSE
 * commit. Collapse shares its direction with ordinary downward scrolling, so
 * one aggressive flick at the top of an overflowing list must never commit on
 * its first event — with the cap, the commit needs at least two events with
 * the list still at its top, and the first real scroll resets the run.
 * Expansion has no such conflict (the list is already at its top) and stays
 * uncapped.
 */
const WHEEL_COLLAPSE_STEP_PX = PULL_COMMIT_PX / 2;

/** Ignore trackpad rebound while the committed shade settle is running. */
const WHEEL_COMMIT_LOCK_MS = 280;

/** iOS-style visual depth: one, two, or three cards, never more. */
const MAX_VISIBLE_STACK_LAYERS = 3;

/** Vertical offset (px) each successive peek card protrudes beneath the top. */
const STACK_PEEK_OFFSET_PX = 7;

/** Clear space after the final peek before the next notification group. */
const STACK_BOTTOM_CLEARANCE_PX = 10;

const CLEAR_CONFIRM_TIMEOUT_MS = 5_000;
const SHADE_SETTLE_MS = 340;
const SHADE_MIN_SETTLE_MS = 260;
const SHADE_MAX_SETTLE_MS = 440;
const SHADE_MIN_SETTLE_SPEED_PX_PER_MS = 0.22;
const SHADE_EASING = "cubic-bezier(0.25,0.1,0.25,1)";
const PULL_CANCEL_SETTLE_MS = SHADE_SETTLE_MS;
const SHADE_MIN_FLICK_DISTANCE_PX = 22;
const SHADE_FLICK_VELOCITY_PX_PER_MS = 0.45;
const SHADE_MIN_VELOCITY_SAMPLE_MS = 16;
// The count and clear slots trade the same 40px of list flow space. Their
// geometry must settle on one clock or a cancelled pull overshoots before the
// slower slot catches up, making the count reverse direction at the edge.
const NOTIFICATION_COUNT_RESTORE_MS = SHADE_SETTLE_MS;
const NOTIFICATION_ROW_SETTLE_MS = 220;
/** The stack fan has enough travel to read clearly without feeling delayed. */
export const STACK_FAN_SETTLE_MS = 300;
const STACK_FAN_LAYOUT_TRANSITION = {
  duration: STACK_FAN_SETTLE_MS / 1_000,
  ease: [0.25, 0.1, 0.25, 1],
} as const;
/**
 * A fold retains the fanned DOM until its rows have reached the stack. Sharing
 * this clock with the layout settle prevents sibling groups from snapping into
 * their new positions before the disappearing cards finish converging.
 */
export const STACK_FOLD_SETTLE_MS = 340;
const STACK_FOLD_COMPACTION_BUFFER_MS = 34;
const STACK_FOLD_LAYOUT_TRANSITION = {
  duration: STACK_FOLD_SETTLE_MS / 1_000,
  ease: [0.25, 0.1, 0.25, 1],
} as const;

interface PendingStackFold {
  timer: number;
  mayRestoreRestedShade: boolean;
  shadeCloseStarted: boolean;
}

/**
 * Scroll + glass polish for the shade, in one inline block (house pattern —
 * see HOME_ENTER_CSS in HomeScreen):
 *
 *  - `.eliza-notif-glass` is the liquid-glass card recipe every notification
 *    (and stack peek) carries: frosted translucent fill, the shared specular
 *    sheen + inset edge stack from ./liquid-glass, hover as a neutral lighten.
 *  - The shadcn `scroll-fade` utility derives top/bottom edge masks from the
 *    scroll timeline, so rows dissolve at clipped edges without a JS scroll
 *    listener mutating data attributes.
 *  - Where `animation-timeline: view()` is supported, each row also scales and
 *    fades slightly while crossing the scrollport edges — the depth cue of a
 *    platform notification shade. Progressive enhancement only; the fallback
 *    is the plain masked scroll.
 *  - Rows hidden by the closed shade track pull distance with opacity and
 *    vertical settling, so the user's finger reveals content before release.
 *
 * Reduced motion still tracks direct manipulation under the pointer, but
 * removes every automated settle and decorative transition.
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
.eliza-notif-glass {
  background-color: rgb(12 12 14 / 34%);
  background-image: ${LIQUID_GLASS_SHEEN};
  box-shadow: ${LIQUID_GLASS_EDGE_SHADOW};
  -webkit-backdrop-filter: ${LIQUID_GLASS_BLUR};
  backdrop-filter: ${LIQUID_GLASS_BLUR};
  transition: background-color 150ms linear;
}
/* Chromium honors url(#…) on backdrop-filter → refract the background at the
   rim (the "liquid" cue). WebKit can't, so it keeps the frosted blur above. */
@supports (backdrop-filter: url(#x)) or (-webkit-backdrop-filter: url(#x)) {
  .eliza-notif-glass {
    -webkit-backdrop-filter: ${LIQUID_GLASS_REFRACTION};
    backdrop-filter: ${LIQUID_GLASS_REFRACTION};
  }
}
/* A dense expanded inbox cannot afford one live backdrop-refraction graph per
   card. Keep the full material for the small rested triage; while previewing
   or expanded, the same sheen/rim sits on a solid fill so drag
   and scroll stay compositor-cheap even at the 100-row render cap. */
.eliza-notif-scroll[data-shade-preview] .eliza-notif-glass,
.eliza-notif-scroll[data-shade-mode="expanded"] .eliza-notif-glass {
  background-color: rgb(22 22 25);
  -webkit-backdrop-filter: none;
  backdrop-filter: none;
}
/* Backdrop refraction has to resample the fixed wallpaper while the complete
   home pane translates. Keep the same opaque material during a horizontal rail
   drag/settle, then restore refraction when the pager reaches rest. */
[data-rail-gesture-active] .eliza-notif-glass {
  background-color: rgb(22 22 25 / 88%);
  -webkit-backdrop-filter: none;
  backdrop-filter: none;
}
/* A collapsed stack is a set of physical cards, not translucent glass panes.
   Keep its front card and peeks solid through every shade/pager material
   override so the wallpaper and adjacent rows cannot show through. */
.eliza-notif-scroll [data-notification-stack-material] .eliza-notif-glass,
.eliza-notif-scroll [data-notification-stacked] .eliza-notif-glass,
.eliza-notif-scroll .eliza-notif-glass.eliza-notif-stack-peek {
  background-color: rgb(28 28 30);
  background-image: none;
  -webkit-backdrop-filter: none;
  backdrop-filter: none;
}
/* Directional specular rim tracing every rounded corner (mask-composite ring)
   — replaces the old one-sided inset hairline that read as a vertical line. */
${liquidGlassRimCss(".eliza-notif-glass")}
.eliza-notif-glass:hover {
  background-color: rgb(38 38 42 / 42%);
}
.eliza-notif-pull-reveal {
  transform-origin: top center;
}
.eliza-notif-shade-transition {
  transform-origin: top center;
  transition:
    grid-template-rows var(--eliza-notif-geometry-duration, var(--eliza-notif-settle-duration, ${SHADE_SETTLE_MS}ms)) ${SHADE_EASING},
    height var(--eliza-notif-geometry-duration, var(--eliza-notif-settle-duration, ${SHADE_SETTLE_MS}ms)) ${SHADE_EASING},
    margin-bottom var(--eliza-notif-geometry-duration, var(--eliza-notif-settle-duration, ${SHADE_SETTLE_MS}ms)) ${SHADE_EASING},
    padding-bottom var(--eliza-notif-geometry-duration, var(--eliza-notif-settle-duration, ${SHADE_SETTLE_MS}ms)) ${SHADE_EASING},
    row-gap var(--eliza-notif-geometry-duration, var(--eliza-notif-settle-duration, ${SHADE_SETTLE_MS}ms)) ${SHADE_EASING},
    opacity var(--eliza-notif-opacity-duration, var(--eliza-notif-settle-duration, ${SHADE_SETTLE_MS}ms)) ${SHADE_EASING} var(--eliza-notif-opacity-delay, 0ms),
    transform var(--eliza-notif-geometry-duration, var(--eliza-notif-settle-duration, ${SHADE_SETTLE_MS}ms)) ${SHADE_EASING};
}
/* Rows, peeks, controls, and the count badge share the stack's full settle so
   the physical layers crossfade while they converge instead of swapping near
   the endpoint. */
[data-notification-stack-fanned]:not([data-notification-stack-closing]) .eliza-notif-shade-transition {
  --eliza-notif-geometry-duration: ${STACK_FAN_SETTLE_MS}ms;
  transition-timing-function: ${SHADE_EASING};
}
[data-notification-stack-closing] .eliza-notif-shade-transition {
  --eliza-notif-geometry-duration: ${STACK_FOLD_SETTLE_MS}ms;
  transition-timing-function: ${SHADE_EASING};
}
[data-notification-stack-fanned]:not([data-notification-stack-closing]) :is([data-notification-stack-peek], [data-notification-source-count], [data-notification-stack-controls], [data-notification-disposable-row]) {
  --eliza-notif-opacity-duration: ${STACK_FAN_SETTLE_MS}ms;
  --eliza-notif-opacity-delay: 0ms;
}
[data-notification-stack-closing] :is([data-notification-stack-peek], [data-notification-source-count], [data-notification-stack-controls], [data-notification-disposable-row]) {
  --eliza-notif-opacity-duration: ${STACK_FOLD_SETTLE_MS}ms;
  --eliza-notif-opacity-delay: 0ms;
}
.eliza-notif-count-transition {
  transition:
    height var(--eliza-notif-settle-duration, ${NOTIFICATION_COUNT_RESTORE_MS}ms) ${SHADE_EASING},
    margin-bottom var(--eliza-notif-settle-duration, ${NOTIFICATION_COUNT_RESTORE_MS}ms) ${SHADE_EASING},
    opacity var(--eliza-notif-opacity-duration, var(--eliza-notif-settle-duration, ${NOTIFICATION_COUNT_RESTORE_MS}ms)) ${SHADE_EASING} var(--eliza-notif-opacity-delay, 0ms),
    transform var(--eliza-notif-settle-duration, ${NOTIFICATION_COUNT_RESTORE_MS}ms) ${SHADE_EASING};
}
.eliza-notif-scroll[data-shade-dragging] .eliza-notif-shade-transition,
.eliza-notif-scroll[data-shade-dragging] .eliza-notif-count-transition {
  transition: none;
}
.eliza-notif-scroll[data-shade-dragging] .eliza-notif-row,
.eliza-notif-scroll[data-shade-settling] .eliza-notif-row {
  animation: none !important;
}
.eliza-notif-scroll .eliza-notif-row.eliza-notif-pull-reveal,
.eliza-notif-scroll .eliza-notif-row.eliza-notif-shade-transition {
  animation: none;
}
.eliza-notif-scroll {
  isolation: isolate;
  scrollbar-width: none;
}
/* Count and card shells become independent compositor layers while they trade
   flow space. Keep cards above the count so its label fades behind their
   material instead of painting through it during either shade direction. */
.eliza-notif-scroll [data-notification-count-slot] {
  position: relative;
  z-index: 0;
}
.eliza-notif-scroll [data-notification-group] {
  position: relative;
  z-index: 1;
}
.eliza-notif-scroll::-webkit-scrollbar { display: none; }
@keyframes eliza-notif-fade-in {
  from { opacity: 0; }
  to   { opacity: 1; }
}
.eliza-notif-row-inner {
  transition:
    transform ${NOTIFICATION_ROW_SETTLE_MS}ms cubic-bezier(0.22,1,0.36,1),
    opacity ${NOTIFICATION_ROW_SETTLE_MS}ms linear;
}
.eliza-notif-row-inner[data-swipe-dragging] {
  transition: none;
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
  .eliza-notif-center,
  .eliza-notif-center *,
  .eliza-notif-center *::before,
  .eliza-notif-center *::after {
    animation: none !important;
    transition: none !important;
  }
}
`;

let notificationsHomeCenterRenderObserverForTests: (() => void) | null = null;

function usePrefersReducedMotion(): boolean {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(() => {
    if (
      typeof window === "undefined" ||
      typeof window.matchMedia !== "function"
    ) {
      return false;
    }
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  });

  useEffect(() => {
    if (
      typeof window === "undefined" ||
      typeof window.matchMedia !== "function"
    ) {
      return undefined;
    }

    const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setPrefersReducedMotion(mediaQuery.matches);
    update();

    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", update);
      return () => mediaQuery.removeEventListener("change", update);
    }

    mediaQuery.addListener(update);
    return () => mediaQuery.removeListener(update);
  }, []);

  return prefersReducedMotion;
}

export function __setNotificationsHomeCenterRenderObserverForTests(
  observer: (() => void) | null,
): void {
  notificationsHomeCenterRenderObserverForTests = observer;
}

/**
 * The notification inbox. Loading, hydrated-empty, and terminal-error states
 * remain visually distinct; the error state offers an explicit retry. Mounted
 * inline on the home column (HomeScreen), directly beneath the time/weather
 * header — the same layer as the widgets.
 */
export function NotificationsHomeCenter({
  emptyGestureTargetRef,
}: {
  /**
   * Larger background surface that may start the pull only while the inbox is
   * empty. Populated shades continue to own their list gestures directly.
   */
  emptyGestureTargetRef?: RefObject<HTMLElement | null>;
} = {}): React.JSX.Element | null {
  notificationsHomeCenterRenderObserverForTests?.();
  const { notifications, hydrated, hydrationStatus } = useNotifications();
  const reduceMotion = usePrefersReducedMotion();
  // Shade mode: rested (interrupt-tier triage) vs expanded (full inbox).
  // Producer groups stay stacked until individually fanned out.
  const [shadeExpanded, setShadeExpanded] = useState(false);
  const [shadeOpenProgress, setShadeOpenProgress] = useState(1);
  // Per-producer stack expansion (iOS-shade idiom). Tapping a peek fans that
  // stack and enters the expanded shade; folding the shade resets every stack.
  const [expandedStacks, setExpandedStacks] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [openingStacks, setOpeningStacks] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [closingStacks, setClosingStacks] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [stackPeekOpenOffsets, setStackPeekOpenOffsets] = useState<
    ReadonlyMap<string, readonly number[]>
  >(() => new Map());
  const stackGeometryRevision = useMemo(
    () =>
      notifications
        .map(
          (notification) =>
            `${notification.id}\u0000${notification.title}\u0000${notification.body ?? ""}`,
        )
        .join("\u0001"),
    [notifications],
  );
  const expandedStacksRef = useRef(expandedStacks);
  expandedStacksRef.current = expandedStacks;
  const [shadeOpenedByStack, setShadeOpenedByStack] = useState(false);
  const shadeOpenedByStackRef = useRef(shadeOpenedByStack);
  shadeOpenedByStackRef.current = shadeOpenedByStack;
  const [confirmingGroupKey, setConfirmingGroupKey] = useState<string | null>(
    null,
  );
  const [confirmingClearAll, setConfirmingClearAll] = useState(false);
  const [shadeClosing, setShadeClosing] = useState(false);
  const [pullCancellingDirection, setPullCancellingDirection] = useState<
    "expand" | "collapse" | null
  >(null);
  const shadeCloseTimer = useRef<number | null>(null);
  const pullCancelTimer = useRef<number | null>(null);
  const stackFoldTimers = useRef(new Map<string, PendingStackFold>());
  const centerRef = useRef<HTMLElement | null>(null);
  const pendingShadeFocusRef = useRef(false);
  const pendingStackFocusRef = useRef<string | null>(null);
  const pendingCollapsedStackFocusRef = useRef<string | null>(null);
  const pendingRestedCountFocusRef = useRef(false);
  const cancelPullCancellation = useCallback(() => {
    if (pullCancelTimer.current !== null) {
      window.clearTimeout(pullCancelTimer.current);
      pullCancelTimer.current = null;
    }
    setPullCancellingDirection(null);
  }, []);
  const cancelStackFold = useCallback((key: string) => {
    const pending = stackFoldTimers.current.get(key);
    if (pending) {
      window.clearTimeout(pending.timer);
      stackFoldTimers.current.delete(key);
    }
    setClosingStacks((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  }, []);
  const cancelAllStackFolds = useCallback(() => {
    for (const pending of stackFoldTimers.current.values()) {
      window.clearTimeout(pending.timer);
    }
    stackFoldTimers.current.clear();
    setClosingStacks((prev) => (prev.size === 0 ? prev : new Set()));
  }, []);
  const expandStack = useCallback(
    (key: string, moveFocus: boolean) => {
      if (shadeCloseTimer.current !== null) {
        // A newly fanned producer supersedes an auto-restore started by an
        // older fold. Reverse the shared shade settle and let the live stack
        // projection decide whether a later fold should restore rest.
        window.clearTimeout(shadeCloseTimer.current);
        shadeCloseTimer.current = null;
        setShadeClosing(false);
        for (const pending of stackFoldTimers.current.values()) {
          pending.shadeCloseStarted = false;
        }
      }
      cancelPullCancellation();
      cancelStackFold(key);
      centerRef.current?.style.setProperty(
        "--eliza-notif-settle-duration",
        `${STACK_FAN_SETTLE_MS}ms`,
      );
      if (moveFocus) pendingStackFocusRef.current = key;
      if (!shadeExpanded) {
        setShadeOpenedByStack(true);
        setShadeOpenProgress(reduceMotion ? 1 : 0);
      }
      if (!reduceMotion) {
        setOpeningStacks((prev) => {
          const next = new Set(prev);
          next.add(key);
          return next;
        });
      }
      setExpandedStacks((prev) => {
        if (prev.has(key)) return prev;
        const next = new Set(prev);
        next.add(key);
        return next;
      });
      setConfirmingGroupKey(null);
      setConfirmingClearAll(false);
      setShadeExpanded(true);
    },
    [cancelPullCancellation, cancelStackFold, reduceMotion, shadeExpanded],
  );
  const collapseStack = useCallback(
    (key: string, moveFocus = false) => {
      cancelPullCancellation();
      cancelStackFold(key);
      if (moveFocus) pendingCollapsedStackFocusRef.current = key;
      setOpeningStacks((prev) => {
        if (!prev.has(key)) return prev;
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
      setExpandedStacks((prev) => {
        if (!prev.has(key)) return prev;
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
      setConfirmingGroupKey((current) => (current === key ? null : current));
      setConfirmingClearAll(false);
    },
    [cancelPullCancellation, cancelStackFold],
  );

  useLayoutEffect(() => {
    const shouldOpenShade =
      shadeExpanded && shadeOpenProgress === 0 && !reduceMotion;
    const shouldFanStacks = openingStacks.size > 0 && !reduceMotion;
    if (!shouldOpenShade && !shouldFanStacks) return;

    // Snapshot the mounted origin once, then launch both targets on the next
    // frame. This preserves a real CSS transition without two idle frames or
    // two separate React commits when a stack also opens the shade.
    centerRef.current?.getBoundingClientRect();
    const targetFrame = window.requestAnimationFrame(() => {
      if (shouldOpenShade) setShadeOpenProgress(1);
      if (shouldFanStacks) setOpeningStacks(new Set());
    });
    return () => window.cancelAnimationFrame(targetFrame);
  }, [openingStacks, reduceMotion, shadeExpanded, shadeOpenProgress]);

  useLayoutEffect(() => {
    if (!reduceMotion) return;
    if (shadeOpenProgress !== 1) setShadeOpenProgress(1);
    if (openingStacks.size > 0) setOpeningStacks(new Set());
  }, [openingStacks.size, reduceMotion, shadeOpenProgress]);

  useLayoutEffect(() => {
    const center = centerRef.current;
    if (!center || expandedStacks.size === 0 || stackGeometryRevision === "") {
      return;
    }

    let disposed = false;
    let measureFrame: number | null = null;
    const stackRows = () =>
      center.querySelectorAll<HTMLElement>(
        "[data-notification-group-key][data-notification-stack-fanned] [data-notification-stack-rows]",
      );
    const measure = () => {
      measureFrame = null;
      if (disposed) return;
      const measured = new Map<string, readonly number[]>();
      for (const rowList of stackRows()) {
        const group = rowList.closest<HTMLElement>(
          "[data-notification-group-key]",
        );
        const key = group?.dataset.notificationGroupKey;
        if (!key) continue;
        const rows = Array.from(rowList.children).filter(
          (child): child is HTMLElement =>
            child instanceof HTMLElement &&
            child.hasAttribute("data-notif-row"),
        );
        if (rows.length < 2) continue;

        let offsetPx = 0;
        const offsets: number[] = [];
        for (
          let rowIndex = 0;
          rowIndex < Math.min(rows.length - 1, MAX_VISIBLE_STACK_LAYERS - 1);
          rowIndex += 1
        ) {
          const rowContent = rows[rowIndex]?.querySelector<HTMLElement>(
            '[data-testid="notification-row"]',
          );
          if (!rowContent) break;
          // The content button retains its natural size while the outer grid
          // row fans from 0fr. Measuring it avoids sampling an intermediate
          // transition height and keeps variable-height rows spatially exact.
          const renderedHeightPx = rowContent.getBoundingClientRect().height;
          const rowHeightPx =
            renderedHeightPx > 0 ? renderedHeightPx : rowContent.scrollHeight;
          if (rowHeightPx <= 0) break;
          offsetPx += rowHeightPx + 6;
          offsets.push(offsetPx);
        }
        if (offsets.length > 0) measured.set(key, offsets);
      }

      setStackPeekOpenOffsets((previous) => {
        let changed = previous.size !== measured.size;
        if (!changed) {
          for (const [key, offsets] of measured) {
            const prior = previous.get(key);
            if (
              prior?.length !== offsets.length ||
              offsets.some((offset, index) => prior[index] !== offset)
            ) {
              changed = true;
              break;
            }
          }
        }
        return changed ? measured : previous;
      });
    };
    const scheduleMeasure = () => {
      if (disposed) return;
      if (measureFrame !== null) window.cancelAnimationFrame(measureFrame);
      measureFrame = window.requestAnimationFrame(measure);
    };

    measure();
    const resizeObserver =
      typeof ResizeObserver === "function"
        ? new ResizeObserver(scheduleMeasure)
        : null;
    for (const rowList of stackRows()) {
      for (const row of Array.from(rowList.children)) {
        const rowContent = row.querySelector<HTMLElement>(
          '[data-testid="notification-row"]',
        );
        if (rowContent) resizeObserver?.observe(rowContent);
      }
    }
    window.addEventListener("resize", scheduleMeasure);
    void document.fonts?.ready.then(scheduleMeasure);
    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      window.removeEventListener("resize", scheduleMeasure);
      if (measureFrame !== null) window.cancelAnimationFrame(measureFrame);
    };
  }, [expandedStacks, stackGeometryRevision]);

  useLayoutEffect(() => {
    if (
      !pendingShadeFocusRef.current ||
      !shadeExpanded ||
      shadeOpenProgress !== 1
    ) {
      return;
    }
    const firstRow = centerRef.current?.querySelector<HTMLElement>(
      '[data-testid="notification-row"]',
    );
    if (!firstRow) return;
    pendingShadeFocusRef.current = false;
    firstRow.focus();
  }, [shadeExpanded, shadeOpenProgress]);

  useLayoutEffect(() => {
    const key = pendingStackFocusRef.current;
    if (!key || openingStacks.has(key) || !expandedStacks.has(key)) return;
    const group = Array.from(
      centerRef.current?.querySelectorAll<HTMLElement>(
        "[data-notification-group-key]",
      ) ?? [],
    ).find((candidate) => candidate.dataset.notificationGroupKey === key);
    const collapseControl = group?.querySelector<HTMLElement>(
      '[data-testid="notification-stack-collapse"]',
    );
    if (!collapseControl) return;
    pendingStackFocusRef.current = null;
    collapseControl.focus();
  }, [expandedStacks, openingStacks]);

  useLayoutEffect(() => {
    const key = pendingCollapsedStackFocusRef.current;
    if (!key || (expandedStacks.has(key) && !closingStacks.has(key))) {
      return;
    }
    const group = Array.from(
      centerRef.current?.querySelectorAll<HTMLElement>(
        "[data-notification-group-key]",
      ) ?? [],
    ).find((candidate) => candidate.dataset.notificationGroupKey === key);
    pendingCollapsedStackFocusRef.current = null;
    group
      ?.querySelector<HTMLElement>('[data-testid="notification-row"]')
      ?.focus();
  }, [closingStacks, expandedStacks]);

  useLayoutEffect(() => {
    if (
      !pendingRestedCountFocusRef.current ||
      (shadeExpanded && !shadeClosing)
    ) {
      return;
    }
    pendingRestedCountFocusRef.current = false;
    centerRef.current
      ?.querySelector<HTMLElement>('[data-testid="notifications-count-button"]')
      ?.focus();
  }, [shadeClosing, shadeExpanded]);
  // Dampened live pull (px), SIGNED: positive is a downward pull (expand),
  // negative an upward push (collapse). React mounts the preview once when a
  // gesture starts; pointer moves update existing styles directly so a
  // 100-notification inbox does not rebuild its React tree every frame.
  const [pullDirection, setPullDirection] = useState<
    "expand" | "collapse" | null
  >(null);
  const pullDirectionRef = useRef<"expand" | "collapse" | null>(null);
  const pullPxRef = useRef(0);
  const pullMomentumRef = useRef<{
    direction: "expand" | "collapse";
    startedAtMs: number;
    samples: MomentumSample[];
  } | null>(null);
  // No list-level clock tick here (binding pattern, spec §C.4): relative
  // timestamps live in the `<RelativeTime>` leaf inside each row, which owns the
  // shared visibility-gated ticker. The minute roll re-renders those text nodes
  // only - not this list, not the rows, not the glass surface.
  const scrollRef = useRef<HTMLUListElement | null>(null);
  const pullVisibleGroupsRef = useRef<HTMLElement[] | undefined>(undefined);
  const pointerPull = useRef<{
    id: number;
    startX: number;
    startY: number;
    axis: "none" | "x" | "y";
    // clientY at the moment the drag FIRST reaches the top (scrollTop<=0). The
    // pull is measured from here, not from the gesture start, so a drag that
    // first scrolled the list up to its top doesn't arrive already maxed.
    anchorY: number | null;
  } | null>(null);
  const emptyPointerPull = useRef<{
    id: number;
    startX: number;
    startY: number;
    axis: "none" | "x" | "y";
  } | null>(null);
  // A touch drag can end in `pointercancel` before the row sees enough pointer
  // movement to suppress the browser's synthetic click. The list owns the
  // vertical shade gesture, so it also blocks that one immediate follow-up
  // click; the next intentional tap remains available.
  const suppressNotificationClick = useRef(false);
  const suppressNotificationClickTimer = useRef<number | null>(null);
  // Wheel accumulation toward a shade commit: one direction at a time; a
  // direction flip abandons the previous run.
  const wheelPull = useRef<{ dir: 1 | -1; px: number }>({ dir: 1, px: 0 });
  const wheelCommitLockUntil = useRef(0);
  // Idle-decay timer: a wheel run accumulates toward the commit, but two
  // nudges seconds apart must not sum into a surprise transition — the
  // accumulator resets after a short quiet period.
  const wheelDecayTimer = useRef<number | null>(null);
  // Mirrors what the shade can currently do, read by the native touch
  // listeners and the wheel handler without re-binding on every data change.
  // The two are mutually exclusive (expand only from rested-with-hidden-rows,
  // collapse only from expanded), which is what makes the gestures directional
  // instead of a toggle.
  const shadeGestureRef = useRef({ canExpand: false, canCollapse: false });
  const shadePresentationRef = useRef({
    expanded: shadeExpanded,
    closing: shadeClosing,
  });
  shadePresentationRef.current = {
    expanded: shadeExpanded,
    closing: shadeClosing,
  };

  const applyPullPresentation = useCallback((px: number) => {
    applyNotificationPullPresentation(
      centerRef.current,
      px,
      shadePresentationRef.current.expanded,
      shadePresentationRef.current.closing,
      pullVisibleGroupsRef.current,
    );
  }, []);
  const {
    schedule: schedulePullPresentation,
    flush: flushScheduledPullPresentation,
    cancel: cancelScheduledPullPresentation,
  } = useRafCoalescer(applyPullPresentation);

  const setShadeSettleDuration = useCallback((durationMs: number) => {
    centerRef.current?.style.setProperty(
      "--eliza-notif-settle-duration",
      `${durationMs}ms`,
    );
  }, []);

  const flushPullPresentation = useCallback(() => {
    flushScheduledPullPresentation();
    centerRef.current?.getBoundingClientRect();
  }, [flushScheduledPullPresentation]);

  const armNotificationClickSuppression = useCallback(() => {
    suppressNotificationClick.current = true;
    if (suppressNotificationClickTimer.current !== null) {
      window.clearTimeout(suppressNotificationClickTimer.current);
    }
    suppressNotificationClickTimer.current = window.setTimeout(() => {
      suppressNotificationClick.current = false;
      suppressNotificationClickTimer.current = null;
    }, 500);
  }, []);

  const setPullPx = useCallback(
    (px: number, preserveDirectionAtZero = false) => {
      pullPxRef.current = px;
      const nextDirection =
        px > 0
          ? "expand"
          : px < 0
            ? "collapse"
            : preserveDirectionAtZero
              ? pullDirectionRef.current
              : null;
      const directionChanged = pullDirectionRef.current !== nextDirection;
      if (nextDirection) {
        const now = performance.now();
        let momentum = pullMomentumRef.current;
        if (!momentum || momentum.direction !== nextDirection) {
          momentum = {
            direction: nextDirection,
            startedAtMs: now,
            samples: [{ positionPx: 0, timeMs: now }],
          };
          pullMomentumRef.current = momentum;
        }
        momentum.samples.push({ positionPx: px, timeMs: now });
        const cutoff = now - MOMENTUM_RELEASE_WINDOW_MS;
        while (
          momentum.samples.length > 2 &&
          (momentum.samples[1]?.timeMs ?? now) < cutoff
        ) {
          momentum.samples.shift();
        }
      } else {
        pullMomentumRef.current = null;
      }
      if (directionChanged) {
        pullDirectionRef.current = nextDirection;
        pullVisibleGroupsRef.current = nextDirection
          ? visibleNotificationGroups(centerRef.current, scrollRef.current)
          : undefined;
        setPullDirection(nextDirection);
      }
      // The zero state is rendered declaratively after the dragging marker is
      // removed, allowing the release transition to run. Non-zero movement is
      // direct manipulation and must update in the current input event.
      if (!nextDirection) {
        cancelScheduledPullPresentation();
      } else if (directionChanged) {
        cancelScheduledPullPresentation();
        applyPullPresentation(px);
      } else {
        schedulePullPresentation(px);
      }
    },
    [
      applyPullPresentation,
      cancelScheduledPullPresentation,
      schedulePullPresentation,
    ],
  );

  const cancelClearConfirmation = useCallback(() => {
    setConfirmingClearAll(false);
    setConfirmingGroupKey(null);
  }, []);

  const beginPullCancellation = useCallback(
    (direction: "expand" | "collapse", settleMs: number) => {
      if (pullCancelTimer.current !== null) {
        window.clearTimeout(pullCancelTimer.current);
      }
      setShadeSettleDuration(settleMs);
      // The cancelling direction keeps the preview DOM mounted until every
      // surface reaches its zero-opacity/zero-layout endpoint. Removing it at
      // pointer-up would make quiet groups disappear while the count eases.
      setPullCancellingDirection(direction);
      pullCancelTimer.current = window.setTimeout(() => {
        pullCancelTimer.current = null;
        setPullCancellingDirection(null);
      }, settleMs + STACK_FOLD_COMPACTION_BUFFER_MS);
    },
    [setShadeSettleDuration],
  );

  const setShade = useCallback(
    (expanded: boolean) => {
      if (shadeCloseTimer.current) {
        window.clearTimeout(shadeCloseTimer.current);
        shadeCloseTimer.current = null;
      }
      cancelPullCancellation();
      setShadeClosing(false);
      setShadeExpanded(expanded);
      setConfirmingClearAll(false);
      setConfirmingGroupKey(null);
      setShadeOpenedByStack(false);
      if (expanded) {
        pendingRestedCountFocusRef.current = false;
      } else {
        cancelAllStackFolds();
        pendingShadeFocusRef.current = false;
        pendingStackFocusRef.current = null;
        // Folding the shade folds every fanned stack with it so the next open
        // starts from a predictable grouped inbox.
        setExpandedStacks(new Set());
        setOpeningStacks(new Set());
        setShadeOpenProgress(1);
      }
      // Collapse completion is deterministic even when a smooth scroll was
      // interrupted. Expansion resets after the expanded rows mount below.
      if (!expanded && scrollRef.current) scrollRef.current.scrollTop = 0;
    },
    [cancelAllStackFolds, cancelPullCancellation],
  );

  const beginProgrammaticShadeOpen = useCallback(() => {
    setShadeSettleDuration(SHADE_SETTLE_MS);
    if (reduceMotion) {
      setShadeOpenProgress(1);
    } else {
      setShadeOpenProgress(0);
    }
    setShade(true);
  }, [reduceMotion, setShade, setShadeSettleDuration]);

  const openShadeFromControl = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      pendingShadeFocusRef.current = event.detail === 0;
      beginProgrammaticShadeOpen();
    },
    [beginProgrammaticShadeOpen],
  );

  // Every expansion path must reveal the shade's first row and clear control.
  // Stack taps call expandStack directly (not setShade), and mounting their
  // hidden siblings can trigger browser scroll anchoring; reset after that DOM
  // commit, before paint, so the expanded shade always starts at its real top.
  useLayoutEffect(() => {
    if (shadeExpanded && scrollRef.current) {
      scrollRef.current.scrollTop = 0;
    }
  }, [shadeExpanded]);

  useLayoutEffect(() => {
    // Settled renders are fully declarative. Direct writes are reserved for an
    // active drag/close so they cannot overwrite click-entry interpolation.
    if (!pullDirection && !shadeClosing) return;
    if (pullDirection) {
      pullVisibleGroupsRef.current = visibleNotificationGroups(
        centerRef.current,
        scrollRef.current,
      );
    }
    applyNotificationPullPresentation(
      centerRef.current,
      pullPxRef.current,
      shadeExpanded,
      shadeClosing,
      pullVisibleGroupsRef.current,
    );
  });

  const requestShadeCollapse = useCallback(
    (settleMs = SHADE_SETTLE_MS) => {
      if (!shadeExpanded || shadeClosing) return;
      cancelPullCancellation();
      cancelClearConfirmation();
      const list = scrollRef.current;
      if (list && list.scrollTop > 0) {
        list.scrollTo?.({
          top: 0,
          behavior: reduceMotion ? "auto" : "smooth",
        });
      }
      wheelCommitLockUntil.current = Date.now() + WHEEL_COMMIT_LOCK_MS;
      // A release can arrive before the last coalesced pointer frame. Paint the
      // latest direct-manipulation value synchronously and flush its style so
      // the retained close transition always starts from what the finger did.
      if (pullPxRef.current !== 0) {
        flushPullPresentation();
      }
      // End direct manipulation before starting the close settle. Leaving a
      // non-zero pull marks the shade as dragging, which intentionally disables
      // child transitions and turns the committed close into a delayed snap.
      setPullPx(0);
      if (reduceMotion) {
        setShade(false);
        return;
      }
      // Fanned stacks own longer geometry than the ordinary shade. Retaining
      // their keyed rows through that endpoint prevents pointer-up from
      // compacting a still-visible stack into one card.
      const retainsFannedStacks = expandedStacksRef.current.size > 0;
      const retainedSettleMs = Math.max(
        settleMs,
        retainsFannedStacks ? STACK_FOLD_SETTLE_MS : 0,
      );
      setShadeSettleDuration(retainedSettleMs);
      setShadeClosing(true);
      shadeCloseTimer.current = window.setTimeout(
        () => {
          shadeCloseTimer.current = null;
          setShade(false);
        },
        retainedSettleMs +
          (retainsFannedStacks ? STACK_FOLD_COMPACTION_BUFFER_MS : 0),
      );
    },
    [
      cancelClearConfirmation,
      cancelPullCancellation,
      flushPullPresentation,
      reduceMotion,
      setPullPx,
      setShade,
      setShadeSettleDuration,
      shadeClosing,
      shadeExpanded,
    ],
  );

  useLayoutEffect(() => {
    if (reduceMotion && shadeClosing) setShade(false);
  }, [reduceMotion, setShade, shadeClosing]);

  const completeStackFold = useCallback(
    (key: string) => {
      const pending = stackFoldTimers.current.get(key);
      if (!pending) return;
      window.clearTimeout(pending.timer);
      stackFoldTimers.current.delete(key);
      // Another producer can fan while this stack is converging. Restore the
      // rested shade only when the live projection still makes this the final
      // expanded stack; the intent captured at click time is not authoritative.
      const restoresRestedShade =
        pending.mayRestoreRestedShade &&
        shadeOpenedByStackRef.current &&
        expandedStacksRef.current.size === 1 &&
        expandedStacksRef.current.has(key);
      collapseStack(key);
      if (restoresRestedShade && !pending.shadeCloseStarted) {
        requestShadeCollapse(STACK_FOLD_SETTLE_MS);
      }
    },
    [collapseStack, requestShadeCollapse],
  );

  const foldStack = useCallback(
    (key: string, moveFocus = false) => {
      if (!expandedStacks.has(key) || stackFoldTimers.current.has(key)) return;
      const restoresRestedShade =
        shadeOpenedByStack &&
        expandedStacks.size === 1 &&
        expandedStacks.has(key);
      if (reduceMotion) {
        collapseStack(key, moveFocus);
        if (restoresRestedShade) requestShadeCollapse();
        return;
      }

      cancelPullCancellation();
      if (moveFocus) pendingCollapsedStackFocusRef.current = key;
      setOpeningStacks((prev) => {
        if (!prev.has(key)) return prev;
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
      setClosingStacks((prev) => {
        const next = new Set(prev);
        next.add(key);
        return next;
      });
      setConfirmingGroupKey((current) => (current === key ? null : current));
      setConfirmingClearAll(false);
      // A stack that opened the shade also closes it, but both layers share
      // this fold clock. Sequencing the shade afterward creates a visible
      // second tail even when the stack itself has already reached rest.
      const pending: PendingStackFold = {
        timer: 0,
        mayRestoreRestedShade: shadeOpenedByStack,
        shadeCloseStarted: restoresRestedShade && !shadeClosing,
      };
      pending.timer = window.setTimeout(
        () => completeStackFold(key),
        STACK_FOLD_SETTLE_MS + STACK_FOLD_COMPACTION_BUFFER_MS,
      );
      stackFoldTimers.current.set(key, pending);
      if (pending.shadeCloseStarted) {
        requestShadeCollapse(STACK_FOLD_SETTLE_MS);
      }
    },
    [
      cancelPullCancellation,
      collapseStack,
      completeStackFold,
      expandedStacks,
      reduceMotion,
      requestShadeCollapse,
      shadeClosing,
      shadeOpenedByStack,
    ],
  );

  useLayoutEffect(() => {
    if (!reduceMotion || closingStacks.size === 0) return;
    for (const key of closingStacks) completeStackFold(key);
  }, [closingStacks, completeStackFold, reduceMotion]);

  const hasClearConfirmation =
    confirmingClearAll || confirmingGroupKey !== null;
  useEffect(() => {
    if (!hasClearConfirmation) return;
    const timeout = window.setTimeout(
      cancelClearConfirmation,
      CLEAR_CONFIRM_TIMEOUT_MS,
    );
    const cancelOnOutsidePress = (event: PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest('[data-confirming="true"]')
      ) {
        return;
      }
      cancelClearConfirmation();
    };
    document.addEventListener("pointerdown", cancelOnOutsidePress, true);
    return () => {
      window.clearTimeout(timeout);
      document.removeEventListener("pointerdown", cancelOnOutsidePress, true);
    };
  }, [cancelClearConfirmation, hasClearConfirmation]);

  useEffect(() => {
    if (!shadeExpanded) return;
    const collapseOnOutsideClick = (event: MouseEvent) => {
      const target = event.target;
      const center = centerRef.current;
      if (target instanceof Node && center && !center.contains(target)) {
        requestShadeCollapse();
      }
    };
    document.addEventListener("click", collapseOnOutsideClick, true);
    return () =>
      document.removeEventListener("click", collapseOnOutsideClick, true);
  }, [requestShadeCollapse, shadeExpanded]);

  const commitPull = useCallback(() => {
    const px = pullPxRef.current;
    const { canExpand, canCollapse } = shadeGestureRef.current;
    const commitPx =
      notifications.length === 0 ? EMPTY_PULL_COMMIT_PX : PULL_COMMIT_PX;
    const canMove = (px > 0 && canExpand) || (px < 0 && canCollapse);
    const now = performance.now();
    const momentum = pullMomentumRef.current;
    const sampleDurationMs = momentum ? now - momentum.startedAtMs : 0;
    const fallbackVelocity =
      momentum && sampleDurationMs >= SHADE_MIN_VELOCITY_SAMPLE_MS
        ? px / sampleDurationMs
        : 0;
    const releaseVelocity = momentum
      ? sampleDurationMs >= SHADE_MIN_VELOCITY_SAMPLE_MS
        ? getMomentumReleaseVelocity({
            samples: momentum.samples,
            endPositionPx: px,
            endTimeMs: now,
            fallbackVelocityPxPerMs: fallbackVelocity,
          })
        : 0
      : fallbackVelocity;
    const shouldCommit =
      canMove &&
      shouldCommitMomentumDetent({
        displacementPx: px,
        releaseVelocityPxPerMs: releaseVelocity,
        distanceThresholdPx: commitPx,
        minimumFlickDistancePx:
          notifications.length === 0
            ? EMPTY_PULL_COMMIT_PX / 2
            : SHADE_MIN_FLICK_DISTANCE_PX,
        flickVelocityThresholdPxPerMs: SHADE_FLICK_VELOCITY_PX_PER_MS,
      });
    const remainingDistancePx = shouldCommit
      ? Math.max(0, PULL_TRAVEL_PX - Math.abs(px))
      : Math.abs(px);
    const settleMs = getVelocityAwareSettleDuration({
      velocityPxPerMs: releaseVelocity,
      remainingDistancePx,
      fallbackDurationMs: PULL_CANCEL_SETTLE_MS,
      minimumDurationMs: SHADE_MIN_SETTLE_MS,
      maximumDurationMs: SHADE_MAX_SETTLE_MS,
      minimumSpeedPxPerMs: SHADE_MIN_SETTLE_SPEED_PX_PER_MS,
    });

    if (px !== 0) flushPullPresentation();
    setShadeSettleDuration(settleMs);
    // Directional: a downward pull only expands, an upward push only
    // collapses. A gesture in the direction of the current state is a no-op.
    if (shouldCommit && px > 0 && canExpand) setShade(true);
    else if (shouldCommit && px < 0 && canCollapse) {
      requestShadeCollapse(settleMs);
      return;
    } else if (px !== 0 && !reduceMotion && canMove) {
      beginPullCancellation(px > 0 ? "expand" : "collapse", settleMs);
    }
    setPullPx(0);
  }, [
    beginPullCancellation,
    flushPullPresentation,
    notifications.length,
    reduceMotion,
    requestShadeCollapse,
    setPullPx,
    setShade,
    setShadeSettleDuration,
  ]);

  // Shared wheel accumulator for both the list and, while empty, the wider
  // home background. Returns whether the shade consumed this delta so the
  // native background listener can suppress browser overscroll.
  const handleWheelDelta = useCallback(
    (deltaY: number, scrollTop: number): boolean => {
      const empty = notifications.length === 0;
      if (Date.now() < wheelCommitLockUntil.current) return true;
      // Away from the top the scroller owns every wheel event.
      if (scrollTop > 0) {
        wheelPull.current.px = 0;
        return false;
      }
      const { canExpand, canCollapse } = shadeGestureRef.current;
      const dir: 1 | -1 = deltaY < 0 ? 1 : -1;
      if (dir === 1 ? !canExpand : !canCollapse) {
        wheelPull.current.px = 0;
        return false;
      }
      if (wheelPull.current.dir !== dir) {
        wheelPull.current = { dir, px: 0 };
      }
      // Collapse shares its direction with ordinary downward scrolling, so a
      // single flick must never commit it on its first event (see
      // WHEEL_COLLAPSE_STEP_PX); the first real scroll resets the run above.
      wheelPull.current.px +=
        dir === 1 ? -deltaY : Math.min(deltaY, WHEEL_COLLAPSE_STEP_PX);
      // A wheel gesture has no end event: decay the accumulator after a short
      // quiet period so two separate nudges don't sum into a transition.
      if (wheelDecayTimer.current) window.clearTimeout(wheelDecayTimer.current);
      wheelDecayTimer.current = window.setTimeout(() => {
        wheelPull.current.px = 0;
      }, 220);
      const commitPx = empty ? EMPTY_PULL_COMMIT_PX : PULL_COMMIT_PX;
      if (wheelPull.current.px >= commitPx) {
        wheelPull.current.px = 0;
        if (wheelDecayTimer.current)
          window.clearTimeout(wheelDecayTimer.current);
        if (empty) {
          wheelCommitLockUntil.current = Date.now() + WHEEL_COMMIT_LOCK_MS;
        }
        if (dir === 1) beginProgrammaticShadeOpen();
        else requestShadeCollapse();
      }
      return true;
    },
    [beginProgrammaticShadeOpen, notifications.length, requestShadeCollapse],
  );

  const onListWheel = useCallback(
    (e: React.WheelEvent) => {
      const el = scrollRef.current;
      if (el) handleWheelDelta(e.deltaY, el.scrollTop);
    },
    [handleWheelDelta],
  );

  // The pull gesture's TOUCH path binds native listeners: the list is a real
  // `touch-action: pan-y` scroller, so the browser claims a downward pan for
  // scrolling the moment it starts — a React (passive) touchmove can't take it
  // back. A non-passive touchmove that preventDefault()s only the at-top
  // downward overscroll is the one way to own the pull without breaking
  // ordinary scrolling (see reference: pan-y pull gestures are dead on arrival
  // without this). `surfaceReady` re-runs the bind when hydration establishes a
  // genuinely empty inbox or when a notification arrives before hydration.
  const hasNotifications = notifications.length > 0;
  const surfaceReady = hydrated || hasNotifications;
  useEffect(() => {
    const list = scrollRef.current;
    if (!list || !surfaceReady) return;
    const gestureTarget =
      !hasNotifications && emptyGestureTargetRef?.current
        ? emptyGestureTargetRef.current
        : list;
    const usesEmptyBackground = gestureTarget !== list;
    let start: { identifier: number; x: number; y: number } | null = null;
    // clientY where the drag first reached the top; the pull is measured from
    // here so a continuous drag that scrolled the list up to its top doesn't
    // jump the shade by the pre-top travel and instantly commit.
    let expandAnchorY: number | null = null;
    let collapseAnchorY: number | null = null;
    let closeFromBottomEdge = false;
    const resetTouchState = () => {
      start = null;
      expandAnchorY = null;
      collapseAnchorY = null;
      closeFromBottomEdge = false;
    };
    const abortTouchPull = () => {
      resetTouchState();
      setPullPx(0);
    };
    const onTouchStart = (e: TouchEvent) => {
      const t = e.touches[0];
      const target = e.target;
      if (
        e.touches.length !== 1 ||
        !t ||
        (usesEmptyBackground && isInteractiveGestureTarget(target))
      ) {
        abortTouchPull();
        return;
      }
      start = {
        identifier: t.identifier,
        x: t.clientX,
        y: t.clientY,
      };
      // Already at the top → anchor at the touch start so the whole drag counts
      // as pull. Started scrolled down → leave null; the move handler anchors at
      // the instant scrollTop first reaches 0 (the top crossing).
      expandAnchorY = start && gestureTarget.scrollTop <= 0 ? start.y : null;

      const maxScrollTop = Math.max(
        0,
        gestureTarget.scrollHeight - gestureTarget.clientHeight,
      );
      const atBottom = gestureTarget.scrollTop >= maxScrollTop - 1;
      const viewportBottom =
        window.visualViewport?.height ?? window.innerHeight;
      const visibleBottom = Math.min(
        gestureTarget.getBoundingClientRect().bottom,
        viewportBottom,
      );
      closeFromBottomEdge = Boolean(
        start &&
          shadeGestureRef.current.canCollapse &&
          start.y >= visibleBottom - SHADE_CLOSE_EDGE_PX,
      );
      collapseAnchorY =
        start &&
        shadeGestureRef.current.canCollapse &&
        (usesEmptyBackground ||
          closeFromBottomEdge ||
          maxScrollTop <= 1 ||
          atBottom)
          ? start.y
          : null;
    };
    const updateTouchPosition = (t: Touch, event?: TouchEvent) => {
      if (!start || !t) return;
      const dx = t.clientX - start.x;
      const dy = t.clientY - start.y;
      // A horizontal gesture belongs to the row swipe; hand it off for good.
      if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > PULL_SLOP_PX) {
        abortTouchPull();
        return;
      }
      if (Math.abs(dy) > PULL_SLOP_PX && Math.abs(dy) >= Math.abs(dx)) {
        armNotificationClickSuppression();
      }
      if (closeFromBottomEdge && dy < 0 && Math.abs(dy) >= Math.abs(dx)) {
        // Claim the bottom-edge close from its first vertical pixel so the
        // native scroller never moves underneath the gesture before the slop
        // threshold is crossed.
        event?.preventDefault();
      }
      const { canExpand, canCollapse } = shadeGestureRef.current;
      if (dy < -PULL_SLOP_PX) {
        // A narrow bottom-edge push closes directly. Everywhere else, the
        // pan-y scroller owns upward travel while content remains below; once
        // it reaches the list end, additional travel becomes an
        // overscroll-to-close. Rebase there so scroll travel never counts
        // toward the close threshold.
        const maxScrollTop = Math.max(
          0,
          gestureTarget.scrollHeight - gestureTarget.clientHeight,
        );
        const atBottom = gestureTarget.scrollTop >= maxScrollTop - 1;
        if (
          canCollapse &&
          (usesEmptyBackground ||
            closeFromBottomEdge ||
            maxScrollTop <= 1 ||
            atBottom)
        ) {
          if (collapseAnchorY === null) collapseAnchorY = t.clientY;
          const push = collapseAnchorY - t.clientY;
          if (push > PULL_SLOP_PX) {
            event?.preventDefault();
            setPullPx(-dampenPull(push));
          } else if (pullPxRef.current !== 0) {
            setPullPx(0, true);
          }
        } else {
          collapseAnchorY = null;
          if (pullPxRef.current !== 0) setPullPx(0, true);
        }
        return;
      }
      if (gestureTarget.scrollTop <= 0 && canExpand) {
        if (expandAnchorY === null) expandAnchorY = t.clientY;
        const pull = t.clientY - expandAnchorY;
        if (pull > PULL_SLOP_PX) {
          event?.preventDefault();
          setPullPx(dampenPull(pull));
        } else if (pullPxRef.current !== 0) {
          // Finger reversed back above the anchor — the pull is withdrawn, so
          // the release must not commit from the stale peak (parity with the
          // pointer path).
          setPullPx(0, true);
        }
      } else if (expandAnchorY !== null) {
        // Scrolled back down into content — abandon the pull and re-anchor.
        expandAnchorY = null;
        if (pullPxRef.current !== 0) setPullPx(0, true);
      }
    };
    const onTouchMove = (event: TouchEvent) => {
      if (!start) return;
      if (event.touches.length !== 1) {
        abortTouchPull();
        return;
      }
      const touch = touchWithIdentifier(event.touches, start.identifier);
      if (touch) updateTouchPosition(touch, event);
      else abortTouchPull();
    };
    const onTouchEnd = (event: TouchEvent) => {
      if (!start) return;
      const finalTouch = touchWithIdentifier(
        event.changedTouches,
        start.identifier,
      );
      if (!finalTouch && event.changedTouches.length > 0) {
        abortTouchPull();
        return;
      }
      if (finalTouch) updateTouchPosition(finalTouch);
      resetTouchState();
      commitPull();
    };
    const onTouchCancel = () => {
      // An OS-cancelled gesture (incoming call, edge-gesture takeover, palm
      // rejection) ABORTS: snap back to rest, never change the shade from a
      // gesture the user never completed.
      abortTouchPull();
    };
    const onEmptyBackgroundWheel = (e: WheelEvent) => {
      const target = e.target;
      // The list's React handler owns wheel input inside the narrow inline
      // surface. The home listener only fills the otherwise dead background.
      if (
        !usesEmptyBackground ||
        isInteractiveGestureTarget(target) ||
        (target instanceof Node && list.contains(target))
      ) {
        return;
      }
      if (handleWheelDelta(e.deltaY, gestureTarget.scrollTop)) {
        e.preventDefault();
      }
    };
    gestureTarget.addEventListener("touchstart", onTouchStart, {
      passive: true,
    });
    gestureTarget.addEventListener("touchmove", onTouchMove, {
      passive: false,
    });
    gestureTarget.addEventListener("touchend", onTouchEnd);
    gestureTarget.addEventListener("touchcancel", onTouchCancel);
    if (usesEmptyBackground) {
      gestureTarget.addEventListener("wheel", onEmptyBackgroundWheel, {
        passive: false,
      });
    }
    return () => {
      gestureTarget.removeEventListener("touchstart", onTouchStart);
      gestureTarget.removeEventListener("touchmove", onTouchMove);
      gestureTarget.removeEventListener("touchend", onTouchEnd);
      gestureTarget.removeEventListener("touchcancel", onTouchCancel);
      gestureTarget.removeEventListener("wheel", onEmptyBackgroundWheel);
    };
  }, [
    armNotificationClickSuppression,
    commitPull,
    emptyGestureTargetRef,
    handleWheelDelta,
    hasNotifications,
    setPullPx,
    surfaceReady,
  ]);

  // A populated shade can also be pulled open from non-interactive home space
  // (clock/weather chrome or an empty widget-grid lane). Events originating in
  // the notification list stay with its scroll/gesture handler above, and taps
  // never touch notification state.
  useEffect(() => {
    const surface = emptyGestureTargetRef?.current;
    const list = scrollRef.current;
    if (!hasNotifications || !surface || !list || surface === list) return;
    let start: { identifier: number; x: number; y: number } | null = null;
    let axis: "none" | "x" | "y" = "none";
    let ownsPull = false;

    const reset = () => {
      start = null;
      axis = "none";
      ownsPull = false;
    };
    const abort = () => {
      reset();
      setPullPx(0);
    };
    const onTouchStart = (event: TouchEvent) => {
      const touch = event.touches[0];
      const target = event.target;
      if (
        event.touches.length !== 1 ||
        !touch ||
        isInteractiveGestureTarget(target) ||
        (target instanceof Node && list.contains(target))
      ) {
        abort();
        return;
      }
      reset();
      start = {
        identifier: touch.identifier,
        x: touch.clientX,
        y: touch.clientY,
      };
    };
    const updateTouchPosition = (touch: Touch, event?: TouchEvent) => {
      if (!start || !touch) return;
      const dx = touch.clientX - start.x;
      const dy = touch.clientY - start.y;
      if (
        axis === "none" &&
        (Math.abs(dx) > PULL_SLOP_PX || Math.abs(dy) > PULL_SLOP_PX)
      ) {
        axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
      }
      if (axis === "x") {
        if (ownsPull) setPullPx(0);
        reset();
        return;
      }
      if (
        axis === "y" &&
        dy > PULL_SLOP_PX &&
        surface.scrollTop <= 0 &&
        shadeGestureRef.current.canExpand
      ) {
        ownsPull = true;
        event?.preventDefault();
        setPullPx(dampenPull(dy));
      } else if (ownsPull && pullPxRef.current !== 0) {
        setPullPx(0, true);
      }
    };
    const onTouchMove = (event: TouchEvent) => {
      if (!start) return;
      if (event.touches.length !== 1) {
        abort();
        return;
      }
      const touch = touchWithIdentifier(event.touches, start.identifier);
      if (touch) updateTouchPosition(touch, event);
      else abort();
    };
    const onTouchEnd = (event: TouchEvent) => {
      if (!start) return;
      const finalTouch = touchWithIdentifier(
        event.changedTouches,
        start.identifier,
      );
      if (!finalTouch && event.changedTouches.length > 0) {
        abort();
        return;
      }
      if (finalTouch) updateTouchPosition(finalTouch);
      const shouldCommit = ownsPull;
      reset();
      if (shouldCommit) commitPull();
    };
    const onTouchCancel = () => {
      abort();
    };
    const onWheel = (event: WheelEvent) => {
      const target = event.target;
      if (
        event.deltaY >= 0 ||
        isInteractiveGestureTarget(target) ||
        (target instanceof Node && list.contains(target))
      ) {
        return;
      }
      if (handleWheelDelta(event.deltaY, surface.scrollTop)) {
        event.preventDefault();
      }
    };

    surface.addEventListener("touchstart", onTouchStart, { passive: true });
    surface.addEventListener("touchmove", onTouchMove, { passive: false });
    surface.addEventListener("touchend", onTouchEnd);
    surface.addEventListener("touchcancel", onTouchCancel);
    surface.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      surface.removeEventListener("touchstart", onTouchStart);
      surface.removeEventListener("touchmove", onTouchMove);
      surface.removeEventListener("touchend", onTouchEnd);
      surface.removeEventListener("touchcancel", onTouchCancel);
      surface.removeEventListener("wheel", onWheel);
    };
  }, [
    commitPull,
    emptyGestureTargetRef,
    handleWheelDelta,
    hasNotifications,
    setPullPx,
  ]);

  // The unused center space beneath a short inbox and the clear band around it
  // are also close gesture lanes. They live outside the scrollport, so an
  // upward swipe can fold an expanded shade without first finding the final
  // notification row.
  useEffect(() => {
    const surface = emptyGestureTargetRef?.current;
    const center = centerRef.current;
    const list = scrollRef.current;
    if (!shadeExpanded || shadeClosing || !surface || !center || !list) return;
    let start: { identifier: number; x: number; y: number } | null = null;

    const abort = () => {
      start = null;
      setPullPx(0);
    };

    const onTouchStart = (event: TouchEvent) => {
      const touch = event.touches[0];
      const target = event.target;
      if (
        event.touches.length !== 1 ||
        !touch ||
        !shadeGestureRef.current.canCollapse ||
        !(target instanceof Node) ||
        list.contains(target) ||
        isInteractiveGestureTarget(target)
      ) {
        abort();
        return;
      }
      start = {
        identifier: touch.identifier,
        x: touch.clientX,
        y: touch.clientY,
      };
    };
    const updateTouchPosition = (touch: Touch, event?: TouchEvent) => {
      if (!start || !touch) return;
      if (!shadeGestureRef.current.canCollapse) {
        start = null;
        if (pullPxRef.current !== 0) setPullPx(0);
        return;
      }
      const dx = touch.clientX - start.x;
      const dy = touch.clientY - start.y;
      if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > PULL_SLOP_PX) {
        start = null;
        setPullPx(0);
        return;
      }
      if (dy < 0 && Math.abs(dy) >= Math.abs(dx)) event?.preventDefault();
      if (dy < -PULL_SLOP_PX) {
        setPullPx(-dampenPull(-dy));
      } else if (pullPxRef.current !== 0) {
        setPullPx(0, true);
      }
    };
    const onTouchMove = (event: TouchEvent) => {
      if (!start) return;
      if (event.touches.length !== 1) {
        abort();
        return;
      }
      const touch = touchWithIdentifier(event.touches, start.identifier);
      if (touch) updateTouchPosition(touch, event);
      else abort();
    };
    const onTouchEnd = (event: TouchEvent) => {
      if (!start) return;
      const finalTouch = touchWithIdentifier(
        event.changedTouches,
        start.identifier,
      );
      if (!finalTouch && event.changedTouches.length > 0) {
        abort();
        return;
      }
      if (finalTouch) updateTouchPosition(finalTouch);
      start = null;
      commitPull();
    };
    const onTouchCancel = () => {
      abort();
    };

    surface.addEventListener("touchstart", onTouchStart, { passive: true });
    surface.addEventListener("touchmove", onTouchMove, { passive: false });
    surface.addEventListener("touchend", onTouchEnd);
    surface.addEventListener("touchcancel", onTouchCancel);
    return () => {
      surface.removeEventListener("touchstart", onTouchStart);
      surface.removeEventListener("touchmove", onTouchMove);
      surface.removeEventListener("touchend", onTouchEnd);
      surface.removeEventListener("touchcancel", onTouchCancel);
    };
  }, [
    commitPull,
    emptyGestureTargetRef,
    setPullPx,
    shadeClosing,
    shadeExpanded,
  ]);

  // Clear timers that may outlive a single gesture.
  useEffect(
    () => () => {
      if (wheelDecayTimer.current) window.clearTimeout(wheelDecayTimer.current);
      if (shadeCloseTimer.current) window.clearTimeout(shadeCloseTimer.current);
      if (pullCancelTimer.current !== null) {
        window.clearTimeout(pullCancelTimer.current);
      }
      for (const pending of stackFoldTimers.current.values()) {
        window.clearTimeout(pending.timer);
      }
      stackFoldTimers.current.clear();
      if (suppressNotificationClickTimer.current !== null) {
        window.clearTimeout(suppressNotificationClickTimer.current);
      }
    },
    [],
  );

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
  const clearProducer = useCallback(
    (key: string, ids: readonly string[]) => {
      if (confirmingGroupKey !== key) {
        setConfirmingClearAll(false);
        setConfirmingGroupKey(key);
        return;
      }
      setConfirmingGroupKey(null);
      foldStack(key);
      void removeNotifications(ids);
    },
    [confirmingGroupKey, foldStack],
  );
  const clearAll = useCallback(() => {
    if (!confirmingClearAll) {
      setConfirmingGroupKey(null);
      setConfirmingClearAll(true);
      return;
    }
    setConfirmingClearAll(false);
    setConfirmingGroupKey(null);
    cancelAllStackFolds();
    setOpeningStacks(new Set());
    setExpandedStacks(new Set());
    void clearNotifications();
  }, [cancelAllStackFolds, confirmingClearAll]);

  // An emptied-out inbox resets the shade so the next arrival starts rested.
  // `pullPx` is cleared too: if the inbox empties mid-pull the touch effect
  // unbinds before touchend, so a stale translateY would otherwise ride into
  // the next arrival's first paint.
  useEffect(() => {
    if (notifications.length === 0) {
      cancelAllStackFolds();
      setShadeExpanded(false);
      setShadeOpenedByStack(false);
      setOpeningStacks(new Set());
      setExpandedStacks(new Set());
      setConfirmingGroupKey(null);
      setConfirmingClearAll(false);
      cancelPullCancellation();
      setPullPx(0);
    }
  }, [
    cancelAllStackFolds,
    cancelPullCancellation,
    notifications.length,
    setPullPx,
  ]);

  // Build stable rested and expanded projections. During a downward pull,
  // lower-priority groups reveal under the finger while already-visible
  // interrupt groups retain their keys and positions.
  const {
    allGroupRowsByKey,
    expandedGroups,
    previewGroups,
    restedGroupKeys,
    restedGroups,
  } = useMemo(() => {
    const capped = orderDashboardNotifications(notifications).slice(
      0,
      MAX_RENDERED_ROWS,
    );
    const expanded = groupDashboardNotifications(capped);
    const rested = expanded.flatMap((group) => {
      const rows = group.rows.filter(isInterruptPriority);
      return rows.length > 0 ? [{ ...group, rows }] : [];
    });
    const restedByKey = new Map(rested.map((group) => [group.key, group]));
    let previewExpansionCount = 0;
    const preview = expanded.flatMap((group) => {
      const restedGroup = restedByKey.get(group.key);
      const revealsHiddenRows =
        !restedGroup || group.rows.length > restedGroup.rows.length;
      if (!revealsHiddenRows) return [group];
      if (previewExpansionCount < MAX_PULL_PREVIEW_GROUPS) {
        previewExpansionCount += 1;
        return [group];
      }
      return restedGroup ? [restedGroup] : [];
    });
    return {
      allGroupRowsByKey: new Map(
        groupDashboardNotifications(notifications).map((group) => [
          group.key,
          group.rows,
        ]),
      ),
      expandedGroups: expanded,
      previewGroups: preview,
      restedGroupKeys: new Set(rested.map((group) => group.key)),
      restedGroups: rested,
    };
  }, [notifications]);

  // Do not flash an empty result while the initial request is still in flight.
  // Once hydrated, keep the transparent pull target mounted so an empty shade
  // can communicate its state instead of ignoring the gesture.
  if (hydrationStatus === "failed") {
    return (
      <section
        aria-label="Notifications"
        data-testid="home-notification-center"
        className="eliza-notif-center relative flex min-h-20 flex-none items-center px-1.5 py-1 text-white"
      >
        <style>{NOTIF_SCROLL_CSS}</style>
        <LiquidGlassRefractionDefs />
        <div
          role="alert"
          data-testid="notifications-unavailable"
          className="eliza-notif-glass flex w-full items-center justify-between gap-3 rounded-2xl border border-orange-500/30 px-4 py-3"
        >
          <div className="min-w-0">
            <p className="text-sm font-semibold text-white">
              Notifications unavailable
            </p>
            <p className="mt-0.5 text-xs leading-snug text-white/60">
              Your notification history could not be loaded. New alerts may
              still arrive.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void retryNotificationHydration()}
            className="flex h-11 shrink-0 items-center gap-1.5 rounded-xl bg-orange-500 px-3 text-xs font-semibold text-black transition-colors hover:bg-orange-600"
          >
            <RefreshCw aria-hidden className="h-3.5 w-3.5" />
            Retry
          </button>
        </div>
      </section>
    );
  }
  if (!surfaceReady) return null;

  const pullPx = pullPxRef.current;
  const isPulling = pullDirection !== null;
  const canExpand = !shadeExpanded;
  const canCollapse = shadeExpanded && !shadeClosing;
  const previewingExpansion =
    canExpand &&
    (pullDirection === "expand" || pullCancellingDirection === "expand");
  const groups = shadeExpanded
    ? expandedGroups
    : previewingExpansion
      ? previewGroups
      : restedGroups;
  shadeGestureRef.current = { canExpand, canCollapse };
  const {
    shadeCloseProgress,
    committedCloseProgress,
    disposableContentVisibility,
    pullContentVisibility,
    notificationCountVisibility,
    notificationCountOffset,
    notificationCountLayoutVisibility,
    emptyStateVisibility,
    collapseControlVisibility,
    clearControlVisibility,
    clearControlLayoutVisibility,
  } = notificationPullPresentation(pullPx, shadeExpanded, shadeClosing);
  const disposableLayoutVisibility = 1 - committedCloseProgress;
  const stackLayoutTransition =
    expandedStacks.size > 0 && closingStacks.size === 0
      ? STACK_FAN_LAYOUT_TRANSITION
      : STACK_FOLD_LAYOUT_TRANSITION;
  const collapseControlPresentationVisibility =
    collapseControlVisibility * shadeOpenProgress;
  const showCollapseControl =
    (shadeExpanded || previewingExpansion) &&
    hasNotifications &&
    expandedStacks.size === 0 &&
    !shadeOpenedByStack;
  const abortPointerPull = () => {
    const px = pullPxRef.current;
    if (px !== 0) {
      flushPullPresentation();
      if (!reduceMotion) {
        beginPullCancellation(
          px > 0 ? "expand" : "collapse",
          PULL_CANCEL_SETTLE_MS,
        );
      }
    }
    setPullPx(0);
  };
  const onListPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType !== "mouse" || !e.isPrimary) return;
    const el = scrollRef.current;
    pointerPull.current = {
      id: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      axis: "none",
      // At-top → anchor at the press (whole drag is pull); scrolled down →
      // anchor at the top crossing in the move handler.
      anchorY: el && el.scrollTop <= 0 ? e.clientY : null,
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
      // Capture on the vertical lock so a release outside the (narrow,
      // centered) list still fires onListPointerEnd — otherwise pullPx freezes
      // and the shade sticks translated down.
      if (g.axis === "y") {
        armNotificationClickSuppression();
        e.currentTarget.setPointerCapture?.(e.pointerId);
      }
    }
    if (g.axis !== "y") return;
    const { canExpand: mayExpand, canCollapse } = shadeGestureRef.current;
    if (dy < 0) {
      // Upward drag: the collapse gesture. A mouse drag never scrolls the
      // list, so it is measured from the gesture start — no top-crossing to
      // re-anchor at, and no scroll position to respect.
      if (canCollapse) {
        setPullPx(
          dy < -PULL_SLOP_PX ? -dampenPull(-dy) : 0,
          dy >= -PULL_SLOP_PX,
        );
      } else if (pullPxRef.current !== 0) setPullPx(0, true);
      return;
    }
    // Downward drag: the expand gesture, only from the list top.
    if (el.scrollTop <= 0 && mayExpand) {
      if (g.anchorY === null) g.anchorY = e.clientY;
      const pull = e.clientY - g.anchorY;
      setPullPx(
        pull > PULL_SLOP_PX ? dampenPull(pull) : 0,
        pull <= PULL_SLOP_PX,
      );
    } else if (g.anchorY !== null) {
      g.anchorY = null;
      if (pullPxRef.current !== 0) setPullPx(0, true);
    }
  };
  const onListPointerEnd = (e: React.PointerEvent) => {
    const g = pointerPull.current;
    if (!g || g.id !== e.pointerId) return;
    // Pointerup can carry the final coalesced position. Applying it before the
    // release decision preserves a last-moment reversal or flick instead of
    // committing from the previous frame's stale sample.
    onListPointerMove(e);
    pointerPull.current = null;
    commitPull();
  };
  const onListPointerCancel = (e: React.PointerEvent) => {
    if (pointerPull.current?.id !== e.pointerId) return;
    pointerPull.current = null;
    abortPointerPull();
  };
  const onEmptyPointerDown = (e: React.PointerEvent) => {
    const list = scrollRef.current;
    if (
      e.pointerType !== "mouse" ||
      !e.isPrimary ||
      !canCollapse ||
      !list ||
      (e.target instanceof Node && list.contains(e.target)) ||
      isInteractiveGestureTarget(e.target)
    ) {
      return;
    }
    emptyPointerPull.current = {
      id: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      axis: "none",
    };
  };
  const onEmptyPointerMove = (e: React.PointerEvent) => {
    const gesture = emptyPointerPull.current;
    if (!gesture || gesture.id !== e.pointerId) return;
    if (!shadeGestureRef.current.canCollapse) {
      emptyPointerPull.current = null;
      if (pullPxRef.current !== 0) setPullPx(0);
      return;
    }
    const dx = e.clientX - gesture.startX;
    const dy = e.clientY - gesture.startY;
    if (
      gesture.axis === "none" &&
      (Math.abs(dx) > PULL_SLOP_PX || Math.abs(dy) > PULL_SLOP_PX)
    ) {
      gesture.axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
      if (gesture.axis === "y") {
        e.currentTarget.setPointerCapture?.(e.pointerId);
      }
    }
    if (gesture.axis === "x") {
      emptyPointerPull.current = null;
      return;
    }
    if (gesture.axis !== "y") return;
    setPullPx(dy < -PULL_SLOP_PX ? -dampenPull(-dy) : 0, dy >= -PULL_SLOP_PX);
  };
  const onEmptyPointerEnd = (e: React.PointerEvent) => {
    const gesture = emptyPointerPull.current;
    if (!gesture || gesture.id !== e.pointerId) return;
    onEmptyPointerMove(e);
    emptyPointerPull.current = null;
    commitPull();
  };
  const onEmptyPointerCancel = (e: React.PointerEvent) => {
    if (emptyPointerPull.current?.id !== e.pointerId) return;
    emptyPointerPull.current = null;
    abortPointerPull();
  };
  const onListClickCapture = (e: React.MouseEvent) => {
    if (!suppressNotificationClick.current) return;
    suppressNotificationClick.current = false;
    if (suppressNotificationClickTimer.current !== null) {
      window.clearTimeout(suppressNotificationClickTimer.current);
      suppressNotificationClickTimer.current = null;
    }
    e.preventDefault();
    e.stopPropagation();
  };
  const notificationCountAfterGroupIndex = restedGroups.length - 1;
  const notificationCount = hasNotifications ? (
    <li
      key="notification-count"
      data-testid="notifications-count"
      data-notification-count-slot=""
      aria-hidden={notificationCountVisibility === 0 ? true : undefined}
      inert={notificationCountVisibility === 0 ? true : undefined}
      style={{
        height: `${notificationCountLayoutVisibility * 32}px`,
        marginBottom: `${(notificationCountLayoutVisibility - 1) * 8}px`,
        opacity: notificationCountVisibility,
        transform: `translate3d(0, ${notificationCountOffset}px, 0)`,
        transition: isPulling ? "none" : undefined,
      }}
      className="eliza-notif-count-transition flex shrink-0 items-center justify-center px-3 text-2xs font-medium text-white/50"
    >
      <button
        type="button"
        data-testid="notifications-count-button"
        data-notif-control=""
        aria-label={`Show all ${notifications.length} notification${notifications.length === 1 ? "" : "s"}`}
        aria-expanded={shadeExpanded && !shadeClosing}
        onClick={openShadeFromControl}
        className="flex h-8 w-full shrink-0 items-center justify-center gap-1 text-inherit transition-colors hover:text-white/70"
      >
        {notifications.length === 1
          ? "1 Notification"
          : `${notifications.length} Notifications`}
        <ChevronDown
          aria-hidden
          data-testid="notifications-count-chevron"
          className="h-3 w-3 shrink-0"
        />
      </button>
    </li>
  ) : null;
  return (
    <section
      ref={centerRef}
      aria-label="Notifications"
      data-testid="home-notification-center"
      data-notification-reduced-motion={reduceMotion ? "" : undefined}
      data-notification-shade-cancelling={
        pullCancellingDirection ? "" : undefined
      }
      onPointerDown={onEmptyPointerDown}
      onPointerMove={onEmptyPointerMove}
      onPointerUp={onEmptyPointerEnd}
      onPointerCancel={onEmptyPointerCancel}
      // No card chrome on the CONTAINER: the inbox has no fill and no border of
      // its own — the glass lives on each notification card. It sits inline on
      // the home field directly under the time/weather header.
      // `eliza-notif-center-in` is added only when real rows exist, so a quiet
      // hydrated gesture band cannot consume the first-arrival animation.
      // `min-h-0 flex-1` lets a populated inbox fill the home column down to the
      // chat when the parent grows it.
      className={cn(
        "eliza-notif-center relative flex min-h-0 flex-1 flex-col overflow-hidden text-white",
        hasNotifications && "eliza-notif-center-in",
        !hasNotifications && "min-h-14 flex-none",
      )}
    >
      <style>{NOTIF_SCROLL_CSS}</style>
      <LiquidGlassRefractionDefs />
      {/* No "Notifications" header, no group eyebrows, no dividers: the
          physical gaps between card clusters ARE the grouping. Directional
          pull gestures own the shade transition; the collapse command stays
          pinned to the viewport while notification rows scroll beneath it. */}
      <ul
        ref={scrollRef}
        onPointerDown={onListPointerDown}
        onPointerMove={onListPointerMove}
        onPointerUp={onListPointerEnd}
        onPointerCancel={onListPointerCancel}
        onClickCapture={onListClickCapture}
        onWheel={onListWheel}
        data-testid="home-notification-list"
        data-shade-mode={shadeExpanded ? "expanded" : "rested"}
        data-shade-preview={previewingExpansion ? "expanding" : undefined}
        data-shade-dragging={isPulling ? "" : undefined}
        data-shade-settling={shadeClosing ? "" : undefined}
        className={cn(
          // select-none: a mouse pull-drag must read as a gesture, not a text
          // selection sweep across the cards (platform-shade idiom).
          "eliza-notif-scroll relative flex min-h-0 touch-pan-y select-none flex-col gap-2 overflow-y-auto overflow-x-hidden overscroll-y-contain px-1.5 pt-1",
          showCollapseControl ? "flex-[0_1_auto] pb-2" : "flex-1 pb-10",
          hasNotifications &&
            "scroll-fade scroll-fade-t-[1.25rem] scroll-fade-b-[1.5rem]",
          shadeClosing && "pointer-events-none",
        )}
      >
        {hasNotifications ? (
          <li
            data-notification-clear-slot=""
            aria-hidden={clearControlVisibility === 0 ? true : undefined}
            inert={clearControlVisibility < 1 ? true : undefined}
            style={{
              height: clearControlLayoutVisibility * 32,
              marginBottom: (clearControlLayoutVisibility - 1) * 8,
              opacity: clearControlVisibility,
              transform: `translate3d(0, ${(1 - clearControlVisibility) * -8}px, 0)`,
            }}
            className="eliza-notif-shade-transition flex shrink-0 justify-end overflow-hidden px-1"
          >
            {shadeExpanded || previewingExpansion ? (
              <button
                type="button"
                data-testid="notifications-clear-all"
                data-confirming={confirmingClearAll ? "true" : undefined}
                data-notif-control=""
                aria-label={
                  confirmingClearAll
                    ? "Confirm clear all notifications"
                    : "Clear all notifications"
                }
                onClick={clearAll}
                className={cn(
                  "eliza-notif-control-transition h-8 overflow-hidden text-xs font-medium text-white/60 transition-[width,color] duration-200 ease-out hover:text-white/90",
                  confirmingClearAll ? "w-12 text-white" : "w-8",
                )}
              >
                <ClearConfirmationContent confirming={confirmingClearAll} />
              </button>
            ) : null}
          </li>
        ) : null}
        {!hasNotifications ? (
          <li
            role="status"
            data-testid="notifications-empty"
            data-notification-empty=""
            aria-hidden={
              !shadeExpanded && !previewingExpansion ? true : undefined
            }
            inert={!shadeExpanded && !previewingExpansion ? true : undefined}
            style={{
              ...notificationPullRevealStyle(emptyStateVisibility),
              transition: isPulling ? "none" : undefined,
            }}
            className="eliza-notif-pull-reveal eliza-notif-shade-transition flex min-h-14 items-center justify-center px-3 py-3 text-2xs font-medium text-white/45"
          >
            No Notifications
          </li>
        ) : null}
        {notificationCountAfterGroupIndex < 0 ? notificationCount : null}
        {groups.flatMap((group, groupIndex) => {
          const allGroupRows = allGroupRowsByKey.get(group.key) ?? group.rows;
          const groupWasRested = restedGroupKeys.has(group.key);
          const pullRevealed = previewingExpansion && !groupWasRested;
          const revealProgress = pullRevealed
            ? notificationGroupPullVisibility(
                pullPx,
                groupIndex,
                shadeExpanded,
                shadeClosing,
                true,
              )
            : 1;
          const closeVisibility = notificationGroupPullVisibility(
            pullPx,
            groupIndex,
            shadeExpanded,
            shadeClosing,
            false,
          );
          const shadeOpenVisibility =
            shadeExpanded && !groupWasRested ? shadeOpenProgress : 1;
          const groupVisibility = Math.min(
            closeVisibility,
            shadeOpenVisibility,
          );
          const groupContainerOffset = notificationGroupContainerOffset(
            pullPx,
            shadeExpanded,
            shadeClosing,
          );
          const stackExpanded = expandedStacks.has(group.key);
          // Every presentation shares one shell, so the top NotificationRow
          // stays under the same parent/key while a fanned stack closes.
          const fanned = stackExpanded && group.rows.length > 1;
          const stackClosing = closingStacks.has(group.key);
          const stackFanProgress =
            openingStacks.has(group.key) || stackClosing ? 0 : 1;
          // A rested priority card keeps the visual depth of every folded
          // sibling from the same producer, including quiet rows. The content
          // remains priority-only; the peeks communicate that tapping fans a
          // real stack instead of opening a lone notification.
          const restedStackRows = groupWasRested ? allGroupRows : [];
          const collapsedStackRows =
            !shadeExpanded && groupWasRested ? restedStackRows : group.rows;
          const stacked = !fanned && collapsedStackRows.length > 1;
          // Resting peeks remain mounted invisibly behind a fan so full cards
          // can fold back into them without a last-frame pop.
          const peeks = collapsedStackRows.slice(1, MAX_VISIBLE_STACK_LAYERS);
          const expandedStackTailPx =
            peeks.length * STACK_PEEK_OFFSET_PX +
            (peeks.length > 0 ? STACK_BOTTOM_CLEARANCE_PX : 0);
          const restedPeekCount = Math.min(
            Math.max(restedStackRows.length - 1, 0),
            MAX_VISIBLE_STACK_LAYERS - 1,
          );
          const restedStackTailPx =
            restedPeekCount * STACK_PEEK_OFFSET_PX +
            (restedPeekCount > 0 ? STACK_BOTTOM_CLEARANCE_PX : 0);
          const stackTailRevealProgress = shadeExpanded
            ? disposableLayoutVisibility
            : previewingExpansion
              ? groupWasRested
                ? notificationPullRevealProgress(pullPx, groupIndex)
                : 1
              : 0;
          const stackTailPx =
            restedStackTailPx +
            (expandedStackTailPx - restedStackTailPx) * stackTailRevealProgress;
          const fannedOpenPaddingPx =
            expandedStackTailPx + (16 - expandedStackTailPx) * stackFanProgress;
          const rows = fanned
            ? group.rows
            : [group.rows[0] as AgentNotification];
          const collapsedGroupHasMore = !fanned && allGroupRows.length > 1;
          const stackPeekMode = fanned
            ? "close"
            : groupWasRested
              ? "static"
              : "disposable";
          const stackPeekVisibility = fanned
            ? Math.max(
                groupWasRested ? shadeCloseProgress : 0,
                1 - stackFanProgress,
              )
            : stackPeekMode === "disposable"
              ? pullContentVisibility
              : 1;
          const stackPeekExpansionProgress = fanned
            ? Math.min(stackFanProgress, 1 - shadeCloseProgress)
            : 0;
          // CSS owns the retained fold from start to finish. Motion layout is
          // suspended for that interval so the zero-geometry DOM compaction
          // cannot launch a second settle after the visible fold is complete.
          const groupElement = (
            <motion.li
              key={group.key}
              layout={
                !reduceMotion &&
                !isPulling &&
                !pullCancellingDirection &&
                !shadeClosing &&
                !stackClosing
                  ? "position"
                  : false
              }
              transition={{ layout: stackLayoutTransition }}
              data-notification-group=""
              data-notification-group-key={group.key}
              data-notification-group-index={groupIndex}
              data-notification-stack-fanned={fanned ? "" : undefined}
              data-notification-stack-closing={stackClosing ? "" : undefined}
              data-rested-notification-group={groupWasRested ? "" : undefined}
              data-notification-pull-reveal={pullRevealed ? "" : undefined}
              inert={pullRevealed ? true : undefined}
              className={cn(
                "relative flex flex-col",
                pullRevealed &&
                  "eliza-notif-pull-reveal eliza-notif-shade-transition pointer-events-none",
              )}
              style={
                pullRevealed || groupContainerOffset !== 0
                  ? {
                      opacity: pullRevealed ? revealProgress : undefined,
                      transform: `translate3d(0, ${
                        groupContainerOffset +
                        (pullRevealed ? (1 - revealProgress) * -8 : 0)
                      }px, 0)`,
                    }
                  : undefined
              }
            >
              <div
                data-notification-group-content=""
                data-notification-stacked={stacked ? "" : undefined}
                data-notification-stack-material={
                  allGroupRows.length > 1 ? "" : undefined
                }
                data-notification-rested-tail-px={restedStackTailPx}
                data-notification-expanded-tail-px={expandedStackTailPx}
                data-testid={stacked ? "notification-stack" : undefined}
                className="eliza-notif-shade-transition relative flex flex-col"
                style={{
                  paddingBottom: fanned
                    ? fannedOpenPaddingPx * disposableLayoutVisibility +
                      shadeCloseProgress * restedStackTailPx
                    : stacked
                      ? stackTailPx
                      : 0,
                  opacity: groupWasRested ? 1 : groupVisibility,
                  transform: groupWasRested
                    ? undefined
                    : `translate3d(0, ${notificationGroupPullOffset(
                        pullPx,
                        shadeExpanded,
                        shadeClosing,
                        groupVisibility,
                      )}px, 0)`,
                  transition: isPulling ? "none" : undefined,
                }}
              >
                {fanned ? (
                  <div
                    data-testid="notification-stack-controls"
                    data-notification-stack-controls=""
                    aria-hidden={stackClosing ? true : undefined}
                    inert={stackClosing ? true : undefined}
                    className="eliza-notif-shade-transition flex items-center justify-between gap-3 overflow-hidden px-2"
                    style={{
                      height:
                        stackFanProgress * disposableLayoutVisibility * 36,
                      opacity: stackFanProgress * disposableContentVisibility,
                      transform: `translate3d(0, ${
                        (1 - stackFanProgress * disposableContentVisibility) *
                        -6
                      }px, 0)`,
                    }}
                  >
                    <span className="truncate text-xs font-semibold text-white/55">
                      {group.label}
                    </span>
                    <span className="flex shrink-0 items-center gap-1">
                      <button
                        type="button"
                        data-testid="notification-stack-collapse"
                        data-notif-control=""
                        disabled={stackClosing}
                        onClick={(event) =>
                          foldStack(group.key, event.detail === 0)
                        }
                        className="h-8 px-2 text-xs font-medium text-white/60 transition-colors hover:text-white/90"
                      >
                        Show Less
                      </button>
                      <button
                        type="button"
                        data-testid="notification-stack-clear"
                        data-confirming={
                          confirmingGroupKey === group.key ? "true" : undefined
                        }
                        data-notif-control=""
                        aria-label={
                          confirmingGroupKey === group.key
                            ? `Confirm clear ${group.label} notifications`
                            : `Clear ${group.label} notifications`
                        }
                        onClick={() =>
                          clearProducer(
                            group.key,
                            allGroupRows.map((notification) => notification.id),
                          )
                        }
                        className={cn(
                          "eliza-notif-control-transition h-8 overflow-hidden text-xs font-medium text-white/60 transition-[width,color] duration-200 ease-out hover:text-white/90",
                          confirmingGroupKey === group.key
                            ? "w-12 text-white"
                            : "w-8",
                        )}
                      >
                        <ClearConfirmationContent
                          confirming={confirmingGroupKey === group.key}
                        />
                      </button>
                    </span>
                  </div>
                ) : null}
                <ul
                  data-notification-stack-rows=""
                  className={cn(
                    "relative z-[2] flex flex-col",
                    fanned && "eliza-notif-shade-transition",
                  )}
                  style={
                    fanned ? { rowGap: `${stackFanProgress * 6}px` } : undefined
                  }
                >
                  {rows.map((notification, rowIndex) => (
                    <NotificationRow
                      key={notification.id}
                      notification={notification}
                      stackKey={
                        rowIndex === 0 && collapsedGroupHasMore
                          ? group.key
                          : undefined
                      }
                      stackCount={
                        rowIndex === 0 && allGroupRows.length > 1
                          ? allGroupRows.length
                          : undefined
                      }
                      stackCountVisibility={
                        rowIndex === 0 && allGroupRows.length > 1
                          ? fanned
                            ? 1 - stackFanProgress
                            : 1
                          : undefined
                      }
                      stackPeeks={
                        rowIndex === 0 && peeks.length > 0
                          ? {
                              count: peeks.length,
                              disabled: stackClosing,
                              expansionProgress: stackPeekExpansionProgress,
                              fanned,
                              groupLabel: group.label,
                              mode: stackPeekMode,
                              openOffsetsPx: stackPeekOpenOffsets.get(
                                group.key,
                              ),
                              testIdVisible: !fanned || shadeCloseProgress > 0,
                              totalCount: allGroupRows.length,
                              visibility: stackPeekVisibility,
                            }
                          : undefined
                      }
                      shadeVisibility={
                        fanned && rowIndex > 0
                          ? stackFanProgress * disposableLayoutVisibility
                          : undefined
                      }
                      onExpandStack={expandStack}
                      onOpen={openNotification}
                      onDismiss={dismissNotification}
                    />
                  ))}
                </ul>
              </div>
            </motion.li>
          );
          return groupIndex === notificationCountAfterGroupIndex
            ? [groupElement, notificationCount]
            : [groupElement];
        })}
      </ul>
      {showCollapseControl ? (
        <div
          data-testid="notifications-collapse-footer"
          data-notification-collapse-footer=""
          aria-hidden={
            collapseControlPresentationVisibility === 0 ? true : undefined
          }
          inert={collapseControlPresentationVisibility < 1 ? true : undefined}
          style={{
            opacity: collapseControlPresentationVisibility,
            transform: `translateY(${
              (1 - collapseControlPresentationVisibility) * 4
            }px)`,
            transition: isPulling ? "none" : undefined,
          }}
          className="eliza-notif-shade-transition pointer-events-none flex shrink-0 justify-center px-3"
        >
          <button
            type="button"
            data-testid="notifications-collapse"
            onClick={(event) => {
              pendingRestedCountFocusRef.current = event.detail === 0;
              requestShadeCollapse();
            }}
            className="pointer-events-auto flex min-h-touch items-center justify-center gap-1 px-2 text-2xs font-medium text-white/55 transition-colors hover:text-white/90"
          >
            Collapse
            <ChevronUp aria-hidden className="h-3 w-3 shrink-0" />
          </button>
        </div>
      ) : null}
    </section>
  );
}
