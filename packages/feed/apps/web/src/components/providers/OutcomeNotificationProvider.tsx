"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type OutcomeNotification,
  OutcomeNotificationPopup,
} from "@/components/notifications/OutcomeNotificationPopup";
import { StackedSummaryPopup } from "@/components/notifications/StackedSummaryPopup";
import { useMarketOutcomeListener } from "@/hooks/useMarketOutcomeListener";
import { useQueuedOutcomes } from "@/hooks/useQueuedOutcomes";

interface OutcomeNotificationContextValue {
  /** Show a single win/loss outcome notification pop-up */
  showOutcome: (notification: Omit<OutcomeNotification, "id">) => void;
  /** Show a stacked summary for multiple outcomes (e.g. user was away) */
  showBatchOutcomes: (notifications: Omit<OutcomeNotification, "id">[]) => void;
}

const OutcomeNotificationContext =
  createContext<OutcomeNotificationContextValue | null>(null);

/** Access outcome notification actions. Throws if used outside OutcomeNotificationProvider. */
export function useOutcomeNotification(): OutcomeNotificationContextValue {
  const ctx = useContext(OutcomeNotificationContext);
  if (!ctx)
    throw new Error(
      "useOutcomeNotification requires OutcomeNotificationProvider",
    );
  return ctx;
}

function makeId(): string {
  return crypto.randomUUID();
}

/**
 * Mounts SSE listener + queued notification delivery inside the provider tree,
 * so both hooks have access to the outcome notification context.
 */
function OutcomeNotificationListeners() {
  useMarketOutcomeListener();
  useQueuedOutcomes();
  return null;
}

type ActiveMode = "idle" | "single" | "batch";

/**
 * Provides win/loss outcome notification pop-ups with mutual exclusion.
 *
 * Only one overlay (single pop-up OR stacked summary) is ever visible at a time.
 * When one is active and the other is requested, the incoming request is deferred
 * to refs (not state) so it doesn't trigger a render. Deferred items are shown
 * when the active overlay dismisses.
 *
 * Transition rules:
 * - idle + showOutcome → show single, mode = 'single'
 * - idle + showBatch  → show batch, mode = 'batch'
 * - single + showOutcome → queue to singleQueueRef
 * - single + showBatch  → store in pendingBatchRef
 * - batch + showOutcome  → queue to singleQueueRef
 * - batch + showBatch   → ignore (already showing batch)
 *
 * Dismiss transitions:
 * - single dismissed, queue not empty → show next single
 * - single dismissed, queue empty, pending batch → show batch, mode = 'batch'
 * - single dismissed, queue empty, no batch → mode = 'idle'
 * - batch dismissed, singles queued → show first single, mode = 'single'
 * - batch dismissed, nothing queued → mode = 'idle'
 */
export function OutcomeNotificationProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  // Rendering state — only one is non-empty at a time
  const [current, setCurrent] = useState<OutcomeNotification | null>(null);
  const [batchNotifications, setBatchNotifications] = useState<
    OutcomeNotification[]
  >([]);

  // Refs for arbitration — deferred items live here, not in state
  const modeRef = useRef<ActiveMode>("idle");
  const singleQueueRef = useRef<OutcomeNotification[]>([]);
  const pendingBatchRef = useRef<OutcomeNotification[] | null>(null);

  const showOutcome = useCallback(
    (notification: Omit<OutcomeNotification, "id">) => {
      const full: OutcomeNotification = { ...notification, id: makeId() };

      if (modeRef.current === "idle") {
        modeRef.current = "single";
        setCurrent(full);
      } else {
        // Both 'single' and 'batch' → queue for later
        singleQueueRef.current.push(full);
      }
    },
    [],
  );

  const showBatchOutcomes = useCallback(
    (notifications: Omit<OutcomeNotification, "id">[]) => {
      if (notifications.length === 0) return;

      // Single item → treat as single notification
      if (notifications.length === 1) {
        showOutcome(notifications[0]!);
        return;
      }

      const full = notifications.map((n) => ({ ...n, id: makeId() }));

      if (modeRef.current === "idle") {
        modeRef.current = "batch";
        setBatchNotifications(full);
      } else if (modeRef.current === "single") {
        // Defer — store in ref, show when single queue drains
        pendingBatchRef.current = full;
      }
      // If already in 'batch' mode, ignore (don't stack batches)
    },
    [showOutcome],
  );

  const handleDismiss = useCallback(() => {
    // Single dismissed — check what's next
    if (singleQueueRef.current.length > 0) {
      // More singles in queue → show next
      const next = singleQueueRef.current.shift();
      if (next) {
        setCurrent(next);
        return;
      }
    }

    // Single queue empty — check for pending batch
    setCurrent(null);

    if (pendingBatchRef.current) {
      const batch = pendingBatchRef.current;
      pendingBatchRef.current = null;
      modeRef.current = "batch";
      setBatchNotifications(batch);
    } else {
      modeRef.current = "idle";
    }
  }, []);

  const handleBatchDismiss = useCallback(() => {
    setBatchNotifications([]);

    // Check for queued singles
    if (singleQueueRef.current.length > 0) {
      const next = singleQueueRef.current.shift();
      if (next) {
        modeRef.current = "single";
        setCurrent(next);
        return;
      }
    }

    modeRef.current = "idle";
  }, []);

  const handleBatchViewResult = useCallback(() => {
    setBatchNotifications([]);

    // Same transition as dismiss — check for queued singles
    if (singleQueueRef.current.length > 0) {
      const next = singleQueueRef.current.shift();
      if (next) {
        modeRef.current = "single";
        setCurrent(next);
        return;
      }
    }

    modeRef.current = "idle";
  }, []);

  const value = useMemo(
    () => ({ showOutcome, showBatchOutcomes }),
    [showOutcome, showBatchOutcomes],
  );

  return (
    <OutcomeNotificationContext.Provider value={value}>
      {children}
      <OutcomeNotificationListeners />
      <OutcomeNotificationPopup
        notification={current}
        onDismiss={handleDismiss}
      />
      <StackedSummaryPopup
        notifications={batchNotifications}
        onDismiss={handleBatchDismiss}
        onViewResult={handleBatchViewResult}
      />
    </OutcomeNotificationContext.Provider>
  );
}
