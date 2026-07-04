/**
 * Conversation-swipe jank telemetry (#9954).
 *
 * The frame-budget HUD (useFrameBudgetMonitor) only runs behind the explicit
 * `__ELIZA_PERF_HUD__` dev opt-in, so a swipe-jank regression is invisible
 * outside a dev session. This hook scopes a FrameBudgetSampler to the lifetime
 * of a single conversation-swipe gesture: it starts sampling rAF deltas +
 * long-tasks when the gesture begins and, on release, flushes the summary into
 * the bounded view-interaction telemetry ring as a `conversation-swipe-jank`
 * event. The drop-frame %, p95 frame time, and fps are therefore observable in
 * the same ring every other interaction lands in — no HUD required.
 *
 * The math is the shared, unit-tested frame-budget summarizer; this file is
 * only the per-gesture lifecycle glue.
 */

import { useCallback, useEffect, useRef } from "react";
import { emitConversationSwipeJank } from "../view-telemetry";
import { type FrameBudget, FrameBudgetSampler } from "./frame-budget";

export interface ConversationSwipeJankHandle {
  /** Begin sampling — call when a swipe gesture starts driving the drag. */
  begin: () => void;
  /**
   * Flush the sampled window as a telemetry event and stop sampling. Pass the
   * committed swipe `direction` ("prev"/"next") so the emitted event attributes
   * the jank to a navigation; omit it for a cancelled drag that settled back.
   */
  end: (direction?: "prev" | "next") => void;
}

/**
 * Sample frame budget over a single conversation-swipe gesture and emit the
 * summary to the telemetry ring on release. `begin` is idempotent (a no-op while
 * already sampling) so the per-frame `onDragX` can call it on every move without
 * restarting the window; `end` flushes + resets so the next gesture starts clean.
 */
export function useConversationSwipeJank(
  budget?: FrameBudget,
): ConversationSwipeJankHandle {
  const samplerRef = useRef<FrameBudgetSampler | null>(null);

  const getSampler = useCallback((): FrameBudgetSampler => {
    if (!samplerRef.current) {
      samplerRef.current = new FrameBudgetSampler(
        budget ? { budget } : undefined,
      );
    }
    return samplerRef.current;
  }, [budget]);

  const begin = useCallback(() => {
    const sampler = getSampler();
    if (sampler.running) return;
    sampler.reset();
    sampler.start();
  }, [getSampler]);

  const end = useCallback((direction?: "prev" | "next") => {
    const sampler = samplerRef.current;
    if (!sampler?.running) return;
    const summary = sampler.summary();
    sampler.stop();
    // A gesture with no settled frames (instant commit, e.g. a synthetic test
    // pointer with no rAF tick) yields an empty window — nothing meaningful to
    // report, so skip the event rather than emit a zeroed summary.
    if (summary.sampleCount === 0) return;
    emitConversationSwipeJank(summary, direction);
  }, []);

  // Stop any in-flight sampler if the overlay unmounts mid-gesture.
  useEffect(
    () => () => {
      samplerRef.current?.stop();
    },
    [],
  );

  return { begin, end };
}
