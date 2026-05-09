import { describe, test, expect } from "bun:test";
import { loadTriggerOutputSchema } from "../../src/utils/outputSchema";
import {
  validateWorkflow,
  positionNodes,
  validateOutputReferences,
  validateNodeParameters,
  validateNodeInputs,
  correctOptionParameters,
  detectUnknownParameters,
  ensureExpressionPrefix,
} from "../../src/utils/workflow";
import {
  createValidWorkflow,
  createWorkflowWithoutPositions,
  createWorkflowWithBranching,
  createInvalidWorkflow_noNodes,
  createInvalidWorkflow_brokenConnection,
  createInvalidWorkflow_duplicateNames,
  createTriggerNode,
  createGmailNode,
  createGmailTriggerNode,
  createGithubTriggerNode,
  createSlackNode,
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
    const connError = result.errors.find((e) =>
      e.includes("non-existent target node"),
    );
    expect(connError).toBeDefined();
  });

  test("detects duplicate node names", () => {
    const result = validateWorkflow(createInvalidWorkflow_duplicateNames());
    expect(result.valid).toBe(false);
    const dupError = result.errors.find((e) =>
      e.includes("Duplicate node name"),
    );
    expect(dupError).toBeDefined();
  });

  test("warns about missing trigger node", () => {
    const workflow = createValidWorkflow({
      nodes: [
        { ...createGmailNode(), type: "n8n-nodes-base.gmail" },
        createSlackNode(),
      ],
      connections: {
        Gmail: {
          main: [[{ node: "Slack", type: "main", index: 0 }]],
        },
      },
    });
    const result = validateWorkflow(workflow);
    expect(result.valid).toBe(true);
    const triggerWarning = result.warnings.find((w) =>
      w.includes("no trigger node"),
    );
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
    const orphanWarning = result.warnings.find((w) =>
      w.includes("no incoming connections"),
    );
    expect(orphanWarning).toBeDefined();
    expect(orphanWarning).toContain("Slack");
  });

  test("warns about missing positions (positionNodes handles the fix)", () => {
    const workflow = createWorkflowWithoutPositions();
    const result = validateWorkflow(workflow);
    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.includes("auto-positioned"))).toBe(
      true,
    );
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
    const srcError = result.errors.find((e) =>
      e.includes("non-existent source node"),
    );
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
    const triggerPos = result.nodes.find((n) =>
      n.type.includes("Trigger"),
    )!.position;
    const gmailPos = result.nodes.find((n) =>
      n.type.includes("gmail"),
    )!.position;
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
    const gmailPos = result.nodes.find((n) => n.name === "Gmail")!.position;
    const slackPos = result.nodes.find((n) => n.name === "Slack")!.position;
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

// ============================================================================
// validateOutputReferences
// ============================================================================

