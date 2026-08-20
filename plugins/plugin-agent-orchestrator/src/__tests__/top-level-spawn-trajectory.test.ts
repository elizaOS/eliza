/**
 * Pins the real TASKS action bridge for top-level fire-and-forget spawns: the
 * child must receive a managed trajectory env before its durable task record is
 * attached, and the correlation directory must survive in session metadata.
 */
import type { IAgentRuntime, Memory, State } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { tasksAction } from "../actions/tasks.js";
import { OrchestratorTaskService } from "../services/orchestrator-task-service.js";

const ROOM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const AGENT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

describe("TASKS top-level child trajectory bridge", () => {
  it("forwards detached trace env and metadata, then attaches the same session", async () => {
    const spawnSession = vi.fn(async (opts: Record<string, unknown>) => ({
      sessionId: "session-1",
      agentType: "elizaos",
      workdir: opts.workdir,
      status: "running",
      metadata: opts.metadata,
    }));
    const acp = {
      spawnSession,
      getSessions: vi.fn(async () => []),
      listSessions: vi.fn(async () => []),
      getSession: vi.fn(async () => undefined),
      resolveAgentType: vi.fn(async () => "elizaos"),
      stopSession: vi.fn(async () => undefined),
    };
    const taskService = {
      prepareDetachedChildTrace: vi.fn(() => ({
        env: {
          ELIZA_TRAJECTORY_LOGGING: "1",
          ELIZA_TRAJECTORY_DIR: "/state/child-trajectories/pending-1",
          ELIZA_TRACE_ID: "trace-1",
          ELIZA_TASK_ID: "pending-1",
          ELIZA_PARENT_TRAJECTORY_STEP_ID: "parent-step-1",
        },
        metadata: {
          orchestratorChildTrajectoryDir: "/state/child-trajectories/pending-1",
        },
      })),
      createTask: vi.fn(async () => ({ id: "task-1" })),
      attachSession: vi.fn(async () => undefined),
      listTasks: vi.fn(async () => []),
      getTask: vi.fn(async () => null),
    };
    const runtime = {
      agentId: AGENT,
      character: { name: "Tester" },
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      getSetting: (key: string) =>
        key === "ELIZA_ORCHESTRATOR_TASK_ROOMS"
          ? "0"
          : key === "ELIZA_AGENT_SELECTION_STRATEGY"
            ? "dynamic"
            : undefined,
      getService: (type: string) => {
        if (type === "ACP_SERVICE" || type === "ACP_SUBPROCESS_SERVICE") {
          return acp;
        }
        if (type === OrchestratorTaskService.serviceType) return taskService;
        return undefined;
      },
      reportError: vi.fn(),
      emitEvent: vi.fn(async () => undefined),
      useModel: vi.fn(async () => "{}"),
    } as unknown as IAgentRuntime;
    const message = {
      id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      roomId: ROOM,
      entityId: USER,
      agentId: AGENT,
      content: {
        text: "Delegate a read-only coding check in this exact workdir.",
        source: "client_chat",
      },
    } as unknown as Memory;

    const result = await tasksAction.handler(
      runtime,
      message,
      undefined as unknown as State,
      {
        parameters: {
          action: "spawn_agent",
          task: "Read src/a.ts and run its test.",
          agentType: "elizaos",
          workdir: process.cwd(),
          lockWorkdir: true,
          approvalPreset: "readonly",
        },
      },
      undefined,
    );

    expect(result?.success).toBe(true);
    expect(taskService.prepareDetachedChildTrace).toHaveBeenCalledTimes(1);
    expect(spawnSession).toHaveBeenCalledWith(
      expect.objectContaining({
        workdir: process.cwd(),
        env: expect.objectContaining({
          ELIZA_TRAJECTORY_DIR: "/state/child-trajectories/pending-1",
        }),
        metadata: expect.objectContaining({
          orchestratorChildTrajectoryDir: "/state/child-trajectories/pending-1",
        }),
      }),
    );
    expect(taskService.createTask).toHaveBeenCalledTimes(1);
    expect(taskService.attachSession).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        sessionId: "session-1",
        traceId: "trace-1",
        parentTrajectoryStepId: "parent-step-1",
        metadata: expect.objectContaining({
          orchestratorChildTrajectoryDir: "/state/child-trajectories/pending-1",
        }),
      }),
    );
  });

  it("exposes lockWorkdir to the planner action schema", () => {
    expect(
      tasksAction.parameters?.some((entry) => entry.name === "lockWorkdir"),
    ).toBe(true);
  });
});
