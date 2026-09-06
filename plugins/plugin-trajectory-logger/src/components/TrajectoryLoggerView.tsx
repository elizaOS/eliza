/**
 * TrajectoryLoggerView - the GUI data wrapper for the Trajectory Logger
 * surface.
 *
 * It owns the live trajectory data (the 700ms polling hook + the selected-phase
 * drilldown state) and renders the one presentational
 * {@link TrajectoryLoggerSpatialView} inside a {@link SpatialSurface}. The
 * browser DOM surface ships today, while the retained modality contract stays
 * available for future adapters.
 */

import type { OverlayAppContext } from "@elizaos/shared";
import { Button } from "@elizaos/ui";
import { useAgentElement } from "@elizaos/ui/agent-surface";
import { dispatchNavigateViewEvent } from "@elizaos/ui/events";

import { useCallback, useEffect, useState } from "react";
import { fetchTrajectoryDetail, type TrajectoryDetail } from "../api-client";
import type { PhaseName } from "../phases";
import { summarizePhases } from "../phases";
import { usePollingTrajectories } from "../usePollingTrajectories";
import {
  type Slot,
  TrajectoryLoggerSpatialView,
  type TrajectorySnapshot,
} from "./TrajectoryLoggerSpatialView.tsx";
import { TrajectoryRecord } from "./TrajectoryRecord";

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
  const [pinned, setPinned] = useState(() => ({
    id:
      typeof window === "undefined"
        ? ""
        : (new URLSearchParams(window.location.search).get("trajectory") ?? ""),
  }));
  const pinnedId = pinned.id;
  const [idInput, setIdInput] = useState(pinnedId);
  const [record, setRecord] = useState<TrajectoryDetail | null>(null);
  const [recordError, setRecordError] = useState<string | null>(null);
  const state = usePollingTrajectories(!pinnedId);
  const [selected, setSelected] = useState<Selection>(null);

  useEffect(() => {
    setRecord(null);
    setRecordError(null);
    if (!pinned.id) return;
    const controller = new AbortController();
    void fetchTrajectoryDetail(pinned.id, { signal: controller.signal }).then(
      (detail) => {
        if (!controller.signal.aborted) setRecord(detail);
      },
      (error: unknown) => {
        if (!controller.signal.aborted)
          setRecordError(
            error instanceof Error ? error.message : String(error),
          );
      },
    );
    return () => controller.abort();
  }, [pinned]);

  const onAction = useCallback(
    (action: string) => {
      if (action === "back") {
        if (exitToApps) exitToApps();
        else navigateToApps();
        return;
      }
      if (action === "refresh") {
        // The hook polls continuously; a manual refresh is a no-op beyond the
        // in-flight tick. Kept for action-contract parity with the interact API.
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
    <div className="eliza-chat-scroll h-full min-h-0 min-w-0 overflow-y-auto overscroll-contain pb-[var(--eliza-chat-clearance,5.25rem)]">
      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex justify-start">
          <Button
            variant="outline"
            size="sm"
            type="button"
            ref={backControl.ref}
            {...backControl.agentProps}
            onClick={() => onAction("back")}
            aria-label="Back to apps"
          >
            Back to apps
          </Button>
        </div>
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!idInput.trim()) return;
            setPinned({ id: idInput.trim() });
          }}
        >
          <label htmlFor="trajectory-id" className="block text-sm font-medium">
            Inspect a specific trajectory
          </label>
          <div className="flex flex-wrap gap-2">
            <input
              id="trajectory-id"
              value={idInput}
              onChange={(event) => setIdInput(event.target.value)}
              placeholder="step-…"
              className="min-w-0 flex-1 rounded-lg border border-border bg-background p-2 text-sm"
            />
            <Button type="submit" variant="outline" disabled={!idInput.trim()}>
              Load turn
            </Button>
            {pinnedId && (
              <Button
                type="button"
                variant="outline"
                onClick={() => setPinned({ id: "" })}
              >
                Follow live
              </Button>
            )}
          </div>
        </form>
        {pinnedId ? (
          <>
            <p className="text-sm text-muted-foreground">
              Pinned turn. Live polling is paused while you inspect it.
            </p>
            {recordError ? (
              <p role="alert">
                Could not load this turn. Check the ID and select Load turn to
                retry. {recordError}
              </p>
            ) : record ? (
              <TrajectoryRecord detail={record} />
            ) : (
              <p role="status">Loading recorded turn…</p>
            )}
          </>
        ) : (
          <>
            <TrajectoryLoggerSpatialView
              snapshot={snapshot}
              onAction={onAction}
            />
            {(state.active ?? state.last) && (
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  const id = (state.active ?? state.last)?.id;
                  if (id) {
                    setIdInput(id);
                    setPinned({ id });
                  }
                }}
              >
                Pin turn and inspect full record
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
