import { useEffect, useState } from "react";
import {
  CLOUD_HANDOFF_PHASE_EVENT,
  type CloudHandoffPhaseDetail,
} from "../events";

// How long a terminal phase lingers before the banner self-clears. `migrating`
// has no timer — it persists until the swap resolves (the container boot can
// take 60-90s).
const SUCCESS_LINGER_MS = 4000;
const FAILURE_LINGER_MS = 6000;

/**
 * Subscribe to the shared→dedicated cloud-agent handoff lifecycle
 * ({@link CLOUD_HANDOFF_PHASE_EVENT}) so a progress indicator can render it.
 * The backend already drives the whole handoff (instant chat on the shared
 * adapter → silent history import → atomic client swap) and emits the phase;
 * this hook just exposes the latest phase and auto-clears the terminal ones so
 * the banner dismisses itself. Returns `null` when there is nothing to show.
 */
export function useCloudHandoffPhase(): CloudHandoffPhaseDetail | null {
  const [detail, setDetail] = useState<CloudHandoffPhaseDetail | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onPhase = (event: Event) => {
      const next = (event as CustomEvent<CloudHandoffPhaseDetail>).detail;
      if (next) setDetail(next);
    };
    window.addEventListener(CLOUD_HANDOFF_PHASE_EVENT, onPhase);
    return () => window.removeEventListener(CLOUD_HANDOFF_PHASE_EVENT, onPhase);
  }, []);

  useEffect(() => {
    if (!detail || detail.phase === "migrating") return;
    const lingerMs =
      detail.phase === "timed-out" || detail.phase === "failed"
        ? FAILURE_LINGER_MS
        : SUCCESS_LINGER_MS;
    const id = window.setTimeout(() => setDetail(null), lingerMs);
    return () => window.clearTimeout(id);
  }, [detail]);

  return detail;
}
