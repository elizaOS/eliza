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
 *      the create action assembled, and the session's pre-prompt status. The
 *      attach must happen before the prompt so a crash cannot leave unowned
 *      Smithers work; later lifecycle events transition that same row.
 *   2. Direct-runner attach failure is soft — attachSession throwing is
 *      logged, but the action still returns `success: true` with the widget.
 *   3. Direct-runner thread-mint failure is clean — when createTask throws,
 *      the action does not try to attach, omits the widget, and still runs ACP.
 *      Smithers fail-fast coverage lives in the widget-emission suite because
 *      this file intentionally disables Smithers for deterministic lifecycle
 *      assertions.
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
  let eventHandler:
    | ((sessionId: string, event: string, data: unknown) => void)
    | undefined;
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
      eventHandler?.(sid, "stopped", { sessionId: sid });
    }),
    cancelSession: vi.fn(async () => undefined),
    getSession: vi.fn(async (sid: string) => sessions.get(sid)),
    getChangedPaths: vi.fn(() => []),
    // Residuals gate: these one-shot sessions scaffold no owned artifacts.
    getOrchestratorOwnedArtifacts: vi.fn(() => []),
    listSessions: vi.fn(async () => [...sessions.values()]),
    onSessionEvent: vi.fn(
      (handler: (sessionId: string, event: string, data: unknown) => void) => {
        eventHandler = handler;
        return () => {
          eventHandler = undefined;
        };
      },
    ),
    emitSessionEvent: vi.fn(
      (sessionId: string, event: string, data: unknown) => {
        eventHandler?.(sessionId, event, data);
      },
    ),
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
    getSetting: vi.fn(() => undefined),
  } as never;
}

describe("TASKS:create attaches spawned sessions to the minted task thread", () => {
  it("attaches each spawned session before its first prompt", async () => {
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
          timeout_ms: 30_000,
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
    expect(attachSession.mock.invocationCallOrder[0]).toBeLessThan(
      acp.sendPrompt.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(input.model).toBe("gpt-5.5");
    // The per-part label the create action assigned rides through.
    expect(typeof input.label).toBe("string");
    expect((input.label as string).length).toBeGreaterThan(0);
  });

  it("still returns success (with the widget) when attachSession throws", async () => {
    // The explicitly selected direct runner has no durable graph to orphan, so
    // optional widget bookkeeping may fail without suppressing useful ACP work.
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
          timeout_ms: 30_000,
        },
      },
      cb,
    );

    expect(result?.success).toBe(true);
    expect(result?.text).toContain(`[TASK:${THREAD_ID}]`);
    expect(attachSession).toHaveBeenCalledTimes(1);
  });

  it("does not attempt to attach when thread-mint fails (no taskId)", async () => {
    // The direct runner has no durable graph to recover: no taskId means no
    // attach call, while the ACP work still runs without a widget.
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
          timeout_ms: 30_000,
        },
      },
      cb,
    );

    expect(result?.success).toBe(true);
    expect(result?.data?.taskId).toBeNull();
    expect(attachSession).not.toHaveBeenCalled();
  });

  // 20s test cap to match the 15s inner waitFor below — the real git
  // change-set capture + evidence assembly sit right at the 5s default on
  // loaded runners.
  it("does NOT falsely promote the minted task to active for a single-turn create (real service)", {
    timeout: 20_000,
  }, async () => {
    // Drive the real sequence — task mint → spawn → attach → prompt → stopped
    // event — against a REAL OrchestratorTaskService. The early attach makes
    // the work recoverable, while the terminal event still has to clear the
    // live-session count when the one-shot turn closes.
    const acp = statefulAcp();
    const store = new OrchestratorTaskStore({ backend: "memory" });
    const taskService = new OrchestratorTaskService(
      {
        getService: () => acp,
        logger: console,
        // The completion pipeline reads verification settings through
        // runtime.getSetting; a bare fake without it dies mid-validation.
        getSetting: () => undefined,
      } as never,
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
          timeout_ms: 30_000,
        },
      },
      cb,
    );

    expect(result?.success).toBe(true);
    const taskId = result?.data?.taskId as string;
    expect(typeof taskId).toBe("string");
    expect(taskId.length).toBeGreaterThan(0);

    // The task_complete bridge does real work (change-set capture via git
    // subprocesses, completion-evidence assembly) before promoting to
    // `validating`; the default 1s waitFor bound flakes on loaded runners.
    await vi.waitFor(
      async () => {
        expect((await taskService.getTask(taskId))?.status).toBe("validating");
      },
      { timeout: 15_000, interval: 250 },
    );
    const detail = await taskService.getTask(taskId);
    expect(detail?.sessionCount).toBe(1);
    // The finished single-turn session is indexed for history/attribution but
    // is no longer live. Its task_complete event advances the durable task to
    // validating, the same state the real ACP terminal event produces.
    expect(detail?.activeSessionCount).toBe(0);
    expect(detail?.status).not.toBe("active");
    expect(detail?.status).toBe("validating");
    expect(detail?.sessions[0]?.status).toBe("stopped");
    expect(detail?.sessions[0]?.stoppedAt).toBeTypeOf("number");
  });
});
