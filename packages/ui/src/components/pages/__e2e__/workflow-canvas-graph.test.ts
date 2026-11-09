import { describe, expect, it } from "vitest";
import type {
  WorkflowExecution,
  WorkflowStepManifest,
} from "../../../api/client-types-chat";
import { workflowStepsToFlow } from "../workflow-canvas-graph";

const steps: WorkflowStepManifest[] = ["a", "b", "c"].map((id) => ({
  id,
  label: id.toUpperCase(),
  kind: "task",
}));

function execution(
  events: Array<{ type: string; nodeId?: string }>,
  extra: Partial<WorkflowExecution> = {},
): WorkflowExecution {
  return {
    id: "run-1",
    status: "running",
    finished: false,
    startedAt: "2026-11-08T08:00:00.000Z",
    mode: "manual",
    workflowId: "wf-1",
    workflowVersionId: "v1",
    workflowName: "Digest",
    input: {},
    events: events.map((event, index) => ({
      id: `e${index}`,
      sequence: index,
      runId: "run-1",
      workflowId: "wf-1",
      timestamp: "2026-11-08T08:00:00.000Z",
      payload: {},
      ...event,
    })),
    ...extra,
  };
}

function states(run: WorkflowExecution | null): Record<string, string> {
  const { nodes } = workflowStepsToFlow(steps, run);
  return Object.fromEntries(nodes.map((node) => [node.id, node.data.state]));
}

describe("workflow canvas node state", () => {
  it("shows pending nodes as queued and only the started node as running", () => {
    const run = execution([
      { type: "NodePending", nodeId: "a" },
      { type: "NodePending", nodeId: "b" },
      { type: "NodePending", nodeId: "c" },
      { type: "NodeStarted", nodeId: "a" },
    ]);
    expect(states(run)).toEqual({ a: "running", b: "queued", c: "queued" });
    const animated = workflowStepsToFlow(steps, run).edges.filter(
      (edge) => edge.animated,
    );
    expect(animated).toEqual([]);
  });

  it("shows a skipped node as skipped", () => {
    expect(
      states(execution([{ type: "NodeSkipped", nodeId: "b" }])).b,
    ).toBe("skipped");
  });

  it("ignores tool calls and approval decisions", () => {
    const run = execution([
      { type: "NodeStarted", nodeId: "a" },
      { type: "ToolCallFinished", nodeId: "a" },
      { type: "NodeWaitingApproval", nodeId: "b" },
      { type: "ApprovalGranted", nodeId: "b" },
      { type: "TaskHeartbeat", nodeId: "a" },
    ]);
    expect(states(run)).toEqual({ a: "running", b: "waiting", c: "idle" });
  });

  it("maps finish, failure and cancellation", () => {
    const run = execution([
      { type: "NodeFinished", nodeId: "a" },
      { type: "NodeFailed", nodeId: "b" },
      { type: "NodeCancelled", nodeId: "c" },
    ]);
    expect(states(run)).toEqual({ a: "finished", b: "failed", c: "failed" });
  });

  it("shows no node in progress once the run has settled", () => {
    const run = execution(
      [
        { type: "NodeFailed", nodeId: "a" },
        { type: "NodePending", nodeId: "b" },
        { type: "NodeStarted", nodeId: "c" },
      ],
      { status: "failed", finished: true },
    );
    expect(states(run)).toEqual({ a: "failed", b: "idle", c: "idle" });
  });

  it("drives a typed workflow's steps from its output", () => {
    const run = execution(
      [
        { type: "NodeStarted", nodeId: "typed-steps" },
        { type: "NodeFinished", nodeId: "typed-steps" },
      ],
      {
        status: "finished",
        finished: true,
        output: [
          {
            nodeId: "typed-steps",
            runId: "run-1",
            text: "done",
            steps: [
              { id: "a", status: "completed", text: "x" },
              { id: "b", status: "skipped", text: "" },
            ],
          },
        ],
      },
    );
    expect(states(run)).toEqual({ a: "finished", b: "skipped", c: "idle" });
  });

  it("ignores typed output of another run", () => {
    const run = execution([], {
      output: [
        {
          nodeId: "typed-steps",
          runId: "other-run",
          text: "done",
          steps: [{ id: "a", status: "completed", text: "x" }],
        },
      ],
    });
    expect(states(run).a).toBe("idle");
  });
});
