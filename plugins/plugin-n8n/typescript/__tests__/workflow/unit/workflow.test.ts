import { describe, expect, test } from "vitest";
import { positionNodes, validateWorkflow } from "../../../workflow/utils/workflow";
import {
  createGmailNode,
  createInvalidWorkflow_brokenConnection,
  createInvalidWorkflow_duplicateNames,
  createInvalidWorkflow_noNodes,
  createSlackNode,
  createTriggerNode,
  createValidWorkflow,
  createWorkflowWithBranching,
  createWorkflowWithoutPositions,
} from "../fixtures/workflows";

// ============================================================================
// validateWorkflow
// ============================================================================

describe("validateWorkflow", () => {
  test("valid workflow passes validation", () => {
    const result = validateWorkflow(createValidWorkflow());
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test("rejects workflow with no nodes", () => {
    const result = validateWorkflow(createInvalidWorkflow_noNodes());
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Workflow must have at least one node");
  });

  test("rejects workflow with missing nodes array", () => {
    const result = validateWorkflow({
      name: "Bad",
      nodes: null as unknown as [],
      connections: {},
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Missing or invalid nodes array");
  });

  test("rejects workflow with missing connections", () => {
    const result = validateWorkflow({
      name: "Bad",
      nodes: [createTriggerNode()],
      connections: null as unknown as Record<string, unknown>,
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Missing or invalid connections object");
  });

  test("detects broken connections to non-existent nodes", () => {
    const result = validateWorkflow(createInvalidWorkflow_brokenConnection());
    expect(result.valid).toBe(false);
    const connError = result.errors.find((e) => e.includes("non-existent target node"));
    expect(connError).toBeDefined();
  });

  test("detects duplicate node names", () => {
    const result = validateWorkflow(createInvalidWorkflow_duplicateNames());
    expect(result.valid).toBe(false);
    const dupError = result.errors.find((e) => e.includes("Duplicate node name"));
    expect(dupError).toBeDefined();
  });

  test("warns about missing trigger node", () => {
    const workflow = createValidWorkflow({
      nodes: [{ ...createGmailNode(), type: "n8n-nodes-base.gmail" }, createSlackNode()],
      connections: {
        Gmail: {
          main: [[{ node: "Slack", type: "main", index: 0 }]],
        },
      },
    });
    const result = validateWorkflow(workflow);
    expect(result.valid).toBe(true);
    const triggerWarning = result.warnings.find((w) => w.includes("no trigger node"));
    expect(triggerWarning).toBeDefined();
  });

  test("warns about orphan nodes", () => {
    const workflow = createValidWorkflow({
      nodes: [createTriggerNode(), createGmailNode(), createSlackNode()],
      connections: {
        "Schedule Trigger": {
          main: [[{ node: "Gmail", type: "main", index: 0 }]],
        },
      },
    });
    const result = validateWorkflow(workflow);
    const orphanWarning = result.warnings.find((w) => w.includes("no incoming connections"));
    expect(orphanWarning).toBeDefined();
    expect(orphanWarning).toContain("Slack");
  });

  test("warns about missing positions (positionNodes handles the fix)", () => {
    const workflow = createWorkflowWithoutPositions();
    const result = validateWorkflow(workflow);
    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.includes("auto-positioned"))).toBe(true);
  });

  test("detects nodes with missing name", () => {
    const result = validateWorkflow({
      name: "Bad",
      nodes: [{ ...createTriggerNode(), name: "" }],
      connections: {},
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Node missing name");
  });

  test("detects nodes with missing type", () => {
    const result = validateWorkflow({
      name: "Bad",
      nodes: [{ ...createTriggerNode(), type: "" }],
      connections: {},
    });
    expect(result.valid).toBe(false);
    const typeError = result.errors.find((e) => e.includes("missing type"));
    expect(typeError).toBeDefined();
  });

  test("connection from non-existent source node", () => {
    const result = validateWorkflow({
      name: "Bad",
      nodes: [createTriggerNode()],
      connections: {
        "Ghost Node": {
          main: [[{ node: "Schedule Trigger", type: "main", index: 0 }]],
        },
      },
    });
    expect(result.valid).toBe(false);
    const srcError = result.errors.find((e) => e.includes("non-existent source node"));
    expect(srcError).toBeDefined();
  });
});

// ============================================================================
// positionNodes
// ============================================================================

describe("positionNodes", () => {
  test("skips positioning when all nodes have valid positions", () => {
    const workflow = createValidWorkflow();
    const result = positionNodes(workflow);
    // Positions should remain unchanged
    expect(result.nodes[0].position).toEqual(workflow.nodes[0].position);
    expect(result.nodes[1].position).toEqual(workflow.nodes[1].position);
  });

  test("positions nodes with missing positions", () => {
    const workflow = createWorkflowWithoutPositions();
    const result = positionNodes(workflow);
    for (const node of result.nodes) {
      expect(node.position).toBeDefined();
      expect(typeof node.position[0]).toBe("number");
      expect(typeof node.position[1]).toBe("number");
    }
  });

  test("positions trigger node before action nodes (left-to-right)", () => {
    const workflow = createWorkflowWithoutPositions();
    const result = positionNodes(workflow);
    // Trigger should be leftmost (smallest X)
    const triggerPos = result.nodes.find((n) => n.type.includes("Trigger"))?.position;
    const gmailPos = result.nodes.find((n) => n.type.includes("gmail"))?.position;
    expect(triggerPos[0]).toBeLessThan(gmailPos[0]);
  });

  test("positions branching nodes at different Y levels", () => {
    const workflow = {
      ...createWorkflowWithBranching(),
      nodes: createWorkflowWithBranching().nodes.map((n) => ({
        ...n,
        position: undefined as unknown as [number, number],
      })),
    };
    const result = positionNodes(workflow);
    // Gmail and Slack are at the same depth but different branches
    const gmailPos = result.nodes.find((n) => n.name === "Gmail")?.position;
    const slackPos = result.nodes.find((n) => n.name === "Slack")?.position;
    // Same X (same level), different Y (different branches)
    expect(gmailPos[0]).toBe(slackPos[0]);
    expect(gmailPos[1]).not.toBe(slackPos[1]);
  });

  test("does not mutate original workflow", () => {
    const workflow = createWorkflowWithoutPositions();
    const originalPos = workflow.nodes[0].position;
    positionNodes(workflow);
    expect(workflow.nodes[0].position).toBe(originalPos);
  });

  test("handles single-node workflow", () => {
    const workflow = {
      name: "Single",
      nodes: [
        {
          ...createTriggerNode(),
          position: undefined as unknown as [number, number],
        },
      ],
      connections: {},
    };
    const result = positionNodes(workflow);
    expect(result.nodes[0].position).toBeDefined();
    expect(result.nodes[0].position[0]).toBe(250);
    // Y is centered: startY(300) - totalHeight(100)/2 = 250
    expect(result.nodes[0].position[1]).toBe(250);
  });

  test("handles linear chain of 4 nodes", () => {
    const workflow = {
      name: "Linear Chain",
      nodes: [
        {
          ...createTriggerNode({ name: "Start" }),
          position: undefined as unknown as [number, number],
        },
        {
          ...createGmailNode({ name: "Step1" }),
          position: undefined as unknown as [number, number],
        },
        {
          ...createSlackNode({ name: "Step2" }),
          position: undefined as unknown as [number, number],
        },
        {
          ...createGmailNode({ name: "Step3" }),
          position: undefined as unknown as [number, number],
        },
      ],
      connections: {
        Start: { main: [[{ node: "Step1", type: "main", index: 0 }]] },
        Step1: { main: [[{ node: "Step2", type: "main", index: 0 }]] },
        Step2: { main: [[{ node: "Step3", type: "main", index: 0 }]] },
      },
    };
    const result = positionNodes(workflow);
    // Each node should have increasing X
    const positions = result.nodes.map((n) => n.position[0]);
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i]).toBeGreaterThan(positions[i - 1]);
    }
  });
});
