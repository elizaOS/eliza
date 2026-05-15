import { useEffect, useState } from "react";
import {
  fetchTrajectoryDetail,
  fetchTrajectoryList,
  type TrajectoryDetail,
  type TrajectoryListItem,
} from "./api-client";

const POLL_MS = 700;

export interface PollingTrajectoryState {
  active: TrajectoryListItem | null;
  activeDetail: TrajectoryDetail | null;
  last: TrajectoryListItem | null;
  lastDetail: TrajectoryDetail | null;
  error: string | null;
  ready: boolean;
}

const INITIAL: PollingTrajectoryState = {
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
        const active =
          list.trajectories.find((t) => t.status === "active") ?? null;
        const last =
          list.trajectories.find((t) => t.status !== "active") ?? null;

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
          ready: true,
        });
      } catch (err) {
        if (cancelled) return;
        if (err instanceof DOMException && err.name === "AbortError") return;
        setState((prev) => ({
          ...prev,
          ready: true,
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
