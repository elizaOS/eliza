/**
 * Per-view runtime telemetry profiler (issue #10202, criterion #5).
 *
 * Mounted by `KeepAliveViewHost` inside each view slot (between the error
 * boundary and the view). It does two things, both gated behind
 * `isRenderTelemetryEnabled()` so production is a pure pass-through:
 *
 *  1. wraps the view in a React `<Profiler>` to accumulate this view's render
 *     count + commit durations (the per-view number the single tree-wide
 *     AppRoot Profiler in main.tsx cannot give);
 *  2. on every lifecycle transition (show/hide/pause/evict) emits a
 *     `view-runtime-telemetry` sample carrying render count, p95 commit
 *     duration, JS heap (`performance.memory`, when present), and the
 *     `resource-counters` snapshot (active subscriptions / pending timers /
 *     heavy resources) for that view.
 *
 * So a leaking/expensive view is visible in the saved telemetry ring + logs,
 * not just in a devtools session.
 */

import {
  Profiler,
  type ProfilerOnRenderCallback,
  useCallback,
  useEffect,
  useRef,
} from "react";
import { percentile } from "../../hooks/frame-budget";
import {
  currentRoute,
  ERROR_THRESHOLD,
  emitRenderTelemetry,
  INFO_THRESHOLD,
  isRenderTelemetryEnabled,
  nextRenderTelemetrySequence,
  type RenderTelemetrySeverity,
  WINDOW_MS,
} from "../../hooks/useRenderGuard";
import { snapshotResourceCounters } from "../../perf/resource-counters";
import { resolveHeapUsage } from "../../state/bounded-view-lru";
import { useViewLifecycle } from "../../state/useViewLifecycle";
import type { ViewLifecyclePhase } from "../../state/view-lifecycle-types";
import {
  emitViewRuntimeTelemetry,
  installViewRuntimeTelemetryRing,
  type ViewRuntimeTelemetryReason,
} from "../../view-runtime-telemetry";

function readJsHeapUsedSize(): number | undefined {
  return resolveHeapUsage()?.usedJSHeapSize;
}

export interface ViewTelemetryProfilerProps {
  viewId: string;
  children: React.ReactNode;
}

export function ViewTelemetryProfiler({
  viewId,
  children,
}: ViewTelemetryProfilerProps): React.JSX.Element {
  const commitDurations = useRef<number[]>([]);
  const renderCount = useRef(0);
  const lastCommitMs = useRef(0);
  // Sliding 1s window of commit timestamps for per-view rerender-storm
  // detection (the per-view analogue of RenderTelemetryProfiler, which only
  // watches the whole tree). A storm in one view emits on the shared
  // RENDER_TELEMETRY_EVENT channel tagged with this viewId, so a fanout bug is
  // attributable to the offending view.
  const commitWindow = useRef<number[]>([]);
  const lastStormSeverity = useRef<RenderTelemetrySeverity | null>(null);

  // The Profiler callback runs at COMMIT time, not during render — useCallback
  // so the (commit-time) clock read is classified as deferred, not render-time
  // nondeterminism, matching the audit's treatment of callback args.
  const onRender = useCallback<ProfilerOnRenderCallback>(
    (_, phase, actualDuration, baseDuration, startTime, commitTime) => {
      renderCount.current += 1;
      lastCommitMs.current = actualDuration;
      const durations = commitDurations.current;
      durations.push(actualDuration);
      // Keep the window bounded so p95 stays cheap and recent.
      if (durations.length > 256) durations.shift();

      if (!isRenderTelemetryEnabled()) return;
      const now = Date.now();
      const win = commitWindow.current;
      win.push(now);
      while (win.length > 0 && win[0] < now - WINDOW_MS) win.shift();
      if (win.length < INFO_THRESHOLD) {
        lastStormSeverity.current = null;
        return;
      }
      const severity: RenderTelemetrySeverity =
        win.length >= ERROR_THRESHOLD ? "error" : "info";
      if (lastStormSeverity.current === severity) return;
      if (lastStormSeverity.current === "error") return;
      lastStormSeverity.current = severity;
      emitRenderTelemetry({
        source: "ReactProfiler",
        name: viewId,
        severity,
        phase,
        actualDuration,
        baseDuration,
        startTime,
        commitTime,
        updateCount: win.length,
        threshold: severity === "error" ? ERROR_THRESHOLD : INFO_THRESHOLD,
        windowMs: WINDOW_MS,
        at: now,
        sequence: nextRenderTelemetrySequence(),
        route: currentRoute(),
      });
    },
    [viewId],
  );

  const emit = useCallback(
    (phase: ViewLifecyclePhase, reason: ViewRuntimeTelemetryReason) => {
      if (!isRenderTelemetryEnabled()) return;
      installViewRuntimeTelemetryRing();
      const snap = snapshotResourceCounters(viewId);
      emitViewRuntimeTelemetry({
        viewId,
        phase,
        reason,
        renderCount: renderCount.current,
        lastCommitMs: lastCommitMs.current,
        commitDurationP95Ms: percentile(commitDurations.current, 95),
        jsHeapUsedSize: readJsHeapUsedSize(),
        activeSubscriptions: snap.activeSubscriptions,
        pendingTimers: snap.pendingTimers,
        heavyResources: snap.heavyResources,
      });
    },
    [viewId],
  );

  useEffect(() => {
    emit("active", "show");
  }, [emit]);

  useViewLifecycle({
    onShow: () => emit("active", "show"),
    onHide: () => emit("inactive", "hide"),
    onPause: () => emit("paused", "pause"),
    onResume: () => emit("active", "resume"),
    onEvict: () => emit("evicted", "evict"),
  });

  if (!isRenderTelemetryEnabled()) {
    return <>{children}</>;
  }

  return (
    <Profiler id={viewId} onRender={onRender}>
      {children}
    </Profiler>
  );
}
