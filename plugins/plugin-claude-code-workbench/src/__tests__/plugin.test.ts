import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { IAgentRuntime } from "@elizaos/core";
import { loadClaudeCodeWorkbenchConfig } from "../config.ts";
import { claudeCodeWorkbenchPlugin } from "../plugin.ts";

const runtime = {} as IAgentRuntime;

describe("claudeCodeWorkbenchPlugin", () => {
  let savedNodeOptions: string | undefined;
  beforeEach(() => {
    delete process.env.CLAUDE_CODE_WORKBENCH_WORKSPACE_ROOT;
    delete process.env.CLAUDE_CODE_WORKBENCH_TIMEOUT_MS;
    delete process.env.CLAUDE_CODE_WORKBENCH_ALLOWED_WORKFLOWS;
    delete process.env.CLAUDE_CODE_WORKBENCH_ENABLE_MUTATING_WORKFLOWS;
    // CI sets NODE_OPTIONS=--max-old-space-size=4096 globally; the
    // "writes only prefixed env vars" assertion expects NODE_OPTIONS to be
    // undefined after init, so unset it here and restore afterwards.
    savedNodeOptions = process.env.NODE_OPTIONS;
    delete process.env.NODE_OPTIONS;
  });
  afterEach(() => {
    if (savedNodeOptions === undefined) {
      delete process.env.NODE_OPTIONS;
    } else {
      process.env.NODE_OPTIONS = savedNodeOptions;
    }
  });

  it("exposes expected plugin metadata and wiring", () => {
    expect(claudeCodeWorkbenchPlugin.name).toBe("claude-code-workbench");
    expect(claudeCodeWorkbenchPlugin.description).toContain("Claude Code");
    expect(claudeCodeWorkbenchPlugin.services?.length).toBe(1);
    expect(claudeCodeWorkbenchPlugin.actions?.length).toBe(2);
    expect(claudeCodeWorkbenchPlugin.providers?.[0]?.name).toBe(
      "CLAUDE_CODE_WORKBENCH_STATUS",
    );
    expect(claudeCodeWorkbenchPlugin.routes?.length).toBe(3);
  });

  it("initializes config values and writes only prefixed env vars", async () => {
    if (!claudeCodeWorkbenchPlugin.init) {
      throw new Error("claudeCodeWorkbenchPlugin.init missing");
    }

    await claudeCodeWorkbenchPlugin.init(
      {
        CLAUDE_CODE_WORKBENCH_TIMEOUT_MS: "30000",
        CLAUDE_CODE_WORKBENCH_ALLOWED_WORKFLOWS: "check,pre_review_local",
        NODE_OPTIONS: "--inspect=0.0.0.0:9229",
      },
      runtime,
    );

    expect(process.env.CLAUDE_CODE_WORKBENCH_TIMEOUT_MS).toBe("30000");
    expect(process.env.NODE_OPTIONS).toBeUndefined();

    const loaded = loadClaudeCodeWorkbenchConfig(process.env);
    expect(loaded.timeoutMs).toBe(30_000);
    expect(loaded.allowedWorkflowIds).toEqual(["check", "pre_review_local"]);
  });

  it("throws config error when values are invalid", async () => {
    if (!claudeCodeWorkbenchPlugin.init) {
      throw new Error("claudeCodeWorkbenchPlugin.init missing");
    }

    await expect(
      claudeCodeWorkbenchPlugin.init(
        {
          CLAUDE_CODE_WORKBENCH_TIMEOUT_MS: "10",
        },
        runtime,
      ),
    ).rejects.toThrow("configuration error");
  });
});