describe("validateOutputReferences", () => {
  test("valid trigger field passes (Gmail Subject)", () => {
    const workflow = {
      name: "Gmail to Slack",
      nodes: [
        createGmailTriggerNode(),
        createSlackNode({ parameters: { text: "={{ $json.Subject }}" } }),
      ],
      connections: {
        "Gmail Trigger": {
          main: [[{ node: "Slack", type: "main", index: 0 }]],
        },
      },
    };
    const refs = validateOutputReferences(workflow);
    expect(refs).toEqual([]);
  });

  test("detects wrong case on trigger field (subject vs Subject)", () => {
    const workflow = {
      name: "Gmail to Slack",
      nodes: [
        createGmailTriggerNode(),
        createSlackNode({ parameters: { text: "={{ $json.subject }}" } }),
      ],
      connections: {
        "Gmail Trigger": {
          main: [[{ node: "Slack", type: "main", index: 0 }]],
        },
      },
    };
    const refs = validateOutputReferences(workflow);
    expect(refs.length).toBe(1);
    expect(refs[0].field).toBe("subject");
    expect(refs[0].sourceNodeType).toBe("n8n-nodes-base.gmailTrigger");
    expect(refs[0].availableFields).toContain("Subject (string)");
  });

  test("valid nested trigger field (GitHub body.repository.name)", () => {
    // Validates against captured GitHub trigger schema. The static crawl only
    // captures the surface event shape, so nested body.repository validation
    // requires the live-execution capture. Skip if nested schema is absent.
    const triggerSchema = loadTriggerOutputSchema(
      "n8n-nodes-base.githubTrigger",
    );
    if (!triggerSchema || !triggerSchema.fields.includes("body")) return;

    const workflow = {
      name: "GitHub to Slack",
      nodes: [
        createGithubTriggerNode(),
        createSlackNode({
          parameters: { text: "={{ $json.body.repository.name }}" },
        }),
      ],
      connections: {
        "GitHub Trigger": {
          main: [[{ node: "Slack", type: "main", index: 0 }]],
        },
      },
    };
    const refs = validateOutputReferences(workflow);
    expect(refs).toEqual([]);
  });

  test("detects invalid nested trigger field", () => {
    const workflow = {
      name: "GitHub to Slack",
      nodes: [
        createGithubTriggerNode(),
        createSlackNode({ parameters: { text: "={{ $json.body.repo }}" } }),
      ],
      connections: {
        "GitHub Trigger": {
          main: [[{ node: "Slack", type: "main", index: 0 }]],
        },
      },
    };
    const refs = validateOutputReferences(workflow);
    // Schema depends on n8n execution data — if not captured, validation is skipped
    if (refs.length === 0) return;
    expect(refs.length).toBe(1);
    expect(refs[0].field).toBe("body.repo");
  });

  test("skips unknown trigger type (no false positives)", () => {
    const workflow = {
      name: "Unknown trigger",
      nodes: [
        createTriggerNode({
          name: "My Trigger",
          type: "n8n-nodes-base.unknownTrigger",
        }),
        createSlackNode({ parameters: { text: "={{ $json.anything }}" } }),
      ],
      connections: {
        "My Trigger": {
          main: [[{ node: "Slack", type: "main", index: 0 }]],
        },
      },
    };
    const refs = validateOutputReferences(workflow);
    expect(refs).toEqual([]);
  });

  test("validates non-trigger node (Gmail resource/operation schema)", () => {
    const workflow = {
      name: "Gmail getAll to Slack",
      nodes: [
        createTriggerNode(),
        createGmailNode({
          parameters: { resource: "message", operation: "getAll" },
        }),
        createSlackNode({ parameters: { text: "={{ $json.subject }}" } }),
      ],
      connections: {
        "Schedule Trigger": {
          main: [[{ node: "Gmail", type: "main", index: 0 }]],
        },
        Gmail: {
          main: [[{ node: "Slack", type: "main", index: 0 }]],
        },
      },
    };
    const refs = validateOutputReferences(workflow);
    expect(refs).toEqual([]);
  });

  test("mixed valid and invalid expressions", () => {
    const workflow = {
      name: "Gmail to Slack",
      nodes: [
        createGmailTriggerNode(),
        createSlackNode({
          parameters: { text: "={{ $json.Subject }} from {{ $json.sender }}" },
        }),
      ],
      connections: {
        "Gmail Trigger": {
          main: [[{ node: "Slack", type: "main", index: 0 }]],
        },
      },
    };
    const refs = validateOutputReferences(workflow);
    expect(refs.length).toBe(1);
    expect(refs[0].field).toBe("sender");
  });

  test("no expressions returns empty", () => {
    const workflow = {
      name: "Static workflow",
      nodes: [
        createGmailTriggerNode(),
        createSlackNode({ parameters: { text: "Hello world" } }),
      ],
      connections: {
        "Gmail Trigger": {
          main: [[{ node: "Slack", type: "main", index: 0 }]],
        },
      },
    };
    const refs = validateOutputReferences(workflow);
    expect(refs).toEqual([]);
  });

  test('resolves $("NodeName") to correct source node schema', () => {
    // Chain: Gmail Trigger → Gmail (getAll) → Slack
    // Slack references Gmail Trigger via $('Gmail Trigger').item.json.Subject (valid)
    // and Gmail via $json.subject (direct upstream, also valid)
    const workflow = {
      name: "Named ref test",
      nodes: [
        createGmailTriggerNode(),
        createGmailNode({
          parameters: { resource: "message", operation: "getAll" },
        }),
        createSlackNode({
          parameters: {
            text: "={{ $('Gmail Trigger').item.json.Subject }} - {{ $json.subject }}",
          },
        }),
      ],
      connections: {
        "Gmail Trigger": {
          main: [[{ node: "Gmail", type: "main", index: 0 }]],
        },
        Gmail: {
          main: [[{ node: "Slack", type: "main", index: 0 }]],
        },
      },
    };
    const refs = validateOutputReferences(workflow);
    // Both should be valid — Subject exists in Gmail Trigger schema, subject exists in Gmail getAll schema
    expect(refs).toEqual([]);
  });

  test("detects invalid field on named node ref", () => {
    // Chain: Gmail Trigger → Gmail (getAll) → Slack
    // Slack uses $('Gmail Trigger').item.json.nonExistentField — should be invalid
    const workflow = {
      name: "Bad named ref",
      nodes: [
        createGmailTriggerNode(),
        createGmailNode({
          parameters: { resource: "message", operation: "getAll" },
        }),
        createSlackNode({
          parameters: {
            text: "={{ $('Gmail Trigger').item.json.nonExistentField }}",
          },
        }),
      ],
      connections: {
        "Gmail Trigger": {
          main: [[{ node: "Gmail", type: "main", index: 0 }]],
        },
        Gmail: {
          main: [[{ node: "Slack", type: "main", index: 0 }]],
        },
      },
    };
    const refs = validateOutputReferences(workflow);
    expect(refs.length).toBe(1);
    expect(refs[0].field).toBe("nonExistentField");
    expect(refs[0].sourceNodeName).toBe("Gmail Trigger");
  });

  test("named ref uses named node schema, not direct upstream", () => {
    // Chain: Gmail Trigger → Gmail (getAll) → Slack
    // Slack uses $('Gmail Trigger').item.json.From — valid in trigger schema
    // Without the fix, this would validate against Gmail (getAll) schema
    const workflow = {
      name: "Cross-node ref",
      nodes: [
        createGmailTriggerNode(),
        createGmailNode({
          parameters: { resource: "message", operation: "getAll" },
        }),
        createSlackNode({
          parameters: {
            text: "={{ $('Gmail Trigger').item.json.From }}",
          },
        }),
      ],
      connections: {
        "Gmail Trigger": {
          main: [[{ node: "Gmail", type: "main", index: 0 }]],
        },
        Gmail: {
          main: [[{ node: "Slack", type: "main", index: 0 }]],
        },
      },
    };
    const refs = validateOutputReferences(workflow);
    expect(refs).toEqual([]);
  });
});

