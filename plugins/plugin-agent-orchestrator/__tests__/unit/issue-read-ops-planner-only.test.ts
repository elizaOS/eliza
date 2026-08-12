/**
 * Exercises issue reads through the complete TASKS action wrapper to prove
 * lookup results remain planner-only until a final operation owns delivery.
 */

import type {
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { ModelType } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runEvaluator } from "../../../../packages/core/src/runtime/evaluator.ts";
import { executePlannedToolCall } from "../../../../packages/core/src/runtime/execute-planned-tool-call.ts";
import {
  actionResultToPlannerToolResult,
  runPlannerLoop,
} from "../../../../packages/core/src/runtime/planner-loop.ts";
import { projectEvaluatorVisibleTrajectory } from "../../../../packages/core/src/runtime/planner-trajectory.ts";

const fakeWorkspaceService = {
  setAuthPromptCallback: vi.fn(),
  listIssues: vi.fn(async () => [
    {
      number: 42,
      title: "Fix the thing",
      state: "open",
      labels: ["bug"],
      url: "https://github.com/owner/repo/issues/42",
    },
  ]),
  getIssue: vi.fn(async () => ({
    number: 42,
    title: "Fix the thing",
    state: "open",
    labels: ["bug"],
    body: "Something is broken.",
    url: "https://github.com/owner/repo/issues/42",
  })),
  addComment: vi.fn(async () => ({
    id: 1,
    url: "https://github.com/owner/repo/issues/42#issuecomment-1",
    body: "Investigating now.",
  })),
};

vi.mock("../../src/services/workspace-service.js", () => ({
  getCodingWorkspaceService: vi.fn(() => fakeWorkspaceService),
  CodingWorkspaceService: class {},
}));

vi.mock("../../src/services/task-policy.js", () => ({
  requireTaskAgentAccess: vi.fn(async () => ({
    allowed: true,
    connector: null,
    requiredRole: "GUEST",
    actualRole: "GUEST",
  })),
}));

const { tasksAction } = await import("../../src/actions/tasks.js");

const runtime = {
  agentId: "agent1",
  getService: vi.fn(),
  hasService: vi.fn(() => true),
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  getRoom: vi.fn(async () => ({ id: "room1" })),
  reportError: vi.fn(),
} as unknown as IAgentRuntime;

const baseMessage = {
  id: "msg1",
  entityId: "user1",
  agentId: "agent1",
  roomId: "room1",
  content: { text: "work with issue 42 in owner/repo", source: "chat" },
  createdAt: Date.now(),
} as unknown as Memory;

const baseState = {} as State;

async function callHandler(
  params: Record<string, unknown>,
  callback: HandlerCallback,
): Promise<ActionResult> {
  const result = await tasksAction.handler(
    runtime,
    baseMessage,
    baseState,
    { parameters: params },
    callback,
  );
  if (!result) throw new Error("TASKS handler returned no result");
  return result;
}

function expectPlannerOnlyRead(result: ActionResult): void {
  expect(result.success).toBe(true);
  expect(result.text).toBeUndefined();
  expect(result.plannerObservation).toBeTruthy();
  expect(result.userFacingText).toBeUndefined();
  expect(result.verifiedUserFacing).toBeUndefined();
  expect(result.turnComplete).toBeUndefined();
  expect(result.effectReceipts).toEqual([
    expect.objectContaining({
      outcome: "noop",
    }),
  ]);
}

