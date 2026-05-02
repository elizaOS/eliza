import { describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { IAgentRuntime } from "@elizaos/core";
import type { ClaudeCodeWorkbenchConfig } from "../config.ts";
import { ClaudeCodeWorkbenchService } from "../services/workbench-service.ts";
import type { WorkbenchWorkflow } from "../workflows.ts";

const mockRuntime = {} as IAgentRuntime;

function makeWorkflow(
  overrides: Partial<WorkbenchWorkflow>,
): WorkbenchWorkflow {
  return {
    id: "echo_ok",
    title: "Echo",
    description: "Echo test",
    category: "test",
    command: process.execPath,
    args: ["-e", "process.stdout.write('ok')"],
    mutatesRepo: false,
    ...overrides,
  };
}

function makeConfig(
  workspaceRoot: string,
  overrides: Partial<ClaudeCodeWorkbenchConfig> = {},
): ClaudeCodeWorkbenchConfig {
  return {
    workspaceRoot,
    timeoutMs: 2_000,
    maxOutputChars: 5_000,
    maxStdinBytes: 8_192,
    allowedWorkflowIds: ["*"],
    enableMutatingWorkflows: false,
    ...overrides,
  };
}

describe("ClaudeCodeWorkbenchService", () => {
  it("runs allowed workflows and captures output", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ccw-root-"));
    const service = new ClaudeCodeWorkbenchService(
      mockRuntime,
      makeConfig(root),
      [makeWorkflow({})],
    );

    const result = await service.run({ workflow: "echo_ok" });

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("ok");
  });

  it("rejects unknown workflows", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ccw-root-"));
    const service = new ClaudeCodeWorkbenchService(
      mockRuntime,
      makeConfig(root),
      [makeWorkflow({})],
    );

    await expect(service.run({ workflow: "missing" })).rejects.toThrow(
      "Unknown workflow",
    );
  });

  it("blocks mutating workflows when disabled", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ccw-root-"));
    const service = new ClaudeCodeWorkbenchService(
      mockRuntime,
      makeConfig(root, { enableMutatingWorkflows: false }),
      [makeWorkflow({ id: "mutating", mutatesRepo: true })],
    );

    await expect(service.run({ workflow: "mutating" })).rejects.toThrow(
      "mutates the repository",
    );
  });

  it("allows mutating workflows when explicitly enabled", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ccw-root-"));
    const service = new ClaudeCodeWorkbenchService(
      mockRuntime,
      makeConfig(root, { enableMutatingWorkflows: true }),
      [makeWorkflow({ id: "mutating", mutatesRepo: true })],
    );

    const result = await service.run({ workflow: "mutating" });
    expect(result.ok).toBe(true);
  });

  it("enforces timeout and marks result as timed out", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ccw-root-"));
    const service = new ClaudeCodeWorkbenchService(
      mockRuntime,
      makeConfig(root, { timeoutMs: 100 }),
      [
        makeWorkflow({
          id: "slow",
          args: ["-e", 'setTimeout(() => process.stdout.write("done"), 3000)'],
        }),
      ],
    );

    const result = await service.run({ workflow: "slow" });

    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.stderr).toContain("timed out");
  });

  it("caps output size and flags truncation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ccw-root-"));
    const service = new ClaudeCodeWorkbenchService(
      mockRuntime,
      makeConfig(root, { maxOutputChars: 20 }),
      [
        makeWorkflow({
          id: "large",
          args: [
            "-e",
            "process.stdout.write('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ')",
          ],
        }),
      ],
    );

    const result = await service.run({ workflow: "large" });

    expect(result.ok).toBe(true);
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stdout).toContain(
      "[truncated by plugin-claude-code-workbench]",
    );
  });

  it("rejects cwd outside workspace root", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ccw-root-"));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "ccw-outside-"));
    const service = new ClaudeCodeWorkbenchService(
      mockRuntime,
      makeConfig(root),
      [makeWorkflow({})],
    );

    await expect(
      service.run({ workflow: "echo_ok", cwd: outside }),
    ).rejects.toThrow("CLAUDE_CODE_WORKBENCH_WORKSPACE_ROOT");
  });

  it("exposes last run metadata in status", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ccw-root-"));
    const service = new ClaudeCodeWorkbenchService(
      mockRuntime,
      makeConfig(root),
      [makeWorkflow({})],
    );

    const before = service.getStatus();
    expect(before.lastRunAt).toBeUndefined();

    await service.run({ workflow: "echo_ok" });

    const after = service.getStatus();
    expect(after.lastRunAt).toBeNumber();
    expect(after.lastWorkflow).toBe("echo_ok");
    expect(after.lastExitCode).toBe(0);
  });
});
