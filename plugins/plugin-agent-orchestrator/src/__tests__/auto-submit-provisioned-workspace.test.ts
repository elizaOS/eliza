/**
 * Exercises the real git readiness and durable once-state around automatic PR
 * submission; GitHub publication itself is replaced with ordered spies.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OrchestratorTaskService } from "../services/orchestrator-task-service.js";
import { OrchestratorTaskStore } from "../services/orchestrator-task-store.js";
import { CodingWorkspaceService } from "../services/workspace-service.js";

const roots: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    [
      "-c",
      "user.email=test@example.com",
      "-c",
      "user.name=Auto Submit Test",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd, encoding: "utf8" },
  ).trim();
}

function repo(): { workdir: string; head: string } {
  const root = mkdtempSync(join(tmpdir(), "orch-auto-submit-"));
  roots.push(root);
  const workdir = join(root, "work");
  const bare = join(root, "origin.git");
  git(root, "init", "-q", "--bare", bare);
  git(root, "init", "-q", "-b", "main", workdir);
  writeFileSync(join(workdir, "README.md"), "seed\n");
  git(workdir, "add", ".");
  git(workdir, "commit", "-q", "-m", "seed");
  git(workdir, "remote", "add", "origin", bare);
  git(workdir, "push", "-q", "-u", "origin", "main");
  writeFileSync(join(workdir, "feature.ts"), "export const safe = true;\n");
  git(workdir, "add", ".");
  git(workdir, "commit", "-q", "-m", "feature");
  return { workdir, head: git(workdir, "rev-parse", "HEAD") };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

async function harness() {
  const { workdir, head } = repo();
  let workspaceService: CodingWorkspaceService;
  const runtime = {
    agentId: "agent-1",
    getSetting: () => undefined,
    reportError: vi.fn(),
    getRoom: vi.fn(async () => ({ source: "discord" })),
    sendMessageToTarget: vi.fn(async () => {
      throw new Error("connector offline");
    }),
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    getService: (type: string) =>
      type === CodingWorkspaceService.serviceType
        ? workspaceService
        : undefined,
  };
  workspaceService = new CodingWorkspaceService(runtime as never, {
    baseDir: join(workdir, "unused"),
  });
  const workspace = {
    id: "workspace-1",
    path: workdir,
    branch: "feature/task-1",
    baseBranch: "main",
    isWorktree: false,
    repo: "https://github.com/example/repo.git",
    status: "ready",
  };
  (
    workspaceService as unknown as {
      workspaces: Map<string, typeof workspace>;
    }
  ).workspaces.set(workspace.id, workspace);

  const store = new OrchestratorTaskStore({ backend: "memory" });
  const detail = await store.createTask({
    title: "Safe change",
    goal: "implement the change and open a pull request",
    acceptanceCriteria: ["change committed"],
    roomId: "00000000-0000-4000-8000-000000000001",
  });
  const now = Date.now();
  await store.addSession({
    id: "row-1",
    taskId: detail.task.id,
    sessionId: "session-1",
    framework: "opencode",
    label: "Ada",
    originalTask: "implement the change and open a pull request",
    repo: workspace.repo,
    workdir,
    status: "completed",
    decisionCount: 0,
    autoResolvedCount: 0,
    registeredAt: now,
    lastActivityAt: now,
    idleCheckCount: 0,
    taskDelivered: true,
    lastSeenDecisionIndex: 0,
    spawnedAt: now,
    retryCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheTokens: 0,
    costUsd: 0,
    usageState: "unavailable",
    metadata: { provisionedWorkspaceId: workspace.id },
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
  });
  const service = new OrchestratorTaskService(runtime as never, { store });
  return {
    service,
    store,
    workspaceService,
    taskId: detail.task.id,
    head,
    workdir,
  };
}

type SubmitHarness = {
  autoSubmitProvisionedWorkspace(
    taskId: string,
    sessionId: string,
  ): Promise<void>;
};

describe("automatic provisioned-workspace submission", () => {
  it("scans before push and re-arms when the scan blocks", async () => {
    const { service, store, workspaceService, taskId } = await harness();
    const order: string[] = [];
    vi.spyOn(workspaceService, "assertPullRequestDiffReady").mockImplementation(
      async () => {
        order.push("scan");
        throw new Error("blocked secret");
      },
    );
    vi.spyOn(workspaceService, "push").mockImplementation(async () => {
      order.push("push");
    });

    await expect(
      (service as unknown as SubmitHarness).autoSubmitProvisionedWorkspace(
        taskId,
        "session-1",
      ),
    ).rejects.toThrow("blocked secret");
    expect(order).toEqual(["scan"]);
    expect(
      (await store.getTask(taskId))?.task.metadata.autoSubmitState,
    ).toBeUndefined();
  });

  it("reuses an existing branch PR and notification failure cannot re-arm it", async () => {
    const { service, store, workspaceService, taskId, workdir } =
      await harness();
    const order: string[] = [];
    vi.spyOn(workspaceService, "assertPullRequestDiffReady").mockImplementation(
      async () => {
        order.push("scan");
        return undefined;
      },
    );
    vi.spyOn(workspaceService, "push").mockImplementation(async () => {
      order.push("push");
      git(workdir, "push", "-q", "-u", "origin", "feature/task-1");
    });
    vi.spyOn(workspaceService, "findOpenPullRequest").mockImplementation(
      async () => {
        order.push("find");
        return {
          number: 7,
          url: "https://github.com/example/repo/pull/7",
        } as never;
      },
    );
    const create = vi.spyOn(workspaceService, "createPR");

    await (service as unknown as SubmitHarness).autoSubmitProvisionedWorkspace(
      taskId,
      "session-1",
    );
    await (service as unknown as SubmitHarness).autoSubmitProvisionedWorkspace(
      taskId,
      "session-1",
    );

    expect(order).toEqual(["scan", "push", "find"]);
    expect(create).not.toHaveBeenCalled();
    expect((await store.getTask(taskId))?.task.metadata).toMatchObject({
      autoSubmittedPrUrl: "https://github.com/example/repo/pull/7",
      prUrl: "https://github.com/example/repo/pull/7",
      autoSubmitState: { state: "opened" },
    });
  });
});
