import { logger } from "@polyagent/shared";
import { useCallback, useEffect, useRef, useState } from "react";

export interface PullToRefreshOptions {
  onRefresh: () => Promise<void> | void;
  threshold?: number;
  maxPullDistance?: number;
  enabled?: boolean;
}

export interface PullToRefreshReturn {
  pullDistance: number;
  isRefreshing: boolean;
  containerRef: (node: HTMLDivElement | null) => void;
  triggerRefresh: () => void;
}

interface PTRListeners {
  start: (e: TouchEvent) => void;
  move: (e: TouchEvent) => void;
  end: () => void;
  wheel: (e: WheelEvent) => void;
}

interface HTMLDivElementWithPTR extends HTMLDivElement {
  _ptrListeners?: PTRListeners;
}

/**
 * Hook for implementing pull-to-refresh functionality.
 *
 * Supports both touch gestures (mobile) and mouse wheel (desktop) for triggering
 * refresh actions. Provides visual feedback during pull and handles edge cases
 * like preventing duplicate refreshes and managing scroll state.
 *
 * Features:
 * - Touch gesture support for mobile devices
 * - Mouse wheel support for desktop
 * - Visual pull distance feedback
 * - Automatic refresh triggering at threshold
 * - Prevents duplicate refresh calls
 * - Respects scroll position
 *
 * @param options - Configuration options including refresh callback and thresholds
 *
 * @returns Pull-to-refresh state and control functions:
 * - `pullDistance`: Current pull distance in pixels
 * - `isRefreshing`: Whether refresh is currently in progress
 * - `containerRef`: Ref callback to attach to scrollable container
 * - `triggerRefresh`: Function to manually trigger refresh
 *
 * @example
 * const { pullDistance, isRefreshing, containerRef } = usePullToRefresh({
 *   onRefresh: async () => {
 *     await fetchData();
 *   },
 *   threshold: 80,
 *   maxPullDistance: 150
 * });
 */
