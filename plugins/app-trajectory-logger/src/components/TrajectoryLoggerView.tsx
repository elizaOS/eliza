/**
 * Full-screen overlay view for the Trajectory Logger app.
 *
 * Shows two stacked cards:
 *   1. Pending — the in-flight trajectory (status === "active")
 *   2. Last completed — the most recently finished/error trajectory
 *
 * Each card surfaces a HANDLE / PLAN / ACTION / EVALUATE phase strip with
 * a thin status indicator. Clicking a phase opens a drilldown panel for
 * that phase. Updates poll the existing /api/trajectories endpoints, so
 * opening the app and chatting with the agent shows phases activating in
 * real time.
 */

import { Button, type OverlayAppContext } from "@elizaos/app-core";
import { ChevronLeft, RefreshCw } from "lucide-react";
import { usePollingTrajectories } from "../usePollingTrajectories";
import { TrajectoryCard } from "./TrajectoryCard";

export function TrajectoryLoggerView({ exitToApps }: OverlayAppContext) {
  const state = usePollingTrajectories(true);

  return (
    <div className="flex h-full w-full flex-col bg-bg">
      <header className="flex items-center justify-between gap-3 border-b border-border/24 px-4 py-3">
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={exitToApps}
            aria-label="Back to apps"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <div className="text-base font-semibold text-txt">
            Trajectory Logger
          </div>
        </div>
        <div className="flex items-center gap-2 text-2xs text-muted/70">
          <RefreshCw
            className={[
              "h-3.5 w-3.5",
              state.ready && state.error === null ? "" : "opacity-40",
            ].join(" ")}
          />
          <span>polling</span>
        </div>
      </header>

      <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
        {!state.ready ? (
          <div className="rounded-xl border border-dashed border-border/24 bg-card/20 px-4 py-6 text-center text-sm text-muted">
            Loading trajectories…
          </div>
        ) : null}

        {state.error ? (
          <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-xs text-red-400">
            {state.error}
          </div>
        ) : null}

        <TrajectoryCard
          title="Pending"
          subtitle={
            state.active
              ? "currently in flight"
              : "waiting for the next agent turn"
          }
          trajectory={state.active}
          detail={state.activeDetail}
          live
        />

        <TrajectoryCard
          title="Last trajectory"
          subtitle={
            state.last
              ? `${state.last.status} · ${state.last.llmCallCount} llm calls`
              : "no recent turns"
          }
          trajectory={state.last}
          detail={state.lastDetail}
          live={false}
        />
      </div>
    </div>
  );
}
