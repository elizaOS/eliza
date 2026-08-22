/**
 * WorkflowSteps — inline multi-step progress list for a `[WORKFLOW]` block
 * (issue #13536 §(d)). Renders step k/N with a per-step status icon; a
 * re-emitted block with advanced statuses mutates the list in place. Purely
 * presentational — the parser (`../message-workflow-parser.ts`) owns validation.
 */

import {
  Circle,
  CircleCheck,
  CircleX,
  ExternalLink,
  Loader2,
  Square,
} from "lucide-react";
import { memo, useEffect, useMemo, useState } from "react";
import { client } from "../../../api";
import type { WorkflowExecution } from "../../../api/client-types-chat";
import { dispatchVisualizeWorkflow } from "../../pages/workflow-graph-events";
import type {
  WorkflowSpec,
  WorkflowStepStatus,
} from "../message-workflow-parser";
import { ChatWidgetShell } from "./chat-widget-shell";
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
  const [execution, setExecution] = useState<WorkflowExecution | null>(null);
  useEffect(() => {
    if (!workflow.runId) return;
    let active = true;
    const load = async () => {
      try {
        const next = await client.getWorkflowExecution(
          workflow.runId as string,
        );
        if (active) setExecution(next);
        return ["cancelled", "continued", "failed", "finished"].includes(
          next.status,
        );
      } catch {
        // error-policy:J4 the emitted snapshot remains visible if live refresh is unavailable.
        return false;
      }
    };
    void load();
    const timer = window.setInterval(async () => {
      if (await load()) window.clearInterval(timer);
    }, 1_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [workflow.runId]);
  const steps = useMemo(() => {
    if (!execution) return workflow.steps;
    const latest = new Map<string, string>();
    for (const event of execution.events ?? []) {
      if (event.nodeId) latest.set(event.nodeId, event.type);
    }
    return workflow.steps.map((step) => {
      const event = step.nodeId ? latest.get(step.nodeId) : undefined;
      if (!event) return step;
      if (/fail|error/i.test(event))
        return { ...step, status: "failed" as const };
      if (/finish|complete|success/i.test(event))
        return { ...step, status: "done" as const };
      return { ...step, status: "running" as const };
    });
  }, [execution, workflow.steps]);
  const done = steps.filter((s) => s.status === "done").length;
  const failed =
    execution?.status === "failed" || steps.some((s) => s.status === "failed");
  const complete =
    Boolean(
      execution &&
        ["cancelled", "continued", "failed", "finished"].includes(
          execution.status,
        ),
    ) ||
    failed ||
    done === steps.length;
  const title = workflow.title ?? "Workflow";
  return (
    <ChatWidgetShell
      title={title}
      status={
        <span
          className={`text-xs-tight font-medium tabular-nums ${
            failed ? "text-danger" : "text-muted"
          }`}
        >
          {done}/{workflow.steps.length}
        </span>
      }
      summary={`${done}/${workflow.steps.length} ${failed ? "failed" : "complete"}`}
      complete={complete}
      testId="workflow-steps-shell"
    >
      <div
        data-testid="workflow-steps"
        data-workflow-id={workflow.id}
        className="flex flex-col gap-2 py-1.5"
      >
        <ol className="flex flex-col gap-1">
          {steps.map((step, i) => (
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
        {workflow.widgets?.map((widget) => (
          <div
            key={widget.id}
            className="mt-2 rounded-lg border border-border/70 bg-muted/20 p-2.5"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-txt">
                {widget.title}
              </span>
              <span className="rounded bg-primary/10 px-1.5 py-0.5 text-3xs uppercase tracking-wider text-primary">
                {widget.component}
              </span>
            </div>
            {execution?.output !== undefined ? (
              <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap text-xs-tight text-muted">
                {JSON.stringify(execution.output, null, 2)}
              </pre>
            ) : null}
          </div>
        ))}
        {workflow.workflowId || (workflow.runId && !complete) ? (
          <div className="mt-2 flex gap-2 border-t border-border/60 pt-2">
            {workflow.workflowId ? (
              <button
                type="button"
                onClick={() =>
                  dispatchVisualizeWorkflow(workflow.workflowId as string)
                }
                className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-primary hover:bg-primary/10"
              >
                <ExternalLink className="h-3.5 w-3.5" /> Open workflow
              </button>
            ) : null}
            {workflow.runId && !complete ? (
              <button
                type="button"
                onClick={() =>
                  void client
                    .cancelWorkflowExecution(workflow.runId as string)
                    .then(setExecution)
                }
                className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-muted"
              >
                <Square className="h-3.5 w-3.5" /> Cancel run
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </ChatWidgetShell>
  );
}, workflowPropsEqual);
