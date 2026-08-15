/** Verifies deterministic Smithers graph geometry and live event projection without a DOM. */
import { describe, expect, it } from "vitest";
import type {
  WorkflowExecution,
  WorkflowStepManifest,
} from "../../api/client-types-chat";
import { workflowStepsToFlow } from "./workflow-canvas-graph";

const steps: WorkflowStepManifest[] = [
  { id: "start", label: "Start", kind: "task", dependsOn: [] },
  { id: "left", label: "Left", kind: "task", dependsOn: ["start"] },
  { id: "right", label: "Right", kind: "task", dependsOn: ["start"] },
  {
    id: "merge",
    label: "Merge",
    kind: "parallel",
    dependsOn: ["left", "right"],
  },
];

describe("workflowStepsToFlow", () => {
  it("lays parallel dependencies out in shared columns with exact edges", () => {
    const flow = workflowStepsToFlow(steps, null);
    expect(flow.edges.map((edge) => `${edge.source}->${edge.target}`)).toEqual([
      "start->left",
      "start->right",
      "left->merge",
      "right->merge",
    ]);
    const positions = Object.fromEntries(
      flow.nodes.map((node) => [node.id, node.position]),
    );
    expect(positions.left.x).toBe(positions.right.x);
    expect(positions.left.y).not.toBe(positions.right.y);
    expect(positions.merge.x).toBeGreaterThan(positions.left.x);
  });

  it("projects the latest native execution event onto each node", () => {
    const execution = {
      events: [
        { nodeId: "left", type: "node.started" },
        { nodeId: "left", type: "node.finished" },
        { nodeId: "right", type: "node.waiting-approval" },
      ],
    } as WorkflowExecution;
    const flow = workflowStepsToFlow(steps, execution);
    expect(flow.nodes.find((node) => node.id === "left")?.data.state).toBe(
      "finished",
    );
    expect(flow.nodes.find((node) => node.id === "right")?.data.state).toBe(
      "waiting",
    );
  });

  it("drops dangling declared dependencies instead of inventing an edge", () => {
    const flow = workflowStepsToFlow(
      [
        { id: "first", label: "First", kind: "task" },
        {
          id: "detached",
          label: "Detached",
          kind: "task",
          dependsOn: ["missing"],
        },
      ],
      null,
    );
    expect(flow.edges).toEqual([]);
  });

  it("keeps malformed cyclic manifests within bounded canvas geometry", () => {
    const flow = workflowStepsToFlow(
      [
        { id: "one", label: "One", kind: "task", dependsOn: ["two"] },
        { id: "two", label: "Two", kind: "task", dependsOn: ["one"] },
      ],
      null,
    );
    expect(
      Math.max(...flow.nodes.map((node) => node.position.x)),
    ).toBeLessThanOrEqual(500);
  });
});
