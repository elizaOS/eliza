/**
 * Render-count test tooling (real, fails-when-broken).
 *
 * A re-render is a React *commit* to a subtree. To catch unnecessary re-renders
 * (and lock them against regression), wrap the subtree under test in
 * {@link RenderProbe} and assert on the counter after an interaction — the
 * counter increments once per commit (mount + each update), exactly mirroring
 * React's own profiler. A regression that adds an extra commit makes the count
 * go up, so the assertion FAILS. This is not a heuristic: it counts the real
 * commits React performs.
 *
 * Two granularities:
 *  - {@link RenderProbe} (React.Profiler): counts commits of a whole subtree —
 *    use it to lock "this view does not re-render its children when X ticks".
 *  - {@link useRenderSpy}: increments a counter on every render of the component
 *    it's called in — use it to lock a single component's render count.
 *
 * Both are pure test instrumentation (no behavior change); they belong in
 * *.test.tsx files, not shipped UI.
 */

import { Profiler, type ProfilerOnRenderCallback, type ReactNode } from "react";

export interface RenderCounter {
  /** Total commits (mounts + updates). */
  count: number;
  /** Commits in the "mount" phase. */
  mounts: number;
  /** Commits in "update" / "nested-update" phases. */
  updates: number;
  /** Sum of React's actualDuration across commits (ms) — cost, not just count. */
  totalActualMs: number;
  /** Reset all tallies (e.g. to count only post-interaction commits). */
  reset(): void;
}

/** Create a fresh render counter for a test. */
export function makeRenderCounter(): RenderCounter {
  return {
    count: 0,
    mounts: 0,
    updates: 0,
    totalActualMs: 0,
    reset() {
      this.count = 0;
      this.mounts = 0;
      this.updates = 0;
      this.totalActualMs = 0;
    },
  };
}

export interface RenderProbeProps {
  /** Stable id for the profiled region (shown in failure messages). */
  id: string;
  /** The counter this probe writes commits into. */
  counter: RenderCounter;
  children: ReactNode;
}

/**
 * Wrap a subtree to count its React commits into `counter`. Every time React
 * commits this region (mount or update), the counter advances — so a test can
 * assert the exact number of renders an interaction triggers.
 */
export function RenderProbe({
  id,
  counter,
  children,
}: RenderProbeProps): React.JSX.Element {
  const onRender: ProfilerOnRenderCallback = (_id, phase, actualDuration) => {
    counter.count += 1;
    if (phase === "mount") counter.mounts += 1;
    else counter.updates += 1;
    counter.totalActualMs += actualDuration;
  };
  return (
    <Profiler id={id} onRender={onRender}>
      {children}
    </Profiler>
  );
}

/**
 * Increment `counter` on every render of the component that calls this hook.
 * Unlike {@link RenderProbe} (subtree commits), this counts a single
 * component's render function invocations — the tightest lock for "component X
 * must not re-render on an unrelated state change".
 */
export function useRenderSpy(counter: RenderCounter): void {
  counter.count += 1;
}
