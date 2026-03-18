import { describe, expect, test, vi } from "vitest";
import type { ModelType } from "@elizaos/core";
import type { N8nWorkflowResponse, WorkflowDraft } from "../../../workflow/types/index";
import {
  classifyDraftIntent,
  extractKeywords,
  generateWorkflow,
  matchWorkflow,
} from "../../../workflow/utils/generation";
import { createWorkflowResponse } from "../fixtures/workflows";
import { createMockRuntime } from "../helpers/mockRuntime";

/**
 * Interface for typing useModel mock call arguments
 */
interface MockCallArgs {
  prompt: string;
  schema?: unknown;
  [key: string]: unknown;
}

// ============================================================================
// extractKeywords
// ============================================================================

describe("extractKeywords", () => {
  test("returns keywords from valid LLM response", async () => {
    const runtime = createMockRuntime({
      useModel: vi.fn(() => Promise.resolve({ keywords: ["gmail", "stripe", "send"] })),
    });

    const result = await extractKeywords(runtime, "Send Stripe via Gmail");
    expect(result).toEqual(["gmail", "stripe", "send"]);
  });

  test("trims and filters empty keywords", async () => {
    const runtime = createMockRuntime({
      useModel: vi.fn(() => Promise.resolve({ keywords: [" gmail ", "", "  slack  ", " "] })),
    });

    const result = await extractKeywords(runtime, "Gmail and Slack");
    expect(result).toEqual(["gmail", "slack"]);
  });

  test("limits to 5 keywords", async () => {
    const runtime = createMockRuntime({
      useModel: vi.fn(() =>
        Promise.resolve({
          keywords: ["a", "b", "c", "d", "e", "f", "g"],
        })
      ),
    });

    const result = await extractKeywords(runtime, "Many keywords");
    expect(result).toHaveLength(5);
  });

  test("throws when LLM returns null", async () => {
    const runtime = createMockRuntime({
      useModel: vi.fn(() => Promise.resolve(null)),
    });

    expect(extractKeywords(runtime, "test")).rejects.toThrow("Invalid keyword extraction response");
  });

  test("throws when LLM returns object without keywords", async () => {
    const runtime = createMockRuntime({
      useModel: vi.fn(() => Promise.resolve({ result: "no keywords field" })),
    });

    expect(extractKeywords(runtime, "test")).rejects.toThrow("Invalid keyword extraction response");
  });

  test("throws when keywords contains non-strings", async () => {
    const runtime = createMockRuntime({
      useModel: vi.fn(() => Promise.resolve({ keywords: ["valid", 42, null] })),
    });

    expect(extractKeywords(runtime, "test")).rejects.toThrow("non-string elements");
  });
});

// ============================================================================
// matchWorkflow
// ============================================================================

