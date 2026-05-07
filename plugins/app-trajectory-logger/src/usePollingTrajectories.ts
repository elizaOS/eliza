/**
 * Polling hook that drives the realtime trajectory widget.
 *
 * The runtime persists trajectories to SQL but does not emit a realtime
 * event stream — the simplest way to surface in-flight data is to poll the
 * existing list + detail endpoints. We poll the list at a slow cadence
 * (1.5s) to detect new trajectories and the active detail at a faster
 * cadence (700ms) so phase transitions feel live in the UI.
 */

import { useEffect, useRef, useState } from "react";
import {
  fetchTrajectoryDetail,
  fetchTrajectoryList,
  type TrajectoryDetail,
  type TrajectoryListItem,
} from "./api-client";

const LIST_POLL_MS = 1500;
const ACTIVE_DETAIL_POLL_MS = 700;
const COMPLETED_DETAIL_POLL_MS = 4000;

export interface PollingTrajectoryState {
  active: TrajectoryListItem | null;
  activeDetail: TrajectoryDetail | null;
  last: TrajectoryListItem | null;
  lastDetail: TrajectoryDetail | null;
  /** Last error message from the polling loop, if any. Cleared on next success. */
  error: string | null;
  /** True after the first list fetch settles (success or failure). */
  ready: boolean;
}

interface ListAndDetailController {
  cancel: () => void;
}

function startPollingLoop(
  setState: (
    update: (prev: PollingTrajectoryState) => PollingTrajectoryState,
  ) => void,
): ListAndDetailController {
  let cancelled = false;
  const controller = new AbortController();

  let lastSeenActiveId: string | null = null;
  let lastSeenLastId: string | null = null;

  let listTimer: ReturnType<typeof setTimeout> | null = null;
  let detailTimer: ReturnType<typeof setTimeout> | null = null;

  const tickList = async (): Promise<void> => {
    if (cancelled) return;
    try {
      const result = await fetchTrajectoryList({
        limit: 10,
        signal: controller.signal,
      });
      if (cancelled) return;

      const active =
        result.trajectories.find((t) => t.status === "active") ?? null;
      const last =
        result.trajectories.find((t) => t.status !== "active") ?? null;

      setState((prev) => ({
        ...prev,
        active,
        last,
        ready: true,
        error: null,
      }));

      lastSeenActiveId = active?.id ?? null;
      lastSeenLastId = last?.id ?? null;
    } catch (err) {
      if (cancelled) return;
      if (err instanceof DOMException && err.name === "AbortError") return;
      setState((prev) => ({
        ...prev,
        ready: true,
        error: err instanceof Error ? err.message : String(err),
      }));
    } finally {
      if (!cancelled) {
        listTimer = setTimeout(() => {
          void tickList();
        }, LIST_POLL_MS);
      }
    }
  };

  const tickDetail = async (): Promise<void> => {
    if (cancelled) return;
    const activeId = lastSeenActiveId;
    const lastId = lastSeenLastId;
    let nextDelay = COMPLETED_DETAIL_POLL_MS;

    try {
      if (activeId) {
        const detail = await fetchTrajectoryDetail(activeId, {
          signal: controller.signal,
        });
        if (cancelled) return;
        setState((prev) => ({ ...prev, activeDetail: detail }));
        nextDelay = ACTIVE_DETAIL_POLL_MS;
      } else {
        setState((prev) =>
          prev.activeDetail === null ? prev : { ...prev, activeDetail: null },
        );
      }

      if (lastId) {
        const detail = await fetchTrajectoryDetail(lastId, {
          signal: controller.signal,
        });
        if (cancelled) return;
        setState((prev) =>
          prev.lastDetail?.trajectory.id === detail.trajectory.id &&
          prev.lastDetail.trajectory.updatedAt === detail.trajectory.updatedAt
            ? prev
            : { ...prev, lastDetail: detail },
        );
      } else {
        setState((prev) =>
          prev.lastDetail === null ? prev : { ...prev, lastDetail: null },
        );
      }
    } catch (err) {
      if (cancelled) return;
      if (err instanceof DOMException && err.name === "AbortError") return;
      // Detail failures are less critical — list polling keeps going.
    } finally {
      if (!cancelled) {
        detailTimer = setTimeout(() => {
          void tickDetail();
        }, nextDelay);
      }
    }
  };

  void tickList();
  void tickDetail();

  return {
    cancel: () => {
      cancelled = true;
      controller.abort();
      if (listTimer) clearTimeout(listTimer);
      if (detailTimer) clearTimeout(detailTimer);
    },
  };
}

const INITIAL_STATE: PollingTrajectoryState = {
  active: null,
  activeDetail: null,
  last: null,
  lastDetail: null,
  error: null,
  ready: false,
};

export function usePollingTrajectories(
  enabled: boolean,
): PollingTrajectoryState {
  const [state, setState] = useState<PollingTrajectoryState>(INITIAL_STATE);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    if (!enabled) {
      setState(INITIAL_STATE);
      return undefined;
    }

    const controller = startPollingLoop((update) => {
      setState((prev) => update(prev));
    });

    return () => {
      controller.cancel();
    };
  }, [enabled]);

  return state;
}
