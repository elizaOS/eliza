/**
 * Inline home notification inbox.
 *
 * Resting mode is deliberately small: interrupt-tier notifications remain
 * visible and a single explicit control reveals the quiet remainder. The inbox
 * itself never changes mode in response to scrolling, wheel momentum, a drag,
 * an outside click, or a producer-stack interaction. Producer stacks own their
 * own fan/fold state and may be expanded independently in either inbox mode.
 */
import type { AgentNotification } from "@elizaos/core";
import { ChevronDown, ChevronUp, RefreshCw } from "lucide-react";
import { motion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "../../lib/utils";
import {
  isSafeDeepLink,
  navigateDeepLink,
} from "../../state/notifications/navigate-deep-link";
import {
  removeNotification,
  retryNotificationHydration,
  useNotifications,
} from "../../state/notifications/notification-store";
import {
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
  STACK_FAN_GESTURE_PX,
} from "./notification-shade-content";

import {
  LIQUID_GLASS_BLUR,
  LIQUID_GLASS_EDGE_SHADOW,
  LIQUID_GLASS_REFRACTION,
  LIQUID_GLASS_SHEEN,
  LiquidGlassRefractionDefs,
  liquidGlassRimCss,
} from "./liquid-glass";

const MAX_RENDERED_ROWS = 100;
const MAX_VISIBLE_STACK_LAYERS = 3;
const STACK_PEEK_OFFSET_PX = 7;
const STACK_BOTTOM_CLEARANCE_PX = 10;
const NOTIFICATION_ROW_SETTLE_MS = 220;
const STACK_LAYOUT_TRANSITION = {
  duration: 0.34,
  ease: [0.22, 1, 0.36, 1],
} as const;

/**
 * The list has a natural height until this cap, then becomes its own native
 * scrollport. Keeping the section out of flex-fill means the Apps section that
 * follows it in HomeScreen moves with the actual notification content instead
 * of sitting below an artificial empty region.
 */
export const NOTIFICATION_LIST_MAX_HEIGHT = "min(48dvh, 28rem)";

const NOTIF_SCROLL_CSS = `
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
@supports (backdrop-filter: url(#x)) or (-webkit-backdrop-filter: url(#x)) {
  .eliza-notif-glass {
    -webkit-backdrop-filter: ${LIQUID_GLASS_REFRACTION};
    backdrop-filter: ${LIQUID_GLASS_REFRACTION};
  }
}
.eliza-notif-scroll[data-inbox-mode="all"] .eliza-notif-glass,
[data-rail-gesture-active] .eliza-notif-glass {
  background-color: rgb(22 22 25 / 88%);
  -webkit-backdrop-filter: none;
  backdrop-filter: none;
}
.eliza-notif-scroll [data-notification-stacked] .eliza-notif-glass,
.eliza-notif-scroll .eliza-notif-glass.eliza-notif-stack-peek {
  background-color: rgb(28 28 30);
  background-image: none;
  -webkit-backdrop-filter: none;
  backdrop-filter: none;
}
${liquidGlassRimCss(".eliza-notif-glass")}
.eliza-notif-glass:hover { background-color: rgb(38 38 42 / 42%); }
.eliza-notif-scroll {
  scrollbar-width: none;
  -webkit-overflow-scrolling: touch;
}
.eliza-notif-scroll::-webkit-scrollbar { display: none; }
.eliza-notif-row-inner {
  transition:
    transform ${NOTIFICATION_ROW_SETTLE_MS}ms cubic-bezier(0.22,1,0.36,1),
    opacity ${NOTIFICATION_ROW_SETTLE_MS}ms linear;
}
.eliza-notif-row-inner[data-swipe-dragging] { transition: none; }
@media (prefers-reduced-motion: reduce) {
  .eliza-notif-center-in { animation: none; }
  .eliza-notif-row-inner { transition: none; }
}
`;

let notificationsHomeCenterRenderObserverForTests: (() => void) | null = null;

export function __setNotificationsHomeCenterRenderObserverForTests(
  observer: (() => void) | null,
): void {
  notificationsHomeCenterRenderObserverForTests = observer;
}

export function NotificationsHomeCenter(): React.JSX.Element | null {
  notificationsHomeCenterRenderObserverForTests?.();
  const { notifications, hydrated, hydrationStatus } = useNotifications();
  const [inboxExpanded, setInboxExpanded] = useState(false);
  const [expandedStacks, setExpandedStacks] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const scrollRef = useRef<HTMLUListElement | null>(null);
  const scrollAfterExpansion = useRef(false);

  const expandStack = useCallback((key: string) => {
    setExpandedStacks((current) => {
      if (current.has(key)) return current;
      const next = new Set(current);
      next.add(key);
      return next;
    });
  }, []);

  const collapseStack = useCallback((key: string) => {
    setExpandedStacks((current) => {
      if (!current.has(key)) return current;
      const next = new Set(current);
      next.delete(key);
      return next;
    });
  }, []);

  const toggleInboxMode = useCallback(() => {
    setInboxExpanded((current) => {
      if (current) {
        setExpandedStacks(new Set());
        if (scrollRef.current) scrollRef.current.scrollTop = 0;
        return false;
      }
      scrollAfterExpansion.current = true;
      return true;
    });
  }, []);

  // Opening the full inbox begins moving into the newly revealed quiet digest
  // instead of jumping back to the first priority card. The explicit toggle is
  // the only path that arms this effect.
  useEffect(() => {
    if (!inboxExpanded || !scrollAfterExpansion.current) return;
    scrollAfterExpansion.current = false;
    const frame = window.requestAnimationFrame(() => {
      const list = scrollRef.current;
      const firstNew = list?.querySelector<HTMLElement>(
        "[data-inbox-newly-revealed]",
      );
      if (!list || !firstNew) return;
      const top = Math.max(0, firstNew.offsetTop - list.clientHeight * 0.25);
      const reducedMotion = window.matchMedia?.(
        "(prefers-reduced-motion: reduce)",
      ).matches;
      list.scrollTo?.({
        top,
        behavior: reducedMotion ? "auto" : "smooth",
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [inboxExpanded]);

  const openNotification = useCallback((notification: AgentNotification) => {
    if (notification.deepLink && isSafeDeepLink(notification.deepLink)) {
      navigateDeepLink(notification.deepLink);
    }
    void removeNotification(notification.id);
  }, []);

  const dismissNotification = useCallback((id: string) => {
    void removeNotification(id);
  }, []);

  const {
    allGroupRowsByKey,
    allGroups,
    quietNotifications,
    restedGroupKeys,
    restedGroups,
  } = useMemo(() => {
    const capped = orderDashboardNotifications(notifications).slice(
      0,
      MAX_RENDERED_ROWS,
    );
    const grouped = groupDashboardNotifications(capped);
    const rested = grouped.flatMap((group) => {
      const rows = group.rows.filter(isInterruptPriority);
      return rows.length > 0 ? [{ ...group, rows }] : [];
    });
    return {
      allGroupRowsByKey: new Map(
        grouped.map((group) => [group.key, group.rows]),
      ),
      allGroups: grouped,
      quietNotifications: capped.filter(
        (notification) => !isInterruptPriority(notification),
      ),
      restedGroupKeys: new Set(rested.map((group) => group.key)),
      restedGroups: rested,
    };
  }, [notifications]);

  const hiddenQuietCount = useMemo(() => {
    if (inboxExpanded) return 0;
    const revealedIds = new Set<string>();
    for (const key of expandedStacks) {
      for (const row of allGroupRowsByKey.get(key) ?? []) {
        revealedIds.add(row.id);
      }
    }
    return quietNotifications.filter(
      (notification) => !revealedIds.has(notification.id),
    ).length;
  }, [allGroupRowsByKey, expandedStacks, inboxExpanded, quietNotifications]);

  useEffect(() => {
    if (notifications.length > 0) return;
    setInboxExpanded(false);
    setExpandedStacks(new Set());
  }, [notifications.length]);

  if (hydrationStatus === "failed" && notifications.length === 0) {
    return (
      <section
        aria-label="Notifications"
        data-testid="home-notification-center"
        className="relative w-full px-1.5 py-1 text-white"
      >
        <style>{NOTIF_SCROLL_CSS}</style>
        <LiquidGlassRefractionDefs />
        <div
          role="alert"
          data-testid="notifications-unavailable"
          className="eliza-notif-glass flex items-center justify-between gap-3 rounded-2xl px-4 py-3"
        >
          <span className="text-sm text-white/75">
            Notifications unavailable
          </span>
          <button
            type="button"
            aria-label="Retry loading notifications"
            onClick={() => void retryNotificationHydration()}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-white/60 transition-colors hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50"
          >
            <RefreshCw aria-hidden className="h-4 w-4" />
          </button>
        </div>
      </section>
    );
  }

  // Hydration must settle before an empty result is trusted. An empty inbox has
  // no gesture band: it occupies no layout space above Apps.
  if (!hydrated && notifications.length === 0) return null;
  if (notifications.length === 0) return null;

  const groups = inboxExpanded ? allGroups : restedGroups;
  const showModeToggle = inboxExpanded || hiddenQuietCount > 0;

  return (
    <section
      aria-label="Notifications"
      data-testid="home-notification-center"
      className="eliza-notif-center-in relative w-full overflow-hidden text-white"
    >
      <style>{NOTIF_SCROLL_CSS}</style>
      <LiquidGlassRefractionDefs />
      <ul
        id="home-notification-list"
        ref={scrollRef}
        data-testid="home-notification-list"
        data-shade-mode={inboxExpanded ? "expanded" : "rested"}
        data-inbox-mode={inboxExpanded ? "all" : "priority"}
        className={cn(
          "eliza-notif-scroll relative flex touch-pan-y select-none flex-col gap-2 overflow-y-auto overflow-x-hidden overscroll-y-contain px-1.5 py-1",
          "scroll-fade scroll-fade-t-[1.25rem] scroll-fade-b-[1.5rem]",
        )}
        style={{ maxHeight: NOTIFICATION_LIST_MAX_HEIGHT }}
      >
        {groups.map((group) => {
          const allGroupRows = allGroupRowsByKey.get(group.key) ?? group.rows;
          const stackExpanded = expandedStacks.has(group.key);
          // Fanning a producer always exposes the producer's complete rows,
          // even while the inbox remains in priority mode.
          const fanned = stackExpanded && allGroupRows.length > 1;
          const stacked = !fanned && allGroupRows.length > 1;
          const peeks = allGroupRows.slice(1, MAX_VISIBLE_STACK_LAYERS);
          const stackTailPx =
            peeks.length * STACK_PEEK_OFFSET_PX +
            (peeks.length > 0 ? STACK_BOTTOM_CLEARANCE_PX : 0);
          const rows = fanned
            ? allGroupRows
            : [group.rows[0] as AgentNotification];
          const newlyRevealed =
            inboxExpanded && !restedGroupKeys.has(group.key);

          return (
            <motion.li
              key={group.key}
              layout="position"
              transition={{ layout: STACK_LAYOUT_TRANSITION }}
              data-notification-group=""
              data-inbox-newly-revealed={newlyRevealed ? "" : undefined}
              className={cn("relative flex flex-col", fanned && "pb-2")}
            >
              <div
                data-notification-group-content=""
                data-notification-stacked={stacked ? "" : undefined}
                data-testid={stacked ? "notification-stack" : undefined}
                className="relative flex flex-col"
                style={{ paddingBottom: stacked ? stackTailPx : 0 }}
              >
                {fanned ? (
                  <div
                    data-testid="notification-stack-controls"
                    className="flex h-9 items-center justify-between gap-3 px-2"
                  >
                    <span className="truncate text-xs font-semibold text-white/55">
                      {group.label}
                    </span>
                    <button
                      type="button"
                      data-testid="notification-stack-collapse"
                      data-notif-control=""
                      onClick={() => collapseStack(group.key)}
                      className="h-8 shrink-0 px-2 text-xs font-medium text-white/60 transition-colors hover:text-white/90"
                    >
                      Show Less
                    </button>
                  </div>
                ) : null}
                <motion.ul
                  layout="position"
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
                        rowIndex === 0 && stacked ? group.key : undefined
                      }
                      stackCount={
                        rowIndex === 0 && stacked
                          ? allGroupRows.length
                          : undefined
                      }
                      onExpandStack={expandStack}
                      onOpen={openNotification}
                      onDismiss={dismissNotification}
                    />
                  ))}
                </motion.ul>
                {stacked
                  ? peeks.map((peek, index) => (
                      <button
                        key={peek.id}
                        type="button"
                        data-testid="notification-stack-peek"
                        data-notif-control=""
                        aria-label={`Show all ${allGroupRows.length} ${group.label} notifications`}
                        onClick={() => expandStack(group.key)}
                        className="eliza-notif-glass eliza-notif-stack-peek absolute inset-x-0 top-0 rounded-2xl"
                        style={{
                          bottom: stackTailPx,
                          zIndex: 1 - index,
                          transform: `translateY(${(index + 1) * STACK_PEEK_OFFSET_PX}px) scale(${
                            1 - (index + 1) * 0.015
                          })`,
                        }}
                      />
                    ))
                  : null}
              </div>
            </motion.li>
          );
        })}
      </ul>
      {showModeToggle ? (
        <button
          type="button"
          data-testid="notifications-mode-toggle"
          data-notif-control=""
          aria-expanded={inboxExpanded}
          aria-controls="home-notification-list"
          aria-label={
            inboxExpanded
              ? "Show priority notifications only"
              : `Show ${hiddenQuietCount} more notification${hiddenQuietCount === 1 ? "" : "s"}`
          }
          onClick={toggleInboxMode}
          className="mt-1 flex h-8 w-full items-center justify-center gap-1 text-2xs font-medium text-white/55 transition-colors hover:text-white/80"
        >
          {inboxExpanded ? "Show Less" : `${hiddenQuietCount} More`}
          {inboxExpanded ? (
            <ChevronUp aria-hidden className="h-3 w-3 shrink-0" />
          ) : (
            <ChevronDown aria-hidden className="h-3 w-3 shrink-0" />
          )}
        </button>
      ) : null}
    </section>
  );
}
