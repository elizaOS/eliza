/**
 * #11216 wired control PAUSE to the durable pauseTask (stops sessions, sets
 * paused:true, which freezes advanceTaskStatus) — but the paired
 * resume/continue branch only did a bare ACP session send, so pause was a
 * one-way door from the action surface: no unpause path ever cleared the
 * durable flag. These tests drive the REAL OrchestratorTaskService (in-memory
 * store + fake ACP) through the TASKS control action and pin the symmetry:
 * pause freezes the status state machine, resume/continue unfreezes it, and
 * the plain ACP-send fallback for sessions with no durable task survives.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { tasksAction } from "../../src/actions/tasks.js";
import { OrchestratorTaskService } from "../../src/services/orchestrator-task-service.js";
import { OrchestratorTaskStore } from "../../src/services/orchestrator-task-store.js";
import {
  callback,
  memory,
  state,
} from "../../src/test-utils/action-test-utils.js";

// Same rationale as orchestrator-task-service.test.ts: disable the #8896
// default-criteria contract so criteria-free tasks keep the original
// state-machine behaviour these tests pin.
const PREV_GOAL_CONTRACT = process.env.ELIZA_REQUIRE_GOAL_CONTRACT;
beforeAll(() => {
  process.env.ELIZA_REQUIRE_GOAL_CONTRACT = "0";
});
afterAll(() => {
  if (PREV_GOAL_CONTRACT === undefined)
    delete process.env.ELIZA_REQUIRE_GOAL_CONTRACT;
  else process.env.ELIZA_REQUIRE_GOAL_CONTRACT = PREV_GOAL_CONTRACT;
});

interface LiveSession {
  id: string;
  name: string;
  agentType: string;
  workdir: string;
  status: string;
  createdAt: Date;
  lastActivityAt: Date;
}

/**
 * Fake AcpService serving both consumers: the task service's event bridge /
 * lifecycle calls (onSessionEvent, spawnSession, stopSession) and the control
 * action's session resolution + send path (listSessions, getSession,
 * sendToSession).
 */
class FakeAcp {
  private handler:
    | ((sessionId: string, event: string, data: unknown) => void)
    | null = null;
  private counter = 0;
  live: LiveSession[] = [];
  readonly sent: { sessionId: string; message: string }[] = [];
  readonly stopped: string[] = [];

  onSessionEvent(
    cb: (sessionId: string, event: string, data: unknown) => void,
  ): () => void {
    this.handler = cb;
    return () => {
      this.handler = null;
    };
  }

  emit(sessionId: string, event: string, data: unknown = {}): void {
    this.handler?.(sessionId, event, data);
  }

  spawnSession(opts: Record<string, unknown>): Promise<{
    sessionId: string;
    agentType: string;
    workdir: string;
    status: string;
  }> {
    this.counter += 1;
    return Promise.resolve({
      sessionId: `session-${this.counter}`,
      agentType: (opts.agentType as string | undefined) ?? "codex",
      workdir: (opts.workdir as string | undefined) ?? "/repo",
      status: "ready",
    });
  }

  sendToSession(sessionId: string, message: string): Promise<void> {
    this.sent.push({ sessionId, message });
    return Promise.resolve();
  }

  stopSession(sessionId: string): Promise<void> {
    this.stopped.push(sessionId);
    this.live = this.live.filter((session) => session.id !== sessionId);
    return Promise.resolve();
  }

  listSessions(): LiveSession[] {
    return this.live;
  }

  getSession(id: string): LiveSession | undefined {
    return this.live.find((session) => session.id === id);
  }
}

function liveSession(id: string): LiveSession {
  const now = new Date("2026-07-02T10:00:00.000Z");
  return {
    id,
    name: "agent-one",
    agentType: "codex",
    workdir: "/repo",
    status: "ready",
    createdAt: now,
    lastActivityAt: now,
  };
}

/** Yield a macrotask so the fire-and-forget event handler chain settles. */
const flush = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

async function drive(
  acp: FakeAcp,
  sessionId: string,
  event: string,
  data: unknown = {},
): Promise<void> {
  acp.emit(sessionId, event, data);
  await flush();
}

const opts = (parameters: Record<string, unknown>) => ({ parameters });

/**
 * A real, started OrchestratorTaskService with one task and one spawned
 * session, plus a runtime that resolves the task service by its own
 * serviceType and the fake ACP for everything else (mirrors the live plugin
 * wiring runControl sees).
 */
async function harness(): Promise<{
  acp: FakeAcp;
  runtime: IAgentRuntime;
  taskService: OrchestratorTaskService;
  taskId: string;
  sessionId: string;
}> {
  const acp = new FakeAcp();
  let taskService: OrchestratorTaskService | null = null;
  const runtime = {
    getService: vi.fn((type: string) =>
      type === OrchestratorTaskService.serviceType ? taskService : acp,
    ),
    hasService: vi.fn(() => true),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  } as never as IAgentRuntime;
  const store = new OrchestratorTaskStore({ backend: "memory" });
  taskService = new OrchestratorTaskService(runtime, { store });
  await taskService.start();
  const task = await taskService.createTask({
    title: "Ship feature",
    goal: "Implement and verify",
  });
  const detail = await taskService.spawnAgentForTask(task.id);
  const sessionId = detail?.sessions[0]?.sessionId;
  if (!sessionId) throw new Error("expected a spawned session");
  return { acp, runtime, taskService, taskId: task.id, sessionId };
}

async function control(
  runtime: IAgentRuntime,
  parameters: Record<string, unknown>,
) {
  return tasksAction.handler(
    runtime,
    memory({}),
    state,
    opts(parameters),
    callback(),
  );
}

