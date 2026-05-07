import type { PhaseName, PhaseStatus } from "../phases";

interface PhaseChipProps {
  phase: PhaseName;
  status: PhaseStatus;
  summary: string | null;
  selected: boolean;
  onClick: () => void;
}

const DOT: Record<PhaseStatus, string> = {
  idle: "bg-muted/30",
  active: "bg-blue-500 animate-pulse",
  done: "bg-green-500",
  skipped: "bg-yellow-500",
  error: "bg-red-500",
};

export function PhaseChip({
  phase,
  status,
  summary,
  selected,
  onClick,
}: PhaseChipProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs transition-colors",
        selected
          ? "bg-card/80 ring-1 ring-blue-500/40"
          : "bg-card/30 hover:bg-card/50",
      ].join(" ")}
    >
      <span
        className={["h-1.5 w-1.5 shrink-0 rounded-full", DOT[status]].join(" ")}
        aria-hidden
      />
      <span className="text-2xs font-semibold uppercase tracking-wider text-txt">
        {phase}
      </span>
      <span className="min-w-0 flex-1 truncate text-muted">
        {summary ?? "—"}
      </span>
    </button>
  );
}
