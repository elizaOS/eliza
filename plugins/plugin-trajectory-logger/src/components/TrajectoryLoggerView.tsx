import { Button, type OverlayAppContext, useAgentElement } from "@elizaos/ui";
import { TerminalPluginView } from "@elizaos/ui/components/views/TerminalPluginView";
import { Activity, ChevronLeft, History } from "lucide-react";
import { useState } from "react";
import type { TrajectoryListItem } from "../api-client";
import { fetchTrajectoryDetail, fetchTrajectoryList } from "../api-client";
import { type PhaseName, type PhaseSummary, summarizePhases } from "../phases";
import { usePollingTrajectories } from "../usePollingTrajectories";
import { PhaseChip } from "./PhaseChip";
import { PhaseDrilldown } from "./PhaseDrilldown";

export type Slot = "now" | "last";
type Selection = { slot: Slot; phase: PhaseName } | null;

export function TrajectoryLoggerView({ exitToApps }: OverlayAppContext) {
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
      <header className="flex items-center justify-between gap-2 border-b border-border/24 px-3 py-2">
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
          <span className="text-sm font-semibold text-txt">
            Trajectory Logger
          </span>
          <LoggingStatusBadge active={!!state.active} />
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
          <div className="rounded border border-border/24 bg-card/30 p-2">
            <PhaseDrilldown phase={selected} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function TrajectoryLoggerTuiView() {
  return (
    <TerminalPluginView
      id="trajectory-logger"
      label="Trajectory Logger TUI"
      description="Terminal realtime trajectory inspector for HANDLE / PLAN / ACTION / EVALUATE turns"
      commands={["list-trajectories", "open-latest", "filter-phase", "refresh"]}
      endpoints={["/api/trajectories", "/api/trajectories/latest"]}
    />
  );
}

export async function interact(
  capability: string,
  params?: Record<string, unknown>,
): Promise<unknown> {
  if (capability === "list-trajectories" || capability === "refresh") {
    return fetchTrajectoryList({
      limit: typeof params?.limit === "number" ? params.limit : 10,
    });
  }

  if (capability === "open-latest") {
    const list = await fetchTrajectoryList({ limit: 1 });
    const latest = list.trajectories[0];
    return latest ? fetchTrajectoryDetail(latest.id) : null;
  }

  if (capability === "filter-phase") {
    const requestedPhase =
      typeof params?.phase === "string" ? params.phase.toUpperCase() : "HANDLE";
    const list = await fetchTrajectoryList({ limit: 10 });
    const details = await Promise.all(
      list.trajectories
        .slice(0, 5)
        .map((trajectory) => fetchTrajectoryDetail(trajectory.id)),
    );
    return details.map((detail) => ({
      id: detail.trajectory.id,
      status: detail.trajectory.status,
      phase: requestedPhase,
      llmCalls: detail.llmCalls.filter((call) =>
        [call.purpose, call.stepType, call.actionType]
          .filter(Boolean)
          .some((value) => value.toUpperCase().includes(requestedPhase)),
      ).length,
      toolEvents: detail.toolEvents?.length ?? 0,
      evaluationEvents: detail.evaluationEvents?.length ?? 0,
    }));
  }

  throw new Error(`Trajectory Logger TUI does not support "${capability}".`);
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
              slot={slot}
              phase={p.phase}
              status={p.status}
              summary={p.summary}
              selected={selectedPhase === p.phase}
              onClick={() => onSelect(p.phase)}
            />
          ))}
        </div>
      ) : (
        <span className="text-2xs text-muted/40">No run</span>
      )}
    </div>
  );
}

/**
 * Compact privacy badge: surfaces "trajectory logging ON/OFF" prominently in
 * the view header. `active` reflects whether there is currently a live
 * trajectory being recorded; the badge stays informational either way (a user
 * who has logging ON but no active turn still sees "ON / idle").
 */
function LoggingStatusBadge({ active }: { active: boolean }) {
  const tone = active
    ? "border-blue-500/40 bg-blue-500/10 text-blue-300"
    : "border-border/30 bg-bg-elevated text-muted";
  const label = active ? "Logging ON / recording" : "Logging ON / idle";
  return (
    <span
      title="Trajectory logging is enabled. Disable in Cloud Dashboard / Security / Privacy."
      className={`inline-flex items-center rounded-sm border px-2 py-0.5 text-2xs uppercase tracking-wide ${tone}`}
      data-testid="trajectory-logging-badge"
    >
      {label}
    </span>
  );
}
