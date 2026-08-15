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
  | "running"
  | "finished"
  | "failed"
  | "waiting";

interface WorkflowNodeData extends Record<string, unknown> {
  step: WorkflowStepManifest;
  state: WorkflowStepState;
}

export type WorkflowCanvasNode = Node<WorkflowNodeData, "workflowStep">;

function eventState(type?: string): WorkflowStepState {
  if (!type) return "idle";
  if (/fail|error|cancel/i.test(type)) return "failed";
  if (/waiting|approval|signal/i.test(type)) return "waiting";
  if (/finish|complete|success/i.test(type)) return "finished";
  return "running";
}

function latestNodeStates(
  execution: WorkflowExecution | null,
): Map<string, WorkflowStepState> {
  const states = new Map<string, WorkflowStepState>();
  for (const event of execution?.events ?? []) {
    if (event.nodeId) states.set(event.nodeId, eventState(event.type));
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
