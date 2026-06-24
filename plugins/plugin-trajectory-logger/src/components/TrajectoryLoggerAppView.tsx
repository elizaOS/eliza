/**
 * TrajectoryLoggerAppView - the legacy full-screen GUI overlay for the
 * Trajectory Logger app, mounted through the OverlayApp loader
 * (`trajectory-logger-app.ts`) and the app-shell page (`register.ts`).
 *
 * The unified GUI/XR/TUI surface is `TrajectoryLoggerView` (a thin data wrapper
 * over `TrajectoryLoggerSpatialView`); this hand-written overlay stays for the
 * OverlayApp mount path, mirroring how the Phone surface keeps `PhoneAppView`
 * alongside the collapsed `PhoneView`.
 */

import { Button, type OverlayAppContext } from "@elizaos/ui";
import { useAgentElement } from "@elizaos/ui/agent-surface";
import { Activity, ChevronLeft, History, Route } from "lucide-react";
import { useState } from "react";
import type { TrajectoryListItem } from "../api-client";
import { type PhaseName, type PhaseSummary, summarizePhases } from "../phases";
import { usePollingTrajectories } from "../usePollingTrajectories";
import { PhaseChip } from "./PhaseChip";
import { PhaseDrilldown } from "./PhaseDrilldown";

export type Slot = "now" | "last";
type Selection = { slot: Slot; phase: PhaseName } | null;

export function TrajectoryLoggerAppView({ exitToApps }: OverlayAppContext) {
  const state = usePollingTrajectories(true);
  const [sel, setSel] = useState<Selection>(null);

  const backButton = useAgentElement<HTMLButtonElement>({
    id: "action-back",
    role: "button",
    label: "Back",
    group: "trajectory-nav",
    description: "Return to the apps list",
  });

  const nowPhases = summarizePhases(state.activeDetail, {
    trajectoryActive: true,
  });
  const lastPhases = summarizePhases(state.lastDetail, {
    trajectoryActive: false,
  });
  const selected: PhaseSummary | null = !sel
    ? null
    : ((sel.slot === "now" ? nowPhases : lastPhases).find(
        (p) => p.phase === sel.phase,
      ) ?? null);

  return (
    <div className="flex h-full w-full flex-col bg-bg text-xs">
      <header className="flex items-center justify-between gap-2 px-2 py-2">
        <div className="flex items-center gap-2">
          <Button
            ref={backButton.ref}
            variant="ghost"
            size="sm"
            onClick={exitToApps}
            aria-label="Back"
            {...backButton.agentProps}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="grid h-7 w-7 place-items-center">
            <Route className="h-3.5 w-3.5 text-accent" aria-hidden />
          </span>
          <span className="text-sm font-semibold text-txt">Trajectories</span>
        </div>
        {state.unavailable ? (
          <span className="sr-only max-w-[42vw] truncate text-2xs text-muted/60">
            Trajectory logging unavailable on this surface
          </span>
        ) : state.error ? (
          <span className="max-w-[42vw] truncate text-2xs text-danger">
            {state.error}
          </span>
        ) : !state.ready ? (
          <span className="sr-only text-2xs text-muted/60">loading…</span>
        ) : (
          <LoggingStatusBadge active={!!state.active} />
        )}
      </header>

      <div className="flex flex-1 flex-col gap-2 overflow-y-auto p-2 pb-32">
        <PhaseStrip
          live
          slot="now"
          trajectory={state.active}
          phases={nowPhases}
          selectedPhase={sel?.slot === "now" ? sel.phase : null}
          onSelect={(phase) =>
            setSel((p) =>
              p?.slot === "now" && p.phase === phase
                ? null
                : { slot: "now", phase },
            )
          }
        />
        <PhaseStrip
          live={false}
          slot="last"
          trajectory={state.last}
          phases={lastPhases}
          selectedPhase={sel?.slot === "last" ? sel.phase : null}
          onSelect={(phase) =>
            setSel((p) =>
              p?.slot === "last" && p.phase === phase
                ? null
                : { slot: "last", phase },
            )
          }
        />
        {selected ? (
          <div className="max-h-[52vh] overflow-auto px-1 py-2">
            <PhaseDrilldown phase={selected} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function PhaseStrip({
  live,
  slot,
  trajectory,
  phases,
  selectedPhase,
  onSelect,
}: {
  live: boolean;
  slot: Slot;
  trajectory: TrajectoryListItem | null;
  phases: PhaseSummary[];
  selectedPhase: PhaseName | null;
  onSelect: (phase: PhaseName) => void;
}) {
  const Icon = live ? Activity : History;
  const recording = live && !!trajectory;
  // How far the progress line should fill: up to and including the last
  // non-idle phase. 0 when nothing has run.
  let lastDone = -1;
  phases.forEach((p, i) => {
    if (p.status !== "idle") lastDone = i;
  });
  const fillPct =
    phases.length > 1 ? (Math.max(0, lastDone) / (phases.length - 1)) * 100 : 0;
  return (
    <div
      className={[
        "flex min-w-0 flex-col gap-2 px-2 py-2 transition-colors",
        recording ? "animate-[pulse_2.4s_ease-in-out_infinite]" : "",
      ].join(" ")}
    >
      <div className="flex items-center justify-between">
        <span
          title={live ? "Current turn" : "Last turn"}
          className={[
            "flex items-center gap-2 text-[11px] font-semibold uppercase tracking-normal",
            recording ? "text-accent" : "text-muted",
          ].join(" ")}
        >
          <Icon
            className={["h-3.5 w-3.5", recording ? "animate-pulse" : ""].join(
              " ",
            )}
            aria-label={live ? "Current turn" : "Last turn"}
          />
          {live ? "Now" : "Last"}
        </span>
        {!trajectory ? (
          <span className="sr-only text-2xs text-muted/50">no turn yet</span>
        ) : null}
      </div>
      <div
        className="relative min-w-0"
        title={trajectory ? undefined : "No trajectory captured yet"}
      >
        {/* Progress rail behind the medallion row */}
        <div className="pointer-events-none absolute inset-x-[12.5%] top-[18px] h-0.5 bg-border/20">
          <div
            className={[
              "h-full transition-all duration-500",
              recording ? "bg-accent/70" : "bg-ok/55",
            ].join(" ")}
            style={{ width: `${fillPct}%` }}
          />
        </div>
        <div className="relative grid min-w-0 grid-cols-4 gap-1">
          {phases.map((p) => (
            <PhaseChip
              key={p.phase}
              slot={slot}
              phase={p.phase}
              status={p.status}
              summary={p.summary}
              selected={selectedPhase === p.phase}
              onClick={() => onSelect(p.phase)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * Compact status badge for the overlay header.
 */
function LoggingStatusBadge({ active }: { active: boolean }) {
  const tone = active ? "text-danger" : "text-muted";
  const label = active ? "recording" : "idle";
  return (
    <span
      title="Trajectory logging status"
      className={`inline-flex items-center gap-1.5 px-1 py-1 text-2xs font-semibold uppercase tracking-wide ${tone}`}
      data-testid="trajectory-logging-badge"
    >
      <span
        className={[
          "h-1.5 w-1.5 rounded-full",
          active ? "bg-danger animate-pulse" : "bg-muted/40",
        ].join(" ")}
        aria-hidden
      />
      {label}
    </span>
  );
}
