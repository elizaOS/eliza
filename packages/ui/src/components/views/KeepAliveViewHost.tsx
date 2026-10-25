/**
 * KeepAliveViewHost — the bounded, lifecycle-aware view host (issue #10202).
 *
 * Replaces ViewRouter's "render exactly one branch" with "render the active
 * view PLUS any retained keep-alive views, each in its own lifecycle slot,
 * wrapped in a per-view error boundary and telemetry profiler". The set of
 * rendered ids comes from the `ViewLifecycleController` (active ∪ retained
 * keep-alive), which also enforces the bounded LRU + pinned exemptions and the
 * pause/resume signal bus.
 *
 * For the default retention policy (`keepAlive:false`, the shell's current
 * behavior) the controller never retains a hidden builtin view, so the set is
 * just `{activeViewId}` and this host mounts exactly one view — behaviorally
 * identical to the old ViewRouter, but now every view gets:
 *   - a keyed, resettable per-view ViewErrorBoundary (crash containment),
 *   - a per-view ViewTelemetryProfiler (render/heap/resource telemetry),
 *   - a ViewLifecycleSlot so `useViewLifecycle`/`usePausableInterval` work,
 *   - controller-driven pause on app-background / tab-hidden / memory pressure.
 *
 * Views that opt into `keepAlive` are retained mounted-but-hidden and paused
 * while hidden, bounded by the device-memory LRU. The synthetic e2e fixture
 * drives this multi-view path with real RAF/interval/listener views.
 */

import {
  type ReactNode,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from "react";
import {
  type ViewRenderSet,
  viewLifecycleController,
} from "../../state/view-lifecycle";
import { ViewLifecycleSlot } from "../../state/view-lifecycle-context";
import { ViewErrorBoundary } from "./ViewErrorBoundary";
import { ViewTelemetryProfiler } from "./ViewTelemetryProfiler";

export interface KeepAliveViewHostProps {
  /** The id of the view that should be active/visible right now. */
  activeViewId: string;
  /** Render a view's content by id. Called for the active + any retained id. */
  renderView: (viewId: string) => ReactNode;
}

export function KeepAliveViewHost({
  activeViewId,
  renderView,
}: KeepAliveViewHostProps): React.JSX.Element {
  // Make the active view the controller's active view + install the shared
  // pause/resume signal bus once. setActive drives hide/pause/evict of the
  // previous view per its policy and enforces the LRU.
  useEffect(() => {
    viewLifecycleController.installSignals();
  }, []);
  useEffect(() => {
    viewLifecycleController.setActive(activeViewId);
  }, [activeViewId]);

  const renderSet = useSyncExternalStore<ViewRenderSet>(
    (onChange) => viewLifecycleController.subscribe(onChange),
    () => viewLifecycleController.getRenderSet(),
    () => viewLifecycleController.getRenderSet(),
  );

  // The active view must render even on the very first commit, before the
  // setActive effect has run and published a render set — so union the prop in.
  const renderIds = useMemo(() => {
    const ids = new Set(renderSet.retainedIds);
    ids.add(activeViewId);
    return [...ids];
  }, [renderSet.retainedIds, activeViewId]);

  return (
    <>
      {renderIds.map((viewId) => {
        // A host whose renderView cannot reconstruct content for a retained id
        // (e.g. the app's active-only router) returns null — skip the slot
        // entirely rather than mount an empty, lifeless ViewLifecycleSlot +
        // ViewErrorBoundary + ViewTelemetryProfiler over nothing (#10202 review).
        const content = renderView(viewId);
        if (content == null) return null;
        const hidden = viewId !== activeViewId;
        return (
          <ViewLifecycleSlot key={viewId} viewId={viewId} hidden={hidden}>
            <ViewErrorBoundary viewId={viewId}>
              <ViewTelemetryProfiler viewId={viewId}>
                {content}
              </ViewTelemetryProfiler>
            </ViewErrorBoundary>
          </ViewLifecycleSlot>
        );
      })}
    </>
  );
}
