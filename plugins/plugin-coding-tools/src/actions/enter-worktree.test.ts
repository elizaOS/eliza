import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  CAPABILITY_ROUTER_SERVICE_TYPE,
  type ElizaCapabilityRouter,
  type GitCommandRunParams,
  type GitCommandRunResult,
  type IAgentRuntime,
  type Memory,
  type State,
} from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SandboxService } from "../services/sandbox-service.js";
import { SessionCwdService } from "../services/session-cwd-service.js";
import { withUnavailablePlugin } from "../test-helpers/capability-router.js";
import { SANDBOX_SERVICE, SESSION_CWD_SERVICE } from "../types.js";
import { enterWorktreeHandler } from "./enter-worktree.js";

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
  const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "ewt-repo-"));
  await initRepo(repoDir);

  const conversationId = "conv-enter-test";

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

function setCapabilityRouter(
  env: TestEnv,
  router: ElizaCapabilityRouter,
): void {
  const getService = env.runtime.getService.bind(env.runtime);
  (env.runtime as { getService: (k: string) => unknown }).getService = (
    key: string,
  ) => (key === CAPABILITY_ROUTER_SERVICE_TYPE ? router : getService(key));
}

function makeGitRouter(
  commandRun: (params: GitCommandRunParams) => Promise<GitCommandRunResult>,
): ElizaCapabilityRouter {
  return withUnavailablePlugin({
    environment: "desktop",
    availability: async () => ({
      environment: "desktop",
      available: true,
      capabilities: {
        fs: false,
        pty: false,
        git: true,
        model: false,
        plugin: false,
      },
    }),
    fs: {
      list: async () => {
        throw new Error("fs unavailable");
      },
      readText: async () => {
        throw new Error("fs unavailable");
      },
      writeText: async () => {
        throw new Error("fs unavailable");
      },
    },
    pty: {
      runCommand: async () => {
        throw new Error("pty unavailable");
      },
    },
    git: {
      status: async () => {
        throw new Error("git status unavailable");
      },
      diff: async () => {
        throw new Error("git diff unavailable");
      },
      commandRun,
    },
    model: {
      status: async () => {
        throw new Error("model unavailable");
      },
    },
  });
}

function gitCommandResult(params: GitCommandRunParams): GitCommandRunResult {
  return {
    operation: {
      id: "git-op-routed",
      name: "git.command.run",
      cwd: params.root,
      command: params.args,
      status: "completed",
      stdout: "",
      stderr: "",
      exitCode: 0,
      signal: null,
      startedAt: "2026-05-17T00:00:00.000Z",
      completedAt: "2026-05-17T00:00:00.001Z",
    },
  };
}

const state: State | undefined = undefined;

describe("ENTER_WORKTREE", () => {
  let env: TestEnv = undefined as TestEnv;

  beforeEach(async () => {
    env = await setupRepo();
  });

  afterEach(async () => {
    await cleanupEnv(env);
  });

  it("creates a worktree, sets session cwd to it, and adds it as a sandbox root", async () => {
    const result = await enterWorktreeHandler(
      env.runtime,
      makeMessage(env.conversationId),
      state,
      { parameters: {} },
    );

    if (!result.success) throw new Error(result.text);
    const data = result.data as Record<string, unknown> | undefined;
    const worktreePath = data?.worktreePath as string | undefined;
    expect(typeof worktreePath).toBe("string");
    expect(worktreePath).toBeDefined();
    if (!worktreePath) throw new Error("missing worktreePath");

    env.cleanupDirs.push(worktreePath);

    const stat = await fs.stat(worktreePath);
    expect(stat.isDirectory()).toBe(true);

    expect(env.session.getCwd(env.conversationId)).toBe(
      path.resolve(worktreePath),
    );

    expect(typeof data?.branch).toBe("string");
    expect(result.text).toContain("Entered worktree");
  });

  it("routes git worktree add through the capability router when available", async () => {
    const calls: GitCommandRunParams[] = [];
    setCapabilityRouter(
      env,
      makeGitRouter(async (params) => {
        calls.push(params);
        return gitCommandResult(params);
      }),
    );
    const worktreePath = path.join(
      await fs.realpath(env.repoDir),
      "routed-worktree",
    );
    const result = await enterWorktreeHandler(
      env.runtime,
      makeMessage(env.conversationId),
      state,
      {
        parameters: {
          name: "routed-feature",
          path: worktreePath,
          base: "main",
        },
      },
    );

    if (!result.success) throw new Error(result.text);
    expect(calls).toEqual([
      {
        root: env.repoDir,
        args: ["worktree", "add", "-b", "routed-feature", worktreePath, "main"],
      },
    ]);
    expect(env.session.getCwd(env.conversationId)).toBe(
      path.resolve(worktreePath),
    );
  });

  it("uses the provided name when supplied", async () => {
    const result = await enterWorktreeHandler(
      env.runtime,
      makeMessage(env.conversationId),
      state,
      { parameters: { name: "feature-x" } },
    );
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown> | undefined;
    expect(data?.branch).toBe("feature-x");
    const worktreePath = data?.worktreePath as string;
    env.cleanupDirs.push(worktreePath);

    const branchOutput = execFileSync("git", ["branch", "--show-current"], {
      cwd: worktreePath,
      encoding: "utf8",
    });
    expect(branchOutput.trim()).toBe("feature-x");
  });

  it("fails with io_error when run from a non-git directory", async () => {
    const nonGitDir = await fs.mkdtemp(path.join(os.tmpdir(), "ewt-nongit-"));
    env.cleanupDirs.push(nonGitDir);

    const conversationId = "conv-nongit";

    const runtime = {
      getSetting: (key: string) => {
        if (key === "CODING_TOOLS_WORKSPACE_ROOTS") return nonGitDir;
        return undefined;
      },
    } as IAgentRuntime;
    const sandbox = await SandboxService.start(runtime);
    const session = await SessionCwdService.start(runtime);
    session.setCwd(conversationId, nonGitDir);
    const services: Record<string, unknown> = {
      [SANDBOX_SERVICE]: sandbox,
      [SESSION_CWD_SERVICE]: session,
    };
    (runtime as { getService: (k: string) => unknown }).getService = (
      key: string,
    ) => services[key] ?? null;

    const result = await enterWorktreeHandler(
      runtime,
      makeMessage(conversationId),
      state,
      {
        parameters: {},
      },
    );

    expect(result.success).toBe(false);
    expect(result.text).toContain("io_error");

    await sandbox.stop();
    await session.stop();
  });

  it("fails with missing_param when message has no roomId", async () => {
    const result = await enterWorktreeHandler(
      env.runtime,
      {} as Memory,
      state,
      { parameters: {} },
    );
    expect(result.success).toBe(false);
    expect(result.text).toContain("missing_param");
  });
});
