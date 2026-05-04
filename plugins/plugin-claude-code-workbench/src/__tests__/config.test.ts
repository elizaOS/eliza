import { describe, expect, it } from "bun:test";
import {
  DEFAULT_WORKBENCH_WORKFLOWS,
  isWorkflowAllowed,
  loadClaudeCodeWorkbenchConfig,
} from "../config.ts";

describe("plugin-claude-code-workbench config", () => {
  it("uses defaults when config is empty", () => {
    const config = loadClaudeCodeWorkbenchConfig({});

    expect(config.timeoutMs).toBe(10 * 60_000);
    expect(config.maxOutputChars).toBe(120_000);
    expect(config.maxStdinBytes).toBe(64 * 1024);
    expect(config.allowedWorkflowIds).toEqual(["*"]);
    expect(config.enableMutatingWorkflows).toBe(false);
  });

  it("parses allowlist values", () => {
    const config = loadClaudeCodeWorkbenchConfig({
      CLAUDE_CODE_WORKBENCH_ALLOWED_WORKFLOWS: " check , Pre.Review Local ",
    });

    expect(config.allowedWorkflowIds).toEqual(["check", "pre_review_local"]);
  });

  it("parses boolean for mutating workflows", () => {
    const config = loadClaudeCodeWorkbenchConfig({
      CLAUDE_CODE_WORKBENCH_ENABLE_MUTATING_WORKFLOWS: "true",
    });

    expect(config.enableMutatingWorkflows).toBe(true);
  });

  it("rejects invalid timeout values", () => {
    expect(() =>
      loadClaudeCodeWorkbenchConfig({
        CLAUDE_CODE_WORKBENCH_TIMEOUT_MS: "100",
      }),
    ).toThrow();
  });

  it("exports default workflow ids", () => {
    expect(DEFAULT_WORKBENCH_WORKFLOWS.length).toBeGreaterThan(5);
  });
});

describe("workflow allowlist helper", () => {
  it("supports wildcard allowlist", () => {
    expect(isWorkflowAllowed("check", ["*"])).toBe(true);
  });

  it("matches normalized workflow ids", () => {
    expect(isWorkflowAllowed("Pre.Review Local", ["pre_review_local"])).toBe(
      true,
    );
    expect(isWorkflowAllowed("check", ["pre_review_local"])).toBe(false);
  });
});