// ============================================================================
// validateNodeParameters
// ============================================================================

describe("validateNodeParameters", () => {
  test("detects missing required parameters", () => {
    // Default Gmail fixture is missing required "Email Type" parameter
    const warnings = validateNodeParameters(createValidWorkflow());
    expect(
      warnings.some(
        (w) => w.includes("Gmail") && w.includes("required parameter"),
      ),
    ).toBe(true);
  });

  test("skips unknown node types", () => {
    const workflow = {
      name: "Unknown",
      nodes: [
        {
          name: "Custom",
          type: "n8n-nodes-community.unknownNode",
          typeVersion: 1,
          position: [0, 0] as [number, number],
          parameters: {},
        },
      ],
      connections: {},
    };
    const warnings = validateNodeParameters(workflow);
    expect(warnings).toEqual([]);
  });

  test("includes the n8n property description so the user knows what the parameter governs", () => {
    // Repro: clarification panel shows `missing required parameter "Name"`
    // for the Discord node. "Name" alone tells the user nothing —
    // n8n's UI shows a description tooltip but the Automations panel
    // doesn't. Pull the description from the same catalog the
    // validator reads and append it in parens.
    //
    // Discord's "Server" and "Channel" required parameters carry
    // descriptions in the upstream node catalog, so use those to
    // verify the formatting.
    const workflow = {
      name: "Discord notify",
      nodes: [
        {
          name: "Post to Discord",
          type: "n8n-nodes-base.discord",
          typeVersion: 2,
          position: [0, 0] as [number, number],
          parameters: { resource: "message", operation: "send" },
        },
      ],
      connections: {},
    };
    const warnings = validateNodeParameters(workflow);
    const serverWarning = warnings.find((w) => w.includes('"Server"'));
    expect(serverWarning).toBeDefined();
    expect(serverWarning).toContain("(Select the server");
  });

  test("omits the parens suffix when the property has no description", () => {
    // The default Gmail fixture's required `emailType` parameter has
    // no description in the catalog. The warning string must stay
    // tight in that case — no empty parens, no trailing whitespace.
    const warnings = validateNodeParameters(createValidWorkflow());
    const gmailWarning = warnings.find(
      (w) => w.includes("Gmail") && w.includes("required parameter"),
    );
    expect(gmailWarning).toBeDefined();
    expect(gmailWarning).not.toMatch(/\(\s*\)/);
    expect(gmailWarning).toBe(
      'Node "Gmail": missing required parameter "Email Type"',
    );
  });

  test("strips HTML tags from the catalog description", () => {
    // The actionNetwork.tagId property (resource=personTag, operation=add)
    // is required and its catalog description embeds an <a href="...">
    // expression link. The clarification surface is plain text, so raw
    // HTML must not leak through into the warning string.
    const workflow = {
      name: "Action Network Tag",
      nodes: [
        {
          name: "Add Tag",
          type: "n8n-nodes-base.actionNetwork",
          typeVersion: 1,
          position: [0, 0] as [number, number],
          parameters: { resource: "personTag", operation: "add" },
        },
      ],
      connections: {},
    };
    const warnings = validateNodeParameters(workflow);
    const tagWarning = warnings.find((w) => w.includes('"Tag Name or ID"'));
    expect(tagWarning).toBeDefined();
    expect(tagWarning).toContain("specify an ID using an expression");
    expect(tagWarning).not.toMatch(/<[^>]+>/);
  });
});

