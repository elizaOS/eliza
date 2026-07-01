/**
 * OrchestratorGrillingCard — shows the orchestrator "grilling" a sub-agent's
 * evidence against the acceptance criteria for a goal: a header with the
 * overall verdict and a per-criterion list (state icon + label + optional
 * note). Presentational only — the caller supplies the already-evaluated
 * `status` and per-criterion `state`; the card never decides pass/fail itself.
 * Follows the agent-orchestrator widget's tone vocabulary (accent = met,
 * danger = failed, muted = pending).
 */

import { CheckCircle2, CircleDashed, Loader2, XCircle } from "lucide-react";
import type { ReactNode } from "react";

export type GrillingStatus =
  | "evidence-pending"
  | "criteria-failed"
  | "criteria-met";

export type GrillingCriterionState = "pending" | "failed" | "met";

export type GrillingCriterion = {
  id: string;
  label: string;
  state: GrillingCriterionState;
  note?: string;
};

export type OrchestratorGrillingCardProps = {
  status: GrillingStatus;
  goal: string;
  criteria: GrillingCriterion[];
};

type StatusStyle = {
  label: string;
  toneClass: string;
  icon: ReactNode;
};

function statusStyle(status: GrillingStatus): StatusStyle {
  switch (status) {
    case "criteria-met":
      return {
        label: "Criteria met",
        toneClass: "bg-accent/20 text-accent",
        icon: <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />,
      };
    case "criteria-failed":
      return {
        label: "Criteria failed",
        toneClass: "bg-danger/20 text-danger",
        icon: <XCircle className="h-3.5 w-3.5" aria-hidden />,
      };
    default:
      return {
        label: "Reviewing evidence",
        toneClass: "bg-muted/20 text-muted",
        icon: <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />,
      };
  }
}

function criterionIcon(state: GrillingCriterionState): ReactNode {
  switch (state) {
    case "met":
      return <CheckCircle2 className="h-4 w-4 text-accent" aria-hidden />;
    case "failed":
      return <XCircle className="h-4 w-4 text-danger" aria-hidden />;
    default:
      return <CircleDashed className="h-4 w-4 text-muted" aria-hidden />;
  }
}

function criterionStateLabel(state: GrillingCriterionState): string {
  switch (state) {
    case "met":
      return "met";
    case "failed":
      return "failed";
    default:
      return "pending";
  }
}

export function OrchestratorGrillingCard({
  status,
  goal,
  criteria,
}: OrchestratorGrillingCardProps) {
  const style = statusStyle(status);

  return (
    <div
      data-testid="orchestrator-grilling"
      data-grilling-status={status}
      className="my-2 p-2 text-sm"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-3xs uppercase tracking-wider text-muted">
            Validating evidence
          </div>
          <div className="mt-0.5 font-semibold leading-snug">{goal}</div>
        </div>
        <span
          data-testid="orchestrator-grilling-status"
          className={`inline-flex shrink-0 items-center gap-1 rounded-sm px-1.5 py-0.5 text-3xs font-medium ${style.toneClass}`}
        >
          {style.icon}
          {style.label}
        </span>
      </div>

      <ul className="mt-2 flex flex-col gap-1.5">
        {criteria.map((criterion) => (
          <li
            key={criterion.id}
            data-testid={`grilling-criterion-${criterion.id}`}
            data-criterion-state={criterion.state}
            className="flex items-start gap-2"
          >
            <span className="mt-0.5 shrink-0">
              {criterionIcon(criterion.state)}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 leading-snug">
                  {criterion.label}
                </span>
                <span className="shrink-0 text-3xs uppercase tracking-wider text-muted">
                  {criterionStateLabel(criterion.state)}
                </span>
              </div>
              {criterion.note ? (
                <p className="mt-0.5 text-3xs text-muted">{criterion.note}</p>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