describe("matchWorkflow", () => {
  test("returns no-match for empty workflow list", async () => {
    const runtime = createMockRuntime();
    const result = await matchWorkflow(runtime, "Activate Stripe", []);

    expect(result.matchedWorkflowId).toBeNull();
    expect(result.confidence).toBe("none");
    expect(result.matches).toHaveLength(0);
    expect(result.reason).toContain("No workflows available");
  });

  test("calls useModel with workflow list in prompt", async () => {
    const useModel = vi.fn(() =>
      Promise.resolve({
        matchedWorkflowId: "wf-001",
        confidence: "high",
        matches: [{ id: "wf-001", name: "Stripe", score: 0.9 }],
        reason: "matched",
      })
    );
    const runtime = createMockRuntime({ useModel });

    const workflows: N8nWorkflowResponse[] = [
      createWorkflowResponse({ id: "wf-001", name: "Stripe Payments", active: true }),
      createWorkflowResponse({ id: "wf-002", name: "Gmail Auto", active: false }),
    ];

    await matchWorkflow(runtime, "Activate Stripe", workflows);

    // Verify useModel was called
    expect(useModel).toHaveBeenCalledTimes(1);
    // Verify the prompt includes workflow names
    const callArgs = useModel.mock.calls[0] as [ModelType, MockCallArgs];
    const params = callArgs[1];
    expect(params.prompt).toContain("Stripe Payments");
    expect(params.prompt).toContain("Gmail Auto");
    expect(params.prompt).toContain("ACTIVE");
    expect(params.prompt).toContain("INACTIVE");
  });

  test("returns graceful failure when LLM throws", async () => {
    const runtime = createMockRuntime({
      useModel: vi.fn(() => Promise.reject(new Error("LLM timeout"))),
    });

    const workflows: N8nWorkflowResponse[] = [
      createWorkflowResponse({ id: "wf-001", name: "Test", active: true }),
    ];

    const result = await matchWorkflow(runtime, "Activate Test", workflows);

    expect(result.matchedWorkflowId).toBeNull();
    expect(result.confidence).toBe("none");
    expect(result.reason).toContain("LLM timeout");
  });

  test("passes through LLM match result", async () => {
    const matchResult = {
      matchedWorkflowId: "wf-002",
      confidence: "medium",
      matches: [{ id: "wf-002", name: "Gmail", score: 0.7 }],
      reason: "Partial match by name",
    };
    const runtime = createMockRuntime({
      useModel: vi.fn(() => Promise.resolve(matchResult)),
    });

    const workflows: N8nWorkflowResponse[] = [
      createWorkflowResponse({ id: "wf-002", name: "Gmail", active: true }),
    ];

    const result = await matchWorkflow(runtime, "the Gmail one", workflows);

    expect(result.matchedWorkflowId).toBe("wf-002");
    expect(result.confidence).toBe("medium");
  });
});

// ============================================================================
// generateWorkflow
// ============================================================================

describe("generateWorkflow", () => {
  test("parses valid JSON response", async () => {
    const workflowJson = JSON.stringify({
      name: "Test Workflow",
      nodes: [{ name: "Start", type: "n8n-nodes-base.start", position: [0, 0] }],
      connections: {},
    });

    const runtime = createMockRuntime({
      useModel: vi.fn(() => Promise.resolve(workflowJson)),
    });

    const result = await generateWorkflow(runtime, "test", []);
    expect(result.name).toBe("Test Workflow");
    expect(result.nodes).toHaveLength(1);
  });

  test("strips markdown code fences from response", async () => {
    const workflowJson = `\`\`\`json
{
  "name": "Fenced",
  "nodes": [{ "name": "A", "type": "t", "position": [0, 0] }],
  "connections": {}
}
\`\`\``;

    const runtime = createMockRuntime({
      useModel: vi.fn(() => Promise.resolve(workflowJson)),
    });

    const result = await generateWorkflow(runtime, "test", []);
    expect(result.name).toBe("Fenced");
  });

  test("throws when response is not valid JSON", async () => {
    const runtime = createMockRuntime({
      useModel: vi.fn(() => Promise.resolve("not json at all")),
    });

    expect(generateWorkflow(runtime, "test", [])).rejects.toThrow("Failed to parse workflow JSON");
  });

  test("throws when workflow has no nodes array", async () => {
    const runtime = createMockRuntime({
      useModel: vi.fn(() => Promise.resolve(JSON.stringify({ name: "Bad", connections: {} }))),
    });

    expect(generateWorkflow(runtime, "test", [])).rejects.toThrow("missing or invalid nodes array");
  });

  test("throws when workflow has no connections object", async () => {
    const runtime = createMockRuntime({
      useModel: vi.fn(() =>
        Promise.resolve(JSON.stringify({ name: "Bad", nodes: [{ name: "A" }] }))
      ),
    });

    expect(generateWorkflow(runtime, "test", [])).rejects.toThrow(
      "missing or invalid connections object"
    );
  });

  test("includes relevant nodes in prompt", async () => {
    const useModel = vi.fn(() =>
      Promise.resolve(
        JSON.stringify({
          name: "WF",
          nodes: [{ name: "A", type: "t", position: [0, 0] }],
          connections: {},
        })
      )
    );
    const runtime = createMockRuntime({ useModel });

    const nodes: NodeDefinition[] = [
      {
        name: "n8n-nodes-base.gmail",
        displayName: "Gmail",
        description: "Send email",
        group: ["output"],
        version: 2,
        defaults: { name: "Gmail" },
        inputs: ["main"],
        outputs: ["main"],
        properties: [],
      },
    ];

    await generateWorkflow(runtime, "send email", nodes);

    const callArgs = useModel.mock.calls[0] as [ModelType, MockCallArgs];
    const params = callArgs[1];
    expect(params.prompt).toContain("Gmail");
    expect(params.prompt).toContain("Send email");
  });
});

