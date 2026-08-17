import { describe, expect, it } from "vitest";
import type { TaskThreadDetailDto } from "../services/orchestrator-task-mapper.js";
import {
  detectWaveCollisions,
  isSalvageEligible,
  readLaneDependencies,
  readLaneId,
  readWaveAttemptId,
  readWaveId,
  shouldRefillWave,
  WaveSupervisor,
} from "../services/wave-supervisor.js";

function task(
  id: string,
  status: TaskThreadDetailDto["status"],
  metadata: Record<string, unknown>,
  usage: Partial<TaskThreadDetailDto["usage"]> = {},
): TaskThreadDetailDto {
  return {
    id,
    title: id,
    kind: "task",
    status,
    priority: "normal",
    paused: false,
    originalRequest: id,
    sessionCount: 0,
    activeSessionCount: 0,
    latestSessionId: null,
    latestSessionLabel: null,
    latestSessionModel: null,
    latestAccountProviderId: null,
    latestAccountId: null,
    latestAccountLabel: null,
    parentTaskId: null,
    latestWorkdir: null,
    latestRepo: "org/repo",
    projectId: null,
    latestActivityAt: 0,
    decisionCount: 0,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      state: "measured",
      byProvider: [],
      ...usage,
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    closedAt: null,
    archivedAt: null,
    goal: id,
    roomId: null,
    taskRoomId: null,
    worldId: null,
    ownerUserId: null,
    acceptanceCriteria: [],
    currentPlan: null,
    providerPolicy: null,
    lastUserTurnAt: null,
    lastCoordinatorTurnAt: null,
    metadata,
    sessions: [],
    decisions: [],
    events: [],
    artifacts: [],
    messages: [],
    transcripts: [],
    planRevisions: [],
  };
}

function makeTaskService(seed: TaskThreadDetailDto[]) {
  const tasks = new Map(seed.map((item) => [item.id, structuredClone(item)]));
  const paused: string[] = [];
  const resumed: string[] = [];
  const created: TaskThreadDetailDto[] = [];
  const spawned: string[] = [];
  return {
    paused,
    resumed,
    created,
    spawned,
    async listTasks() {
      return [...tasks.values()].map(({ id }) => ({ id }));
    },
    async getTask(id: string) {
      return tasks.get(id) ?? null;
    },
    async updateTask(
      id: string,
      patch: { metadata?: Record<string, unknown> },
    ) {
      const existing = tasks.get(id);
      if (!existing) return null;
      const updated = { ...existing, ...patch };
      tasks.set(id, updated);
      return updated;
    },
    async createTask(input: Record<string, unknown>) {
      const createdTask = task(
        `created-${created.length + 1}`,
        "open",
        (input.metadata as Record<string, unknown>) ?? {},
      );
      created.push(createdTask);
      tasks.set(createdTask.id, createdTask);
      return createdTask;
    },
    async spawnAgentForTask(id: string) {
      spawned.push(id);
      return tasks.get(id) ?? null;
    },
    async getTaskOriginTarget() {
      return null;
    },
    async pauseTask(id: string) {
      paused.push(id);
      const existing = tasks.get(id);
      if (!existing) return null;
      const updated = { ...existing, paused: true };
      tasks.set(id, updated);
      return updated;
    },
    async resumeTask(id: string) {
      resumed.push(id);
      const existing = tasks.get(id);
      if (!existing) return null;
      const updated = { ...existing, paused: false };
      tasks.set(id, updated);
      return updated;
    },
  };
}

function makeRuntime(
  taskService: unknown,
  extra: Record<string, unknown> = {},
) {
  return {
    getSetting: (key: string) =>
      key === "ELIZA_ORCHESTRATOR_WAVE_SUPERVISOR" ? "1" : undefined,
    getService: (type: string) =>
      type === "ORCHESTRATOR_TASK_SERVICE" ? taskService : extra[type],
    reportError: () => undefined,
  } as never;
}

