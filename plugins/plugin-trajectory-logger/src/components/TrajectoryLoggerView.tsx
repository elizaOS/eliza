/**
 * TrajectoryLoggerView - the single GUI/XR data wrapper for the Trajectory
 * Logger surface.
 *
 * It owns the live trajectory data (the 700ms polling hook + the selected-phase
 * drilldown state) and renders the one presentational
 * {@link TrajectoryLoggerSpatialView} inside a {@link SpatialSurface}. Omitting
 * the `modality` prop lets `SpatialSurface` auto-detect GUI vs XR via
 * `window.__elizaXRContext`, so the SAME component serves both surfaces. The TUI
 * surface renders the same `TrajectoryLoggerSpatialView` through the terminal
 * registry (see `register-terminal-view.tsx`).
 */

import type { OverlayAppContext } from "@elizaos/ui";
import { useAgentElement } from "@elizaos/ui/agent-surface";
import { Button } from "@elizaos/ui/components/ui/button";
import { dispatchNavigateViewEvent } from "@elizaos/ui/events";

import { useCallback, useState } from "react";
import type { PhaseName } from "../phases";
import { summarizePhases } from "../phases";
import { usePollingTrajectories } from "../usePollingTrajectories";
import {
  type Slot,
  TrajectoryLoggerSpatialView,
  type TrajectorySnapshot,
} from "./TrajectoryLoggerSpatialView.tsx";

type Selection = { slot: Slot; phase: PhaseName } | null;

/** Navigate back to the apps grid via the shared navigation bus. */
function navigateToApps(): void {
  if (typeof window === "undefined") return;
  dispatchNavigateViewEvent({ viewId: "apps", viewPath: "/apps" });
}

export interface TrajectoryLoggerViewProps {
  /**
   * Optional host-supplied "back" handler. When the view is mounted as a
   * full-screen overlay the host passes its `exitToApps`; the bundle/manifest
   * mount renders it without props and Back falls back to the navigation bus.
   */
  exitToApps?: OverlayAppContext["exitToApps"];
}

export function TrajectoryLoggerView({
  exitToApps,
}: TrajectoryLoggerViewProps = {}) {
  const state = usePollingTrajectories(true);
  const [selected, setSelected] = useState<Selection>(null);

  const onAction = useCallback(
    (action: string) => {
      if (action === "back") {
        if (exitToApps) exitToApps();
        else navigateToApps();
        return;
      }
      if (action === "refresh") {
        // The hook polls continuously; a manual refresh is a no-op beyond the
        // in-flight tick. Kept for action-contract parity with the TUI surface.
        return;
      }
      if (action.startsWith("select:")) {
        const [, slot, phase] = action.split(":");
        if ((slot === "now" || slot === "last") && phase) {
          const next: Selection = { slot, phase: phase as PhaseName };
          setSelected((prev) =>
            prev && prev.slot === next.slot && prev.phase === next.phase
              ? null
              : next,
          );
        }
      }
    },
    [exitToApps],
  );

  const backControl = useAgentElement<HTMLButtonElement>({
    id: "trajectory-back-to-apps",
    role: "button",
    label: "Back to apps",
    group: "trajectory-logger",
    description: "Leave the trajectory inspector and return to the apps grid",
    onActivate: () => onAction("back"),
  });

  const snapshot: TrajectorySnapshot = {
    ready: state.ready,
    recording: !!state.active,
    unavailable: state.unavailable,
    error: state.error,
    now: {
      hasTrajectory: !!state.active,
      phases: summarizePhases(state.activeDetail, { trajectoryActive: true }),
    },
    last: {
      hasTrajectory: !!state.last,
      phases: summarizePhases(state.lastDetail, { trajectoryActive: false }),
    },
    selected,
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex justify-start">
        <Button
          unstyled
          type="button"
          ref={backControl.ref}
          {...backControl.agentProps}
          onClick={() => onAction("back")}
          aria-label="Back to apps"
          className="inline-flex items-center justify-center rounded-md border border-border/60 px-3 py-1.5 text-xs font-medium text-muted-strong transition-colors hover:bg-bg-hover hover:text-txt"
        >
          Back to apps
        </Button>
      </div>
      <TrajectoryLoggerSpatialView snapshot={snapshot} onAction={onAction} />
    </div>
  );
}
