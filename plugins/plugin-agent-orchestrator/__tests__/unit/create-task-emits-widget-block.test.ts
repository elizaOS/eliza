/**
 * Closes gap #1 from
 * `docs/orchestrator-dashboard-task-widget-secrets-assessment.md`: on a
 * successful `TASKS:create`, the action must mint a durable orchestrator task
 * thread and emit `[TASK:<threadId>]<title>[/TASK]` in the callback so the
 * chat surface can render the TaskWidget.
 *
 * Three surfaces are pinned:
 *   1. Happy path — OrchestratorTaskService.createTask returns `{ id, title }`;
 *      callback text contains the widget block; result exposes `data.taskId`.
 *   2. Direct-runner failure mode — createTask throws; action still runs the
 *      ACP prompt, but the widget block is omitted and `data.taskId` is null.
 *   3. Smithers failure mode — createTask throws before any ACP session or
 *      graph work begins, because a recoverable graph may never have a
 *      fabricated or missing durable owner.
 *
 * Multi-service `getService` lookup is wired the same way the production
 * runner does: by serviceType string, with the ACP service kept under
 * `ACP_SUBPROCESS_SERVICE` and the task service under
 * `ORCHESTRATOR_TASK_SERVICE`.
 */

import * as os from "node:os";
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { createTaskAction } from "../../src/actions/tasks.js";
import {
  callback,
  memory,
  serviceMock,
  state,
} from "../../src/test-utils/action-test-utils.js";

const THREAD_ID = "0123abcd-1234-5678-9abc-deadbeefcafe";

function runtimeWithServices(opts: {
  acp: ReturnType<typeof serviceMock>;
  taskService?: {
    createTask: (input: unknown) => Promise<unknown>;
    attachSession?: (
      taskId: string,
      input: Record<string, unknown>,
    ) => Promise<boolean>;
  };
}): IAgentRuntime {
  return {
    getService: vi.fn((serviceType: string) => {
      if (
        serviceType === "ACP_SERVICE" ||
        serviceType === "ACP_SUBPROCESS_SERVICE"
      ) {
        return opts.acp;
      }
      if (serviceType === "ORCHESTRATOR_TASK_SERVICE") {
        return opts.taskService ?? null;
      }
      return null;
    }),
    hasService: vi.fn(() => true),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  } as never;
}

