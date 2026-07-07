/**
 * Render fixture for the inline task-activity pipeline (#13536). Mounts the REAL
 * pipeline components — the expanded task card's nested `SubagentBlock`s (one a
 * nested child session), their in-place `ToolCallEventLog` steps and live
 * `PlanChecklist`, plus the standalone `WorkflowSteps` and `PlanChecklist`
 * widgets — populated with the exact `SubagentActivity`/plan shapes the
 * WS-driven `task-activity-store` produces from a `pty-session-event` stream.
 * The store's stream grouping + on-wire reconstruction are proven separately by
 * `task-activity-store.test.ts` (real `client.deliverWsMessageForTest` →
 * `bindWs`); this fixture is the rendered-pixel half the screenshot harness
 * captures without dragging the client/transport graph into the browser bundle.
 */
import { ChevronDown, CirclePlay } from "lucide-react";
import { createRoot } from "react-dom/client";
import type {
  SubagentActivity,
  TaskActivityStep,
} from "../../../../state/task-activity-store";
import type { WorkflowSpec } from "../../message-workflow-parser";
import { PlanChecklist, SubagentBlock } from "../task-pipeline";
import { WorkflowSteps } from "../workflow-steps";

// ChatWidgetShell's i18n selector is supplied by the runner's esbuild state
// stub. Keep this render fixture data-only so it never mutates the app store.
const T = 1_748_779_200_000;

function step(
  id: string,
  seq: number,
  tool: TaskActivityStep["tool"],
): TaskActivityStep {
  return { id, seq, timestamp: T + seq, tool };
}

// The builder sub-agent: a live plan, a resolved read + a running edit — exactly
// the tree the store builds from the fixture's frame sequence.
const builder: SubagentActivity = {
  sessionId: "builder-7f3a",
  status: "running",
  label: "builder",
  currentText: "Patching the turn controller to drain the sub-planner queue",
  plan: [
    { content: "Read the failing planner test", status: "completed" },
    { content: "Patch the turn controller", status: "in_progress" },
    { content: "Re-run the suite", status: "pending" },
  ],
  steps: [
    step("t1", 3, {
      status: "success",
      title: "read",
      output: "180 lines",
      rawInput: { path: "src/runtime/turn-controller.ts" },
    }),
    step("t2", 5, {
      status: "running",
      title: "edit",
      rawInput: { path: "src/runtime/turn-controller.ts" },
    }),
  ],
  updatedAt: T + 5,
  firstSeq: 1,
};

// The reviewer child session, nested under the builder via parentSessionId.
const reviewer: SubagentActivity = {
  sessionId: "reviewer-2c8b",
  parentSessionId: "builder-7f3a",
  status: "running",
  label: "reviewer",
  currentReasoning:
    "The drain guard looks correct; checking the empty-queue path",
  steps: [],
  updatedAt: T + 7,
  firstSeq: 6,
};

const workflow: WorkflowSpec = {
  id: "wf-deploy",
  title: "Deploy",
  steps: [
    { label: "Build image", status: "done" },
    { label: "Push to registry", status: "running" },
    { label: "Roll out", status: "pending" },
  ],
};

const checklist = [
  { content: "Draft the migration runbook", status: "completed" },
  { content: "Review with the on-call", status: "in_progress" },
  { content: "Schedule the maintenance window", status: "pending" },
];

// The expanded task-card shell mirrors TaskWidget's expanded body: header +
// nested SubagentBlocks. Rendered statically here so the card's own client
// hydrate/store subscription (covered by the widget's own tests) stays out of
// the browser bundle.
function TaskCard() {
  return (
    <div
      data-testid="task-widget"
      data-task-id="b1a7c0de"
      data-task-status="active"
      data-expanded="true"
      className="my-2 overflow-hidden rounded-sm border border-border bg-card"
    >
      <div className="flex items-start gap-2 px-3 py-2">
        <span className="mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center text-ok">
          <CirclePlay className="h-3.5 w-3.5 animate-pulse" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-txt">
            Ship the planner loop
          </span>
          <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted">
            <span className="text-ok">active</span>
            <span className="text-muted/40">·</span>
            <span>2/2 agents</span>
            <span className="text-muted/40">·</span>
            <span className="tabular-nums">9.2K</span>
          </span>
        </span>
        <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 rotate-180 text-muted" />
      </div>
      <div
        data-testid="task-widget-pipeline"
        className="flex flex-col gap-3 border-t border-border px-3 py-3"
      >
        <SubagentBlock agent={builder} />
        <SubagentBlock agent={reviewer} />
        <span className="w-fit text-xs text-accent">Open in workbench →</span>
      </div>
    </div>
  );
}

const root = createRoot(document.getElementById("root") as HTMLElement);
root.render(
  <div
    data-testid="task-pipeline-fixture"
    style={{ display: "flex", flexDirection: "column", gap: 20, padding: 20 }}
  >
    <div>
      <div className="mb-1 text-xs uppercase tracking-wide text-muted">
        Live task card (WS-driven, expanded)
      </div>
      <TaskCard />
    </div>
    <div>
      <div className="mb-1 text-xs uppercase tracking-wide text-muted">
        [WORKFLOW] step pipeline
      </div>
      <WorkflowSteps workflow={workflow} />
    </div>
    <div>
      <div className="mb-1 text-xs uppercase tracking-wide text-muted">
        [CHECKLIST] todo list
      </div>
      <div className="my-2 rounded-sm border border-border bg-card px-3 py-2">
        <PlanChecklist entries={checklist} title="Migration" />
      </div>
    </div>
  </div>,
);
