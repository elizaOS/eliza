/**
 * Standardized per-view crash container (issue #10202, criterion #4 — "one
 * crashing view does not destabilize the whole app shell").
 *
 * Today only remote/plugin views (DynamicViewLoader) get a keyed, resettable
 * boundary; builtin/system/developer views share the single un-keyed
 * `ErrorBoundary` at App.tsx whose "Try Again" re-renders the same crashing
 * subtree and whose error state lingers across navigation. This wraps the
 * canonical `ErrorBoundary` so EVERY routed view gets the same isolation +
 * recovery:
 *
 *  - keyed `${viewId}:${recoverKey}` so each view's boundary is independent and
 *    a Retry genuinely remounts a fresh subtree (not a latched stale crash);
 *  - on catch: `controller.markCrashed(viewId)` + a per-view crash telemetry
 *    sample + a structured `[ViewLifecycle]` log line;
 *  - on recover: reset the boundary, bump recoverKey, `markRecovering`, and call
 *    the optional `onRecover` (remote views pass `recoverView` to also
 *    invalidate the bundle cache).
 *
 * Builtin views get a self-contained default fallback (Retry + Back to
 * launcher); callers that already have a richer fallback (DynamicViewLoader's
 * ViewErrorState) pass `renderFallback`.
 */

import { logger } from "@elizaos/logger";
import { useCallback, useRef, useState } from "react";
import { dispatchNavigateViewEvent } from "../../events";
import { snapshotResourceCounters } from "../../perf/resource-counters";
import { viewLifecycleController } from "../../state/view-lifecycle";
import {
  isChunkLoadError,
  tryChunkReloadRecovery,
} from "../../utils/chunk-load-recovery";
import {
  emitViewRuntimeTelemetry,
  installViewRuntimeTelemetryRing,
} from "../../view-runtime-telemetry";
import { Button } from "../ui/button";
import { ErrorBoundary } from "../ui/error-boundary";

export interface ViewErrorBoundaryProps {
  viewId: string;
  /** Pinned views (chat/background) log at a higher severity when they crash. */
  pinned?: boolean;
  /**
   * Extra recovery side-effect on Retry (e.g. DynamicViewLoader's bundle-cache
   * invalidation). The boundary always resets + remounts regardless.
   */
  onRecover?: () => void;
  /** Optional richer fallback; defaults to the built-in Retry/Back card. */
  renderFallback?: (error: Error, recover: () => void) => React.ReactNode;
  children: React.ReactNode;
}

function DefaultViewErrorFallback({
  viewId,
  error,
  onRetry,
}: {
  viewId: string;
  error: Error;
  onRetry: () => void;
}): React.JSX.Element {
  const goToLauncher = useCallback(() => {
    dispatchNavigateViewEvent({ viewPath: "/views" });
  }, []);
  return (
    <div
      data-testid="view-error-boundary-fallback"
      data-view-id={viewId}
      className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center"
    >
      <p className="text-sm font-semibold text-destructive">
        This view ran into a problem
      </p>
      <p className="max-w-sm break-words font-mono text-[11px] text-muted opacity-70">
        {error.message}
      </p>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="rounded-sm text-xs"
          onClick={onRetry}
          data-testid="view-error-retry"
        >
          Retry
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="rounded-sm text-xs"
          onClick={goToLauncher}
          data-testid="view-error-back"
        >
          Back to launcher
        </Button>
      </div>
    </div>
  );
}

export function ViewErrorBoundary({
  viewId,
  pinned = false,
  onRecover,
  renderFallback,
  children,
}: ViewErrorBoundaryProps): React.JSX.Element {
  const [recoverKey, setRecoverKey] = useState(0);
  // Latch the error so the telemetry/log fires once per crash, not per render.
  const reportedError = useRef<Error | null>(null);

  const handleError = useCallback(
    (error: Error) => {
      if (reportedError.current === error) return;
      reportedError.current = error;
      // Mid-session deploy: a lazy view chunk from the running shell's build
      // is gone from the server. A one-shot reload picks up the current
      // deployment and heals every view at once — only when the attempt
      // budget is spent does this fall through to the crash card.
      if (isChunkLoadError(error) && tryChunkReloadRecovery()) {
        logger.info(
          `[ViewLifecycle] view "${viewId}" hit a stale-deploy chunk failure — reloading to the current build`,
        );
        return;
      }
      viewLifecycleController.markCrashed(viewId);
      installViewRuntimeTelemetryRing();
      const snap = snapshotResourceCounters(viewId);
      emitViewRuntimeTelemetry({
        viewId,
        phase: "crashed",
        reason: "crash",
        renderCount: 0,
        lastCommitMs: 0,
        commitDurationP95Ms: 0,
        activeSubscriptions: snap.activeSubscriptions,
        pendingTimers: snap.pendingTimers,
        heavyResources: snap.heavyResources,
      });
      const log = pinned ? logger.error : logger.warn;
      log(
        `[ViewLifecycle] view "${viewId}" crashed: ${error.message}${
          pinned && error.stack ? `\n${error.stack}` : ""
        }`,
      );
    },
    [viewId, pinned],
  );

  return (
    <ErrorBoundary
      key={`${viewId}:${recoverKey}`}
      onError={handleError}
      fallback={(error, resetErrorBoundary) => {
        const recover = () => {
          reportedError.current = null;
          resetErrorBoundary();
          setRecoverKey((k) => k + 1);
          viewLifecycleController.markRecovering(viewId);
          onRecover?.();
        };
        return renderFallback ? (
          renderFallback(error, recover)
        ) : (
          <DefaultViewErrorFallback
            viewId={viewId}
            error={error}
            onRetry={recover}
          />
        );
      }}
    >
      {children}
    </ErrorBoundary>
  );
}
