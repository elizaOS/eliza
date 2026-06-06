import { useAgentElement } from "@elizaos/ui/agent-surface";
import { Brain, CheckSquare, Inbox, Zap } from "lucide-react";
import type { ComponentType } from "react";
import type { PhaseName, PhaseStatus } from "../phases";
import type { Slot } from "./TrajectoryLoggerView";

interface PhaseChipProps {
  slot: Slot;
  phase: PhaseName;
  status: PhaseStatus;
  summary: string | null;
  selected: boolean;
  onClick: () => void;
}

const ICON: Record<PhaseName, ComponentType<{ className?: string }>> = {
  HANDLE: Inbox,
  PLAN: Brain,
  ACTION: Zap,
  EVALUATE: CheckSquare,
};

// Medallion ring + glow per status. Idle is dim-but-legible; active is
// accent-lit and pulses; terminal states carry their own semantic tone.
const MEDALLION: Record<
  PhaseStatus,
  { ring: string; icon: string; label: string }
> = {
  idle: {
    ring: "border-border/40 bg-card/40",
    icon: "text-muted/70",
    label: "text-muted/70",
  },
  active: {
    ring: "border-accent bg-accent/15 shadow-[0_0_0_3px_var(--accent-subtle,rgba(255,88,0,0.14))]",
    icon: "text-accent",
    label: "text-accent",
  },
  done: {
    ring: "border-ok/55 bg-ok/12",
    icon: "text-ok",
    label: "text-txt",
  },
  skipped: {
    ring: "border-warn/45 bg-warn/10",
    icon: "text-warn",
    label: "text-muted",
  },
  error: {
    ring: "border-danger/55 bg-danger/12",
    icon: "text-danger",
    label: "text-danger",
  },
};

export function PhaseChip({
  slot,
  phase,
  status,
  summary,
  selected,
  onClick,
}: PhaseChipProps) {
  const Icon = ICON[phase];
  const tone = MEDALLION[status];
  const slotLabel = slot === "now" ? "current turn" : "last turn";
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `phase-${slot}-${phase.toLowerCase()}`,
    role: "tab",
    label: `${phase} (${slotLabel})`,
    group: slot === "now" ? "phases-now" : "phases-last",
    status: selected ? "active" : "inactive",
    description: `Inspect the ${phase} phase of the ${slotLabel}`,
  });
  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      title={summary ? `${phase} — ${summary}` : phase}
      aria-current={selected ? "true" : undefined}
      {...agentProps}
      className={[
        "group flex min-w-0 flex-col items-center gap-1.5 rounded-xl px-1 py-2 text-center transition-colors",
        selected ? "bg-card/70 ring-1 ring-accent/40" : "hover:bg-card/40",
      ].join(" ")}
    >
      <span
        className={[
          "relative grid h-9 w-9 place-items-center rounded-full border-2 transition-all",
          tone.ring,
          status === "active" ? "animate-pulse" : "",
        ].join(" ")}
        aria-hidden
      >
        <Icon className={["h-4 w-4", tone.icon].join(" ")} />
      </span>
      <span
        className={[
          "text-2xs font-semibold uppercase tracking-wider",
          tone.label,
        ].join(" ")}
      >
        {phase}
      </span>
      {summary ? (
        <span className="w-full truncate text-2xs text-muted">{summary}</span>
      ) : (
        <span className="h-1 w-1 rounded-full bg-muted/30" aria-hidden />
      )}
    </button>
  );
}
