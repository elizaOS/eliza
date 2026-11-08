/** SHELL_HISTORY on a real runtime alongside the SHELL and WORKTREE actions. */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  type AgentRuntime,
  createCharacter,
  type Memory,
  type State,
  type UUID,
} from "@elizaos/core";
import { createSQLiteTestRuntime } from "@elizaos/testing/runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { shellAction } from "../../actions/bash.js";
import { worktreeAction } from "../../actions/worktree.js";
import { BackgroundShellService } from "../../services/background-shell-service.js";
import { SandboxService } from "../../services/sandbox-service.js";
import { SessionCwdService } from "../../services/session-cwd-service.js";
import { SESSION_CWD_SERVICE } from "../../types.js";
import { ShellService } from "../services/shellService";
import { shellHistoryProvider } from "./shellHistoryProvider";

const describeIfPosix = process.platform === "win32" ? describe.skip : describe;

const ROOM = "00000000-0000-0000-0000-00000000c0d1" as UUID;

function message(text: string): Memory {
  return {
    id: crypto.randomUUID() as UUID,
    entityId: "00000000-0000-0000-0000-00000000c0d2" as UUID,
    roomId: ROOM,
    content: { text, channelType: "DM" },
  } as Memory;
}

describeIfPosix("SHELL_HISTORY provider on a real runtime", () => {
  let runtime: AgentRuntime;
  let repoDir: string;
  let previousAllowedDirectory: string | undefined;
  const cleanupDirs: string[] = [];

  beforeEach(async () => {
    repoDir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "shell-history-repo-")),
    );
    cleanupDirs.push(repoDir);
    const gitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    };
    execFileSync("git", ["init", "-q", "-b", "main"], {
      cwd: repoDir,
      env: gitEnv,
    });
    execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "init"], {
      cwd: repoDir,
      env: gitEnv,
    });
    previousAllowedDirectory = process.env.SHELL_ALLOWED_DIRECTORY;
    process.env.SHELL_ALLOWED_DIRECTORY = repoDir;

    runtime = createSQLiteTestRuntime({
      character: createCharacter({
        name: "ShellHistoryCwd",
        settings: { CODING_TOOLS_WORKSPACE_ROOTS: repoDir },
      }),
      logLevel: "fatal",
      enableAutonomy: false,
    });
    await runtime.initialize({ skipMigrations: true });
    for (const service of [
      ShellService,
      SandboxService,
      SessionCwdService,
      BackgroundShellService,
    ]) {
      await runtime.registerService(service);
      await runtime.getServiceLoadPromise(service.serviceType);
    }
    runtime
      .getService<SessionCwdService>(SESSION_CWD_SERVICE)
      ?.setCwd(String(ROOM), repoDir);
  });

  afterEach(async () => {
    await runtime.stop();
    await runtime.close();
    if (previousAllowedDirectory === undefined) {
      delete process.env.SHELL_ALLOWED_DIRECTORY;
    } else {
      process.env.SHELL_ALLOWED_DIRECTORY = previousAllowedDirectory;
    }
    for (const dir of cleanupDirs.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("reports the directory SHELL runs in after entering and leaving a worktree", async () => {
    const entered = await worktreeAction.handler(
      runtime,
      message("work in a new worktree"),
      undefined,
      { parameters: { action: "enter" } },
    );
    expect(entered.success, entered.text).toBe(true);
    const worktreePath = await fs.realpath(String(entered.data?.worktreePath));
    cleanupDirs.push(worktreePath);

    const pwd = await shellAction.handler(
      runtime,
      message("where am I?"),
      undefined,
      { command: "pwd" },
    );
    expect(pwd.success, pwd.text).toBe(true);
    expect(pwd.text).toContain(worktreePath);

    const inWorktree = await shellHistoryProvider.get(
      runtime,
      message("continue"),
      {} as State,
    );
    expect(inWorktree.values?.currentWorkingDirectory).toBe(worktreePath);
    expect(inWorktree.text).toContain(`Current Directory: ${worktreePath}`);

    const exited = await worktreeAction.handler(
      runtime,
      message("leave the worktree"),
      undefined,
      { parameters: { action: "exit" } },
    );
    expect(exited.success, exited.text).toBe(true);

    const afterExit = await shellHistoryProvider.get(
      runtime,
      message("continue"),
      {} as State,
    );
    expect(afterExit.values?.currentWorkingDirectory).toBe(repoDir);
  });
});
