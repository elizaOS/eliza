/** Complete recorded handler/planner/action payloads, separate from call totals. */
import { useId, useState } from "react";
import type { TrajectoryDetailResult } from "../../../api/client-types-cloud";
import { Button } from "../../ui/button";
import { Separator } from "../../ui/separator";
import { TrajectoryCodeBlock } from "./trajectory-code-block";

type Stage = NonNullable<TrajectoryDetailResult["semanticStages"]>[number];
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown) =>
  typeof value === "string"
    ? value
    : value == null
      ? ""
      : JSON.stringify(value, null, 2);

export function trajectoryStageLabel(stage: Stage): string {
  const modelType = object(stage.payload.model).modelType;
  const toolName = object(stage.payload.tool).name;
  const kind = stage.kind
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ");
  if (typeof toolName === "string")
    return `${kind.toLowerCase()} · ${toolName}`;
  if (typeof modelType === "string") {
    const label = modelType.replace(/_/g, " ").toLowerCase();
    return stage.kind === "evaluation" ? `evaluation · ${label}` : label;
  }
  return kind.toLowerCase();
}

function RecordedStep({
  stage,
  onCopy,
}: {
  stage: Stage;
  onCopy: (content: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const contentId = useId();
  const model = object(stage.payload.model);
  const tool = object(stage.payload.tool);
  const search = object(stage.payload.toolSearch);
  return (
    <div>
      <Separator />
      <Button
        variant="ghost"
        size="touch"
        className="w-full justify-start whitespace-normal break-words px-0 text-left text-sm"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={() => setOpen((value) => !value)}
      >
        <span aria-hidden="true">{open ? "▾" : "▸"}</span>
        {trajectoryStageLabel(stage)} · {stage.latencyMs}ms
      </Button>
      {open ? (
        <div id={contentId} className="space-y-3 pb-3">
          {[
            [
              "Input",
              model.messages ?? tool.input ?? tool.args ?? search.query,
            ],
            [
              "Output",
              model.response ??
                tool.output ??
                tool.result ??
                search.results ??
                stage.payload.evaluation,
            ],
            ["Complete recorded step", stage],
          ].map(([label, value]) => (
            <div key={String(label)} className="space-y-2">
              <h4 className="text-xs font-medium">{String(label)}</h4>
              <TrajectoryCodeBlock
                compact
                label={String(label)}
                content={text(value)}
                linesLabel=""
                copyLabel="Copy"
                collapseLabel="Collapse"
                expandLabel="Expand"
                onCopy={onCopy}
              />
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function TrajectoryRecordedSteps({
  stages,
  onCopy,
}: {
  stages: Stage[];
  onCopy: (content: string) => void;
}) {
  if (!stages.length) return null;
  return (
    <section aria-label="Recorded steps">
      <h3 className="mb-2 text-sm font-semibold">Recorded steps</h3>
      <p className="mb-3 text-xs text-muted">
        Handler, planner and action records in time order. Model steps
        correspond to the calls above; they are not additional calls.
      </p>
      {[...stages]
        .sort((a, b) => a.startedAt - b.startedAt)
        .map((stage) => (
          <RecordedStep key={stage.stageId} stage={stage} onCopy={onCopy} />
        ))}
    </section>
  );
}