export function usePullToRefresh(
  options: PullToRefreshOptions,
): PullToRefreshReturn {
  const {
    onRefresh,
    threshold = 80,
    maxPullDistance = 150,
    enabled = true,
  } = options;

  const [pullDistance, setPullDistance] = useState(0);
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Refs to prevent race conditions
  const isRefreshingRef = useRef(false);
  const hasTriggeredRef = useRef(false);
  const touchStartY = useRef<number>(0);
  const isPulling = useRef<boolean>(false);
  const wheelAccumulator = useRef<number>(0);
  const wheelResetTimer = useRef<NodeJS.Timeout | null>(null);
  const rafRef = useRef<number | null>(null);
  const nodeRef = useRef<HTMLDivElement | null>(null);
  const lastWheelTriggerRef = useRef<number>(0);

  const triggerRefresh = useCallback(async () => {
    // Check and set locks atomically - only the first caller proceeds
    if (hasTriggeredRef.current || isRefreshingRef.current) {
      logger.debug("[PTR] Already refreshing, ignoring duplicate call");
      return;
    }

    // Set locks immediately
    logger.debug("[PTR] Setting locks and starting refresh");
    hasTriggeredRef.current = true;
    isRefreshingRef.current = true;

    // Clear wheel accumulator immediately
    wheelAccumulator.current = 0;
    if (wheelResetTimer.current) {
      clearTimeout(wheelResetTimer.current);
      wheelResetTimer.current = null;
    }

    // Lock and show spinner
    setIsRefreshing(true);
    setPullDistance(threshold);

    try {
      await onRefresh();
    } finally {
      logger.debug("[PTR] Refresh complete");
      // Keep spinner visible briefly
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Hide
      setIsRefreshing(false);
      setPullDistance(0);

      // Reset locks after animation (with additional buffer to prevent rapid re-triggers)
      setTimeout(() => {
        logger.debug("[PTR] Locks reset");
        hasTriggeredRef.current = false;
        isRefreshingRef.current = false;
        wheelAccumulator.current = 0;
        lastWheelTriggerRef.current = Date.now();
      }, 500);
    }
  }, [onRefresh, threshold]);

  const setContainerRef = useCallback(
    (node: HTMLDivElement | null) => {
      // Cleanup
      if (nodeRef.current) {
        const old = nodeRef.current as HTMLDivElementWithPTR;
        const listeners = old._ptrListeners;
        if (listeners) {
          old.removeEventListener("touchstart", listeners.start);
          old.removeEventListener("touchmove", listeners.move);
          old.removeEventListener("touchend", listeners.end);
          old.removeEventListener("wheel", listeners.wheel);
        }
      }

      if (!node || !enabled) {
        nodeRef.current = null;
        return;
      }

      nodeRef.current = node;

      // Helper to get actual scroll position (works with both node and document)
      const getScrollTop = (): number => {
        return (document.scrollingElement?.scrollTop ?? 0) || node.scrollTop;
      };

      // === TOUCH HANDLERS ===
      const onTouchStart = (e: TouchEvent) => {
        if (getScrollTop() === 0 && !hasTriggeredRef.current) {
          touchStartY.current = e.touches[0]?.clientY ?? 0;
          isPulling.current = true;
        }
      };

      const onTouchMove = (e: TouchEvent) => {
        if (
          !isPulling.current ||
          hasTriggeredRef.current ||
          getScrollTop() > 0
        ) {
          isPulling.current = false;
          return;
        }

        const touchY = e.touches[0]?.clientY ?? 0;
        const distance = touchY - touchStartY.current;

        if (distance > 10) {
          e.preventDefault();

          // Use RAF to batch updates
          if (rafRef.current) cancelAnimationFrame(rafRef.current);
          rafRef.current = requestAnimationFrame(() => {
            setPullDistance(Math.min(distance, maxPullDistance));
          });
        }
      };

      const onTouchEnd = () => {
        if (!isPulling.current) return;
        isPulling.current = false;

        if (
          pullDistance > threshold &&
          !hasTriggeredRef.current &&
          !isRefreshingRef.current
        ) {
          // triggerRefresh will set locks internally
          triggerRefresh();
        } else {
          setPullDistance(0);
        }
      };

      // === WHEEL HANDLER ===
      const onWheel = (e: WheelEvent) => {
        const scrollTop = getScrollTop();

        const now = Date.now();
        if (now - lastWheelTriggerRef.current < 800) {
          wheelAccumulator.current = 0;
          return;
        }
        // Block all wheel events if already triggered or refreshing
        if (hasTriggeredRef.current || isRefreshingRef.current) {
          wheelAccumulator.current = 0;
          if (wheelResetTimer.current) {
            clearTimeout(wheelResetTimer.current);
            wheelResetTimer.current = null;
          }
          return;
        }

        if (scrollTop > 0) {
          wheelAccumulator.current = 0;
          return;
        }

        // Scroll up at top
        if (e.deltaY < 0) {
          e.preventDefault();

          // Accumulate
          wheelAccumulator.current += Math.abs(e.deltaY) * 3;
          const distance = Math.min(wheelAccumulator.current, maxPullDistance);

          // Use RAF to batch updates for smooth animation
          if (rafRef.current) cancelAnimationFrame(rafRef.current);
          rafRef.current = requestAnimationFrame(() => {
            // Double-check locks before updating UI
            if (!hasTriggeredRef.current && !isRefreshingRef.current) {
              setPullDistance(distance);
            }
          });

          // Clear reset timer
          if (wheelResetTimer.current) {
            clearTimeout(wheelResetTimer.current);
            wheelResetTimer.current = null;
          }

          // Trigger at threshold
          if (
            distance >= threshold &&
            !hasTriggeredRef.current &&
            !isRefreshingRef.current
          ) {
            logger.debug("[PTR Wheel] Triggering at distance:", { distance });
            // Clear accumulator before triggering
            wheelAccumulator.current = 0;
            lastWheelTriggerRef.current = now;
            // triggerRefresh will set locks internally
            triggerRefresh();
          } else if (distance < threshold) {
            // Reset if stops scrolling
            wheelResetTimer.current = setTimeout(() => {
              if (!hasTriggeredRef.current && !isRefreshingRef.current) {
                wheelAccumulator.current = 0;
                setPullDistance(0);
              }
            }, 200);
          }
        }
      };

      // Attach
      node.addEventListener("touchstart", onTouchStart, { passive: false });
      node.addEventListener("touchmove", onTouchMove, { passive: false });
      node.addEventListener("touchend", onTouchEnd, { passive: false });
      node.addEventListener("wheel", onWheel, { passive: false });

      // Store for cleanup
      (node as HTMLDivElementWithPTR)._ptrListeners = {
        start: onTouchStart,
        move: onTouchMove,
        end: onTouchEnd,
        wheel: onWheel,
      };
    },
    [enabled, pullDistance, threshold, maxPullDistance, triggerRefresh],
  );

  // Cleanup
  useEffect(() => {
    return () => {
      if (nodeRef.current) {
        const listeners = (nodeRef.current as HTMLDivElementWithPTR)
          ._ptrListeners;
        if (listeners) {
          nodeRef.current.removeEventListener("touchstart", listeners.start);
          nodeRef.current.removeEventListener("touchmove", listeners.move);
          nodeRef.current.removeEventListener("touchend", listeners.end);
          nodeRef.current.removeEventListener("wheel", listeners.wheel);
        }
      }
      if (wheelResetTimer.current) clearTimeout(wheelResetTimer.current);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  return {
    pullDistance,
    isRefreshing,
    containerRef: setContainerRef,
    triggerRefresh,
  };
}