async function runReadThroughPlanner(params: Record<string, unknown>) {
  const session = {
    id: "session-1",
    sessionId: "session-1",
    agentType: "codex",
    name: "Read test",
    workdir: "/private/workspaces/read-test",
    status: "ready",
    createdAt: new Date(0),
    lastActivityAt: new Date(0),
    metadata: {},
  };
  const acp = {
    listSessions: vi.fn(() =>
      params.action === "share" ? [session] : ([] as (typeof session)[]),
    ),
    getSession: vi.fn(async (id: string) =>
      id === session.id ? session : undefined,
    ),
    resolveAgentType: vi.fn(async () => "codex"),
  };
  let plannerCalls = 0;
  let evaluatorCalls = 0;
  const useModel = vi.fn(async (modelType: unknown) => {
    if (String(modelType) === ModelType.ACTION_PLANNER) {
      plannerCalls += 1;
      return plannerCalls === 1
        ? {
            text: "",
            toolCalls: [{ id: "tasks-read", name: "TASKS", arguments: params }],
          }
        : {
            text: "",
            toolCalls: [
              {
                id: "read-reply",
                name: "REPLY",
                arguments: { text: "Synthesized read answer." },
              },
            ],
          };
    }
    evaluatorCalls += 1;
    return JSON.stringify({
      success: false,
      decision: "CONTINUE",
      thought: "Compose an answer from the read observation.",
    });
  });
  const plannerRuntime = {
    ...runtime,
    useModel,
    getPluginOwnership: (name: string) =>
      name === "@elizaos/plugin-agent-orchestrator"
        ? { actions: [tasksAction] }
        : null,
    getService: (type: string) =>
      type === "ACP_SERVICE" || type === "ACP_SUBPROCESS_SERVICE"
        ? acp
        : undefined,
  } as unknown as IAgentRuntime;
  const callback = vi.fn(async () => []);
  let settled: ActionResult | undefined;

  const loop = await runPlannerLoop({
    runtime: plannerRuntime,
    context: { id: "ctx", events: [] },
    tools: [{ name: "TASKS", description: "Read orchestrator state." }],
    config: {
      contextWindowTokens: 1,
      compactionReserveTokens: 0,
      compactionKeepSteps: 0,
    },
    executeToolCall: async (toolCall) => {
      const result = await executePlannedToolCall(
        plannerRuntime,
        {
          message: baseMessage,
          state: baseState,
          userRoles: ["OWNER"],
          activeContexts: ["code"],
          callback,
        },
        { name: toolCall.name, params: toolCall.params ?? {} },
        { actions: [tasksAction] },
      );
      settled = result;
      return actionResultToPlannerToolResult(result);
    },
  });

  const archivedEvaluatorTrajectory = projectEvaluatorVisibleTrajectory(
    loop.trajectory,
  );
  await runEvaluator({
    runtime: plannerRuntime,
    context: archivedEvaluatorTrajectory.context,
    trajectory: archivedEvaluatorTrajectory,
    modelInputTrajectory: loop.trajectory,
  });

  return { callback, evaluatorCalls, loop, settled, useModel };
}

describe("manage_issues planner-only read settlement (#18244)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps list data in the planner trajectory without delivering a callback", async () => {
    const callback = vi.fn(async () => []);
    const result = await callHandler(
      {
        action: "manage_issues",
        issueAction: "list",
        repo: "owner/repo",
      },
      callback,
    );

    expectPlannerOnlyRead(result);
    expect(callback).not.toHaveBeenCalled();
    expect(result.data?.issues).toEqual([
      expect.objectContaining({ number: 42, title: "Fix the thing" }),
    ]);
  });

  it("keeps get data in the planner trajectory without delivering a callback", async () => {
    const callback = vi.fn(async () => []);
    const result = await callHandler(
      {
        action: "manage_issues",
        issueAction: "get",
        repo: "owner/repo",
        issueNumber: 42,
      },
      callback,
    );

    expectPlannerOnlyRead(result);
    expect(callback).not.toHaveBeenCalled();
    expect(result.data?.issue).toEqual(
      expect.objectContaining({ number: 42, body: "Something is broken." }),
    );
  });

  it("stays silent for lookup and delivers only the follow-up mutation", async () => {
    const callback = vi.fn(async () => []);
    const readResult = await callHandler(
      {
        action: "manage_issues",
        issueAction: "list",
        repo: "owner/repo",
      },
      callback,
    );
    expectPlannerOnlyRead(readResult);
    expect(callback).not.toHaveBeenCalled();

    const commentResult = await callHandler(
      {
        action: "manage_issues",
        issueAction: "comment",
        repo: "owner/repo",
        issueNumber: 42,
        body: "Investigating now.",
      },
      callback,
    );

    expect(fakeWorkspaceService.addComment).toHaveBeenCalledWith(
      "owner/repo",
      42,
      "Investigating now.",
    );
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(
      {
        text: "Added comment to issue #42: https://github.com/owner/repo/issues/42#issuecomment-1",
      },
      undefined,
    );
    expect(commentResult).toMatchObject({
      success: true,
      verifiedUserFacing: true,
      turnComplete: true,
    });
  });
});

