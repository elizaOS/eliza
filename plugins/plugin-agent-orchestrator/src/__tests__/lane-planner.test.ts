/**
 * Lane planner tests pin the deterministic decomposition contract and the
 * TASKS create integration gate. The action tests use a structural ACP fake so
 * they verify metadata and spawn shape without starting real coding CLIs.
 */

import type {
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@octokit/rest", () => ({
  Octokit: class Octokit {},
}));

import { tasksAction } from "../actions/tasks.ts";
import {
  createDeterministicLanePlan,
  LanePlannerService,
  laneReadiness,
  sanitizeLaneBranchName,
  scopeSetsOverlap,
} from "../services/lane-planner.ts";
import { CodingWorkspaceService } from "../services/workspace-service.ts";

const ROOM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MSG = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "00000000-0000-4000-8000-000000000001";

function makeMessage(
  text: string,
  extraContent: Record<string, unknown> = {},
): Memory {
  return {
    id: MSG,
    entityId: AGENT_ID,
    roomId: ROOM,
    content: { text, source: "test", ...extraContent },
  } as unknown as Memory;
}

function makeAcp() {
  let seq = 0;
  const sessions = new Map<string, Record<string, unknown>>();
  const spawnSession = vi.fn(async (opts: Record<string, unknown>) => {
    seq += 1;
    const sessionId = `sess-${seq}`;
    const session = {
      sessionId,
      id: sessionId,
      agentType: opts.agentType ?? "codex",
      name: `Agent ${seq}`,
      workdir: opts.workdir ?? process.cwd(),
      status: "ready",
      createdAt: new Date(0),
      lastActivityAt: new Date(0),
      metadata: opts.metadata,
    };
    sessions.set(sessionId, session);
    return session;
  });
  return {
    spawnSession,
    sendPrompt: vi.fn(async () => ({
      stopReason: "end_turn",
      finalText: "done",
    })),
    sendToSession: vi.fn(async () => ({
      stopReason: "end_turn",
      finalText: "done",
    })),
    stopSession: vi.fn(async (sessionId: string) => {
      const session = sessions.get(sessionId);
      if (session) session.status = "stopped";
    }),
    getSession: vi.fn(async (sessionId: string) => sessions.get(sessionId)),
    listSessions: vi.fn(async () => [...sessions.values()]),
    resolveAgentType: vi.fn(async () => "codex"),
    emitSessionEvent: vi.fn(),
  };
}

