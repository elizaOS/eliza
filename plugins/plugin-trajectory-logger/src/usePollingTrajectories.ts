/**
 * React hook that polls `/api/trajectories` (and the per-id detail route) every
 * 700 ms and returns the active and most-recently-completed trajectory plus
 * their details. Uses an `AbortController` to cancel in-flight requests on
 * unmount. Distinguishes a genuine fetch error from the routes being absent
 * (404/503 when `@elizaos/plugin-training` is not mounted) via a separate
 * `unavailable` flag, so the view can degrade instead of showing an error.
 */
import { useEffect, useState } from "react";
import {
  fetchTrajectoryDetail,
  fetchTrajectoryList,
  type TrajectoryDetail,
  TrajectoryHttpError,
  type TrajectoryListItem,
} from "./api-client";

const POLL_MS = 700;

export interface PollingTrajectoryState {
  active: TrajectoryListItem | null;
  activeDetail: TrajectoryDetail | null;
  last: TrajectoryListItem | null;
  lastDetail: TrajectoryDetail | null;
  error: string | null;
  /**
   * True when the trajectory routes are not mounted on this surface (the
   * provider plugin is absent → 404/503). Distinct from `error`, which is for
   * genuine request failures. When set, the view shows a calm unavailable
   * state instead of leaking the raw HTTP error string.
   */
  unavailable: boolean;
  ready: boolean;
}

const INITIAL: PollingTrajectoryState = {
  active: null,
  activeDetail: null,
  last: null,
  lastDetail: null,
  error: null,
  unavailable: false,
  ready: false,
};

export function usePollingTrajectories(
  enabled: boolean,
): PollingTrajectoryState {
  const [state, setState] = useState<PollingTrajectoryState>(INITIAL);

  useEffect(() => {
    if (!enabled) {
      setState(INITIAL);
      return;
    }
    let cancelled = false;
    const ctrl = new AbortController();

    const tick = async (): Promise<void> => {
      try {
        const list = await fetchTrajectoryList({
          limit: 10,
          signal: ctrl.signal,
        });
        if (cancelled) return;
        const trajectories = Array.isArray(list.trajectories)
          ? list.trajectories
          : [];
        const active = trajectories.find((t) => t.status === "active") ?? null;
        const last = trajectories.find((t) => t.status !== "active") ?? null;

        const [activeDetail, lastDetail] = await Promise.all([
          active
            ? fetchTrajectoryDetail(active.id, { signal: ctrl.signal }).catch(
                () => null,
              )
            : Promise.resolve(null),
          last
            ? fetchTrajectoryDetail(last.id, { signal: ctrl.signal }).catch(
                () => null,
              )
            : Promise.resolve(null),
        ]);
        if (cancelled) return;
        setState({
          active,
          activeDetail,
          last,
          lastDetail,
          error: null,
          unavailable: false,
          ready: true,
        });
      } catch (err) {
        if (cancelled) return;
        if (err instanceof DOMException && err.name === "AbortError") return;
        if (err instanceof TrajectoryHttpError && err.isUnavailable) {
          setState((prev) => ({
            ...prev,
            ready: true,
            error: null,
            unavailable: true,
          }));
          return;
        }
        setState((prev) => ({
          ...prev,
          ready: true,
          unavailable: false,
          error: err instanceof Error ? err.message : String(err),
        }));
      } finally {
        if (!cancelled) setTimeout(tick, POLL_MS);
      }
    };

    void tick();
    return () => {
      cancelled = true;
      ctrl.abort();
    };
  }, [enabled]);

  return state;
}
