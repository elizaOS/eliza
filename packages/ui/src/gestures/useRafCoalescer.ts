/**
 * rAF-paced value coalescer for high-frequency gesture updates.
 *
 * A trackpad/touch panel emits pointer/touch moves well above the display
 * refresh (up to ~1000Hz), and each drag update fans out to a MotionValue
 * subscriber, a React setState, or a direct rail write — running that more than
 * once per painted frame is pure waste (only the last value is shown). This
 * schedules at most one flush per animation frame and always delivers the LATEST
 * pending value. `schedule` batches; `flush` forces the pending value out now (a
 * release must apply the final drag before deciding); `cancel` drops it.
 *
 * When `requestAnimationFrame` is unavailable (SSR / some test envs) the flush
 * runs synchronously so callers never lose the final value.
 */

import * as React from "react";

export interface RafCoalescer<T> {
  /** Queue `value`; it is delivered to the sink on the next animation frame. */
  schedule: (value: T) => void;
  /** If a frame is pending, run it NOW (cancels the queued frame first). */
  flush: () => void;
  /** Drop any pending frame + value without delivering it. */
  cancel: () => void;
}

// Read fresh per call (not a module-load const): SSR/jsdom without a stub, or a
// test that toggles the global, must be observed at the moment of use.
function raf(cb: FrameRequestCallback): number | null {
  return typeof requestAnimationFrame === "function"
    ? requestAnimationFrame(cb)
    : null;
}
function cancelRaf(handle: number): void {
  if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(handle);
}

/**
 * `sink` receives the coalesced value once per frame. Pass a ref-backed callback
 * (or a stable one) so the coalescer's own identity never changes between
 * renders — the returned object is stable for the component's lifetime.
 */
export function useRafCoalescer<T>(sink: (value: T) => void): RafCoalescer<T> {
  const sinkRef = React.useRef(sink);
  sinkRef.current = sink;

  const pending = React.useRef<{ value: T } | null>(null);
  const rafId = React.useRef(0);

  const flushNow = React.useCallback(() => {
    rafId.current = 0;
    const next = pending.current;
    pending.current = null;
    if (next) sinkRef.current(next.value);
  }, []);

  const schedule = React.useCallback(
    (value: T) => {
      pending.current = { value };
      if (rafId.current !== 0) return; // a frame is already pending
      // Mark the frame pending BEFORE scheduling: a synchronous rAF (some test
      // envs run the callback inline) clears rafId inside flushNow, and assigning
      // the returned handle afterwards would re-mark the frame as pending forever
      // — swallowing every later value of the gesture.
      rafId.current = -1;
      const handle = raf(flushNow);
      if (handle === null) {
        // No rAF available (SSR / jsdom without a stub): deliver synchronously so
        // the caller never loses the value. flushNow already reset rafId to 0.
        if (rafId.current === -1) {
          rafId.current = 0;
          flushNow();
        }
        return;
      }
      if (rafId.current === -1) rafId.current = handle;
    },
    [flushNow],
  );

  const flush = React.useCallback(() => {
    if (rafId.current > 0) cancelRaf(rafId.current);
    flushNow();
  }, [flushNow]);

  const cancel = React.useCallback(() => {
    if (rafId.current > 0) cancelRaf(rafId.current);
    rafId.current = 0;
    pending.current = null;
  }, []);

  // Drop any in-flight frame if the consumer unmounts mid-gesture.
  React.useEffect(() => cancel, [cancel]);

  return { schedule, flush, cancel };
}
