/**
 * Tracks the cloud-handoff banner phase from CLOUD_HANDOFF_PHASE_EVENT. Terminal
 * phases linger briefly then self-clear; migrating/failed/timed-out persist until
 * the swap or a retry resolves so a failure is never silent.
 */
import { useEffect, useState } from "react";
import {
  CLOUD_HANDOFF_PHASE_EVENT,
  type CloudHandoffPhaseDetail,
} from "../events";

// How long a successful terminal phase lingers before the banner self-clears.
// `migrating` has no timer — it persists until the swap resolves (the container
// boot can take 60-90s). `timed-out`/`failed`/`insufficient-credits` also have
// NO timer: they stay until the user retries (or adds credits + retries), so a
// failure or the credit-gate prompt is never a silent auto-dismissed fallback.
const SUCCESS_LINGER_MS = 4000;

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
    if (!detail) return;
    // `migrating` persists until the swap resolves; `timed-out`/`failed`/
    // `insufficient-credits` persist until the user retries or adds credits (the
    // surface offers that path). Only the success phases self-dismiss.
    if (
      detail.phase === "migrating" ||
      detail.phase === "timed-out" ||
      detail.phase === "failed" ||
      detail.phase === "insufficient-credits"
    ) {
      return;
    }
    const id = window.setTimeout(() => setDetail(null), SUCCESS_LINGER_MS);
    return () => window.clearTimeout(id);
  }, [detail]);

  return detail;
}
