/**
 * The app's notification inbox, mounted INLINE on the home column (HomeScreen)
 * directly beneath the time/weather header, the same layer as the widgets, in
 * the band between the header and the floating chat. It owns the inbox content
 * (rows, open/deep-link, per-row dismiss), stays visually quiet when empty, and
 * fades in Apple-style when the first notification arrives. Once hydration has
 * established that the inbox is empty, pulling its quiet gesture band reveals a
 * restrained "No Notifications" status instead of producing a blank shade. The
 * inbox container has no
 * card chrome of its own; each notification is a liquid-glass card. Groups
 * carry NO headers or dividers — the physical gap between card clusters is the
 * only group structure (producer labels survive as grouping keys and
 * accessible names, never as rendered eyebrows).
 *
 * Two shade modes:
 *
 *  - RESTED is triage: interrupt-tier (`high`/`urgent`) producer stacks remain
 *    visible above the passive total while quieter notifications stay folded
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
 * footer is a passive total (for example, "3 Notifications"), never a control;
 * it belongs only to the closed shade, fading away during expansion and back
 * in during collapse. Pull/push gestures exclusively own the transition.
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
import { ChevronDown, ChevronUp } from "lucide-react";
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
import { cn } from "../../lib/utils";
import {
  isSafeDeepLink,
  navigateDeepLink,
} from "../../state/notifications/navigate-deep-link";
import {
  clearNotifications,
  removeNotification,
  removeNotifications,
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
const SHADE_CLOSE_FADE_MS = 220;
const NOTIFICATION_COUNT_RESTORE_MS = 140;
const NOTIFICATION_ROW_SETTLE_MS = 220;
const STACK_LAYOUT_TRANSITION = {
  duration: 0.34,
  ease: [0.22, 1, 0.36, 1],
} as const;

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
 * Reduced motion keeps the direct-manipulation transitions that preserve
 * spatial continuity, while omitting scroll-edge decoration and scale-heavy
 * effects.
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
   or expanded, the same sheen/rim sits on an opaque translucent fill so drag
   and scroll stay compositor-cheap even at the 100-row render cap. */
