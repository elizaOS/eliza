/**
 * Projects persisted workflow steps and native execution events into stable
 * graph geometry without depending on the renderer or browser environment.
 */
import type { Edge, Node } from "@xyflow/react";
import type {
  WorkflowExecution,
  WorkflowStepManifest,
} from "../../api/client-types-chat";

export type WorkflowStepState =
  | "idle"
  | "queued"
  | "running"
  | "waiting"
  | "skipped"
  | "finished"
  | "failed";

interface WorkflowNodeData extends Record<string, unknown> {
  step: WorkflowStepManifest;
  state: WorkflowStepState;
}

export type WorkflowCanvasNode = Node<WorkflowNodeData, "workflowStep">;

/**
 * Node lifecycle events of the Smithers engine and the step state each one
 * sets. Every other event (tool calls, outputs, token usage, heartbeats,
 * approval decisions) leaves the node's state as it was.
 */
const NODE_LIFECYCLE_STATES: Readonly<Record<string, WorkflowStepState>> = {
  NodePending: "queued",
  NodeSkipped: "skipped",
  NodeStarted: "running",
  NodeRetrying: "running",
  NodeStalled: "running",
  NodeWaitingApproval: "waiting",
  NodeWaitingTimer: "waiting",
  NodeFinished: "finished",
  NodeFailed: "failed",
  NodeCancelled: "failed",
};

/** States that only an active run can hold. */
const ACTIVE_STATES = new Set<WorkflowStepState>([
  "queued",
  "running",
  "waiting",
]);

function latestNodeStates(
  execution: WorkflowExecution | null,
): Map<string, WorkflowStepState> {
  const states = new Map<string, WorkflowStepState>();
  for (const event of execution?.events ?? []) {
    const state = NODE_LIFECYCLE_STATES[event.type];
    if (event.nodeId && state) states.set(event.nodeId, state);
  }
  // A settled run has no node still in progress; one that never reported its
  // end is shown as not run rather than as running forever.
  if (execution?.finished)
    for (const [nodeId, state] of states)
      if (ACTIVE_STATES.has(state)) states.set(nodeId, "idle");
  for (const [stepId, state] of typedStepStates(execution))
    states.set(stepId, state);
  return states;
}

/**
 * A typed phone workflow compiles to one `typed-steps` node that loops over the
 * spec's steps, so no event names a step. Its output lists each step's result.
 */
function typedStepStates(
  execution: WorkflowExecution | null,
): Map<string, WorkflowStepState> {
  const states = new Map<string, WorkflowStepState>();
  const output = execution?.output;
  if (!Array.isArray(output) || output.length !== 1) return states;
  const item = output[0] as Record<string, unknown> | null;
  if (
    !item ||
    typeof item !== "object" ||
    item.nodeId !== "typed-steps" ||
    item.runId !== execution?.id ||
    !Array.isArray(item.steps)
  )
    return states;
  for (const step of item.steps as unknown[]) {
    if (!step || typeof step !== "object") continue;
    const { id, status } = step as Record<string, unknown>;
    if (typeof id !== "string") continue;
    if (status === "completed") states.set(id, "finished");
    else if (status === "skipped") states.set(id, "skipped");
  }
  return states;
}

/** Converts the persisted visual manifest into deterministic React Flow geometry. */
export function workflowStepsToFlow(
  steps: WorkflowStepManifest[],
  execution: WorkflowExecution | null,
): { nodes: WorkflowCanvasNode[]; edges: Edge[] } {
  const stepIds = new Set(steps.map((step) => step.id));
  const dependencies = new Map<string, string[]>();
  steps.forEach((step, index) => {
    const explicit = (step.dependsOn ?? []).filter((id) => stepIds.has(id));
    dependencies.set(
      step.id,
      step.dependsOn !== undefined || index === 0
        ? explicit
        : [steps[index - 1].id],
    );
  });

  const levels = new Map<string, number>();
  const resolving = new Set<string>();
  const resolveLevel = (stepId: string): number => {
    const resolved = levels.get(stepId);
    if (resolved !== undefined) return resolved;
    if (resolving.has(stepId)) return 0;
    resolving.add(stepId);
    const deps = dependencies.get(stepId) ?? [];
    const level =
      deps.length === 0
        ? 0
        : Math.max(...deps.map((dependency) => resolveLevel(dependency))) + 1;
    resolving.delete(stepId);
    levels.set(stepId, level);
    return level;
  };
  for (const step of steps) resolveLevel(step.id);
  const rows = new Map<number, WorkflowStepManifest[]>();
  for (const step of steps) {
    const level = levels.get(step.id) ?? 0;
    rows.set(level, [...(rows.get(level) ?? []), step]);
  }

  const states = latestNodeStates(execution);
  const nodes = steps.map<WorkflowCanvasNode>((step) => {
    const level = levels.get(step.id) ?? 0;
    const row = rows.get(level) ?? [step];
    const rowIndex = row.findIndex((candidate) => candidate.id === step.id);
    return {
      id: step.id,
      type: "workflowStep",
      position: {
        x: level * 250,
        y: (rowIndex - (row.length - 1) / 2) * 112,
      },
      data: { step, state: states.get(step.id) ?? "idle" },
      draggable: false,
      connectable: false,
      selectable: true,
      ariaLabel: `${step.label}, ${step.kind}`,
    };
  });
  const edges = steps.flatMap<Edge>((step) =>
    (dependencies.get(step.id) ?? []).map((source) => ({
      id: `${source}->${step.id}`,
      source,
      target: step.id,
      type: "smoothstep",
      animated: states.get(step.id) === "running",
      style: {
        stroke:
          states.get(step.id) === "running"
            ? "hsl(var(--primary))"
            : "hsl(var(--border))",
        strokeWidth: 1.5,
      },
    })),
  );
  return { nodes, edges };
}