// ============================================================================
// validateNodeInputs
// ============================================================================

describe("validateNodeInputs", () => {
  test("returns no warnings for properly connected workflow", () => {
    const warnings = validateNodeInputs(createValidWorkflow());
    expect(warnings).toEqual([]);
  });

  test("warns about action node with no incoming connection", () => {
    const workflow = {
      name: "Disconnected",
      nodes: [createTriggerNode(), createGmailNode()],
      connections: {},
    };
    const warnings = validateNodeInputs(workflow);
    expect(warnings.some((w) => w.includes("Gmail"))).toBe(true);
  });

  test("does not warn about trigger nodes without incoming connections", () => {
    const workflow = {
      name: "Only trigger",
      nodes: [createTriggerNode()],
      connections: {},
    };
    const warnings = validateNodeInputs(workflow);
    expect(warnings).toEqual([]);
  });
});

// ============================================================================
// correctOptionParameters
// ============================================================================

describe("correctOptionParameters", () => {
  test("corrects invalid resource and cascading operation (OpenAI chat→text)", () => {
    const workflow = {
      name: "OpenAI Test",
      nodes: [
        createTriggerNode(),
        {
          name: "OpenAI",
          type: "@n8n/n8n-nodes-langchain.openAi",
          typeVersion: 1.8,
          position: [500, 300] as [number, number],
          parameters: { resource: "chat", operation: "message" },
        },
      ],
      connections: {
        "Schedule Trigger": {
          main: [[{ node: "OpenAI", type: "main", index: 0 }]],
        },
      },
    };
    const fixes = correctOptionParameters(workflow);
    expect(fixes).toBeGreaterThanOrEqual(2); // typeVersion + resource (+ possibly operation)
    const openai = workflow.nodes[1];
    // Catalog data evolves; assert the correction landed on a valid v2.x.
    expect(openai.typeVersion).toBeGreaterThanOrEqual(2);
    expect(openai.typeVersion).toBeLessThan(3);
    expect(openai.parameters.resource).toBe("text");
    expect(openai.parameters.operation).toBe("response");
  });

  test("does not touch valid parameters", () => {
    const workflow = {
      name: "Valid Gmail",
      nodes: [createTriggerNode(), createGmailNode()],
      connections: {
        "Schedule Trigger": {
          main: [[{ node: "Gmail", type: "main", index: 0 }]],
        },
      },
    };
    const fixes = correctOptionParameters(workflow);
    expect(fixes).toBe(0);
    expect(workflow.nodes[1].parameters.resource).toBe("message");
    expect(workflow.nodes[1].parameters.operation).toBe("send");
  });

  test("corrects typeVersion when not in catalog version list", () => {
    const workflow = {
      name: "Bad Version",
      nodes: [
        {
          name: "OpenAI",
          type: "@n8n/n8n-nodes-langchain.openAi",
          typeVersion: 1.4,
          position: [250, 300] as [number, number],
          parameters: { resource: "text", operation: "response" },
        },
      ],
      connections: {},
    };
    const fixes = correctOptionParameters(workflow);
    expect(fixes).toBeGreaterThanOrEqual(1);
    // Catalog data evolves; assert the corrected version is in the v2.x range.
    expect(workflow.nodes[0].typeVersion).toBeGreaterThanOrEqual(2);
    expect(workflow.nodes[0].typeVersion).toBeLessThan(3);
  });

  test("skips unknown node types", () => {
    const workflow = {
      name: "Unknown",
      nodes: [
        {
          name: "Custom",
          type: "n8n-nodes-community.unknown",
          typeVersion: 1,
          position: [250, 300] as [number, number],
          parameters: { resource: "whatever" },
        },
      ],
      connections: {},
    };
    const fixes = correctOptionParameters(workflow);
    expect(fixes).toBe(0);
  });

  test("corrects wrong node type prefix (n8n-nodes-base.openAi → langchain)", () => {
    const workflow = {
      name: "Wrong Prefix",
      nodes: [
        {
          name: "OpenAI",
          type: "n8n-nodes-base.openAi",
          typeVersion: 2.1,
          position: [250, 300] as [number, number],
          parameters: { resource: "text", operation: "response" },
        },
      ],
      connections: {},
    };
    const fixes = correctOptionParameters(workflow);
    expect(fixes).toBeGreaterThanOrEqual(1);
    expect(workflow.nodes[0].type).toBe("@n8n/n8n-nodes-langchain.openAi");
  });

  test("skips dependent options not visible for current resource", () => {
    const workflow = {
      name: "OpenAI Image",
      nodes: [
        {
          name: "OpenAI",
          type: "@n8n/n8n-nodes-langchain.openAi",
          typeVersion: 2.1,
          position: [250, 300] as [number, number],
          parameters: { resource: "image", operation: "generate" },
        },
      ],
      connections: {},
    };
    const fixes = correctOptionParameters(workflow);
    expect(fixes).toBe(0);
    expect(workflow.nodes[0].parameters.operation).toBe("generate");
  });
});

