import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { IAgentRuntime, Memory, State } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SandboxService } from "../services/sandbox-service.js";
import { SessionCwdService } from "../services/session-cwd-service.js";
import { SANDBOX_SERVICE, SESSION_CWD_SERVICE } from "../types.js";
import { enterWorktreeHandler } from "./enter-worktree.js";
import { exitWorktreeHandler } from "./exit-worktree.js";

interface TestEnv {
  repoDir: string;
  cleanupDirs: string[];
  sandbox: SandboxService;
  session: SessionCwdService;
  runtime: IAgentRuntime;
  conversationId: string;
}

async function initRepo(repoDir: string): Promise<void> {
  await fs.mkdir(repoDir, { recursive: true });
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
  };
  execFileSync("git", ["init", "-b", "main"], { cwd: repoDir, env });
  execFileSync("git", ["commit", "--allow-empty", "-m", "init"], {
    cwd: repoDir,
    env,
  });
}

async function setupRepo(): Promise<TestEnv> {
  const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "xwt-repo-"));
  await initRepo(repoDir);

  const conversationId = "conv-exit-test";

  const runtime = {
    getSetting: (key: string) => {
      if (key === "CODING_TOOLS_WORKSPACE_ROOTS") return repoDir;
      return undefined;
    },
  } as IAgentRuntime;

  const sandbox = await SandboxService.start(runtime);
  const session = await SessionCwdService.start(runtime);
  session.setCwd(conversationId, repoDir);

  const services: Record<string, unknown> = {
    [SANDBOX_SERVICE]: sandbox,
    [SESSION_CWD_SERVICE]: session,
  };
  (runtime as { getService: (k: string) => unknown }).getService = (
    key: string,
  ) => services[key] ?? null;

  return {
    repoDir,
    cleanupDirs: [repoDir],
    sandbox,
    session,
    runtime,
    conversationId,
  };
}

async function cleanupEnv(env: TestEnv | undefined): Promise<void> {
  if (!env) return;
  for (const dir of env.cleanupDirs) {
    await fs.rm(dir, { recursive: true, force: true });
  }
  await env.sandbox.stop();
  await env.session.stop();
}

function makeMessage(conversationId: string): Memory {
  return { roomId: conversationId } as Memory;
}

async function enter(env: TestEnv): Promise<string> {
  const result = await enterWorktreeHandler(
    env.runtime,
    makeMessage(env.conversationId),
    undefined,
    { parameters: {} },
  );
  if (!result.success) throw new Error(`enter failed: ${result.text}`);
  const data = result.data as Record<string, unknown> | undefined;
  const worktreePath = data?.worktreePath as string;
  env.cleanupDirs.push(worktreePath);
  return worktreePath;
}

const state: State | undefined = undefined;

describe("EXIT_WORKTREE", () => {
  let env: TestEnv = undefined as TestEnv;

  beforeEach(async () => {
    env = await setupRepo();
  });

  afterEach(async () => {
    await cleanupEnv(env);
  });

  it("pops the most recent worktree, restores cwd, and removes the sandbox root", async () => {
    const worktreePath = await enter(env);
    expect(env.session.getCwd(env.conversationId)).toBe(
      path.resolve(worktreePath),
    );

    const result = await exitWorktreeHandler(
      env.runtime,
      makeMessage(env.conversationId),
      state,
      { parameters: {} },
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown> | undefined;
    expect(path.resolve(String(data?.exited))).toBe(path.resolve(worktreePath));
    expect(path.resolve(String(data?.restoredTo))).toBe(
      path.resolve(env.repoDir),
    );
    expect(data?.cleaned).toBe(false);

    expect(env.session.getCwd(env.conversationId)).toBe(
      path.resolve(env.repoDir),
    );

    const stillThere = await fs
      .stat(worktreePath)
      .then(() => true)
      .catch(() => false);
    expect(stillThere).toBe(true);
  });

  it("fails with invalid_param when no worktree is on the stack", async () => {
    const result = await exitWorktreeHandler(
      env.runtime,
      makeMessage(env.conversationId),
      state,
      { parameters: {} },
    );
    expect(result.success).toBe(false);
    expect(result.text).toContain("invalid_param");
    expect(result.text).toContain("no worktree to exit");
  });

  it("with cleanup=true removes the worktree directory", async () => {
    const worktreePath = await enter(env);

    const result = await exitWorktreeHandler(
      env.runtime,
      makeMessage(env.conversationId),
      state,
      { parameters: { cleanup: true } },
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown> | undefined;
    expect(data?.cleaned).toBe(true);

    const stillThere = await fs
      .stat(worktreePath)
      .then(() => true)
      .catch(() => false);
    expect(stillThere).toBe(false);

    const list = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd: env.repoDir,
      encoding: "utf8",
    });
    expect(list).not.toContain(worktreePath);
  });

  it("fails with missing_param when message has no roomId", async () => {
    const result = await exitWorktreeHandler(
      env.runtime,
      {} as Memory,
      state,
      { parameters: {} },
    );
    expect(result.success).toBe(false);
    expect(result.text).toContain("missing_param");
  });
});
