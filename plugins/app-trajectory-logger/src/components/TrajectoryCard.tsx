import { useState } from "react";
import type { TrajectoryDetail, TrajectoryListItem } from "../api-client";
import { type PhaseName, summarizePhases } from "../phases";
import { PhaseChip } from "./PhaseChip";
import { PhaseDrilldown } from "./PhaseDrilldown";

interface TrajectoryCardProps {
  title: string;
  subtitle: string;
  trajectory: TrajectoryListItem | null;
  detail: TrajectoryDetail | null;
  /** When true, the card shows a "live" pulse and treats unfinished phases as in-flight. */
  live: boolean;
}

export function TrajectoryCard({
  title,
  subtitle,
  trajectory,
  detail,
  live,
}: TrajectoryCardProps) {
  const [selectedPhase, setSelectedPhase] = useState<PhaseName | null>(null);
  const phases = summarizePhases(detail, { trajectoryActive: live });
  const selected = selectedPhase
    ? (phases.find((p) => p.phase === selectedPhase) ?? null)
    : null;

  return (
    <section className="flex flex-col gap-3 rounded-2xl border border-border/24 bg-bg/40 p-4">
      <header className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          {live ? (
            <span
              role="img"
              aria-label="Live trajectory"
              className="inline-block h-2 w-2 animate-pulse rounded-full bg-blue-500"
            />
          ) : null}
          <h2 className="text-sm font-semibold uppercase tracking-[0.16em] text-txt">
            {title}
          </h2>
        </div>
        <div className="text-2xs text-muted/70">{subtitle}</div>
      </header>

      {trajectory ? (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {phases.map((p) => (
            <PhaseChip
              key={p.phase}
              phase={p.phase}
              status={p.status}
              summary={p.summary}
              selected={selectedPhase === p.phase}
              onClick={() =>
                setSelectedPhase((prev) => (prev === p.phase ? null : p.phase))
              }
            />
          ))}
        </div>
      ) : (
        <div className="rounded-xl border border-dashed border-border/24 bg-card/20 px-4 py-6 text-center text-xs text-muted">
          {live
            ? "Waiting for the next agent turn — send a message to start one."
            : "No completed turns yet."}
        </div>
      )}

      {trajectory && selected ? (
        <div className="rounded-xl border border-border/24 bg-card/40 p-3">
          <PhaseDrilldown phase={selected} />
        </div>
      ) : null}

      {trajectory ? (
        <footer className="flex flex-wrap items-center gap-x-4 gap-y-1 text-2xs text-muted/60">
          <span>
            id <span className="font-mono">{trajectory.id.slice(0, 8)}</span>
          </span>
          <span>source {trajectory.source}</span>
          <span>{trajectory.llmCallCount} llm</span>
          <span>{trajectory.providerAccessCount} ctx</span>
          {trajectory.endTime ? (
            <span>{new Date(trajectory.endTime).toLocaleTimeString()}</span>
          ) : (
            <span className="text-blue-400">in flight…</span>
          )}
        </footer>
      ) : null}
    </section>
  );
}