// ============================================================================
// classifyDraftIntent
// ============================================================================

describe("classifyDraftIntent", () => {
  const sampleDraft: WorkflowDraft = {
    workflow: {
      name: "Stripe Gmail Summary",
      nodes: [
        {
          name: "Schedule Trigger",
          type: "n8n-nodes-base.scheduleTrigger",
          typeVersion: 1,
          position: [0, 0],
          parameters: {},
        },
        {
          name: "Gmail",
          type: "n8n-nodes-base.gmail",
          typeVersion: 2,
          position: [200, 0],
          parameters: { operation: "send" },
        },
      ],
      connections: {
        "Schedule Trigger": {
          main: [[{ node: "Gmail", type: "main", index: 0 }]],
        },
      },
    },
    prompt: "Send Stripe summaries via Gmail",
    userId: "user-001",
    createdAt: Date.now(),
  };

  test("returns confirm intent from LLM", async () => {
    const useModel = vi.fn(() =>
      Promise.resolve({
        intent: "confirm",
        reason: "User said yes",
      })
    );
    const runtime = createMockRuntime({ useModel });

    const result = await classifyDraftIntent(runtime, "Yes, deploy it", sampleDraft);

    expect(result.intent).toBe("confirm");
    expect(result.reason).toBe("User said yes");
  });

  test("returns modify intent with modification request", async () => {
    const useModel = vi.fn(() =>
      Promise.resolve({
        intent: "modify",
        modificationRequest: "Use Outlook instead",
        reason: "User wants different email",
      })
    );
    const runtime = createMockRuntime({ useModel });

    const result = await classifyDraftIntent(runtime, "Use Outlook instead", sampleDraft);

    expect(result.intent).toBe("modify");
    expect(result.modificationRequest).toBe("Use Outlook instead");
  });

  test("includes draft summary in prompt sent to LLM", async () => {
    const useModel = vi.fn(() =>
      Promise.resolve({
        intent: "confirm",
        reason: "test",
      })
    );
    const runtime = createMockRuntime({ useModel });

    await classifyDraftIntent(runtime, "yes", sampleDraft);

    const callArgs = useModel.mock.calls[0] as [ModelType, MockCallArgs];
    const params = callArgs[1];
    expect(params.prompt).toContain("Stripe Gmail Summary");
    expect(params.prompt).toContain("Schedule Trigger");
    expect(params.prompt).toContain("Send Stripe summaries via Gmail");
  });

  test("returns cancel intent", async () => {
    const useModel = vi.fn(() =>
      Promise.resolve({
        intent: "cancel",
        reason: "User rejected",
      })
    );
    const runtime = createMockRuntime({ useModel });

    const result = await classifyDraftIntent(runtime, "No, forget it", sampleDraft);

    expect(result.intent).toBe("cancel");
  });

  test("returns new intent for unrelated request", async () => {
    const useModel = vi.fn(() =>
      Promise.resolve({
        intent: "new",
        reason: "Completely different request",
      })
    );
    const runtime = createMockRuntime({ useModel });

    const result = await classifyDraftIntent(
      runtime,
      "Create a Slack to Jira integration",
      sampleDraft
    );

    expect(result.intent).toBe("new");
  });
});