describe("TASKS control pause/resume symmetry (#11216 follow-up)", () => {
  it("pause freezes the task; resume clears paused and unfreezes advanceTaskStatus", async () => {
    const { acp, runtime, taskService, taskId, sessionId } = await harness();

    const paused = await control(runtime, {
      action: "control",
      controlAction: "pause",
      taskId,
    });
    expect(paused?.success).toBe(true);
    expect((await taskService.getTask(taskId))?.paused).toBe(true);

    // Frozen: session events cannot advance the durable status while paused.
    await drive(acp, sessionId, "blocked", { message: "stuck" });
    expect((await taskService.getTask(taskId))?.status).not.toBe("blocked");

    const resumed = await control(runtime, {
      action: "control",
      controlAction: "resume",
      taskId,
    });
    expect(resumed?.success).toBe(true);
    expect((await taskService.getTask(taskId))?.paused).toBe(false);

    // Unfrozen: the same event now advances the task status.
    await drive(acp, sessionId, "blocked", { message: "stuck" });
    expect((await taskService.getTask(taskId))?.status).toBe("blocked");
  });

  it("continue also clears the durable paused flag when no live session remains", async () => {
    const { runtime, taskService, taskId } = await harness();

    await control(runtime, {
      action: "control",
      controlAction: "pause",
      taskId,
    });
    expect((await taskService.getTask(taskId))?.paused).toBe(true);

    const result = await control(runtime, {
      action: "control",
      controlAction: "continue",
      taskId,
    });
    expect(result?.success).toBe(true);
    expect(result?.text).toContain(`Resumed coding task ${taskId}`);
    expect((await taskService.getTask(taskId))?.paused).toBe(false);
  });

  it("resume with a taskId and a live session clears paused AND still sends the follow-up", async () => {
    const { acp, runtime, taskService, taskId } = await harness();

    await control(runtime, {
      action: "control",
      controlAction: "pause",
      taskId,
    });
    acp.live = [liveSession("live-1")];
    const sentBefore = acp.sent.length;

    const result = await control(runtime, {
      action: "control",
      controlAction: "resume",
      taskId,
      instruction: "pick the work back up",
    });
    expect(result?.success).toBe(true);
    expect((await taskService.getTask(taskId))?.paused).toBe(false);
    expect(acp.sent.length).toBe(sentBefore + 1);
    expect(acp.sent.at(-1)).toEqual({
      sessionId: "live-1",
      message: "pick the work back up",
    });
  });

  it("resume without a taskId keeps the plain ACP-send fallback (no durable task touched)", async () => {
    const { acp, runtime, taskService } = await harness();
    const resumeSpy = vi.spyOn(taskService, "resumeTask");
    acp.live = [liveSession("live-2")];
    const sentBefore = acp.sent.length;

    const result = await control(runtime, {
      action: "control",
      controlAction: "resume",
      instruction: "keep going",
    });
    expect(result?.success).toBe(true);
    expect(resumeSpy).not.toHaveBeenCalled();
    expect(acp.sent.length).toBe(sentBefore + 1);
    expect(acp.sent.at(-1)).toEqual({
      sessionId: "live-2",
      message: "keep going",
    });
  });

  it("reopen clears a paused flag left by pause-then-archive", async () => {
    const { runtime, taskService, taskId } = await harness();

    await control(runtime, {
      action: "control",
      controlAction: "pause",
      taskId,
    });
    await control(runtime, { action: "archive", taskId });
    expect((await taskService.getTask(taskId))?.paused).toBe(true);

    const result = await control(runtime, { action: "reopen", taskId });
    expect(result?.success).toBe(true);
    const detail = await taskService.getTask(taskId);
    expect(detail?.paused).toBe(false);
    expect(detail?.status).toBe("active");
  });
});

describe("TASKS control is structural — no regex over message text (#11028)", () => {
  // The planner emits `controlAction` when the user asks to pause/stop/resume;
  // the orchestrator no longer scans the message text for control phrasings.
  // "let's stop using axios" or "make it so" in ordinary prose must not
  // stop/resume a running session.
  it("does not infer stop from message text without a structured controlAction", async () => {
    const { acp, runtime } = await harness();
    acp.live = [liveSession("live-3")];

    const result = await tasksAction.handler(
      runtime,
      memory({ text: "let's stop using axios and switch to fetch" }),
      state,
      opts({ action: "control" }),
      callback(),
    );

    expect(result?.success).toBe(false);
    expect(result?.text).toContain("No task-control action was specified");
    expect(acp.stopped).toEqual([]);
  });

  it("does not infer resume from slang in message text", async () => {
    const { acp, runtime } = await harness();
    acp.live = [liveSession("live-4")];
    const sentBefore = acp.sent.length;

    const result = await tasksAction.handler(
      runtime,
      memory({ text: "make it so — do it, yeah i'm down" }),
      state,
      opts({ action: "control" }),
      callback(),
    );

    expect(result?.success).toBe(false);
    expect(acp.sent.length).toBe(sentBefore);
  });

  it("still honors the structured controlAction param", async () => {
    const { acp, runtime } = await harness();
    acp.live = [liveSession("live-5")];

    const result = await tasksAction.handler(
      runtime,
      memory({ text: "nothing control-like in this text" }),
      state,
      opts({ action: "control", controlAction: "stop", sessionId: "live-5" }),
      callback(),
    );

    expect(result?.success).toBe(true);
    expect(acp.stopped).toEqual(["live-5"]);
  });
});
