import { Button, type OverlayAppContext } from "@elizaos/ui";
import { Activity, ChevronLeft, History } from "lucide-react";
import { useState } from "react";
import type { TrajectoryListItem } from "../api-client";
import { type PhaseName, type PhaseSummary, summarizePhases } from "../phases";
import { usePollingTrajectories } from "../usePollingTrajectories";
import { PhaseChip } from "./PhaseChip";
import { PhaseDrilldown } from "./PhaseDrilldown";

type Slot = "now" | "last";
type Selection = { slot: Slot; phase: PhaseName } | null;

export function TrajectoryLoggerView({ exitToApps }: OverlayAppContext) {
  const state = usePollingTrajectories(true);
  const [sel, setSel] = useState<Selection>(null);

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
      <header className="flex items-center justify-between gap-2 border-b border-border/24 px-3 py-2">
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={exitToApps}
            aria-label="Back"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="text-sm font-semibold text-txt">
            Trajectory Logger
          </span>
        </div>
        {state.error ? (
          <span className="text-2xs text-red-400">{state.error}</span>
        ) : !state.ready ? (
          <span className="text-2xs text-muted/60">loading…</span>
        ) : null}
      </header>

      <div className="flex flex-1 flex-col gap-2 overflow-y-auto p-2">
        <PhaseStrip
          live
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
          <div className="rounded border border-border/24 bg-card/30 p-2">
            <PhaseDrilldown phase={selected} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function PhaseStrip({
  live,
  trajectory,
  phases,
  selectedPhase,
  onSelect,
}: {
  live: boolean;
  trajectory: TrajectoryListItem | null;
  phases: PhaseSummary[];
  selectedPhase: PhaseName | null;
  onSelect: (phase: PhaseName) => void;
}) {
  const Icon = live ? Activity : History;
  return (
    <div className="flex items-center gap-2">
      <span
        title={live ? "Current turn" : "Last turn"}
        className={[
          "flex w-5 shrink-0 justify-center",
          live ? "text-blue-400" : "text-muted/60",
        ].join(" ")}
      >
        <Icon
          className={["h-3.5 w-3.5", live ? "animate-pulse" : ""].join(" ")}
          aria-label={live ? "Current turn" : "Last turn"}
        />
      </span>
      {trajectory ? (
        <div className="flex flex-1 gap-1">
          {phases.map((p) => (
            <PhaseChip
              key={p.phase}
              phase={p.phase}
              status={p.status}
              summary={p.summary}
              selected={selectedPhase === p.phase}
              onClick={() => onSelect(p.phase)}
            />
          ))}
        </div>
      ) : (
        <span className="text-2xs text-muted/40">—</span>
      )}
    </div>
  );
}
