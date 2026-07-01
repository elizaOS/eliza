/**
 * Pins the wiring between `TASKS:create` and
 * {@link OrchestratorTaskService.attachSession}: on a successful spawn +
 * mint, every session that `service.spawnSession` returned must be attached
 * to the freshly-minted task thread so the widget/panel read agent count and
 * token usage instead of `0/0`.
 *
 * Pinned surfaces:
 *   1. Happy path — one attachSession call per spawned session, with the
 *      minted taskId, matching sessionId/agentType/workdir, the per-part label
 *      the create action assembled, and the session's REAL post-run status.
 *      For a single-turn create, `runPromptAndClose` / `runPromptViaSmithers`
 *      have already stopped the session before the thread is minted, so the
 *      status attach receives is terminal (`stopped`), NOT the stale `ready`
 *      snapshot captured at spawn time.
 *   2. Attach failure is soft — attachSession throwing is logged, but the
 *      action still returns `success: true` with the widget block (same
 *      policy as thread-mint failure).
 *   3. Thread-mint failure path is clean — when createTask throws, the
 *      action does NOT try to attach (there's no taskId), and the widget
 *      block is omitted while the ACP sessions still ran.
 *   4. Real end-to-end sequence — driving the create action against a stateful
 *      ACP mock (spawn → prompt → stop) and a REAL OrchestratorTaskService,
 *      the minted task is NOT falsely promoted to `active` and its
 *      `activeSessionCount` stays 0, because every attached session is already
 *      terminal. This is the regression the stale-status bug produced.
 *
 * These complement `create-task-emits-widget-block.test.ts` (which pins the
 * mint+widget-block contract) and `attach-session.test.ts` (which pins the
 * service-level attach semantics, including the live-session → `active`
 * promotion branch).
 */

import * as os from "node:os";
import type { IAgentRuntime } from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTaskAction } from "../../src/actions/tasks.js";
import { OrchestratorTaskService } from "../../src/services/orchestrator-task-service.js";
import { OrchestratorTaskStore } from "../../src/services/orchestrator-task-store.js";
import {
  callback,
  memory,
  serviceMock,
  state,
} from "../../src/test-utils/action-test-utils.js";

const THREAD_ID = "aaaabbbb-1111-2222-3333-444455556666";

// Force the direct `runPromptAndClose` path (deterministic single-turn) and
// suppress the default-acceptance-criteria auto-verifier so the real service
// used below doesn't fire it — both branches stop the session in `finally`,
// so the stale-status bug is identical on either runner.
const PREV_SMITHERS = process.env.ELIZA_ORCHESTRATOR_SMITHERS;
const PREV_GOAL_CONTRACT = process.env.ELIZA_REQUIRE_GOAL_CONTRACT;
beforeAll(() => {
  process.env.ELIZA_ORCHESTRATOR_SMITHERS = "0";
  process.env.ELIZA_REQUIRE_GOAL_CONTRACT = "0";
});
afterAll(() => {
  if (PREV_SMITHERS === undefined)
    delete process.env.ELIZA_ORCHESTRATOR_SMITHERS;
  else process.env.ELIZA_ORCHESTRATOR_SMITHERS = PREV_SMITHERS;
  if (PREV_GOAL_CONTRACT === undefined)
    delete process.env.ELIZA_REQUIRE_GOAL_CONTRACT;
  else process.env.ELIZA_REQUIRE_GOAL_CONTRACT = PREV_GOAL_CONTRACT;
});

/**
 * Stateful ACP stand-in that models the real create lifecycle the shared
 * `serviceMock` fakes away: `spawnSession` returns a `ready` session,
 * `stopSession` flips its stored status to `stopped`, and `getSession` returns
 * the CURRENT (post-run) status. The create action's attach loop refreshes the
 * status via `getSession`, so this is what lets the test observe the terminal
 * status instead of the stale `ready` snapshot.
 */