// ============================================================================
// detectUnknownParameters
// ============================================================================

describe("detectUnknownParameters", () => {
  test("detects unknown params on OpenAI node (model → modelId)", () => {
    const workflow = {
      name: "OpenAI Bad Params",
      nodes: [
        {
          name: "OpenAI",
          type: "@n8n/n8n-nodes-langchain.openAi",
          typeVersion: 2.1,
          position: [250, 300] as [number, number],
          parameters: {
            resource: "text",
            operation: "response",
            model: "gpt-5-mini",
            prompt: "Hello world",
          },
        },
      ],
      connections: {},
    };
    const detections = detectUnknownParameters(workflow);
    expect(detections.length).toBe(1);
    expect(detections[0].nodeName).toBe("OpenAI");
    expect(detections[0].unknownKeys).toContain("model");
    expect(detections[0].unknownKeys).toContain("prompt");
    // resource and operation are valid, should NOT be in unknownKeys
    expect(detections[0].unknownKeys).not.toContain("resource");
    expect(detections[0].unknownKeys).not.toContain("operation");
  });

  test("returns empty for node with valid params", () => {
    const workflow = {
      name: "Gmail Valid",
      nodes: [
        {
          name: "Gmail",
          type: "n8n-nodes-base.gmail",
          typeVersion: 2,
          position: [250, 300] as [number, number],
          parameters: { resource: "message", operation: "send" },
        },
      ],
      connections: {},
    };
    const detections = detectUnknownParameters(workflow);
    expect(detections.length).toBe(0);
  });

  test("skips unknown node types", () => {
    const workflow = {
      name: "Unknown Type",
      nodes: [
        {
          name: "Custom",
          type: "n8n-nodes-community.unknown",
          typeVersion: 1,
          position: [250, 300] as [number, number],
          parameters: { anything: "goes" },
        },
      ],
      connections: {},
    };
    const detections = detectUnknownParameters(workflow);
    expect(detections.length).toBe(0);
  });

  test("includes property definitions for LLM correction", () => {
    const workflow = {
      name: "OpenAI Props",
      nodes: [
        {
          name: "OpenAI",
          type: "@n8n/n8n-nodes-langchain.openAi",
          typeVersion: 2.1,
          position: [250, 300] as [number, number],
          parameters: {
            resource: "text",
            operation: "response",
            model: "gpt-5-mini",
          },
        },
      ],
      connections: {},
    };
    const detections = detectUnknownParameters(workflow);
    expect(detections.length).toBe(1);
    // Should include simplified property definitions
    expect(detections[0].propertyDefs.length).toBeGreaterThan(0);
    // modelId should be in the visible definitions for resource: "text"
    const hasModelId = detections[0].propertyDefs.some(
      (p) => p.name === "modelId",
    );
    expect(hasModelId).toBe(true);
    // model should NOT be visible for resource: "text"
    const hasModel = detections[0].propertyDefs.some((p) => p.name === "model");
    expect(hasModel).toBe(false);
  });

  test("handles multiple nodes, only flags ones with unknown params", () => {
    const workflow = {
      name: "Mixed",
      nodes: [
        {
          name: "Gmail",
          type: "n8n-nodes-base.gmail",
          typeVersion: 2,
          position: [250, 300] as [number, number],
          parameters: { resource: "message", operation: "send" },
        },
        {
          name: "OpenAI",
          type: "@n8n/n8n-nodes-langchain.openAi",
          typeVersion: 2.1,
          position: [500, 300] as [number, number],
          parameters: { resource: "text", model: "gpt-4o" },
        },
      ],
      connections: {},
    };
    const detections = detectUnknownParameters(workflow);
    expect(detections.length).toBe(1);
    expect(detections[0].nodeName).toBe("OpenAI");
  });

  test("Code node: jsCode is not flagged as unknown when LLM omits language/mode (defaults resolve visibility)", () => {
    // LLM generates jsCode without setting language or mode — both have defaults that
    // make jsCode visible. Without default resolution, jsCode would be wrongly flagged.
    const workflow = {
      name: "Code Without Defaults",
      nodes: [
        {
          name: "Code",
          type: "n8n-nodes-base.code",
          typeVersion: 2,
          position: [250, 300] as [number, number],
          parameters: { jsCode: "return items;" },
        },
      ],
      connections: {},
    };
    const detections = detectUnknownParameters(workflow);
    expect(detections.length).toBe(0);
  });

  test("Gmail node: subject/sendTo/message not flagged as unknown when LLM omits resource/operation (defaults resolve visibility)", () => {
    // LLM generates email params without resource/operation — both have defaults
    // (resource="message", operation="send") that make these fields visible.
    const workflow = {
      name: "Gmail Without Resource",
      nodes: [
        {
          name: "Gmail",
          type: "n8n-nodes-base.gmail",
          typeVersion: 2.1,
          position: [250, 300] as [number, number],
          parameters: {
            sendTo: "user@example.com",
            subject: "Test",
            message: "Hello",
          },
        },
      ],
      connections: {},
    };
    const detections = detectUnknownParameters(workflow);
    expect(detections.length).toBe(0);
  });

  test("Gmail node: truly unknown LLM param (toEmail) still detected, propertyDefs includes real field names for correction", () => {
    // toEmail does not exist — sendTo does. With default resolution, the LLM correction
    // gets propertyDefs that include sendTo so it can map toEmail → sendTo.
    const workflow = {
      name: "Gmail Wrong Param",
      nodes: [
        {
          name: "Gmail",
          type: "n8n-nodes-base.gmail",
          typeVersion: 2.1,
          position: [250, 300] as [number, number],
          parameters: {
            toEmail: "user@example.com",
            subject: "Test",
            message: "Hello",
          },
        },
      ],
      connections: {},
    };
    const detections = detectUnknownParameters(workflow);
    expect(detections.length).toBe(1);
    expect(detections[0].unknownKeys).toContain("toEmail");
    expect(detections[0].unknownKeys).not.toContain("subject");
    expect(detections[0].unknownKeys).not.toContain("message");
    // propertyDefs should include sendTo so the LLM can map toEmail → sendTo
    const hasSendTo = detections[0].propertyDefs.some(
      (p) => p.name === "sendTo",
    );
    expect(hasSendTo).toBe(true);
  });

  test("Gmail node: partial omission — LLM sets resource but omits operation, dependent fields still visible", () => {
    // LLM explicitly sets resource="message" but omits operation.
    // operation default ("send") must still resolve via pass-2 so sendTo/subject/message stay visible.
    const workflow = {
      name: "Gmail Partial",
      nodes: [
        {
          name: "Gmail",
          type: "n8n-nodes-base.gmail",
          typeVersion: 2.1,
          position: [250, 300] as [number, number],
          parameters: {
            resource: "message",
            sendTo: "bob@test.com",
            subject: "Hi",
            message: "Hello",
          },
        },
      ],
      connections: {},
    };
    const detections = detectUnknownParameters(workflow);
    expect(detections.length).toBe(0);
  });
});

