/**
 * Pins the wiring between `TASKS:create` and
 * {@link OrchestratorTaskService.attachSession}: on a successful spawn +
 * mint, every session that `service.spawnSession` returned must be attached
 * to the freshly-minted task thread so the widget/panel read agent count and
 * token usage instead of `0/0`.
 *
 * Pinned surfaces:
 *   1. Happy path — one attachSession call per spawned session, with the
 *      minted taskId, matching sessionId/agentType/workdir/status, and the
 *      per-part label the create action assembled.
 *   2. Attach failure is soft — attachSession throwing is logged, but the
 *      action still returns `success: true` with the widget block (same
 *      policy as thread-mint failure).
 *   3. Thread-mint failure path is clean — when createTask throws, the
 *      action does NOT try to attach (there's no taskId), and the widget
 *      block is omitted while the ACP sessions still ran.
 *
 * These complement `create-task-emits-widget-block.test.ts` (which pins the
 * mint+widget-block contract) and `attach-session.test.ts` (which pins the
 * service-level attach semantics).
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

const THREAD_ID = "aaaabbbb-1111-2222-3333-444455556666";

function runtimeWithServices(opts: {
  acp: ReturnType<typeof serviceMock>;
  taskService?: {
    createTask?: (input: unknown) => Promise<unknown>;
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

describe("TASKS:create attaches spawned sessions to the minted task thread", () => {
  it("calls attachSession(taskId, {sessionId, ...}) for each successful spawn", async () => {
    const acp = serviceMock();
    const createTask = vi.fn(async () => ({
      id: THREAD_ID,
      title: "Build planner",
    }));
    const attachSession = vi.fn(async () => true);
    const runtime = runtimeWithServices({
      acp,
      taskService: { createTask, attachSession },
    });
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
        },
      },
      cb,
    );

    expect(result?.success).toBe(true);
    expect(result?.data?.taskId).toBe(THREAD_ID);
    // One spawn happened → one attach.
    expect(attachSession).toHaveBeenCalledTimes(1);
    const [attachedTaskId, attachedInput] = attachSession.mock.calls[0] ?? [];
    expect(attachedTaskId).toBe(THREAD_ID);
    const input = attachedInput as Record<string, unknown>;
    expect(typeof input.sessionId).toBe("string");
    expect((input.sessionId as string).length).toBeGreaterThan(0);
    expect(input.agentType).toBe("codex");
    expect(input.workdir).toBe(workdir);
    expect(input.status).toBe("ready");
    expect(input.model).toBe("gpt-5.5");
    // The per-part label the create action assigned rides through.
    expect(typeof input.label).toBe("string");
    expect((input.label as string).length).toBeGreaterThan(0);
  });

  it("still returns success (with the widget) when attachSession throws", async () => {
    // Attach failure must be logged, not demote the action — same soft-fail
    // policy as thread-mint failure. The ACP sessions are still running.
    const acp = serviceMock();
    const createTask = vi.fn(async () => ({
      id: THREAD_ID,
      title: "Build planner",
    }));
    const attachSession = vi.fn(async () => {
      throw new Error("store offline");
    });
    const runtime = runtimeWithServices({
      acp,
      taskService: { createTask, attachSession },
    });
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
    expect(result?.text).toContain(`[TASK:${THREAD_ID}]`);
    expect(attachSession).toHaveBeenCalledTimes(1);
  });

  it("does not attempt to attach when thread-mint fails (no taskId)", async () => {
    // No taskId → no attach call. Sessions are still running; the widget is
    // just omitted from the callback prose (create-task-emits-widget-block
    // already pins that surface — here we only guarantee the attach guard).
    const acp = serviceMock();
    const createTask = vi.fn(async () => {
      throw new Error("mint failed");
    });
    const attachSession = vi.fn(async () => true);
    const runtime = runtimeWithServices({
      acp,
      taskService: { createTask, attachSession },
    });
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
    expect(result?.data?.taskId).toBeNull();
    expect(attachSession).not.toHaveBeenCalled();
  });
});