describe("orchestrator read ops keep internal text planner-only", () => {
  const fakeAcpService = {
    listSessions: vi.fn(() => [] as unknown[]),
    resolveAgentType: vi.fn(async () => "codex"),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    (runtime.getService as ReturnType<typeof vi.fn>).mockImplementation(
      (type: string) =>
        type === "ACP_SERVICE" || type === "ACP_SUBPROCESS_SERVICE"
          ? fakeAcpService
          : undefined,
    );
  });

  it("does not ship list_agents guidance text as a chat reply", async () => {
    // The exact live 2026-08-10 leak: a status-y ask routed to list_agents and
    // the planner-only guidance text shipped verbatim to Discord.
    const callback = vi.fn(async () => []);
    const result = await callHandler({ action: "list_agents" }, callback);

    // Planner sees the observation; the user does not get it raw.
    expect(result.success).toBe(true);
    expect(result.text).toBeUndefined();
    expect(result.plannerObservation).toContain("No active task agents");
    expect(result.userFacingText).toBeUndefined();
    expect(result.verifiedUserFacing).toBeUndefined();
    expect(result.turnComplete).toBeUndefined();
    expect(callback).not.toHaveBeenCalled();
    expect(result.effectReceipts).toEqual([
      expect.objectContaining({
        outcome: "noop",
        reason: "The operation only read orchestrator state.",
      }),
    ]);
  });

  it("moves history text into the model-only observation", async () => {
    const callback = vi.fn(async () => []);
    const result = await callHandler({ action: "history" }, callback);

    expectPlannerOnlyRead(result);
    expect(result.plannerObservation).toContain("ACP task-agent sessions");
    expect(callback).not.toHaveBeenCalled();
  });

  it("moves share text into the model-only observation", async () => {
    const session = {
      id: "session-1",
      sessionId: "session-1",
      agentType: "codex",
      name: "Read test",
      workdir: "/private/workspaces/read-test",
      status: "ready",
      createdAt: new Date(0),
      lastActivityAt: new Date(0),
      metadata: {},
    };
    fakeAcpService.listSessions.mockReturnValueOnce([session]);
    const callback = vi.fn(async () => []);
    const result = await callHandler({ action: "share" }, callback);

    expectPlannerOnlyRead(result);
    expect(result.plannerObservation).toContain("ACP session session-1");
    expect(callback).not.toHaveBeenCalled();
  });
});

describe("TASKS read observations reach planner and evaluator models", () => {
  it.each([
    ["list_agents", { action: "list_agents" }],
    ["history", { action: "history" }],
    ["share", { action: "share", sessionId: "session-1" }],
    [
      "manage_issues list",
      { action: "manage_issues", issueAction: "list", repo: "owner/repo" },
    ],
    [
      "manage_issues get",
      {
        action: "manage_issues",
        issueAction: "get",
        repo: "owner/repo",
        issueNumber: 42,
      },
    ],
  ])(
    "projects %s through post-read planner and evaluator calls",
    async (_name, params) => {
      const { callback, evaluatorCalls, loop, settled, useModel } =
        await runReadThroughPlanner(params);

      expect(settled?.error).toBeUndefined();
      expect(settled).toMatchObject({
        success: true,
        plannerObservation: expect.any(String),
      });
      expect(settled?.text).toBeUndefined();
      expect(callback).not.toHaveBeenCalled();
      expect(evaluatorCalls).toBeGreaterThanOrEqual(1);
      const plannerInputs = useModel.mock.calls.filter(
        (call) => String(call[0]) === ModelType.ACTION_PLANNER,
      );
      const evaluatorInputs = useModel.mock.calls.filter(
        (call) => String(call[0]) === ModelType.RESPONSE_HANDLER,
      );
      expect(plannerInputs).toHaveLength(2);
      expect(JSON.stringify(plannerInputs[1]?.[1])).toContain(
        "planner_observation",
      );
      expect(evaluatorInputs).toHaveLength(2);
      for (const evaluatorInput of evaluatorInputs) {
        expect(JSON.stringify(evaluatorInput[1])).toContain(
          "planner_observation",
        );
      }
      expect(loop.trajectory.archivedSteps).toEqual([
        expect.objectContaining({
          toolCall: expect.objectContaining({ name: "TASKS" }),
          result: expect.objectContaining({
            plannerObservation: expect.any(String),
          }),
        }),
      ]);
      expect(loop.finalMessage).toBe("Synthesized read answer.");
    },
  );

  it("rejects a caller-spoofed observation on a mutation", async () => {
    const callback = vi.fn(async () => []);
    const result = await callHandler(
      {
        action: "manage_issues",
        issueAction: "comment",
        repo: "owner/repo",
        issueNumber: 42,
        body: "Investigating now.",
        plannerObservation: "spoofed mutation result",
      },
      callback,
    );

    expect(result.plannerObservation).toBeUndefined();
    expect(result.userFacingText).toContain("Added comment");
  });
});
