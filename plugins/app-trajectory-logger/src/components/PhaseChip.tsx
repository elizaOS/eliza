import type { PhaseName, PhaseStatus } from "../phases";

interface PhaseChipProps {
  phase: PhaseName;
  status: PhaseStatus;
  summary: string | null;
  selected: boolean;
  onClick: () => void;
}

const STATUS_DOT: Record<PhaseStatus, string> = {
  idle: "bg-muted/40",
  active: "bg-blue-500 animate-pulse",
  done: "bg-green-500",
  skipped: "bg-yellow-500",
  error: "bg-red-500",
};

const STATUS_BORDER: Record<PhaseStatus, string> = {
  idle: "border-border/24",
  active: "border-blue-500/50",
  done: "border-green-500/50",
  skipped: "border-yellow-500/50",
  error: "border-red-500/50",
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
        "flex flex-col items-start gap-1 rounded-xl border px-3 py-2 text-left transition-colors",
        STATUS_BORDER[status],
        selected
          ? "bg-card/80 ring-1 ring-blue-500/40"
          : "bg-card/30 hover:bg-card/50",
      ].join(" ")}
    >
      <div className="flex items-center gap-2">
        <span
          className={[
            "inline-block h-2 w-2 rounded-full",
            STATUS_DOT[status],
          ].join(" ")}
          aria-hidden
        />
        <span className="text-2xs font-semibold uppercase tracking-[0.16em] text-txt">
          {phase}
        </span>
      </div>
      <div className="min-h-[1.25rem] text-xs text-muted">
        {summary ?? <span className="opacity-50">—</span>}
      </div>
    </button>
  );
}