describe("TASKS:create durable-task widget emission", () => {
  it("emits [TASK:<id>]<title>[/TASK] in the callback when createTask succeeds", async () => {
    const acp = serviceMock();
    const createTask = vi.fn(async () => ({
      id: THREAD_ID,
      title: "Build planner",
    }));
    const runtime = runtimeWithServices({ acp, taskService: { createTask } });
    const cb = callback();
    const workdir = os.tmpdir();

    const result = await createTaskAction.handler(
      runtime,
      memory({}),
      state,
      {
        parameters: {
          action: "create",
          title: "Build planner",
          goal: "Ship a working planner",
          task: "fix bug",
          agentType: "codex",
          workdir,
          model: "gpt-5.5",
          approvalPreset: "readonly",
          timeout_ms: 1000,
          acceptanceCriteria: ["tests green", "no lint"],
        },
      },
      cb,
    );

    expect(result?.success).toBe(true);
    expect(result?.text).toContain(`[TASK:${THREAD_ID}]Build planner[/TASK]`);
    expect(result?.data?.taskId).toBe(THREAD_ID);
    expect(createTask).toHaveBeenCalledTimes(1);
    const arg = createTask.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(arg.title).toBe("Build planner");
    expect(arg.goal).toBe("Ship a working planner");
    expect(arg.kind).toBe("coding");
    expect(arg.priority).toBe("normal");
    expect(arg.acceptanceCriteria).toEqual(["tests green", "no lint"]);

    expect(cb).toHaveBeenCalledTimes(1);
    const cbArg = cb.mock.calls[0]?.[0] as { text?: string };
    expect(cbArg?.text ?? "").toContain(
      `[TASK:${THREAD_ID}]Build planner[/TASK]`,
    );
  });

  it("persists the concrete task as the goal when agents is only a backend hint", async () => {
    const acp = serviceMock();
    const createTask = vi.fn(async () => ({
      id: THREAD_ID,
      title: "Personal website",
    }));
    const runtime = runtimeWithServices({ acp, taskService: { createTask } });
    const task =
      "Create a personal website with a bio, social links, and contact section.";

    const result = await createTaskAction.handler(
      runtime,
      memory({ text: "just personal for nubs" }),
      state,
      {
        parameters: {
          action: "create",
          task,
          agentType: "elizaos",
          agents: "elizaos",
          workdir: os.tmpdir(),
        },
      },
      callback(),
    );

    expect(result?.success).toBe(true);
    const input = createTask.mock.calls[0]?.[0] as {
      goal?: string;
      metadata?: { workspaceMutationExpected?: boolean };
    };
    expect(input.goal).toBe(task);
    expect(input.metadata?.workspaceMutationExpected).toBe(true);
  });

  it("direct runner still succeeds without the widget when createTask throws", async () => {
    const acp = serviceMock();
    const createTask = vi.fn(async () => {
      throw new Error("store offline");
    });
    const runtime = runtimeWithServices({ acp, taskService: { createTask } });
    const cb = callback();
    const workdir = os.tmpdir();

    const result = await createTaskAction.handler(
      runtime,
      memory({}),
      state,
      {
        parameters: {
          action: "create",
          task: "fix bug",
          agentType: "codex",
          workdir,
          approvalPreset: "readonly",
          timeout_ms: 1000,
        },
      },
      cb,
    );

    expect(result?.success).toBe(true);
    expect(result?.text).not.toContain("[TASK:");
    expect(result?.text).toContain("I'm on it");
    expect(result?.data?.taskId).toBeNull();
    expect(cb).toHaveBeenCalledTimes(1);
    const cbArg = cb.mock.calls[0]?.[0] as { text?: string };
    expect(cbArg?.text ?? "").not.toContain("[TASK:");
  });

  it("refuses Smithers before ACP spawn when durable task creation fails", async () => {
    const acp = serviceMock();
    const createTask = vi.fn(async () => {
      throw new Error("store offline");
    });
    const runtime = runtimeWithServices({ acp, taskService: { createTask } });
    const cb = callback();
    const previousSmithers = process.env.ELIZA_ORCHESTRATOR_SMITHERS;

    let result: Awaited<ReturnType<typeof createTaskAction.handler>>;
    try {
      process.env.ELIZA_ORCHESTRATOR_SMITHERS = "1";
      result = await createTaskAction.handler(
        runtime,
        memory({}),
        state,
        {
          parameters: {
            action: "create",
            task: "fix bug",
            agentType: "codex",
            workdir: os.tmpdir(),
          },
        },
        cb,
      );
    } finally {
      if (previousSmithers === undefined) {
        delete process.env.ELIZA_ORCHESTRATOR_SMITHERS;
      } else {
        process.env.ELIZA_ORCHESTRATOR_SMITHERS = previousSmithers;
      }
    }

    expect(result?.success).toBe(false);
    expect(result?.error).toBe("SMITHERS_DURABLE_TASK_UNAVAILABLE");
    expect(result?.text).toContain("no workflow agent was started");
    expect(createTask).toHaveBeenCalledTimes(1);
    expect(acp.spawnSession).not.toHaveBeenCalled();
    expect(acp.sendPrompt).not.toHaveBeenCalled();
    expect(acp.stopSession).not.toHaveBeenCalled();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("preserves a durable-link failure when unprompted-session teardown also fails", async () => {
    const acp = serviceMock();
    acp.stopSession.mockRejectedValueOnce(new Error("stop transport failed"));
    const createTask = vi.fn(async () => ({
      id: THREAD_ID,
      title: "Build planner",
    }));
    const attachSession = vi.fn(async () => {
      throw new Error("durable store offline");
    });
    const runtime = runtimeWithServices({
      acp,
      taskService: { createTask, attachSession },
    });
    const cb = callback();
    const previousSmithers = process.env.ELIZA_ORCHESTRATOR_SMITHERS;

    let result: Awaited<ReturnType<typeof createTaskAction.handler>>;
    try {
      process.env.ELIZA_ORCHESTRATOR_SMITHERS = "1";
      result = await createTaskAction.handler(
        runtime,
        memory({}),
        state,
        {
          parameters: {
            action: "create",
            task: "fix bug",
            agentType: "codex",
            workdir: os.tmpdir(),
          },
        },
        cb,
      );
    } finally {
      if (previousSmithers === undefined) {
        delete process.env.ELIZA_ORCHESTRATOR_SMITHERS;
      } else {
        process.env.ELIZA_ORCHESTRATOR_SMITHERS = previousSmithers;
      }
    }

    expect(result?.success).toBe(false);
    expect(result?.text).toContain("durable store offline");
    expect(result?.text).not.toContain("stop transport failed");
    expect(attachSession).toHaveBeenCalledTimes(1);
    expect(acp.stopSession).toHaveBeenCalledTimes(1);
    expect(acp.sendPrompt).not.toHaveBeenCalled();
    expect(runtime.logger?.warn).toHaveBeenCalledWith(
      expect.stringContaining("stop transport failed"),
    );
  });
});
