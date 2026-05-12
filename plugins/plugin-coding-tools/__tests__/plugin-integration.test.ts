import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { IAgentRuntime, Memory, Service, UUID } from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as pluginModule from "../src/index.js";
import codingToolsPlugin, {
  availableToolsProvider,
  CODING_TOOLS_CONTEXTS,
  FILE_STATE_SERVICE,
  FileStateService,
  RIPGREP_SERVICE,
  RipgrepService,
  SANDBOX_SERVICE,
  SandboxService,
  SESSION_CWD_SERVICE,
  SessionCwdService,
} from "../src/index.js";

const EXPECTED_ACTIONS = ["FILE", "SHELL", "WORKTREE"];

describe("@elizaos/plugin-coding-tools — plugin export shape", () => {
  it("exports a Plugin with the expected name", () => {
    expect(codingToolsPlugin.name).toBe("coding-tools");
    expect(codingToolsPlugin.description).toBeTruthy();
  });

  it("registers the consolidated top-level coding actions", () => {
    const actions = codingToolsPlugin.actions ?? [];
    const names = actions.map((a) => a.name).sort();
    expect(names).toEqual([...EXPECTED_ACTIONS].sort());
  });

  it("does not register legacy leaf actions as planner-facing actions", () => {
    const names = new Set((codingToolsPlugin.actions ?? []).map((a) => a.name));
    for (const legacyName of [
      "READ",
      "WRITE",
      "EDIT",
      "BASH",
      "GREP",
      "GLOB",
      "LS",
      "WEB_FETCH",
      "ASK_USER_QUESTION",
      "ENTER_WORKTREE",
      "EXIT_WORKTREE",
    ]) {
      expect(names.has(legacyName), legacyName).toBe(false);
    }
  });

  it("FILE exposes only canonical file umbrella similes", () => {
    const fileAction = (codingToolsPlugin.actions ?? []).find(
      (action) => action.name === "FILE",
    );
    expect(fileAction?.similes).toEqual(["FILE_OPERATION", "FILE_IO"]);
  });

  it("each action has the required fields", () => {
    for (const action of codingToolsPlugin.actions ?? []) {
      expect(action.name, action.name).toBeTruthy();
      expect(action.description, action.name).toBeTruthy();
      expect(action.handler, action.name).toBeTypeOf("function");
      expect(action.validate, action.name).toBeTypeOf("function");
    }
  });

  it("action names are unique", () => {
    const names = (codingToolsPlugin.actions ?? []).map((a) => a.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("exports the 4 active services", () => {
    const services = codingToolsPlugin.services ?? [];
    expect(services).toContain(FileStateService);
    expect(services).toContain(SandboxService);
    expect(services).toContain(SessionCwdService);
    expect(services).toContain(RipgrepService);
    expect(services.length).toBe(4);
  });

  it("does not export removed actions or service constants", () => {
    expect("bashAction" in pluginModule).toBe(false);
    expect("BASH_AST_SERVICE" in pluginModule).toBe(false);
    expect("OS_SANDBOX_SERVICE" in pluginModule).toBe(false);
    expect("SHELL_TASK_SERVICE" in pluginModule).toBe(false);
    expect("ShellTaskService" in pluginModule).toBe(false);
    expect("notebookEditAction" in pluginModule).toBe(false);
    expect("taskOutputAction" in pluginModule).toBe(false);
    expect("taskStopAction" in pluginModule).toBe(false);
    expect("todoWriteAction" in pluginModule).toBe(false);
  });

  it("exports the available-tools provider at position -10 with code/terminal/automation gates", () => {
    expect(codingToolsPlugin.providers ?? []).toContain(availableToolsProvider);
    expect(availableToolsProvider.position).toBe(-10);
    expect(availableToolsProvider.contexts).toEqual([...CODING_TOOLS_CONTEXTS]);
  });

  it("validate ignores CODING_TOOLS_DISABLE — kill switch was removed", async () => {
    const runtime = {
      agentId: "00000000-0000-0000-0000-000000000000",
      getSetting: (key: string) =>
        key === "CODING_TOOLS_DISABLE" ? true : undefined,
      getService: () => null,
    } as IAgentRuntime;
    const message = { roomId: "r" } as Memory;
    for (const action of codingToolsPlugin.actions ?? []) {
      const ok = await action.validate!(runtime, message);
      expect(ok, action.name).toBe(true);
    }
  });
});

describe("@elizaos/plugin-coding-tools — end-to-end smoke", () => {
  let tmpDir: string;
  let runtime: IAgentRuntime;
  let services: Map<string, Service>;
  const cleanup: Array<() => Promise<void>> = [];

  beforeAll(async () => {
    tmpDir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "ct-integ-")),
    );
    await fs.writeFile(
      path.join(tmpDir, "needle.txt"),
      "this file contains the NEEDLE word\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(tmpDir, "other.md"),
      "# heading\n\nbody text\n",
      "utf8",
    );

    services = new Map();
    runtime = {
      agentId: "00000000-0000-0000-0000-000000000000" as UUID,
      getSetting: (_key: string) => undefined,
      getService: (key: string) => services.get(key) ?? null,
    } as IAgentRuntime;

    const fileState = await FileStateService.start(runtime);
    const sandbox = await SandboxService.start(runtime);
    const session = await SessionCwdService.start(runtime);
    const rg = await RipgrepService.start(runtime);
    services.set(FILE_STATE_SERVICE, fileState);
    services.set(SANDBOX_SERVICE, sandbox);
    services.set(SESSION_CWD_SERVICE, session);
    services.set(RIPGREP_SERVICE, rg);
    cleanup.push(() => fileState.stop());
    cleanup.push(() => sandbox.stop());
    cleanup.push(() => session.stop());
    cleanup.push(() => rg.stop());
    session.setCwd("smoke-room", tmpDir);
  });

  afterAll(async () => {
    for (const fn of cleanup) {
      try {
        await fn();
      } catch {
        // ignore
      }
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function findAction(name: string) {
    const actions = codingToolsPlugin.actions ?? [];
    const a = actions.find((x) => x.name === name);
    if (!a) throw new Error(`action ${name} not found`);
    return a;
  }

  function makeMessage(): Memory {
    return { roomId: "smoke-room" } as Memory;
  }

  it("FILE action=read returns a known file's contents", async () => {
    const action = findAction("FILE");
    const result = await action.handler!(runtime, makeMessage(), undefined, {
      parameters: {
        action: "read",
        file_path: path.join(tmpDir, "needle.txt"),
      },
    });
    expect(result.success).toBe(true);
    expect(result.text).toContain("NEEDLE");
  });

  it("FILE action=write creates a new file", async () => {
    const action = findAction("FILE");
    const target = path.join(tmpDir, "smoke-out.txt");
    const result = await action.handler!(runtime, makeMessage(), undefined, {
      parameters: { action: "write", file_path: target, content: "smoke ok" },
    });
    expect(result.success).toBe(true);
    const written = await fs.readFile(target, "utf8");
    expect(written).toBe("smoke ok");
  });

  it("SHELL echo hello", async () => {
    const action = findAction("SHELL");
    const result = await action.handler!(runtime, makeMessage(), undefined, {
      parameters: { command: "echo smoke-bash-ok", cwd: tmpDir },
    });
    expect(result.success).toBe(true);
    expect(result.text).toContain("smoke-bash-ok");
    expect(result.text).toContain("[exit 0]");
  });

  it("FILE action=glob lists *.txt files", async () => {
    const action = findAction("FILE");
    const result = await action.handler!(runtime, makeMessage(), undefined, {
      parameters: { action: "glob", pattern: "*.txt", path: tmpDir },
    });
    expect(result.success).toBe(true);
    expect(result.text).toContain("needle.txt");
  });

  it("FILE action=ls shows fixture entries", async () => {
    const action = findAction("FILE");
    const result = await action.handler!(runtime, makeMessage(), undefined, {
      parameters: { action: "ls", path: tmpDir },
    });
    expect(result.success).toBe(true);
    expect(result.text).toContain("needle.txt");
    expect(result.text).toContain("other.md");
  });

  it("GREP finds the NEEDLE token (skip when ripgrep absent)", async () => {
    const rg = services.get(RIPGREP_SERVICE) as RipgrepService | undefined;
    if (!rg) return;
    const fs2 = await import("node:fs");
    const initial = rg.binary();
    if (!fs2.existsSync(initial)) {
      const candidates = [
        "/opt/homebrew/bin/rg",
        "/usr/local/bin/rg",
        "/usr/bin/rg",
      ];
      const sys = candidates.find((p) => fs2.existsSync(p));
      if (!sys) return;
      (rg as { rgPath: string }).rgPath = sys;
    }
    const action = findAction("FILE");
    const result = await action.handler!(runtime, makeMessage(), undefined, {
      parameters: { action: "grep", pattern: "NEEDLE", path: tmpDir },
    });
    expect(result.success).toBe(true);
    expect(result.text).toContain("needle.txt");
  });

  it("WORKTREE action=enter in a non-git dir fails cleanly", async () => {
    const action = findAction("WORKTREE");
    const result = await action.handler!(runtime, makeMessage(), undefined, {
      parameters: { action: "enter" },
    });
    expect(result.success).toBe(false);
    expect(result.text).toContain("io_error");
  });
});
