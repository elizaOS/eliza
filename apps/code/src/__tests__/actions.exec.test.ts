import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { execSync } from "child_process";
import type { IAgentRuntime, Memory } from "@elizaos/core";
import { getCwd, setCwd } from "../plugin/providers/cwd.js";
import { executeShellAction } from "../plugin/actions/execute-shell.js";
import { gitAction } from "../plugin/actions/git.js";

function createMemory(text: string): Memory {
  return {
    content: { text },
  } as Memory;
}

async function withTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("plugin actions: exec + git", () => {
  const runtime = {} as IAgentRuntime;
  const originalCwd = getCwd();
  let tempDir = "";

  beforeEach(async () => {
    tempDir = await withTempDir("eliza-code-exec-");
    await setCwd(tempDir);
  });

  afterEach(async () => {
    try {
      await setCwd(originalCwd);
    } catch {
      // ignore
    }
    try {
      if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  test("EXECUTE_SHELL runs a simple command and captures stdout", async () => {
    const result = await executeShellAction.handler(runtime, createMemory("$ echo hello"));
    expect(result.success).toBe(true);
    expect(result.text).toContain("$ echo hello");
    expect(result.text).toContain("hello");
  });

  test("EXECUTE_SHELL returns a formatted error when command fails", async () => {
    const result = await executeShellAction.handler(
      runtime,
      createMemory("run `this_command_does_not_exist_12345`")
    );
    expect(result.success).toBe(false);
    expect(result.text.length).toBeGreaterThan(0);
  });

  test("GIT runs git status inside a repo", async () => {
    execSync("git init", { cwd: tempDir, stdio: "ignore" });
    // Ensure git doesn't complain about missing identity during other operations.
    execSync("git config user.email \"test@example.com\"", { cwd: tempDir, stdio: "ignore" });
    execSync("git config user.name \"Test User\"", { cwd: tempDir, stdio: "ignore" });

    const result = await gitAction.handler(runtime, createMemory("git status"));
    expect(result.success).toBe(true);
    expect(result.text).toContain("$ git status");
  });
});