function statefulAcp() {
  const sessions = new Map<
    string,
    {
      id: string;
      name: string;
      agentType: string;
      workdir: string;
      status: string;
      metadata?: Record<string, unknown>;
    }
  >();
  let counter = 0;
  return {
    defaultApprovalPreset: "standard",
    spawnSession: vi.fn(async (opts: Record<string, unknown>) => {
      const id = `sess-${++counter}`;
      const record = {
        id,
        name: `agent-${counter}`,
        agentType: (opts.agentType as string) ?? "codex",
        workdir: (opts.workdir as string) ?? "/tmp/acp",
        status: "ready",
        metadata: opts.metadata as Record<string, unknown> | undefined,
      };
      sessions.set(id, record);
      return {
        sessionId: id,
        id,
        name: record.name,
        agentType: record.agentType,
        workdir: record.workdir,
        status: "ready",
        metadata: record.metadata,
      };
    }),
    sendPrompt: vi.fn(async (sid: string) => ({
      sessionId: sid,
      response: "done",
      finalText: "done",
      stopReason: "end_turn",
      durationMs: 7,
    })),
    sendToSession: vi.fn(async (sid: string) => ({
      sessionId: sid,
      response: "done",
      finalText: "done",
      stopReason: "end_turn",
      durationMs: 7,
    })),
    sendKeysToSession: vi.fn(async () => undefined),
    stopSession: vi.fn(async (sid: string) => {
      const record = sessions.get(sid);
      if (record) record.status = "stopped";
    }),
    cancelSession: vi.fn(async () => undefined),
    getSession: vi.fn(async (sid: string) => sessions.get(sid)),
    listSessions: vi.fn(async () => [...sessions.values()]),
    onSessionEvent: vi.fn(() => () => undefined),
    emitSessionEvent: vi.fn(),
    resolveAgentType: vi.fn(async () => "codex"),
  };
}

function runtimeWithServices(opts: {
  acp: ReturnType<typeof serviceMock> | ReturnType<typeof statefulAcp>;
  taskService?:
    | {
        createTask?: (input: unknown) => Promise<unknown>;
        attachSession?: (
          taskId: string,
          input: Record<string, unknown>,
        ) => Promise<boolean>;
      }
    | OrchestratorTaskService;
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
  it("attaches each spawned session with its REAL post-run (terminal) status", async () => {
    // The single-turn create path stops the session (runPromptAndClose's
    // `finally`) BEFORE the thread is minted, so the SpawnResult.status
    // captured at spawn time is a stale `ready`. The attach loop must refresh
    // the true status from the service — passing `ready` would make
    // attachSession falsely promote the task to `active` and count a dead
    // session as live. This uses a stateful ACP mock so `getSession` returns
    // the post-stop status instead of a frozen `ready` snapshot.
    const acp = statefulAcp();
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
    // The session was stopped before mint — the attach status must reflect
    // that terminal reality, not the stale spawn-time `ready`.
    expect(input.status).toBe("stopped");
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

  it("does NOT falsely promote the minted task to active for a single-turn create (real service)", async () => {
    // The regression this whole PR-follow-up fixes: drive the real sequence —
    // spawn → runPromptAndClose (stops the session) → createTask → attachSession
    // — against a REAL OrchestratorTaskService. Because the session is already
    // terminal by attach time, the task must stay `open` with
    // `activeSessionCount === 0`; a stale `ready` status would have promoted it
    // to `active` and counted a dead session as live.
    const acp = statefulAcp();
    const store = new OrchestratorTaskStore({ backend: "memory" });
    const taskService = new OrchestratorTaskService(
      { getService: () => acp, logger: console } as never,
      { store },
    );
    await taskService.start();

    const runtime = runtimeWithServices({ acp, taskService });
    const cb = callback();
    const workdir = os.tmpdir();

    const result = await createTaskAction.handler(
      runtime,
      memory({}),
      state,
      {
        parameters: {
          action: "create",
          title: "Ship widget",
          goal: "Bind chat-spawned sessions to the durable thread",
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
    const taskId = result?.data?.taskId as string;
    expect(typeof taskId).toBe("string");
    expect(taskId.length).toBeGreaterThan(0);

    const detail = await taskService.getTask(taskId);
    expect(detail?.sessionCount).toBe(1);
    // The finished single-turn session is indexed for history/attribution but
    // must NOT be counted as live, and must NOT promote the task.
    expect(detail?.activeSessionCount).toBe(0);
    expect(detail?.status).not.toBe("active");
    expect(detail?.status).toBe("open");
    expect(detail?.sessions[0]?.status).toBe("stopped");
    expect(detail?.sessions[0]?.stoppedAt).toBeTypeOf("number");
  });
});
