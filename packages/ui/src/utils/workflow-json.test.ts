/**
 * Unit coverage for workflow JSON round-tripping (parse, to-write-request,
 * to-text). Pure functions, no harness.
 */
import { describe, expect, it } from "vitest";
import {
  parseWorkflowJson,
  toWriteRequest,
  workflowToJsonText,
} from "./workflow-json";

const VALID = JSON.stringify(
  {
    id: "wf_1",
    name: "Test workflow",
    active: false,
    nodes: [
      { id: "n1", name: "Trigger", type: "workflows-nodes-base.manualTrigger" },
      { id: "n2", name: "Step", type: "workflows-nodes-base.set" },
    ],
    connections: {
      Trigger: { main: [[{ node: "Step", type: "main", index: 0 }]] },
    },
  },
  null,
  2,
);

describe("parseWorkflowJson", () => {
  it("parses a valid workflow", () => {
    const result = parseWorkflowJson(VALID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.workflow.name).toBe("Test workflow");
    expect(result.workflow.nodes?.length).toBe(2);
    expect(result.workflow.connections?.Trigger).toBeDefined();
  });

  it("rejects empty input", () => {
    const result = parseWorkflowJson("   ");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/empty/i);
  });

  it("rejects non-object root", () => {
    const result = parseWorkflowJson("[]");
    expect(result.ok).toBe(false);
  });

  it("rejects missing name", () => {
    const result = parseWorkflowJson('{"nodes":[]}');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/name/i);
  });

  it("rejects missing nodes array", () => {
    const result = parseWorkflowJson('{"name":"x"}');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/nodes/i);
  });

  it("rejects nodes missing required fields", () => {
    const result = parseWorkflowJson('{"name":"x","nodes":[{"name":"a"}]}');
    expect(result.ok).toBe(false);
  });

  it("reports a line number on JSON syntax errors", () => {
    const result = parseWorkflowJson('{\n  "name": "x",\n  "nodes": [,]\n}');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(typeof result.message).toBe("string");
  });
});

describe("workflowToJsonText", () => {
  it("round-trips through parseWorkflowJson", () => {
    const parsed = parseWorkflowJson(VALID);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const text = workflowToJsonText(parsed.workflow);
    const round = parseWorkflowJson(text);
    expect(round.ok).toBe(true);
    if (!round.ok) return;
    expect(round.workflow.name).toBe(parsed.workflow.name);
    expect(round.workflow.nodes?.length).toBe(parsed.workflow.nodes?.length);
  });

  it("returns a sensible default for null", () => {
    const text = workflowToJsonText(null);
    const parsed = parseWorkflowJson(text);
    expect(parsed.ok).toBe(true);
  });
});

describe("toWriteRequest", () => {
  it("strips id/active and keeps the write fields", () => {
    const parsed = parseWorkflowJson(VALID);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const req = toWriteRequest(parsed);
    expect(req.name).toBe("Test workflow");
    expect(req.nodes.length).toBe(2);
    expect(req.connections).toBeDefined();
    expect(req.settings).toEqual({});
  });

  it("preserves node credentials and execution behavior settings", () => {
    const parsed = parseWorkflowJson(
      JSON.stringify({
        name: "Metadata workflow",
        nodes: [
          {
            id: "http",
            name: "HTTP Request",
            type: "workflows-nodes-base.httpRequest",
            typeVersion: 4.2,
            position: [120, 80],
            parameters: { url: "https://example.com" },
            credentials: {
              httpHeaderAuth: { id: "cred-1", name: "API token" },
            },
            disabled: true,
            continueOnFail: true,
            executeOnce: true,
            alwaysOutputData: true,
            retryOnFail: true,
            maxTries: 3,
            waitBetweenTries: 750,
            onError: "continueErrorOutput",
          },
        ],
        connections: {},
      }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const node = toWriteRequest(parsed).nodes[0];
    expect(node.credentials?.httpHeaderAuth.id).toBe("cred-1");
    expect(node.disabled).toBe(true);
    expect(node.continueOnFail).toBe(true);
    expect(node.executeOnce).toBe(true);
    expect(node.alwaysOutputData).toBe(true);
    expect(node.retryOnFail).toBe(true);
    expect(node.maxTries).toBe(3);
    expect(node.waitBetweenTries).toBe(750);
    expect(node.onError).toBe("continueErrorOutput");
  });
});
