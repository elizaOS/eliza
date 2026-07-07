/**
 * Per-route crash container for the cloud console's registered routes.
 *
 * Every console page (Overview / Agents / Billing / API Keys / Account, …) is
 * a `React.lazy` chunk mounted by `CloudRouterShell`. After a Pages deploy the
 * running shell still references ITS build's hashed assets, so navigating to a
 * not-yet-visited page rejects with "Failed to fetch dynamically imported
 * module" (#15383). Without a boundary here that rejection escaped past the
 * route `<Suspense>` to the app-root `ErrorBoundary` in `packages/app`, which
 * has no chunk recovery — the whole console blanked into a generic crash card
 * until a manual hard refresh.
 *
 * This mirrors `components/views/ViewErrorBoundary`: a chunk-load error hands
 * off to the SHARED one-shot reload recovery (`utils/chunk-load-recovery`,
 * timestamped 5-min cooldown — never a reload loop); anything else degrades to
 * a themed error card while the console chrome (sidebar/top bar) stays
 * mounted. It stays deliberately thinner than ViewErrorBoundary because the
 * view-lifecycle controller and view-runtime telemetry are app-shell-only
 * machinery — console routes have no viewId to feed them.
 */

import { logger } from "@elizaos/logger";
import { useCallback, useRef, useState } from "react";
import { Button } from "../../components/ui/button";
import { ErrorBoundary } from "../../components/ui/error-boundary";
import {
  isChunkLoadError,
  tryChunkReloadRecovery,
} from "../../utils/chunk-load-recovery";

export interface CloudRouteErrorBoundaryProps {
  /** Registered route path (e.g. `"dashboard/billing"`), used for keying + logs. */
  routePath: string;
  children: React.ReactNode;
}

function CloudRouteErrorFallback({
  error,
  onRetry,
}: {
  error: Error;
  onRetry: () => void;
}): React.JSX.Element {
  // A chunk failure that reaches this card exhausted the auto-reload budget
  // (or recovery already fired and the page is about to navigate away). A
  // boundary reset cannot heal it — React.lazy latches the rejected import —
  // so the affordance is an explicit user-initiated page reload instead of a
  // remount. User clicks can't loop: each reload boots a fresh shell.
  const staleChunk = isChunkLoadError(error);
  return (
    <div
      data-testid="cloud-route-error-fallback"
      className="mx-auto flex min-h-[40vh] max-w-prose flex-col items-center justify-center gap-3 p-8 text-center"
    >
      <p className="text-sm font-semibold text-destructive">
        {staleChunk
          ? "This page needs a newer version of the console"
          : "This page ran into a problem"}
      </p>
      <p className="max-w-sm break-words font-mono text-[11px] text-muted opacity-70">
        {error.message}
      </p>
      {staleChunk ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="rounded-sm text-xs"
          onClick={() => window.location.reload()}
          data-testid="cloud-route-error-reload"
        >
          Reload
        </Button>
      ) : (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="rounded-sm text-xs"
          onClick={onRetry}
          data-testid="cloud-route-error-retry"
        >
          Retry
        </Button>
      )}
    </div>
  );
}

export function CloudRouteErrorBoundary({
  routePath,
  children,
}: CloudRouteErrorBoundaryProps): React.JSX.Element {
  const [recoverKey, setRecoverKey] = useState(0);
  // Latch the error so the log/recovery fires once per crash, not per render.
  const reportedError = useRef<Error | null>(null);

  const handleError = useCallback(
    (error: Error) => {
      if (reportedError.current === error) return;
      reportedError.current = error;
      // Mid-session deploy: this route's lazy chunk is gone from the server.
      // One shared, cooldown-guarded reload picks up the current build and
      // heals every route at once; only when the attempt budget is spent does
      // this fall through to the error card.
      if (isChunkLoadError(error) && tryChunkReloadRecovery()) {
        logger.info(
          `[CloudRouteErrorBoundary] route "${routePath}" hit a stale-deploy chunk failure — reloading to the current build`,
        );
        return;
      }
      logger.error(
        `[CloudRouteErrorBoundary] route "${routePath}" crashed: ${error.message}`,
      );
    },
    [routePath],
  );

  return (
    // error-policy:J4 explicit user-facing degrade — the route body crashed;
    // render a designed error card (with recovery affordance) in its slot so
    // the console chrome stays usable.
    <ErrorBoundary
      key={`${routePath}:${recoverKey}`}
      onError={handleError}
      fallback={(error, resetErrorBoundary) => (
        <CloudRouteErrorFallback
          error={error}
          onRetry={() => {
            reportedError.current = null;
            resetErrorBoundary();
            setRecoverKey((k) => k + 1);
          }}
        />
      )}
    >
      {children}
    </ErrorBoundary>
  );
}
