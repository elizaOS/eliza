// spec/trajectoryLogger/index.md, "Story: Inspect the phases of an agent turn"
import type { TurnPhase } from "../gen/trajectoryLogger.ts"
import type { TrajectoryInspection } from "./index.vibe"

const sections = [
  { id: "HandlePhase", label: "Handle", status: "handling" },
  { id: "PlanPhase", label: "Plan", status: "planning" },
  { id: "ActionPhase", label: "Action", status: "acting" },
  { id: "EvaluatePhase", label: "Evaluate", status: "evaluating" },
] as const satisfies readonly {
  id: TurnPhase
  label: string
  status: keyof TrajectoryInspection["status"]
}[]

const statusLabels = {
  PhaseIdle: "Waiting",
  PhaseDone: "Complete",
  PhaseSkipped: "Skipped",
  PhaseErrored: "Failed",
  PhaseActive: "Running",
}

export interface TrajectoryViewProps {
  readonly trajectory: TrajectoryInspection | undefined
}

export function TrajectoryView({ trajectory }: TrajectoryViewProps) {
  if (trajectory === undefined) return <p className="text-muted-foreground">No turn selected</p>
  return (
    <section aria-label="Turn trajectory" className="grid gap-3">
      {sections.map(({ id, label, status }) => (
        <details key={id} className="rounded-md border border-border bg-card p-3">
          <summary className="cursor-pointer">
            {label} <span className="text-muted-foreground">{statusLabels[trajectory.status[status]]}</span>
          </summary>
          <ul className="mt-2 grid gap-2">
            {trajectory.groups[id].map((record) => <li key={record.id}>{record.label}</li>)}
          </ul>
        </details>
      ))}
    </section>
  )
}
