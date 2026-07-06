/**
 * WorkflowSteps — inline multi-step progress list for a `[WORKFLOW]` block
 * (issue #13536 §(d)). Renders step k/N with a per-step status icon; a
 * re-emitted block with advanced statuses mutates the list in place. Purely
 * presentational — the parser (`../message-workflow-parser.ts`) owns validation.
 */

import { Circle, CircleCheck, CircleX, Loader2 } from "lucide-react";
import { memo } from "react";
import type {
  WorkflowSpec,
  WorkflowStepStatus,
} from "../message-workflow-parser";
import { workflowPropsEqual } from "./widget-equality";

const STEP_TONE: Record<WorkflowStepStatus, string> = {
  pending: "text-muted",
  running: "text-ok",
  done: "text-ok",
  failed: "text-danger",
};

function StepIcon({ status }: { status: WorkflowStepStatus }) {
  if (status === "done") return <CircleCheck className="h-3.5 w-3.5 text-ok" />;
  if (status === "failed")
    return <CircleX className="h-3.5 w-3.5 text-danger" />;
  if (status === "running")
    return <Loader2 className="h-3.5 w-3.5 animate-spin text-ok" />;
  return <Circle className="h-3.5 w-3.5 text-muted" />;
}

// Memoized on the workflow spec by value (see `workflowPropsEqual`): a
// re-emitted block that advances a step re-renders; an identical re-parse during
// the surrounding turn's streaming does not.
export const WorkflowSteps = memo(function WorkflowSteps({
  workflow,
}: {
  workflow: WorkflowSpec;
}) {
  const done = workflow.steps.filter((s) => s.status === "done").length;
  const failed = workflow.steps.some((s) => s.status === "failed");
  return (
    <div
      data-testid="workflow-steps"
      data-workflow-id={workflow.id}
      className="my-2 flex flex-col gap-2 rounded-sm border border-border bg-card px-3 py-2"
    >
      <div className="flex items-center justify-between text-xs">
        <span className="font-medium text-txt">
          {workflow.title ?? "Workflow"}
        </span>
        <span
          className={`tabular-nums ${failed ? "text-danger" : "text-muted"}`}
        >
          {done}/{workflow.steps.length}
        </span>
      </div>
      <ol className="flex flex-col gap-1">
        {workflow.steps.map((step, i) => (
          <li
            // biome-ignore lint/suspicious/noArrayIndexKey: steps have no stable id; index+label is stable within a snapshot render.
            key={`${i}-${step.label}`}
            data-status={step.status}
            className="flex items-start gap-2 text-sm"
          >
            <span className="mt-0.5 shrink-0">
              <StepIcon status={step.status} />
            </span>
            <span className="w-6 shrink-0 text-xs tabular-nums text-muted">
              {i + 1}.
            </span>
            <span
              className={`min-w-0 flex-1 break-words ${
                step.status === "done"
                  ? "text-muted"
                  : STEP_TONE[step.status] === "text-danger"
                    ? "text-danger"
                    : "text-txt"
              }`}
            >
              {step.label}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}, workflowPropsEqual);
