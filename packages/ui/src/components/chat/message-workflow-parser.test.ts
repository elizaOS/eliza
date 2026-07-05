/**
 * Parsing of `[WORKFLOW]` blocks: valid steps, status defaulting/clamping,
 * malformed JSON falling back to null (plain text), and the step cap. Pure
 * function, no DOM.
 */
import { describe, expect, it } from "vitest";
import {
  findWorkflowRegions,
  MAX_WORKFLOW_STEPS,
  parseWorkflowBody,
} from "./message-workflow-parser";

describe("parseWorkflowBody", () => {
  it("parses steps and defaults an unknown status to pending", () => {
    const spec = parseWorkflowBody(
      '{"id":"w1","title":"Deploy","steps":[{"label":"build","status":"done"},{"label":"push","status":"bogus"}]}',
    );
    expect(spec).toEqual({
      id: "w1",
      title: "Deploy",
      steps: [
        { label: "build", status: "done" },
        { label: "push", status: "pending" },
      ],
    });
  });

  it("returns null for malformed JSON or empty steps", () => {
    expect(parseWorkflowBody("not json")).toBeNull();
    expect(parseWorkflowBody('{"steps":[]}')).toBeNull();
    expect(parseWorkflowBody('{"steps":[{"label":"  "}]}')).toBeNull();
    expect(parseWorkflowBody("[1,2,3]")).toBeNull();
  });

  it("caps the step list", () => {
    const steps = Array.from({ length: MAX_WORKFLOW_STEPS + 10 }, (_, i) => ({
      label: `s${i}`,
    }));
    const spec = parseWorkflowBody(JSON.stringify({ steps }));
    expect(spec?.steps).toHaveLength(MAX_WORKFLOW_STEPS);
  });

  it("finds a workflow region with char bounds", () => {
    const text =
      'before\n[WORKFLOW]\n{"steps":[{"label":"a"}]}\n[/WORKFLOW]\nafter';
    const regions = findWorkflowRegions(text);
    expect(regions).toHaveLength(1);
    expect(text.slice(regions[0].start, regions[0].end)).toContain(
      "[WORKFLOW]",
    );
    expect(regions[0].workflow.steps[0].label).toBe("a");
  });
});