// W3's lifecycle policy is intentionally tested without a runtime or timers.
describe("wave supervisor pure policy", () => {
  it("reads the canonical wave id and defensive manual-stamp aliases", () => {
    expect(readWaveId({ waveId: "wave-1" })).toBe("wave-1");
    expect(readWaveId({ orchestratorWaveId: "wave-2" })).toBe("wave-2");
    expect(readWaveId({ wave: { id: "wave-3" } })).toBe("wave-3");
    expect(readWaveId({ waveId: "  " })).toBeUndefined();
  });

  it("reads W1 structured lane ids, dependencies, attempt ids, and scopes", () => {
    const metadata = {
      waveId: "wave-1",
      waveAttemptId: "attempt-2",
      lane: {
        id: "lane-2",
        dependencies: ["lane-1"],
        scopePaths: ["src/a.ts"],
      },
    };
    expect(readLaneId(metadata, "task-2")).toBe("lane-2");
    expect(readLaneDependencies(metadata)).toEqual(["lane-1"]);
    expect(readWaveAttemptId(metadata)).toBe("attempt-2");
  });

  it("refills each terminal lane once while the wave goal remains unmet", () => {
    expect(
      shouldRefillWave({
        status: "failed",
        goalMet: false,
        alreadyHandled: false,
      }),
    ).toBe(true);
    expect(
      shouldRefillWave({
        status: "done",
        goalMet: false,
        alreadyHandled: false,
      }),
    ).toBe(true);
    expect(
      shouldRefillWave({
        status: "active",
        goalMet: false,
        alreadyHandled: false,
      }),
    ).toBe(false);
    expect(
      shouldRefillWave({
        status: "failed",
        goalMet: true,
        alreadyHandled: false,
      }),
    ).toBe(false);
    expect(
      shouldRefillWave({
        status: "failed",
        goalMet: false,
        alreadyHandled: true,
      }),
    ).toBe(false);
  });

  it("salvages only failed lanes with a workspace and uncommitted paths", () => {
    expect(
      isSalvageEligible({
        status: "failed",
        workdir: "/tmp/lane",
        changedFiles: ["src/a.ts"],
      }),
    ).toBe(true);
    expect(
      isSalvageEligible({
        status: "done",
        workdir: "/tmp/lane",
        changedFiles: ["src/a.ts"],
      }),
    ).toBe(false);
    expect(
      isSalvageEligible({
        status: "failed",
        workdir: "/tmp/lane",
        changedFiles: [],
      }),
    ).toBe(false);
    expect(
      isSalvageEligible({ status: "failed", changedFiles: ["src/a.ts"] }),
    ).toBe(false);
  });

  it("detects lane-lane directory overlap and lane-PR file overlap", () => {
    expect(
      detectWaveCollisions(
        [
          {
            laneId: "a",
            waveId: "w",
            attemptId: "try-1",
            paths: ["src/auth"],
            repo: "org/repo",
          },
          {
            laneId: "b",
            waveId: "w",
            attemptId: "try-1",
            paths: ["src/auth/login.ts"],
            repo: "org/repo",
          },
          {
            laneId: "c",
            waveId: "other",
            attemptId: "try-1",
            paths: ["src/auth"],
            repo: "org/repo",
          },
          {
            laneId: "d",
            waveId: "w",
            attemptId: "try-1",
            paths: ["src/payments"],
            repo: "org/repo",
          },
        ],
        [
          {
            id: "org/repo#7",
            repo: "org/repo",
            number: 7,
            changedFiles: ["src/payments/settle.ts", "README.md"],
          },
        ],
      ),
    ).toEqual([
      {
        key: "wave:w|attempt:try-1|lane:a|lane:b",
        waveId: "w",
        attemptId: "try-1",
        leftId: "a",
        rightId: "b",
        paths: ["src/auth"],
        kind: "lane-lane",
      },
      {
        key: "wave:w|attempt:try-1|lane:d|pr:org/repo#7",
        waveId: "w",
        attemptId: "try-1",
        leftId: "d",
        rightId: "org/repo#7",
        paths: ["src/payments"],
        kind: "lane-pr",
      },
    ]);
  });

  it("does not compare PR paths without a confirmed matching repository", () => {
    const pullRequest = {
      id: "org/repo#1",
      repo: "org/repo",
      number: 1,
      changedFiles: ["README.md"],
    };
    expect(
      detectWaveCollisions(
        [
          {
            laneId: "unknown",
            waveId: "w",
            attemptId: "try-1",
            paths: ["README.md"],
          },
        ],
        [pullRequest],
      ),
    ).toEqual([]);
    expect(
      detectWaveCollisions(
        [
          {
            laneId: "other",
            waveId: "w",
            attemptId: "try-1",
            paths: ["README.md"],
            repo: "another/project",
          },
        ],
        [pullRequest],
      ),
    ).toEqual([]);
  });

  it("normalizes separators and does not mistake filename prefixes for overlap", () => {
    const collisions = detectWaveCollisions(
      [
        {
          laneId: "a",
          waveId: "w",
          attemptId: "try-1",
          paths: [".\\src\\foo"],
          repo: "org/repo",
        },
        {
          laneId: "b",
          waveId: "w",
          attemptId: "try-1",
          paths: ["src/foobar"],
          repo: "org/repo",
        },
      ],
      [
        {
          id: "org/repo#1",
          repo: "org/repo",
          number: 1,
          changedFiles: ["src/foo/bar.ts"],
        },
      ],
    );
    expect(collisions).toHaveLength(1);
    expect(collisions[0]?.kind).toBe("lane-pr");
  });

  it("scopes lane-lane collisions to the same wave attempt", () => {
    expect(
      detectWaveCollisions(
        [
          {
            laneId: "a",
            waveId: "w",
            attemptId: "try-1",
            paths: ["src/auth"],
          },
          {
            laneId: "b",
            waveId: "w",
            attemptId: "try-2",
            paths: ["src/auth/login.ts"],
          },
        ],
        [],
      ),
    ).toEqual([]);
  });

  it("keeps runtime-scoped status snapshots isolated", async () => {
    const leftService = makeTaskService([
      task("left", "active", { waveId: "left-wave" }),
    ]);
    const rightService = makeTaskService([
      task("right", "active", { waveId: "right-wave" }),
    ]);
    const left = new WaveSupervisor(makeRuntime(leftService));
    const right = new WaveSupervisor(makeRuntime(rightService));
    expect((await left.runOnce()).map((status) => status.waveId)).toEqual([
      "left-wave",
    ]);
    expect((await right.runOnce()).map((status) => status.waveId)).toEqual([
      "right-wave",
    ]);
  });

  it("blocks admission until structured lane dependencies are done", async () => {
    const service = makeTaskService([
      task("dep", "active", { waveId: "w", lane: { id: "lane-1" } }),
      task("child", "open", {
        waveId: "w",
        lane: { id: "lane-2", dependencies: ["lane-1"] },
      }),
    ]);
    const supervisor = new WaveSupervisor(makeRuntime(service));
    expect(await supervisor.tryAcquire("child")).toBe(false);
    await service.updateTask("dep", {
      metadata: { waveId: "w", lane: { id: "lane-1" } },
    });
    const dep = await service.getTask("dep");
    if (dep) (dep as TaskThreadDetailDto).status = "done";
    expect(await supervisor.tryAcquire("child")).toBe(true);
  });

  it("pauses wave execution and persists an auditable reason on cumulative budget breach", async () => {
    const service = makeTaskService([
      task(
        "a",
        "active",
        { waveId: "w", wave: { budget: { maxCostUsd: 1 } } },
        { costUsd: 0.6, totalTokens: 100 },
      ),
      task("b", "open", { waveId: "w" }, { costUsd: 0.4, totalTokens: 100 }),
    ]);
    const supervisor = new WaveSupervisor(makeRuntime(service));
    expect(await supervisor.tryAcquire("b")).toBe(false);
    expect(service.paused).toContain("a");
    const stamped = await service.getTask("a");
    expect(stamped?.metadata.waveSupervisor).toMatchObject({
      pauseCode: "ORCHESTRATOR_WAVE_BUDGET_BREACH",
    });
  });

  it("approves a budget increase through durable task metadata and resumes paused lanes", async () => {
    const service = makeTaskService([
      {
        ...task("a", "active", { waveId: "w" }, { costUsd: 2 }),
        paused: true,
      },
    ]);
    const supervisor = new WaveSupervisor(makeRuntime(service));
    await supervisor.approveBudgetIncrease({
      waveId: "w",
      approvedBy: "reviewer",
      reason: "launch approval",
      maxCostUsd: 3,
    });
    expect(service.resumed).toEqual(["a"]);
    const approved = await service.getTask("a");
    expect(approved?.metadata.waveSupervisor).toMatchObject({
      budgetApproval: {
        approvedBy: "reviewer",
        reason: "launch approval",
        maxCostUsd: 3,
      },
    });
  });

  it("reconciles from durable task state after restart and does not trust prior snapshots", async () => {
    const service = makeTaskService([
      task("a", "active", { waveId: "w" }),
      task("b", "done", { waveId: "w" }),
    ]);
    const first = new WaveSupervisor(makeRuntime(service));
    await first.runOnce();
    const restarted = new WaveSupervisor(makeRuntime(service));
    expect(await restarted.runOnce()).toMatchObject([
      { waveId: "w", activeLanes: 1, terminalLanes: 1 },
    ]);
  });

  it("creates at most one replacement for a terminal lane across recovery reconciles", async () => {
    const service = makeTaskService([
      task("failed", "failed", {
        waveId: "w",
        lane: { id: "lane-1", scopePaths: ["src/a.ts"] },
      }),
    ]);
    const planner = {
      planReplacement: async () => ({
        title: "replacement",
        goal: "fix it",
        initialPrompt: "fix src/a.ts",
        scope: ["src/a.ts"],
      }),
    };
    const supervisor = new WaveSupervisor(makeRuntime(service), { planner });
    await supervisor.runOnce();
    await supervisor.runOnce();
    expect(service.created).toHaveLength(1);
    expect(service.spawned).toEqual(["created-1"]);
  });

  it("carries the terminal lane's request-voice keys onto the replacement task", async () => {
    // The refill continues the SAME user-request lineage: without the carry
    // the replacement task fell back to a fresh task:<id> voice key and the
    // park-notice dedupe (notifyVerifyEscalation) re-opened the double-park
    // window for that request.
    const service = makeTaskService([
      task("failed", "failed", {
        waveId: "w",
        lane: { id: "lane-1", scopePaths: ["src/a.ts"] },
        spawnRootMessageId: "req-1",
        requestVoicePart: "lane:w:lane-1",
      }),
    ]);
    const planner = {
      planReplacement: async () => ({
        title: "replacement",
        goal: "fix it",
        initialPrompt: "fix src/a.ts",
        scope: ["src/a.ts"],
      }),
    };
    const supervisor = new WaveSupervisor(makeRuntime(service), { planner });
    await supervisor.runOnce();
    expect(service.created).toHaveLength(1);
    expect(service.created[0]?.metadata).toMatchObject({
      spawnRootMessageId: "req-1",
      requestVoicePart: "lane:w:lane-1",
    });
  });
});