function makeTaskService() {
  let seq = 0;
  return {
    createTask: vi.fn(async (input: Record<string, unknown>) => {
      seq += 1;
      return { id: `task-${seq}`, ...input };
    }),
    attachSession: vi.fn(async () => undefined),
    getTask: vi.fn(async (): Promise<unknown> => null),
    listTasks: vi.fn(async (): Promise<Array<{ id: string }>> => []),
  };
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

function makeRuntime(
  settings: Record<string, string | undefined>,
  acp = makeAcp(),
  taskService = makeTaskService(),
  extraServices: Record<string, unknown> = {},
): IAgentRuntime & {
  acp: ReturnType<typeof makeAcp>;
  taskService: ReturnType<typeof makeTaskService>;
} {
  return {
    agentId: AGENT_ID,
    character: { name: "Tester" },
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    getSetting: (key: string) => settings[key],
    getService: (type: string) => {
      if (type in extraServices) return extraServices[type];
      if (type === "ACP_SERVICE" || type === "ACP_SUBPROCESS_SERVICE") {
        return acp;
      }
      if (type === "ORCHESTRATOR_TASK_SERVICE") return taskService;
      return undefined;
    },
    createRoom: vi.fn(async () => undefined),
    ensureWorldExists: vi.fn(async () => undefined),
    useModel: vi.fn(async () => "{}"),
  } as unknown as IAgentRuntime & {
    acp: ReturnType<typeof makeAcp>;
    taskService: ReturnType<typeof makeTaskService>;
  };
}

async function runCreate(runtime: IAgentRuntime, message: Memory) {
  const callback = vi.fn(async () => []) as unknown as HandlerCallback;
  return tasksAction.handler(
    runtime,
    message,
    {} as State,
    { parameters: { action: "create" } },
    callback,
  );
}

describe("LanePlannerService deterministic planning", () => {
  it("decomposes explicit scoped tasks into mutually exclusive lanes", () => {
    const plan = createDeterministicLanePlan({
      task: "parent",
      tasks: [
        "Update plugins/plugin-agent-orchestrator/src/services/a.ts",
        "Update packages/core/src/runtime.ts",
      ],
      waveId: "wave-1",
    });

    expect(plan.waveId).toBe("wave-1");
    expect(plan.lanes).toHaveLength(2);
    expect(plan.lanes[0]?.scopePaths).toEqual([
      "plugins/plugin-agent-orchestrator/src/services/a.ts",
    ]);
    expect(plan.lanes[0]?.forbiddenPaths).toEqual([
      "packages/core/src/runtime.ts",
    ]);
    expect(plan.lanes[0]?.collisions).toContainEqual({
      source: "sibling",
      id: "sibling-1",
      paths: ["packages/core/src/runtime.ts"],
    });
    expect(
      scopeSetsOverlap(
        plan.lanes[0]?.scopePaths ?? [],
        plan.lanes[1]?.scopePaths ?? [],
      ),
    ).toBe(false);
  });

  it("rejects overlapping sibling scopes", () => {
    expect(() =>
      createDeterministicLanePlan({
        task: "parent",
        tasks: [
          "Update plugins/plugin-agent-orchestrator/src/services",
          "Update plugins/plugin-agent-orchestrator/src/services/lane-planner.ts",
        ],
      }),
    ).toThrow(/overlap/i);
  });

  it("rejects requested tasks above the deterministic lane cap", () => {
    expect(() =>
      createDeterministicLanePlan({
        task: "parent",
        tasks: Array.from(
          { length: 7 },
          (_, index) => `Update packages/core/src/lane-${index}.ts`,
        ),
      }),
    ).toThrow(/at most 6 lanes; received 7/i);
  });

  it("rejects unknown dependency refs before planning", () => {
    expect(() =>
      createDeterministicLanePlan({
        task: "parent",
        tasks: [
          "Update plugins/plugin-agent-orchestrator/src/services/a.ts",
          "Update packages/core/src/runtime.ts",
        ],
        dependencies: { "lane-2": ["lane-9"] },
      }),
    ).toThrow(/unknown lane/i);
  });

  it("rejects dependency cycles before planning", () => {
    expect(() =>
      createDeterministicLanePlan({
        task: "parent",
        tasks: [
          "Update plugins/plugin-agent-orchestrator/src/services/a.ts",
          "Update packages/core/src/runtime.ts",
        ],
        dependencies: { "lane-1": ["lane-2"], "lane-2": ["lane-1"] },
      }),
    ).toThrow(/cycle/i);
  });

  it("sanitizes bounded non-colliding branch names for duplicate titles", () => {
    const plan = createDeterministicLanePlan({
      task: "parent",
      tasks: [
        "Update plugins/plugin-agent-orchestrator/src/services/lane-planner.ts",
        "Update plugins/plugin-agent-orchestrator/src/actions/tasks.ts",
      ],
      title: "Fix: Lane Planner!!!",
    });
    const branches = plan.lanes.map((lane) => lane.branchName);
    expect(branches[0]).toMatch(/^eliza\/lane\/fix-lane-planner/);
    expect(branches[1]).toMatch(/-2$/);
    expect(new Set(branches).size).toBe(2);
    expect(branches.every((branch) => branch.length <= 80)).toBe(true);
    expect(sanitizeLaneBranchName("../../bad; rm -rf /")).toMatch(
      /^eliza\/lane\//,
    );
  });

  it("uses semantic dependency blockers for readiness", () => {
    const lane = {
      id: "lane-2",
      dependencies: ["lane-1", "lane-3"],
    };

    expect(
      laneReadiness(
        lane,
        new Set(["lane-1"]),
        new Set(),
        new Map([["lane-3", "waiting_on_user"]]),
      ),
    ).toEqual({
      ready: false,
      blockers: ["lane-3: waiting_on_user"],
    });
    expect(laneReadiness(lane, new Set(["lane-1", "lane-3"]))).toEqual({
      ready: true,
      blockers: [],
    });
  });

  it("annotates open PR collisions from an injected provider", async () => {
    const service = new LanePlannerService(makeRuntime({}), {
      listOpenPrCollisions: async () => [
        {
          id: "pr-12",
          title: "touch same service",
          url: "https://github.com/elizaOS/eliza/pull/12",
          paths: [
            "plugins/plugin-agent-orchestrator/src/services/lane-planner.ts",
          ],
        },
      ],
    });

    const plan = await service.plan({
      task: "Update plugins/plugin-agent-orchestrator/src/services/lane-planner.ts",
      waveId: "wave-2",
    });

    expect(plan.lanes[0]?.collisions).toContainEqual({
      source: "open-pr",
      id: "pr-12",
      title: "touch same service",
      url: "https://github.com/elizaOS/eliza/pull/12",
      paths: ["plugins/plugin-agent-orchestrator/src/services/lane-planner.ts"],
    });
  });

  it("emits only the coding backend routing difficulty tags", () => {
    const hardPlan = createDeterministicLanePlan({
      task: "Update packages/core/src/schema.ts for an auth migration",
    });
    const moderatePlan = createDeterministicLanePlan({
      task: "Update plugins/plugin-agent-orchestrator/src/services/lane-planner.ts",
      difficultyTag: "standard",
    });
    const mappedHardPlan = createDeterministicLanePlan({
      task: "Update packages/core/src/runtime.ts",
      difficultyTag: "complex",
    });

    expect(hardPlan.lanes[0]?.difficultyTag).toBe("hard");
    expect(moderatePlan.lanes[0]?.difficultyTag).toBe("moderate");
    expect(mappedHardPlan.lanes[0]?.difficultyTag).toBe("hard");
    expect(
      [hardPlan, moderatePlan, mappedHardPlan].flatMap((plan) =>
        plan.lanes.map((lane) => lane.difficultyTag),
      ),
    ).toEqual(expect.arrayContaining(["hard", "moderate"]));
    expect(
      [hardPlan, moderatePlan, mappedHardPlan].some((plan) =>
        plan.lanes.some((lane) =>
          ["complex", "standard"].includes(lane.difficultyTag),
        ),
      ),
    ).toBe(false);
  });
});

describe("TASKS create lane planner integration", () => {
  const priorSmithers = process.env.ELIZA_ORCHESTRATOR_SMITHERS;

  beforeEach(() => {
    process.env.ELIZA_ORCHESTRATOR_SMITHERS = "0";
  });

  afterEach(() => {
    if (priorSmithers === undefined)
      delete process.env.ELIZA_ORCHESTRATOR_SMITHERS;
    else process.env.ELIZA_ORCHESTRATOR_SMITHERS = priorSmithers;
    vi.restoreAllMocks();
  });

  it("leaves create behavior unaltered when the gate is off", async () => {
    const acp = makeAcp();
    const taskService = makeTaskService();
    const runtime = makeRuntime({}, acp, taskService);

    await runCreate(
      runtime,
      makeMessage(
        "Update plugins/plugin-agent-orchestrator/src/services/lane-planner.ts",
      ),
    );

    expect(acp.spawnSession).toHaveBeenCalledTimes(1);
    expect(taskService.createTask).toHaveBeenCalledTimes(1);
    const spawnMetadata = acp.spawnSession.mock.calls[0]?.[0]?.metadata;
    expect(spawnMetadata).not.toHaveProperty("lane");
    const createMetadata = taskService.createTask.mock.calls[0]?.[0]?.metadata;
    expect(createMetadata).not.toHaveProperty("lane");
    expect(createMetadata).not.toHaveProperty("waveId");
    expect(createMetadata).toHaveProperty("source", "test");
  });

  it("spawns one durable create path per lane when the gate is on", async () => {
    const acp = makeAcp();
    const taskService = makeTaskService();
    const runtime = makeRuntime(
      { ELIZA_ORCHESTRATOR_LANE_PLANNER: "1" },
      acp,
      taskService,
    );

    const result = await tasksAction.handler(
      runtime,
      makeMessage("split work"),
      {} as State,
      {
        parameters: {
          action: "create",
          agents: [
            "Update plugins/plugin-agent-orchestrator/src/services/lane-planner.ts",
            "Update packages/core/src/runtime.ts",
          ].join(" | "),
        },
      },
      vi.fn(async () => []) as unknown as HandlerCallback,
    );

    expect(result?.success).toBe(true);
    expect(acp.spawnSession).toHaveBeenCalledTimes(2);
    expect(taskService.createTask).toHaveBeenCalledTimes(2);
    const firstMeta = acp.spawnSession.mock.calls[0]?.[0]?.metadata as Record<
      string,
      unknown
    >;
    const secondTask = taskService.createTask.mock.calls[1]?.[0] as Record<
      string,
      unknown
    >;
    expect(firstMeta.waveId).toEqual(expect.any(String));
    expect(firstMeta.lane).toMatchObject({
      id: "lane-1",
      scopePaths: [
        "plugins/plugin-agent-orchestrator/src/services/lane-planner.ts",
      ],
      forbiddenPaths: ["packages/core/src/runtime.ts"],
    });
    expect(secondTask.metadata).toMatchObject({
      waveId: firstMeta.waveId,
      lane: {
        id: "lane-2",
        scopePaths: ["packages/core/src/runtime.ts"],
        forbiddenPaths: [
          "plugins/plugin-agent-orchestrator/src/services/lane-planner.ts",
        ],
      },
    });
  });

  it("starts lane 2 before lane 1 finishes", async () => {
    const acp = makeAcp();
    const taskService = makeTaskService();
    const runtime = makeRuntime(
      { ELIZA_ORCHESTRATOR_LANE_PLANNER: "1" },
      acp,
      taskService,
    );
    const lane2Started = deferred();
    const events: string[] = [];
    const serialFallback = setTimeout(() => lane2Started.resolve(), 100);

    acp.sendPrompt.mockImplementation(async (sessionId: string) => {
      events.push(`${sessionId}:start`);
      if (sessionId === "sess-1") {
        await lane2Started.promise;
        events.push(`${sessionId}:finish`);
        return { stopReason: "end_turn", finalText: "done" };
      }
      lane2Started.resolve();
      events.push(`${sessionId}:finish`);
      return { stopReason: "end_turn", finalText: "done" };
    });

    await tasksAction.handler(
      runtime,
      makeMessage("split work"),
      {} as State,
      {
        parameters: {
          action: "create",
          agents: [
            "Update plugins/plugin-agent-orchestrator/src/services/lane-planner.ts",
            "Update packages/core/src/runtime.ts",
          ].join(" | "),
        },
      },
      vi.fn(async () => []) as unknown as HandlerCallback,
    );
    clearTimeout(serialFallback);

    expect(events.indexOf("sess-2:start")).toBeGreaterThan(-1);
    expect(events.indexOf("sess-2:start")).toBeLessThan(
      events.indexOf("sess-1:finish"),
    );
    expect(acp.spawnSession).toHaveBeenCalledTimes(2);
    expect(taskService.createTask).toHaveBeenCalledTimes(2);
  });

  it("keeps maxParallel backlog queued until earlier lanes finish", async () => {
    const acp = makeAcp();
    const taskService = makeTaskService();
    const runtime = makeRuntime(
      { ELIZA_ORCHESTRATOR_LANE_PLANNER: "1" },
      acp,
      taskService,
    );
    const events: string[] = [];
    acp.sendPrompt.mockImplementation(async (sessionId: string) => {
      events.push(`${sessionId}:start`);
      await Promise.resolve();
      events.push(`${sessionId}:finish`);
      return { stopReason: "end_turn", finalText: "done" };
    });

    await tasksAction.handler(
      runtime,
      makeMessage("split work"),
      {} as State,
      {
        parameters: {
          action: "create",
          maxParallel: 1,
          agents: [
            "Update plugins/plugin-agent-orchestrator/src/services/lane-planner.ts",
            "Update packages/core/src/runtime.ts",
            "Update packages/shared/src/contracts/chat.ts",
          ].join(" | "),
        },
      },
      vi.fn(async () => []) as unknown as HandlerCallback,
    );

    expect(acp.spawnSession).toHaveBeenCalledTimes(3);
    expect(events).toEqual([
      "sess-1:start",
      "sess-1:finish",
      "sess-2:start",
      "sess-2:finish",
      "sess-3:start",
      "sess-3:finish",
    ]);
  });

  it("honors dependency order even when maxParallel has spare slots", async () => {
    const acp = makeAcp();
    const taskService = makeTaskService();
    const runtime = makeRuntime(
      { ELIZA_ORCHESTRATOR_LANE_PLANNER: "1" },
      acp,
      taskService,
    );
    const events: string[] = [];
    acp.sendPrompt.mockImplementation(async (sessionId: string) => {
      events.push(`${sessionId}:start`);
      await Promise.resolve();
      events.push(`${sessionId}:finish`);
      return { stopReason: "end_turn", finalText: "done" };
    });

    await tasksAction.handler(
      runtime,
      makeMessage("split work"),
      {} as State,
      {
        parameters: {
          action: "create",
          maxParallel: 3,
          dependencies: { "lane-2": ["lane-1"] },
          agents: [
            "Update plugins/plugin-agent-orchestrator/src/services/lane-planner.ts",
            "Update packages/core/src/runtime.ts",
            "Update packages/shared/src/contracts/chat.ts",
          ].join(" | "),
        },
      },
      vi.fn(async () => []) as unknown as HandlerCallback,
    );

    // Lane 3 is independent and may claim sess-2. Dependent lane 2 must wait
    // for lane 1 and therefore claims sess-3 in this deterministic fixture.
    expect(events.indexOf("sess-3:start")).toBeGreaterThan(
      events.indexOf("sess-1:finish"),
    );
    expect(acp.spawnSession).toHaveBeenCalledTimes(3);
  });

  it("rejects invalid dependency graphs through the public TASKS create surface", async () => {
    const acp = makeAcp();
    const taskService = makeTaskService();
    const runtime = makeRuntime(
      { ELIZA_ORCHESTRATOR_LANE_PLANNER: "1" },
      acp,
      taskService,
    );

    const result = await tasksAction.handler(
      runtime,
      makeMessage("split work"),
      {} as State,
      {
        parameters: {
          action: "create",
          dependencies: { "lane-1": ["lane-2"], "lane-2": ["lane-1"] },
          agents: [
            "Update plugins/plugin-agent-orchestrator/src/services/lane-planner.ts",
            "Update packages/core/src/runtime.ts",
          ].join(" | "),
        },
      },
      vi.fn(async () => []) as unknown as HandlerCallback,
    );

    expect(result?.success).toBe(false);
    expect(result?.error).toBe("LANE_DEPENDENCY_CYCLE");
    expect(acp.spawnSession).not.toHaveBeenCalled();
    expect(taskService.createTask).not.toHaveBeenCalled();
  });

  it("reuses the active session via CodingWorkspaceService.findActiveSessionForTask", async () => {
    const acp = makeAcp();
    const taskService = makeTaskService();
    taskService.getTask.mockResolvedValue({
      task: {
        id: "task-existing",
        title: "Existing",
        goal: "Existing",
        kind: "coding",
        status: "active",
        priority: "normal",
        originalRequest: "Existing",
        acceptanceCriteria: [],
        paused: false,
        archived: false,
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
        lastActivityAt: 1,
        metadata: {},
      },
      sessions: [
        {
          id: "row-1",
          taskId: "task-existing",
          sessionId: "sess-active",
          framework: "codex",
          label: "Agent",
          originalTask: "Existing",
          workdir: process.cwd(),
          status: "ready",
          decisionCount: 0,
          autoResolvedCount: 0,
          registeredAt: 1,
          lastActivityAt: 10,
          idleCheckCount: 0,
          taskDelivered: false,
          lastSeenDecisionIndex: 0,
          spawnedAt: 1,
          retryCount: 0,
          inputTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
          cacheTokens: 0,
          costUsd: 0,
          usageState: "unavailable",
          metadata: {},
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
        },
      ],
      events: [],
      messages: [],
      usage: [],
      artifacts: [],
      decisions: [],
      planRevisions: [],
    });
    const workspaceService = new CodingWorkspaceService({
      getSetting: () => undefined,
      getService: (type: string) =>
        type === "ORCHESTRATOR_TASK_SERVICE" ? taskService : undefined,
    } as unknown as IAgentRuntime);
    const runtime = makeRuntime(
      { ELIZA_ORCHESTRATOR_LANE_PLANNER: "1" },
      acp,
      taskService,
      { CODING_WORKSPACE_SERVICE: workspaceService },
    );

    const result = await tasksAction.handler(
      runtime,
      makeMessage("split work"),
      {} as State,
      {
        parameters: {
          action: "create",
          taskId: "task-existing",
          agents:
            "Update plugins/plugin-agent-orchestrator/src/services/lane-planner.ts",
        },
      },
      vi.fn(async () => []) as unknown as HandlerCallback,
    );

    expect(result?.success).toBe(true);
    expect(acp.spawnSession).not.toHaveBeenCalled();
    const data = result?.data as
      | { lanes?: Array<Record<string, unknown>> }
      | undefined;
    expect(data?.lanes?.[0]).toMatchObject({
      taskId: "task-existing",
      branchName: expect.any(String),
    });
  });

  it("surfaces missing durable task service from the active-session reuse contract", async () => {
    const runtime = {
      getSetting: vi.fn(() => undefined),
      getService: vi.fn(() => undefined),
    } as unknown as IAgentRuntime;
    const workspaceService = new CodingWorkspaceService(runtime);

    await expect(
      workspaceService.findActiveSessionForTask({ taskId: "task-missing" }),
    ).rejects.toMatchObject({
      code: "ORCHESTRATOR_TASK_SERVICE_UNAVAILABLE",
    });
  });

  it("does not let content agents duplicate each planned lane", async () => {
    const acp = makeAcp();
    const taskService = makeTaskService();
    const runtime = makeRuntime(
      { ELIZA_ORCHESTRATOR_LANE_PLANNER: "1" },
      acp,
      taskService,
    );
    const agents = [
      "Update plugins/plugin-agent-orchestrator/src/services/lane-planner.ts",
      "Update packages/core/src/runtime.ts",
    ].join(" | ");

    await tasksAction.handler(
      runtime,
      makeMessage("split work", { agents }),
      {} as State,
      {
        parameters: {
          action: "create",
          agents: undefined,
        },
      },
      vi.fn(async () => []) as unknown as HandlerCallback,
    );

    expect(acp.spawnSession).toHaveBeenCalledTimes(2);
    expect(acp.sendPrompt).toHaveBeenCalledTimes(2);
    expect(taskService.createTask).toHaveBeenCalledTimes(2);
    for (const call of acp.sendPrompt.mock.calls) {
      expect(call[1]).toContain("Lane scope:");
      expect(call[1]).not.toContain("Update packages/core/src/runtime.ts |");
    }
  });

  it("preserves legacy create behavior for a single unscoped gated task", async () => {
    const acp = makeAcp();
    const taskService = makeTaskService();
    const runtime = makeRuntime(
      { ELIZA_ORCHESTRATOR_LANE_PLANNER: "1" },
      acp,
      taskService,
    );

    await runCreate(runtime, makeMessage("fix the bug"));

    expect(acp.spawnSession).toHaveBeenCalledTimes(1);
    expect(acp.sendPrompt).toHaveBeenCalledTimes(1);
    expect(acp.sendPrompt.mock.calls[0]?.[1]).toContain(
      "--- User Task ---\nfix the bug",
    );
    expect(acp.sendPrompt.mock.calls[0]?.[1]).not.toContain("Lane scope:");
    expect(acp.spawnSession.mock.calls[0]?.[0]?.metadata).not.toHaveProperty(
      "lane",
    );
    const createMetadata = taskService.createTask.mock.calls[0]?.[0]?.metadata;
    expect(createMetadata).not.toHaveProperty("lane");
    expect(createMetadata).not.toHaveProperty("waveId");
    expect(createMetadata).toHaveProperty("source", "test");
  });

  it("falls back to legacy single-task behavior when planning fails", async () => {
    const acp = makeAcp();
    const taskService = makeTaskService();
    const runtime = makeRuntime(
      { ELIZA_ORCHESTRATOR_LANE_PLANNER: "1" },
      acp,
      taskService,
    );

    await tasksAction.handler(
      runtime,
      makeMessage("split unscoped work"),
      {} as State,
      {
        parameters: {
          action: "create",
          agents: "fix the bug | add tests",
        },
      },
      vi.fn(async () => []) as unknown as HandlerCallback,
    );

    expect(acp.spawnSession).toHaveBeenCalledTimes(2);
    const spawnMetadata = acp.spawnSession.mock.calls[0]?.[0]?.metadata;
    expect(spawnMetadata).not.toHaveProperty("lane");
    const createMetadata = taskService.createTask.mock.calls[0]?.[0]?.metadata;
    expect(createMetadata).not.toHaveProperty("lane");
    expect(createMetadata).not.toHaveProperty("waveId");
    expect(createMetadata).toHaveProperty("source", "test");
  });

  it("preserves the legacy too-many-agents error when requests exceed both caps", async () => {
    const acp = makeAcp();
    const taskService = makeTaskService();
    const runtime = makeRuntime(
      { ELIZA_ORCHESTRATOR_LANE_PLANNER: "1" },
      acp,
      taskService,
    );

    const result = await tasksAction.handler(
      runtime,
      makeMessage("split too much work"),
      {} as State,
      {
        parameters: {
          action: "create",
          agents: Array.from(
            { length: 9 },
            (_, index) => `Update packages/core/src/too-many-${index}.ts`,
          ).join(" | "),
        },
      },
      vi.fn(async () => []) as unknown as HandlerCallback,
    );

    expect(result?.success).toBe(false);
    expect(result?.error).toBe("TOO_MANY_AGENTS");
    expect(acp.spawnSession).not.toHaveBeenCalled();
    expect(taskService.createTask).not.toHaveBeenCalled();
  });

  it("reports a lane 2 spawn failure without aborting or replaying lane 1", async () => {
    const acp = makeAcp();
    // Lanes share the pre-resolved base backend, so the per-lane failure
    // seam is the spawn itself: lane 1 spawns, lane 2's spawn explodes. The
    // turn must survive with lane 1's work intact and the failure reported —
    // not reject, and not replay lane 1.
    const realSpawn = acp.spawnSession.getMockImplementation();
    let spawnCalls = 0;
    acp.spawnSession.mockImplementation(
      async (opts: Record<string, unknown>) => {
        spawnCalls += 1;
        if (spawnCalls === 2) {
          throw new Error("lane 2 spawn exploded");
        }
        return realSpawn?.(opts);
      },
    );
    const taskService = makeTaskService();
    const runtime = makeRuntime(
      { ELIZA_ORCHESTRATOR_LANE_PLANNER: "1" },
      acp,
      taskService,
    );

    const result = await tasksAction.handler(
      runtime,
      makeMessage("split work"),
      {} as State,
      {
        parameters: {
          action: "create",
          agents: [
            "Update plugins/plugin-agent-orchestrator/src/services/lane-planner.ts",
            "Update packages/core/src/runtime.ts",
          ].join(" | "),
        },
      },
      vi.fn(async () => []) as unknown as HandlerCallback,
    );

    expect(acp.spawnSession).toHaveBeenCalledTimes(2);
    expect(acp.sendPrompt).toHaveBeenCalledTimes(1);
    // Durable linkage persists per-lane BEFORE the spawn, so lane 2's task
    // record exists even though its spawn failed.
    expect(taskService.createTask).toHaveBeenCalledTimes(2);
    // The failure-report return carries the failed lane's row (error intact);
    // lane 1's success is delivered through its own task lifecycle, not here.
    const data = (result as { data?: Record<string, unknown> })?.data;
    const agents = (data?.agents ?? []) as Array<{
      status?: string;
      error?: string;
      label?: string;
    }>;
    expect(agents).toHaveLength(1);
    expect(agents[0]?.status).toBe("failed");
    expect(agents[0]?.error).toBe("lane 2 spawn exploded");
    expect(agents[0]?.label).toContain("packages/core/src/runtime.ts");
  });

  it("returns an ordinary failed lane result without replaying the original request", async () => {
    const acp = makeAcp();
    acp.sendPrompt
      .mockResolvedValueOnce({
        stopReason: "end_turn",
        finalText: "done",
      })
      .mockRejectedValueOnce(new Error("lane 2 prompt failed"));
    const taskService = makeTaskService();
    const runtime = makeRuntime(
      { ELIZA_ORCHESTRATOR_LANE_PLANNER: "1" },
      acp,
      taskService,
    );

    const result = await tasksAction.handler(
      runtime,
      makeMessage("split work"),
      {} as State,
      {
        parameters: {
          action: "create",
          agents: [
            "Update plugins/plugin-agent-orchestrator/src/services/lane-planner.ts",
            "Update packages/core/src/runtime.ts",
          ].join(" | "),
        },
      },
      vi.fn(async () => []) as unknown as HandlerCallback,
    );

    expect(result?.success).toBe(false);
    expect(acp.spawnSession).toHaveBeenCalledTimes(2);
    expect(acp.sendPrompt).toHaveBeenCalledTimes(2);
    expect(taskService.createTask).toHaveBeenCalledTimes(2);
  });
});