.eliza-notif-scroll[data-shade-preview] .eliza-notif-glass,
.eliza-notif-scroll[data-shade-mode="expanded"] .eliza-notif-glass {
  background-color: rgb(22 22 25 / 88%);
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
    grid-template-rows ${SHADE_CLOSE_FADE_MS}ms cubic-bezier(0.22,1,0.36,1),
    height ${SHADE_CLOSE_FADE_MS}ms cubic-bezier(0.22,1,0.36,1),
    margin-bottom ${SHADE_CLOSE_FADE_MS}ms cubic-bezier(0.22,1,0.36,1),
    padding-bottom ${SHADE_CLOSE_FADE_MS}ms cubic-bezier(0.22,1,0.36,1),
    bottom ${SHADE_CLOSE_FADE_MS}ms cubic-bezier(0.22,1,0.36,1),
    opacity ${SHADE_CLOSE_FADE_MS}ms ease-out,
    transform ${SHADE_CLOSE_FADE_MS}ms cubic-bezier(0.22,1,0.36,1);
}
.eliza-notif-count-transition {
  transition:
    height ${NOTIFICATION_COUNT_RESTORE_MS}ms cubic-bezier(0.22,1,0.36,1),
    margin-bottom ${NOTIFICATION_COUNT_RESTORE_MS}ms cubic-bezier(0.22,1,0.36,1),
    opacity ${NOTIFICATION_COUNT_RESTORE_MS}ms ease-out;
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
  scrollbar-width: none;
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
  .eliza-notif-row { animation: none; }
  .eliza-notif-center-in {
    animation: eliza-notif-fade-in 240ms ease-out both !important;
  }
  .eliza-notif-row-inner {
    transition:
      transform ${NOTIFICATION_ROW_SETTLE_MS}ms cubic-bezier(0.22,1,0.36,1),
      opacity ${NOTIFICATION_ROW_SETTLE_MS}ms linear !important;
  }
  .eliza-notif-row-inner[data-swipe-dragging] {
    transition: none !important;
  }
  .eliza-notif-shade-transition {
    transition:
      grid-template-rows ${SHADE_CLOSE_FADE_MS}ms cubic-bezier(0.22,1,0.36,1),
      height ${SHADE_CLOSE_FADE_MS}ms cubic-bezier(0.22,1,0.36,1),
      margin-bottom ${SHADE_CLOSE_FADE_MS}ms cubic-bezier(0.22,1,0.36,1),
      padding-bottom ${SHADE_CLOSE_FADE_MS}ms cubic-bezier(0.22,1,0.36,1),
      bottom ${SHADE_CLOSE_FADE_MS}ms cubic-bezier(0.22,1,0.36,1),
      opacity ${SHADE_CLOSE_FADE_MS}ms ease-out,
      transform ${SHADE_CLOSE_FADE_MS}ms cubic-bezier(0.22,1,0.36,1) !important;
  }
  .eliza-notif-scroll[data-shade-dragging] .eliza-notif-shade-transition {
    transition: none !important;
  }
  .eliza-notif-count-transition {
    transition:
      height ${NOTIFICATION_COUNT_RESTORE_MS}ms cubic-bezier(0.22,1,0.36,1),
      margin-bottom ${NOTIFICATION_COUNT_RESTORE_MS}ms cubic-bezier(0.22,1,0.36,1),
      opacity ${NOTIFICATION_COUNT_RESTORE_MS}ms ease-out !important;
  }
  .eliza-notif-scroll[data-shade-dragging] .eliza-notif-count-transition {
    transition: none !important;
  }
  .eliza-notif-control-transition {
    transition-duration: 220ms !important;
  }
}
`;

let notificationsHomeCenterRenderObserverForTests: (() => void) | null = null;

export function __setNotificationsHomeCenterRenderObserverForTests(
  observer: (() => void) | null,
): void {
  notificationsHomeCenterRenderObserverForTests = observer;
}

/**
 * The notification inbox. Before hydration it renders nothing; a hydrated empty
 * inbox keeps only a visually quiet gesture band so a pull can reveal the empty
 * state. Mounted inline on the home column (HomeScreen), directly beneath the
 * time/weather header — the same layer as the widgets.
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
  const { notifications, hydrated } = useNotifications();
  // Shade mode: rested (interrupt-tier triage) vs expanded (full inbox).
  // Producer groups stay stacked until individually fanned out.
  const [shadeExpanded, setShadeExpanded] = useState(false);
  // Per-producer stack expansion (iOS-shade idiom). Tapping a peek fans that
  // stack and enters the expanded shade; folding the shade resets every stack.
  const [expandedStacks, setExpandedStacks] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [shadeOpenedByStack, setShadeOpenedByStack] = useState(false);
  const [confirmingGroupKey, setConfirmingGroupKey] = useState<string | null>(
    null,
  );
  const [confirmingClearAll, setConfirmingClearAll] = useState(false);
  const [shadeClosing, setShadeClosing] = useState(false);
  const shadeCloseTimer = useRef<number | null>(null);
  const expandStack = useCallback(
    (key: string) => {
      if (!shadeExpanded) setShadeOpenedByStack(true);
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
    [shadeExpanded],
  );
  const collapseStack = useCallback((key: string) => {
    setExpandedStacks((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
    setConfirmingGroupKey((current) => (current === key ? null : current));
    setConfirmingClearAll(false);
  }, []);
  // Dampened live pull (px), SIGNED: positive is a downward pull (expand),
  // negative an upward push (collapse). React mounts the preview once when a
  // gesture starts; pointer moves update existing styles directly so a
  // 100-notification inbox does not rebuild its React tree every frame.
  const [pullDirection, setPullDirection] = useState<
    "expand" | "collapse" | null
  >(null);
  const pullDirectionRef = useRef<"expand" | "collapse" | null>(null);
  const pullPxRef = useRef(0);
  const pullPresentationFrame = useRef<number | null>(null);
  // No list-level clock tick here (binding pattern, spec §C.4): relative
  // timestamps live in the `<RelativeTime>` leaf inside each row, which owns the
  // shared visibility-gated ticker. The minute roll re-renders those text nodes
  // only - not this list, not the rows, not the glass surface.
  const centerRef = useRef<HTMLElement | null>(null);
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

  const setPullPx = useCallback((px: number) => {
    pullPxRef.current = px;
    const nextDirection = px > 0 ? "expand" : px < 0 ? "collapse" : null;
    const directionChanged = pullDirectionRef.current !== nextDirection;
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
    const applyCurrentPull = () => {
      pullPresentationFrame.current = null;
      applyNotificationPullPresentation(
        centerRef.current,
        pullPxRef.current,
        shadePresentationRef.current.expanded,
        shadePresentationRef.current.closing,
        pullVisibleGroupsRef.current,
      );
    };
    if (!nextDirection) {
      if (pullPresentationFrame.current !== null) {
        window.cancelAnimationFrame(pullPresentationFrame.current);
        pullPresentationFrame.current = null;
      }
    } else if (directionChanged) {
      applyCurrentPull();
    } else if (pullPresentationFrame.current === null) {
      pullPresentationFrame.current =
        window.requestAnimationFrame(applyCurrentPull);
    }
  }, []);

  const cancelClearConfirmation = useCallback(() => {
    setConfirmingClearAll(false);
    setConfirmingGroupKey(null);
  }, []);

  const setShade = useCallback((expanded: boolean) => {
    if (shadeCloseTimer.current) {
      window.clearTimeout(shadeCloseTimer.current);
      shadeCloseTimer.current = null;
    }
    setShadeClosing(false);
    setShadeExpanded(expanded);
    setConfirmingClearAll(false);
    setConfirmingGroupKey(null);
    setShadeOpenedByStack(false);
    if (!expanded) {
      // Folding the shade folds every fanned stack with it so the next open
      // starts from a predictable grouped inbox.
      setExpandedStacks(new Set());
    }
    // Collapse completion is deterministic even when a smooth scroll was
    // interrupted. Expansion resets after the expanded rows mount below.
    if (!expanded && scrollRef.current) scrollRef.current.scrollTop = 0;
  }, []);

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

  const requestShadeCollapse = useCallback(() => {
    if (!shadeExpanded || shadeClosing) return;
    const draggedFullyClosed = pullPxRef.current <= -PULL_COMMIT_PX;
    cancelClearConfirmation();
    const list = scrollRef.current;
    if (list && list.scrollTop > 0) {
      list.scrollTo?.({ top: 0, behavior: "smooth" });
    }
    wheelCommitLockUntil.current = Date.now() + WHEEL_COMMIT_LOCK_MS;
    // End direct manipulation before starting the close settle. Leaving a
    // non-zero pull marks the shade as dragging, which intentionally disables
    // child transitions and turns the committed close into a delayed snap.
    setPullPx(0);
    // A completed direct gesture has already faded the disposable cards to
    // zero. Remove their layout immediately instead of making the user wait
    // through a second, invisible close animation.
    if (draggedFullyClosed) {
      setShade(false);
      return;
    }
    setShadeClosing(true);
    shadeCloseTimer.current = window.setTimeout(() => {
      shadeCloseTimer.current = null;
      setShade(false);
    }, SHADE_CLOSE_FADE_MS);
  }, [
    cancelClearConfirmation,
    setPullPx,
    setShade,
    shadeClosing,
    shadeExpanded,
  ]);

  const foldStack = useCallback(
    (key: string) => {
      const restoresRestedShade =
        shadeOpenedByStack &&
        expandedStacks.size === 1 &&
        expandedStacks.has(key);
      collapseStack(key);
      if (restoresRestedShade) requestShadeCollapse();
    },
    [collapseStack, expandedStacks, requestShadeCollapse, shadeOpenedByStack],
  );

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
    // Directional: a downward pull only expands, an upward push only
    // collapses. A gesture in the direction of the current state is a no-op.
    if (px >= commitPx && canExpand) setShade(true);
    else if (px <= -commitPx && canCollapse) {
      requestShadeCollapse();
      return;
    }
    setPullPx(0);
  }, [notifications.length, requestShadeCollapse, setPullPx, setShade]);

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
        if (dir === 1) setShade(true);
        else requestShadeCollapse();
      }
      return true;
    },
    [notifications.length, requestShadeCollapse, setShade],
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
    let start: { x: number; y: number } | null = null;
    // clientY where the drag first reached the top; the pull is measured from
    // here so a continuous drag that scrolled the list up to its top doesn't
    // jump the shade by the pre-top travel and instantly commit.
    let expandAnchorY: number | null = null;
    let collapseAnchorY: number | null = null;
    let closeFromBottomEdge = false;
    const onTouchStart = (e: TouchEvent) => {
      const t = e.touches[0];
      const target = e.target;
      if (usesEmptyBackground && isInteractiveGestureTarget(target)) {
        start = null;
        expandAnchorY = null;
        collapseAnchorY = null;
        closeFromBottomEdge = false;
        return;
      }
      start =
        e.touches.length === 1 && t ? { x: t.clientX, y: t.clientY } : null;
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
    const onTouchMove = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!start || !t) return;
      const dx = t.clientX - start.x;
      const dy = t.clientY - start.y;
      // A horizontal gesture belongs to the row swipe; hand it off for good.
      if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > PULL_SLOP_PX) {
        start = null;
        expandAnchorY = null;
        collapseAnchorY = null;
        closeFromBottomEdge = false;
        return;
      }
      if (Math.abs(dy) > PULL_SLOP_PX && Math.abs(dy) >= Math.abs(dx)) {
        armNotificationClickSuppression();
      }
      if (closeFromBottomEdge && dy < 0 && Math.abs(dy) >= Math.abs(dx)) {
        // Claim the bottom-edge close from its first vertical pixel so the
        // native scroller never moves underneath the gesture before the slop
        // threshold is crossed.
        e.preventDefault();
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
            e.preventDefault();
            setPullPx(-dampenPull(push));
          } else if (pullPxRef.current !== 0) {
            setPullPx(0);
          }
        } else {
          collapseAnchorY = null;
          if (pullPxRef.current !== 0) setPullPx(0);
        }
        return;
      }
      if (gestureTarget.scrollTop <= 0 && canExpand) {
        if (expandAnchorY === null) expandAnchorY = t.clientY;
        const pull = t.clientY - expandAnchorY;
        if (pull > PULL_SLOP_PX) {
          e.preventDefault();
          setPullPx(dampenPull(pull));
        } else if (pullPxRef.current !== 0) {
          // Finger reversed back above the anchor — the pull is withdrawn, so
          // the release must not commit from the stale peak (parity with the
          // pointer path).
          setPullPx(0);
        }
      } else if (expandAnchorY !== null) {
        // Scrolled back down into content — abandon the pull and re-anchor.
        expandAnchorY = null;
        if (pullPxRef.current !== 0) setPullPx(0);
      }
    };
    const onTouchEnd = () => {
      start = null;
      expandAnchorY = null;
      collapseAnchorY = null;
      closeFromBottomEdge = false;
      commitPull();
    };
    const onTouchCancel = () => {
      // An OS-cancelled gesture (incoming call, edge-gesture takeover, palm
      // rejection) ABORTS: snap back to rest, never change the shade from a
      // gesture the user never completed.
      start = null;
      expandAnchorY = null;
      collapseAnchorY = null;
      closeFromBottomEdge = false;
      setPullPx(0);
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
    let start: { x: number; y: number } | null = null;
    let axis: "none" | "x" | "y" = "none";
    let ownsPull = false;

    const reset = () => {
      start = null;
      axis = "none";
      ownsPull = false;
    };
    const onTouchStart = (event: TouchEvent) => {
      const touch = event.touches[0];
      const target = event.target;
      start =
        event.touches.length === 1 &&
        touch &&
        !isInteractiveGestureTarget(target) &&
        !(target instanceof Node && list.contains(target))
          ? { x: touch.clientX, y: touch.clientY }
          : null;
      axis = "none";
      ownsPull = false;
    };
    const onTouchMove = (event: TouchEvent) => {
      const touch = event.touches[0];
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
        event.preventDefault();
        setPullPx(dampenPull(dy));
      } else if (ownsPull && pullPxRef.current !== 0) {
        setPullPx(0);
      }
    };
    const onTouchEnd = () => {
      const shouldCommit = ownsPull;
      reset();
      if (shouldCommit) commitPull();
    };
    const onTouchCancel = () => {
      const shouldResetPull = ownsPull;
      reset();
      if (shouldResetPull) setPullPx(0);
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
    if (!shadeExpanded || !surface || !center || !list) return;
    let start: { x: number; y: number } | null = null;

    const onTouchStart = (event: TouchEvent) => {
      const touch = event.touches[0];
      const target = event.target;
      start =
        event.touches.length === 1 &&
        touch &&
        target instanceof Node &&
        !list.contains(target) &&
        !isInteractiveGestureTarget(target)
          ? { x: touch.clientX, y: touch.clientY }
          : null;
    };
    const onTouchMove = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (!start || !touch) return;
      const dx = touch.clientX - start.x;
      const dy = touch.clientY - start.y;
      if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > PULL_SLOP_PX) {
        start = null;
        setPullPx(0);
        return;
      }
      if (dy < 0 && Math.abs(dy) >= Math.abs(dx)) event.preventDefault();
      if (dy < -PULL_SLOP_PX) {
        setPullPx(-dampenPull(-dy));
      } else if (pullPxRef.current !== 0) {
        setPullPx(0);
      }
    };
    const onTouchEnd = () => {
      if (!start) return;
      start = null;
      commitPull();
    };
    const onTouchCancel = () => {
      start = null;
      setPullPx(0);
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
  }, [commitPull, emptyGestureTargetRef, setPullPx, shadeExpanded]);

  // Clear timers that may outlive a single gesture.
  useEffect(
    () => () => {
      if (wheelDecayTimer.current) window.clearTimeout(wheelDecayTimer.current);
      if (shadeCloseTimer.current) window.clearTimeout(shadeCloseTimer.current);
      if (suppressNotificationClickTimer.current !== null) {
        window.clearTimeout(suppressNotificationClickTimer.current);
      }
      if (pullPresentationFrame.current !== null) {
        window.cancelAnimationFrame(pullPresentationFrame.current);
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
    setExpandedStacks(new Set());
    void clearNotifications();
  }, [confirmingClearAll]);

  // An emptied-out inbox resets the shade so the next arrival starts rested.
  // `pullPx` is cleared too: if the inbox empties mid-pull the touch effect
  // unbinds before touchend, so a stale translateY would otherwise ride into
  // the next arrival's first paint.
  useEffect(() => {
    if (notifications.length === 0) {
      setShadeExpanded(false);
      setShadeOpenedByStack(false);
      setExpandedStacks(new Set());
      setConfirmingGroupKey(null);
      setConfirmingClearAll(false);
      setPullPx(0);
    }
  }, [notifications.length, setPullPx]);

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
  if (!surfaceReady) return null;

  const pullPx = pullPxRef.current;
  const isPulling = pullDirection !== null;
  const canExpand = !shadeExpanded;
  const previewingExpansion = canExpand && pullDirection === "expand";
  const groups = shadeExpanded
    ? expandedGroups
    : previewingExpansion
      ? previewGroups
      : restedGroups;
  shadeGestureRef.current = { canExpand, canCollapse: shadeExpanded };
  const {
    shadeCloseProgress,
    committedCloseProgress,
    disposableContentVisibility,
    pullContentVisibility,
    notificationCountVisibility,
    notificationCountLayoutVisibility,
    emptyStateVisibility,
    collapseControlVisibility,
    clearControlVisibility,
    clearControlLayoutVisibility,
  } = notificationPullPresentation(pullPx, shadeExpanded, shadeClosing);
  const disposableLayoutVisibility = 1 - committedCloseProgress;
  const showCollapseControl =
    (shadeExpanded || previewingExpansion) &&
    hasNotifications &&
    expandedStacks.size === 0 &&
    !shadeOpenedByStack;
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
      if (canCollapse) setPullPx(dy < -PULL_SLOP_PX ? -dampenPull(-dy) : 0);
      else if (pullPxRef.current !== 0) setPullPx(0);
      return;
    }
    // Downward drag: the expand gesture, only from the list top.
    if (el.scrollTop <= 0 && mayExpand) {
      if (g.anchorY === null) g.anchorY = e.clientY;
      const pull = e.clientY - g.anchorY;
      setPullPx(pull > PULL_SLOP_PX ? dampenPull(pull) : 0);
    } else if (g.anchorY !== null) {
      g.anchorY = null;
      if (pullPxRef.current !== 0) setPullPx(0);
    }
  };
  const onListPointerEnd = (e: React.PointerEvent) => {
    const g = pointerPull.current;
    if (!g || g.id !== e.pointerId) return;
    pointerPull.current = null;
    commitPull();
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
        transition: isPulling ? "none" : undefined,
      }}
      className="eliza-notif-count-transition flex shrink-0 items-center justify-center overflow-hidden px-3 text-2xs font-medium text-white/50"
    >
      <button
        type="button"
        data-testid="notifications-count-button"
        data-notif-control=""
        aria-label={`Show all ${notifications.length} notification${notifications.length === 1 ? "" : "s"}`}
        aria-expanded={shadeExpanded}
        onClick={() => setShade(true)}
        className="flex h-full w-full items-center justify-center gap-1 text-inherit transition-colors hover:text-white/70"
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
      // No card chrome on the CONTAINER: the inbox has no fill and no border of
      // its own — the glass lives on each notification card. It sits inline on
      // the home field directly under the time/weather header.
      // `eliza-notif-center-in` is added only when real rows exist, so a quiet
      // hydrated gesture band cannot consume the first-arrival animation.
      // `min-h-0 flex-1` lets a populated inbox fill the home column down to the
      // chat when the parent grows it.
      className={cn(
        "relative flex min-h-0 flex-1 flex-col overflow-hidden text-white",
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
        onPointerCancel={onListPointerEnd}
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
            ? notificationPullRevealProgress(pullPx, groupIndex)
            : 1;
          const closeVisibility = notificationGroupPullVisibility(
            pullPx,
            groupIndex,
            shadeExpanded,
            shadeClosing,
            false,
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
          const peeks = (fanned ? restedStackRows : collapsedStackRows).slice(
            1,
            MAX_VISIBLE_STACK_LAYERS,
          );
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
          const rows = fanned
            ? group.rows
            : [group.rows[0] as AgentNotification];
          const collapsedGroupHasMore = !fanned && allGroupRows.length > 1;
          const groupElement = (
            <motion.li
              key={group.key}
              layout={
                shadeExpanded && !isPulling && !shadeClosing
                  ? "position"
                  : false
              }
              transition={{ layout: STACK_LAYOUT_TRANSITION }}
              data-notification-group=""
              data-notification-group-index={groupIndex}
              data-rested-notification-group={groupWasRested ? "" : undefined}
              data-notification-pull-reveal={pullRevealed ? "" : undefined}
              inert={pullRevealed ? true : undefined}
              className={cn(
                "relative flex flex-col",
                pullRevealed && "eliza-notif-pull-reveal pointer-events-none",
                fanned && "pb-2",
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
                data-notification-rested-tail-px={restedStackTailPx}
                data-notification-expanded-tail-px={expandedStackTailPx}
                data-testid={stacked ? "notification-stack" : undefined}
                className="eliza-notif-shade-transition relative flex flex-col"
                style={{
                  paddingBottom: fanned
                    ? disposableLayoutVisibility * 8 +
                      shadeCloseProgress * restedStackTailPx
                    : stacked
                      ? stackTailPx
                      : 0,
                  opacity: groupWasRested ? 1 : closeVisibility,
                  transform: groupWasRested
                    ? undefined
                    : `translate3d(0, ${notificationGroupPullOffset(
                        pullPx,
                        shadeExpanded,
                        shadeClosing,
                        closeVisibility,
                      )}px, 0)`,
                  transition: isPulling
                    ? "none"
                    : `padding-bottom ${SHADE_CLOSE_FADE_MS}ms cubic-bezier(0.22,1,0.36,1), opacity ${SHADE_CLOSE_FADE_MS}ms ease-out, transform ${SHADE_CLOSE_FADE_MS}ms cubic-bezier(0.22,1,0.36,1)`,
                }}
              >
                {fanned ? (
                  <div
                    data-testid="notification-stack-controls"
                    data-notification-stack-controls=""
                    className="eliza-notif-shade-transition flex items-center justify-between gap-3 overflow-hidden px-2"
                    style={{
                      height: disposableLayoutVisibility * 36,
                      opacity: disposableContentVisibility,
                      transform: `translate3d(0, ${(1 - disposableContentVisibility) * -6}px, 0)`,
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
                        onClick={() => foldStack(group.key)}
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
                <motion.ul
                  layout={
                    shadeExpanded && !isPulling && !shadeClosing
                      ? "position"
                      : false
                  }
                  transition={{ layout: STACK_LAYOUT_TRANSITION }}
                  className={cn(
                    "relative z-[2] flex flex-col",
                    fanned && "gap-1.5",
                  )}
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
                        rowIndex === 0 && collapsedGroupHasMore
                          ? allGroupRows.length
                          : undefined
                      }
                      shadeVisibility={
                        fanned && rowIndex > 0
                          ? disposableLayoutVisibility
                          : undefined
                      }
                      onExpandStack={expandStack}
                      onOpen={openNotification}
                      onDismiss={dismissNotification}
                    />
                  ))}
                </motion.ul>
                {peeks.map((peek, i) => {
                  const peekMode = fanned
                    ? "close"
                    : groupWasRested
                      ? "static"
                      : "disposable";
                  const peekCloseVisibility = fanned
                    ? shadeCloseProgress
                    : peekMode === "disposable"
                      ? pullContentVisibility
                      : 1;
                  return (
                    <button
                      key={peek.id}
                      type="button"
                      data-testid={
                        !fanned || shadeCloseProgress > 0
                          ? "notification-stack-peek"
                          : undefined
                      }
                      data-notif-control=""
                      data-notification-stack-peek=""
                      data-notification-peek-mode={peekMode}
                      tabIndex={peekCloseVisibility < 1 ? -1 : undefined}
                      aria-hidden={peekCloseVisibility === 0 ? true : undefined}
                      aria-label={`Show all ${allGroupRows.length} ${group.label} notifications`}
                      onClick={() => expandStack(group.key)}
                      className={cn(
                        "eliza-notif-glass eliza-notif-stack-peek eliza-notif-shade-transition absolute inset-x-0 top-0 rounded-2xl",
                        fanned && "pointer-events-none",
                      )}
                      style={{
                        bottom: fanned ? restedStackTailPx : stackTailPx,
                        zIndex: 1 - i,
                        opacity: peekCloseVisibility,
                        transform: `translateY(${(i + 1) * STACK_PEEK_OFFSET_PX}px) scale(${
                          1 - (i + 1) * 0.015
                        })`,
                        transition: isPulling
                          ? "none"
                          : `bottom ${SHADE_CLOSE_FADE_MS}ms cubic-bezier(0.22,1,0.36,1), opacity ${SHADE_CLOSE_FADE_MS}ms ease-out`,
                      }}
                    />
                  );
                })}
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
          aria-hidden={collapseControlVisibility === 0 ? true : undefined}
          inert={collapseControlVisibility < 1 ? true : undefined}
          style={{
            opacity: collapseControlVisibility,
            transform: `translateY(${(1 - collapseControlVisibility) * 4}px)`,
          }}
          className="eliza-notif-shade-transition pointer-events-none flex shrink-0 justify-center px-3"
        >
          <button
            type="button"
            data-testid="notifications-collapse"
            onClick={requestShadeCollapse}
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
