import { describe, expect, it } from "bun:test";
import {
  getDefaultWorkflowIds,
  listDefaultWorkflows,
  normalizeWorkflowId,
} from "../workflows.ts";

describe("plugin-claude-code-workbench workflows", () => {
  it("contains unique workflow ids", () => {
    const ids = getDefaultWorkflowIds();
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("includes key repo workflows", () => {
    const ids = getDefaultWorkflowIds();
    expect(ids).toContain("check");
    expect(ids).toContain("pre_review_local");
    expect(ids).toContain("build_local_plugins");
  });

  it("returns cloned workflow args", () => {
    const workflows = listDefaultWorkflows();
    const first = workflows[0];
    first.args.push("--x");

    const fresh = listDefaultWorkflows()[0];
    expect(fresh.args).not.toContain("--x");
  });

  it("normalizes workflow ids", () => {
    expect(normalizeWorkflowId(" Pre.Review Local ")).toBe("pre_review_local");
  });
});
