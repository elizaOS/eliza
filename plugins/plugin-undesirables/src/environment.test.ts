import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateUndesirableConfig } from "./environment";

function runtime(settings: Record<string, string | undefined> = {}): IAgentRuntime {
  return {
    getSetting: (key: string) => settings[key],
  } as unknown as IAgentRuntime;
}

describe("validateUndesirableConfig", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(path.join(tmpdir(), "undesirables-workspace-"));
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
    delete process.env.UNDESIRABLES_WORKSPACE;
  });

  it("requires a workspace setting or environment variable", () => {
    expect(validateUndesirableConfig(runtime())).toEqual({
      valid: false,
      error: expect.stringContaining("UNDESIRABLES_WORKSPACE is required"),
    });
  });

  it("rejects missing paths and paths without SOUL.md", () => {
    expect(
      validateUndesirableConfig(runtime({ UNDESIRABLES_WORKSPACE: "relative/soul" })),
    ).toEqual({
      valid: false,
      error: expect.stringContaining("must be an absolute path"),
    });

    expect(
      validateUndesirableConfig(runtime({ UNDESIRABLES_WORKSPACE: path.join(workspace, "missing") })),
    ).toEqual({
      valid: false,
      error: expect.stringContaining("path does not exist"),
    });

    expect(validateUndesirableConfig(runtime({ UNDESIRABLES_WORKSPACE: workspace }))).toEqual({
      valid: false,
      error: expect.stringContaining("No SOUL.md found"),
    });
  });

  it("prefers runtime settings over environment settings", () => {
    const envWorkspace = mkdtempSync(path.join(tmpdir(), "undesirables-env-"));
    writeFileSync(path.join(envWorkspace, "SOUL.md"), "# Env Soul");
    writeFileSync(path.join(workspace, "SOUL.md"), "# Runtime Soul");
    process.env.UNDESIRABLES_WORKSPACE = envWorkspace;

    expect(validateUndesirableConfig(runtime({ UNDESIRABLES_WORKSPACE: workspace }))).toEqual({
      valid: true,
      workspacePath: workspace,
    });

    rmSync(envWorkspace, { recursive: true, force: true });
  });

  it("accepts a workspace containing SOUL.md from the environment", () => {
    writeFileSync(path.join(workspace, "SOUL.md"), "# Soul");
    process.env.UNDESIRABLES_WORKSPACE = workspace;

    expect(validateUndesirableConfig(runtime())).toEqual({
      valid: true,
      workspacePath: workspace,
    });
  });
});