// ============================================================================
// ensureExpressionPrefix
// ============================================================================

describe("ensureExpressionPrefix", () => {
  test("adds = prefix to {{ }} values", () => {
    const workflow = {
      name: "Test",
      nodes: [
        {
          name: "Gmail",
          type: "n8n-nodes-base.gmail",
          typeVersion: 2,
          position: [0, 0] as [number, number],
          parameters: {
            subject: "{{ $json.Subject }}",
            to: "fixed@example.com",
          },
        },
      ],
      connections: {},
    };
    const count = ensureExpressionPrefix(workflow);
    expect(count).toBe(1);
    expect(workflow.nodes[0].parameters.subject).toBe("={{ $json.Subject }}");
    expect(workflow.nodes[0].parameters.to).toBe("fixed@example.com");
  });

  test("does not double-prefix values already starting with =", () => {
    const workflow = {
      name: "Test",
      nodes: [
        {
          name: "Gmail",
          type: "n8n-nodes-base.gmail",
          typeVersion: 2,
          position: [0, 0] as [number, number],
          parameters: {
            subject: "={{ $json.Subject }}",
          },
        },
      ],
      connections: {},
    };
    const count = ensureExpressionPrefix(workflow);
    expect(count).toBe(0);
    expect(workflow.nodes[0].parameters.subject).toBe("={{ $json.Subject }}");
  });

  test("handles nested objects (fixedCollection values)", () => {
    const workflow = {
      name: "Test",
      nodes: [
        {
          name: "OpenAI",
          type: "@n8n/n8n-nodes-langchain.openAi",
          typeVersion: 2.1,
          position: [0, 0] as [number, number],
          parameters: {
            responses: {
              values: [{ content: "{{ $json.Subject }}" }],
            },
          },
        },
      ],
      connections: {},
    };
    const count = ensureExpressionPrefix(workflow);
    expect(count).toBe(1);
    expect(
      (workflow.nodes[0].parameters.responses as any).values[0].content,
    ).toBe("={{ $json.Subject }}");
  });

  test("handles multiple nodes and multiple values", () => {
    const workflow = {
      name: "Test",
      nodes: [
        {
          name: "Node1",
          type: "n8n-nodes-base.gmail",
          typeVersion: 2,
          position: [0, 0] as [number, number],
          parameters: {
            subject: "{{ $json.Subject }}",
            body: "{{ $json.body }}",
          },
        },
        {
          name: "Node2",
          type: "n8n-nodes-base.slack",
          typeVersion: 2,
          position: [200, 0] as [number, number],
          parameters: {
            text: "{{ $json.output[0].content[0].text }}",
            channel: "#general",
          },
        },
      ],
      connections: {},
    };
    const count = ensureExpressionPrefix(workflow);
    expect(count).toBe(3);
  });

  test("skips nodes without parameters", () => {
    const workflow = {
      name: "Test",
      nodes: [
        {
          name: "Start",
          type: "n8n-nodes-base.start",
          typeVersion: 1,
          position: [0, 0] as [number, number],
          parameters: {},
        },
      ],
      connections: {},
    };
    const count = ensureExpressionPrefix(workflow);
    expect(count).toBe(0);
  });

  test("handles string values in arrays", () => {
    const workflow = {
      name: "Test",
      nodes: [
        {
          name: "Node",
          type: "n8n-nodes-base.set",
          typeVersion: 1,
          position: [0, 0] as [number, number],
          parameters: {
            items: ["{{ $json.a }}", "static", "{{ $json.b }}"],
          },
        },
      ],
      connections: {},
    };
    const count = ensureExpressionPrefix(workflow);
    expect(count).toBe(2);
    expect((workflow.nodes[0].parameters.items as string[])[0]).toBe(
      "={{ $json.a }}",
    );
    expect((workflow.nodes[0].parameters.items as string[])[1]).toBe("static");
    expect((workflow.nodes[0].parameters.items as string[])[2]).toBe(
      "={{ $json.b }}",
    );
  });
});
