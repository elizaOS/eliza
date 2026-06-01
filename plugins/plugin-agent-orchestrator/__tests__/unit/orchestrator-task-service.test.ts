/**
 * {@link OrchestratorTaskService} is the orchestration brain: it owns the task
 * lifecycle the `/api/orchestrator/*` routes expose and bridges ephemeral ACP
 * sub-agent session events onto the durable store. This test pins that
 * behaviour against an in-memory store and a fake ACP that lets us drive
 * session events deterministically:
 *
 *  - lifecycle (create / update / pause / resume / archive / reopen / delete /
 *    fork / validate / messages),
 *  - the session→task status state machine (including the guards that stop a
 *    weak `active` signal from stomping `blocked`/`validating`/terminal/paused),
 *  - usage telemetry roll-up and per-turn dedup,
 *  - cross-task status aggregation and bulk pause/resume.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { OrchestratorTaskService } from "../../src/services/orchestrator-task-service.js";
import { OrchestratorTaskStore } from "../../src/services/orchestrator-task-store.js";
import type { CreateTaskInput } from "../../src/services/orchestrator-task-types.js";

interface SpawnResult {
  sessionId: string;
  agentType: string;
  workdir: string;
  status: string;
}

/**
 * Minimal stand-in for {@link AcpService}. Captures the orchestrator's event
 * subscription so a test can drive session events through the real bridge, and
 * records the spawn / relay / stop calls the lifecycle methods make.
 */
class FakeAcp {
  private handler:
    | ((sessionId: string, event: string, data: unknown) => void)
    | null = null;
  private counter = 0;
  readonly spawnArgs: Record<string, unknown>[] = [];
  readonly sent: { sessionId: string; message: string }[] = [];
  readonly stopped: string[] = [];
  failSend = false;
  failStop = false;

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

  spawnSession(opts: Record<string, unknown>): Promise<SpawnResult> {
    this.spawnArgs.push(opts);
    this.counter += 1;
    return Promise.resolve({
      sessionId: `session-${this.counter}`,
      agentType: (opts.agentType as string | undefined) ?? "codex",
      workdir: (opts.workdir as string | undefined) ?? "/repo",
      status: "ready",
    });
  }

  sendToSession(sessionId: string, message: string): Promise<void> {
    if (this.failSend) return Promise.reject(new Error("send failed"));
    this.sent.push({ sessionId, message });
    return Promise.resolve();
  }

  stopSession(sessionId: string): Promise<void> {
    if (this.failStop) return Promise.reject(new Error("stop failed"));
    this.stopped.push(sessionId);
    return Promise.resolve();
  }
}

function runtime(acp?: FakeAcp): IAgentRuntime {
  return {
    getService: () => acp ?? null,
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  } as never;
}

function makeService(acp?: FakeAcp): OrchestratorTaskService {
  return new OrchestratorTaskService(runtime(acp), {
    store: new OrchestratorTaskStore({ backend: "memory" }),
  });
}

function createInput(
  overrides: Partial<CreateTaskInput> = {},
): CreateTaskInput {
  return { title: "Ship feature", goal: "Implement and verify", ...overrides };
}

function must<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}

/** Yield a macrotask so the fire-and-forget event handler chain (all in-memory
 * microtasks) fully settles before assertions. */
const flush = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

/** Emit a session event through the captured subscription and wait for it. */
async function drive(
  acp: FakeAcp,
  sessionId: string,
  event: string,
  data: unknown = {},
): Promise<void> {
  acp.emit(sessionId, event, data);
  await flush();
}

/** A started service with one task and one spawned (ready) session, plus the
 * fake ACP wired to its event bridge. */
async function withSpawnedSession(): Promise<{
  service: OrchestratorTaskService;
  acp: FakeAcp;
  taskId: string;
  sessionId: string;
}> {
  const acp = new FakeAcp();
  const service = makeService(acp);
  await service.start();
  const task = await service.createTask(createInput());
  const detail = must(
    await service.spawnAgentForTask(task.id),
    "expected spawn detail",
  );
  const sessionId = must(detail.sessions[0], "expected session").sessionId;
  return { service, acp, taskId: task.id, sessionId };
}

/** Like {@link withSpawnedSession} but the spawn carries an explicit
 * human-provided label, exercising the "keep the user's choice" precedence. */
async function withSpawnedSessionLabel(label: string): Promise<{
  service: OrchestratorTaskService;
  acp: FakeAcp;
  taskId: string;
  sessionId: string;
}> {
  const acp = new FakeAcp();
  const service = makeService(acp);
  await service.start();
  const task = await service.createTask(createInput());
  const detail = must(
    await service.spawnAgentForTask(task.id, { label }),
    "expected spawn detail",
  );
  const sessionId = must(detail.sessions[0], "expected session").sessionId;
  return { service, acp, taskId: task.id, sessionId };
}

describe("OrchestratorTaskService — sub-agent naming", () => {
  it("gives a spawned session a non-empty person-name label", async () => {
    const { service, taskId } = await withSpawnedSession();
    const session = must(
      (await service.getTask(taskId))?.sessions[0],
      "session",
    );
    expect(session.label.length).toBeGreaterThan(0);
    // Not the generic "<framework> agent" descriptor any more.
    expect(session.label).not.toMatch(/ agent$/);
  });

  it("weaves the assigned name into the spawned goal prompt", async () => {
    const { service, acp, taskId } = await withSpawnedSession();
    const session = must(
      (await service.getTask(taskId))?.sessions[0],
      "session",
    );
    const initialTask = must(acp.spawnArgs[0], "spawn args").initialTask;
    expect(typeof initialTask).toBe("string");
    expect(initialTask as string).toContain(`You are ${session.label},`);
  });

  it("assigns distinct names to two concurrent sub-agents on one task", async () => {
    const acp = new FakeAcp();
    const service = makeService(acp);
    await service.start();
    const task = await service.createTask(createInput());
    await service.spawnAgentForTask(task.id);
    await service.spawnAgentForTask(task.id);
    const sessions = must(await service.getTask(task.id), "detail").sessions;
    expect(sessions).toHaveLength(2);
    const [first, second] = sessions;
    expect(must(first, "first").label.length).toBeGreaterThan(0);
    expect(must(second, "second").label.length).toBeGreaterThan(0);
    expect(must(first, "first").label).not.toBe(must(second, "second").label);
  });

  it("keeps an explicit caller label instead of assigning a pooled name", async () => {
    const { service, acp, taskId } =
      await withSpawnedSessionLabel("Release Captain");
    const session = must(
      (await service.getTask(taskId))?.sessions[0],
      "session",
    );
    expect(session.label).toBe("Release Captain");
    const initialTask = must(acp.spawnArgs[0], "spawn args").initialTask;
    expect(typeof initialTask).toBe("string");
    expect(initialTask as string).toContain("You are Release Captain,");
  });
});

describe("OrchestratorTaskService — lifecycle", () => {
  it("creates a task and defaults originalRequest to the goal without an extra message", async () => {
    const service = makeService();
    const detail = await service.createTask(
      createInput({ goal: "Build the widget" }),
    );
    expect(detail.status).toBe("open");
    expect(detail.originalRequest).toBe("Build the widget");
    expect(detail.messages).toHaveLength(0);
  });

  it("records the original request as a user turn when one is supplied", async () => {
    const service = makeService();
    const detail = await service.createTask(
      createInput({ originalRequest: "please build it" }),
    );
    expect(detail.messages).toHaveLength(1);
    const message = must(detail.messages[0], "message");
    expect(message.senderKind).toBe("user");
    expect(message.direction).toBe("stdin");
    expect(message.content).toBe("please build it");
  });

  it("lists created tasks and fetches a single detail, null for misses", async () => {
    const service = makeService();
    const a = await service.createTask(createInput({ title: "a" }));
    await service.createTask(createInput({ title: "b" }));
    const list = await service.listTasks();
    expect(list.map((t) => t.title).sort()).toEqual(["a", "b"]);
    expect(must(await service.getTask(a.id), "detail").id).toBe(a.id);
    expect(await service.getTask("missing")).toBeNull();
  });

  it("updates editable task fields and returns null for a missing task", async () => {
    const service = makeService();
    const { id } = await service.createTask(createInput());
    const updated = must(
      await service.updateTask(id, {
        priority: "urgent",
        acceptanceCriteria: ["ci green"],
      }),
      "updated",
    );
    expect(updated.priority).toBe("urgent");
    expect(updated.acceptanceCriteria).toEqual(["ci green"]);
    const preserved = must(
      await service.updateTask(id, {
        title: undefined,
        goal: undefined,
        summary: "real update",
      }),
      "preserved",
    );
    expect(preserved.title).toBe("Ship feature");
    expect(preserved.goal).toBe("Implement and verify");
    expect(preserved.summary).toBe("real update");
    expect(await service.updateTask("missing", { priority: "low" })).toBeNull();
  });

  it("pause stops live sessions and flags paused; resume clears it", async () => {
    const { service, acp, taskId, sessionId } = await withSpawnedSession();
    const paused = must(await service.pauseTask(taskId), "paused");
    expect(paused.paused).toBe(true);
    expect(acp.stopped).toContain(sessionId);
    expect(must(paused.sessions[0], "session").status).toBe("stopped");

    const resumed = must(await service.resumeTask(taskId), "resumed");
    expect(resumed.paused).toBe(false);
    expect(await service.pauseTask("missing")).toBeNull();
    expect(await service.resumeTask("missing")).toBeNull();
  });

  it("archives a task (stopping sessions) and reopens it to active when sessions remain", async () => {
    const { service, acp, taskId, sessionId } = await withSpawnedSession();
    const archived = must(await service.archiveTask(taskId), "archived");
    expect(archived.status).toBe("archived");
    expect(archived.archivedAt).toBeTruthy();
    expect(acp.stopped).toContain(sessionId);

    const reopened = must(await service.reopenTask(taskId), "reopened");
    expect(reopened.status).toBe("active");
    expect(reopened.archivedAt).toBeNull();
  });

  it("reopens a session-less task to open", async () => {
    const service = makeService();
    const { id } = await service.createTask(createInput());
    await service.archiveTask(id);
    const reopened = must(await service.reopenTask(id), "reopened");
    expect(reopened.status).toBe("open");
  });

  it("deletes a task and reports whether it existed", async () => {
    const service = makeService();
    const { id } = await service.createTask(createInput());
    expect(await service.deleteTask(id)).toBe(true);
    expect(await service.getTask(id)).toBeNull();
    expect(await service.deleteTask("missing")).toBe(false);
  });

  it("forks a task, copying the goal/criteria and linking the parent", async () => {
    const service = makeService();
    const parent = await service.createTask(
      createInput({ title: "Origin", acceptanceCriteria: ["a", "b"] }),
    );
    const fork = must(await service.forkTask(parent.id), "fork");
    expect(fork.id).not.toBe(parent.id);
    expect(fork.title).toBe("Origin (fork)");
    expect(fork.goal).toBe(parent.goal);
    expect(fork.acceptanceCriteria).toEqual(["a", "b"]);
    expect(fork.parentTaskId).toBe(parent.id);
    expect(await service.forkTask("missing")).toBeNull();
  });

  it("validates a task to done on pass and back to active on failure", async () => {
    const service = makeService();
    const passed = await service.createTask(createInput());
    await service.updateTask(passed.id, { status: "validating" });
    const done = must(
      await service.validateTask(passed.id, {
        passed: true,
        summary: "all green",
      }),
      "done",
    );
    expect(done.status).toBe("done");
    expect(done.summary).toBe("all green");
    expect(done.closedAt).toBeTruthy();

    const failing = await service.createTask(createInput());
    await service.updateTask(failing.id, { status: "validating" });
    const reverted = must(
      await service.validateTask(failing.id, {
        passed: false,
        summary: "needs another pass",
      }),
      "reverted",
    );
    expect(reverted.status).toBe("active");
    await expect(
      service.validateTask(passed.id, { passed: true, summary: "again" }),
    ).rejects.toThrow(/validating/);
    expect(
      await service.validateTask("missing", {
        passed: true,
        summary: "not found",
      }),
    ).toBeNull();
  });

  it("adds a user message and stamps the last user turn", async () => {
    const service = makeService();
    const { id } = await service.createTask(createInput());
    expect(
      await service.addMessage(id, {
        content: "ping",
        senderKind: "user",
        direction: "stdin",
      }),
    ).toBe(true);
    const detail = must(await service.getTask(id), "detail");
    expect(detail.messages.map((m) => m.content)).toContain("ping");
    expect(detail.lastUserTurnAt).toBeTruthy();
    expect(
      await service.addMessage("missing", {
        content: "x",
        senderKind: "user",
      }),
    ).toBe(false);
  });

  it("reports room message delivery failures instead of claiming success", async () => {
    const acp = new FakeAcp();
    const service = makeService(acp);
    await service.start();
    const task = await service.createTask(createInput());
    await service.spawnAgentForTask(task.id);
    acp.failSend = true;

    const result = must(
      await service.postUserMessage(task.id, "please continue"),
      "result",
    );

    expect(result.forwardedTo).toEqual([]);
    expect(result.failedTo).toHaveLength(1);
    expect((await service.getTask(task.id))?.sessions[0]?.status).toBe(
      "send_failed",
    );
  });

  it("relays a posted user message to every live session as a goal-wrapped follow-up", async () => {
    const { service, acp, taskId, sessionId } = await withSpawnedSession();
    const result = must(
      await service.postUserMessage(taskId, "tweak the header"),
      "post",
    );
    expect(result.recorded).toBe(true);
    expect(result.forwardedTo).toEqual([sessionId]);
    const relayed = must(acp.sent[0], "relayed");
    expect(relayed.sessionId).toBe(sessionId);
    expect(relayed.message).toContain("tweak the header");
    expect(await service.postUserMessage("missing", "x")).toBeNull();
  });

  it("auto-spawns a coding agent when a message is posted with no session live", async () => {
    const acp = new FakeAcp();
    const service = makeService(acp);
    const { id } = await service.createTask(createInput());
    const result = must(await service.postUserMessage(id, "hello"), "post");
    // Parity: messaging a task with no live agent "just works" — it spawns one
    // (the default vendored opencode backend) to act on the message, rather than
    // silently recording it with nowhere to go.
    expect(result.forwardedTo).toEqual(["auto-spawned"]);
    expect(acp.spawnArgs).toHaveLength(1);
    expect(acp.sent).toHaveLength(0);
  });

  it("paginates messages with a limit and cursor", async () => {
    const service = makeService();
    const { id } = await service.createTask(createInput());
    await service.addMessage(id, { content: "one", senderKind: "user" });
    await service.addMessage(id, { content: "two", senderKind: "user" });
    const all = await service.listMessages(id);
    expect(all.items).toHaveLength(2);
    expect(all.nextCursor).toBeNull();
    const firstPage = await service.listMessages(id, { limit: 1 });
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.nextCursor).toBe("1");
    expect((await service.listMessages("missing")).items).toEqual([]);
  });
});

describe("OrchestratorTaskService — event bridge session status", () => {
  it("marks the task active on spawn", async () => {
    const { service, taskId } = await withSpawnedSession();
    expect(must(await service.getTask(taskId), "detail").status).toBe("active");
  });

  it("records tool activity", async () => {
    const { service, acp, taskId, sessionId } = await withSpawnedSession();
    await drive(acp, sessionId, "tool_running", {
      toolCall: { title: "edit" },
    });
    const session = must(
      (await service.getTask(taskId))?.sessions[0],
      "session",
    );
    expect(session.status).toBe("tool_running");
    expect(session.activeTool).toBe("edit");
  });

  it("blocks the session on blocked and login_required", async () => {
    const a = await withSpawnedSession();
    await drive(a.acp, a.sessionId, "blocked", { message: "need input" });
    expect(
      must((await a.service.getTask(a.taskId))?.sessions[0], "s").status,
    ).toBe("blocked");

    const b = await withSpawnedSession();
    await drive(b.acp, b.sessionId, "login_required");
    expect(
      must((await b.service.getTask(b.taskId))?.sessions[0], "s").status,
    ).toBe("blocked");
  });

  it("completes the session and captures the delivery summary on task_complete", async () => {
    const { service, acp, taskId, sessionId } = await withSpawnedSession();
    await drive(acp, sessionId, "task_complete", { response: "shipped it" });
    const session = must(
      (await service.getTask(taskId))?.sessions[0],
      "session",
    );
    expect(session.status).toBe("completed");
    expect(session.taskDelivered).toBe(true);
    expect(session.completionSummary).toBe("shipped it");
    expect(session.stoppedAt).toBeTruthy();
  });

  it("marks the session errored or stopped on those events", async () => {
    const a = await withSpawnedSession();
    await drive(a.acp, a.sessionId, "error", { message: "boom" });
    expect(
      must((await a.service.getTask(a.taskId))?.sessions[0], "s").status,
    ).toBe("errored");

    const b = await withSpawnedSession();
    await drive(b.acp, b.sessionId, "stopped");
    expect(
      must((await b.service.getTask(b.taskId))?.sessions[0], "s").status,
    ).toBe("stopped");
  });

  it("records a sub-agent message as stdout in the task room", async () => {
    const { service, acp, taskId, sessionId } = await withSpawnedSession();
    await drive(acp, sessionId, "message", { text: "making progress" });
    const message = must(
      (await service.getTask(taskId))?.messages.find(
        (m) => m.content === "making progress",
      ),
      "message",
    );
    expect(message.senderKind).toBe("sub_agent");
    expect(message.direction).toBe("stdout");
  });

  it("appends a human-readable event row for each session event", async () => {
    const { service, acp, taskId, sessionId } = await withSpawnedSession();
    await drive(acp, sessionId, "ready");
    const event = must(
      (await service.getTask(taskId))?.events.find(
        (e) => e.eventType === "ready",
      ),
      "event",
    );
    expect(event.summary).toBe("Sub-agent ready");
  });

  it("ignores events for sessions it does not own", async () => {
    const { service, acp, taskId } = await withSpawnedSession();
    const before = must(await service.getTask(taskId), "before").events.length;
    await drive(acp, "ghost-session", "tool_running");
    expect(must(await service.getTask(taskId), "after").events.length).toBe(
      before,
    );
  });
});

describe("OrchestratorTaskService — task status guards", () => {
  it("moves the task to validating on completion, never straight to done", async () => {
    const { service, acp, taskId, sessionId } = await withSpawnedSession();
    await drive(acp, sessionId, "task_complete", { response: "done" });
    expect(must(await service.getTask(taskId), "detail").status).toBe(
      "validating",
    );
  });

  it("routes blocked and login_required to the right task status", async () => {
    const a = await withSpawnedSession();
    await drive(a.acp, a.sessionId, "blocked", { message: "x" });
    expect(must(await a.service.getTask(a.taskId), "d").status).toBe("blocked");

    const b = await withSpawnedSession();
    await drive(b.acp, b.sessionId, "login_required");
    expect(must(await b.service.getTask(b.taskId), "d").status).toBe(
      "waiting_on_user",
    );
  });

  it("does not let a later active signal stomp blocked", async () => {
    const { service, acp, taskId, sessionId } = await withSpawnedSession();
    await drive(acp, sessionId, "blocked", { message: "x" });
    await drive(acp, sessionId, "tool_running", { toolCall: { title: "ls" } });
    expect(must(await service.getTask(taskId), "detail").status).toBe(
      "blocked",
    );
  });

  it("does not let a later active signal stomp validating", async () => {
    const { service, acp, taskId, sessionId } = await withSpawnedSession();
    await drive(acp, sessionId, "task_complete", { response: "done" });
    await drive(acp, sessionId, "tool_running", { toolCall: { title: "ls" } });
    expect(must(await service.getTask(taskId), "detail").status).toBe(
      "validating",
    );
  });

  it("never mutates a terminal task from a session event", async () => {
    const { service, acp, taskId, sessionId } = await withSpawnedSession();
    await drive(acp, sessionId, "task_complete", { response: "done" });
    await service.validateTask(taskId, { passed: true, summary: "verified" });
    await drive(acp, sessionId, "tool_running", { toolCall: { title: "ls" } });
    expect(must(await service.getTask(taskId), "detail").status).toBe("done");
  });

  it("never advances a paused task", async () => {
    const { service, acp, taskId, sessionId } = await withSpawnedSession();
    await service.pauseTask(taskId);
    await drive(acp, sessionId, "blocked", { message: "x" });
    expect(must(await service.getTask(taskId), "detail").status).not.toBe(
      "blocked",
    );
  });

  it("does not mark a session stopped when ACP stop fails", async () => {
    const acp = new FakeAcp();
    const service = makeService(acp);
    await service.start();
    const task = await service.createTask(createInput());
    await service.spawnAgentForTask(task.id);
    const sessionId = must(
      (await service.getTask(task.id))?.sessions[0]?.sessionId,
      "session",
    );
    acp.failStop = true;

    await expect(service.stopTaskAgent(task.id, sessionId)).rejects.toThrow(
      /stop failed/,
    );
    expect((await service.getTask(task.id))?.sessions[0]?.status).toBe(
      "stop_failed",
    );
  });
});

describe("OrchestratorTaskService — usage telemetry", () => {
  const frame = {
    provider: "anthropic",
    model: "claude-opus-4-7",
    inputTokens: 100,
    outputTokens: 50,
    reasoningTokens: 10,
    cacheTokens: 5,
    costUsd: 0.12,
    state: "measured",
  };

  it("records a usage frame and rolls it into the session totals", async () => {
    const { service, acp, taskId, sessionId } = await withSpawnedSession();
    await drive(acp, sessionId, "usage_update", { ...frame });
    const usage = must(await service.getUsage(taskId), "usage");
    expect(usage.totalTokens).toBe(160);
    expect(usage.costUsd).toBeCloseTo(0.12);
    expect(usage.state).toBe("measured");
    expect(usage.byProvider).toHaveLength(1);
    const session = must(
      (await service.getTask(taskId))?.sessions[0],
      "session",
    );
    expect(session.inputTokens).toBe(100);
    expect(session.usageState).toBe("measured");
  });

  it("dedups replayed frames by sourceEventId", async () => {
    const { service, acp, taskId, sessionId } = await withSpawnedSession();
    await drive(acp, sessionId, "usage_update", {
      ...frame,
      sourceEventId: "turn-1",
    });
    await drive(acp, sessionId, "usage_update", {
      ...frame,
      sourceEventId: "turn-1",
    });
    expect(must(await service.getUsage(taskId), "usage").inputTokens).toBe(100);
    await drive(acp, sessionId, "usage_update", {
      ...frame,
      sourceEventId: "turn-2",
    });
    expect(must(await service.getUsage(taskId), "usage").inputTokens).toBe(200);
  });

  it("fills the provider from the session when the frame omits it", async () => {
    const { service, acp, taskId, sessionId } = await withSpawnedSession();
    await drive(acp, sessionId, "usage_update", {
      inputTokens: 10,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheTokens: 0,
    });
    const usage = must(await service.getUsage(taskId), "usage");
    // The default spawn framework is the vendored opencode backend, so a
    // usage frame that omits its provider is attributed to that session.
    expect(must(usage.byProvider[0], "provider").provider).toBe("opencode");
  });

  it("ignores empty usage frames", async () => {
    const { service, acp, taskId, sessionId } = await withSpawnedSession();
    await drive(acp, sessionId, "usage_update", {});
    const usage = must(await service.getUsage(taskId), "usage");
    expect(usage.totalTokens).toBe(0);
    expect(usage.byProvider).toEqual([]);
  });
});

describe("OrchestratorTaskService — aggregation and bulk controls", () => {
  it("reports an empty status with no tasks", async () => {
    const status = await makeService().getStatus();
    expect(status.taskCount).toBe(0);
    expect(status.activeTaskCount).toBe(0);
    expect(status.sessionCount).toBe(0);
    expect(status.usage.state).toBe("unavailable");
    expect(status.usage.byProvider).toEqual([]);
  });

  it("aggregates task and session counts by status", async () => {
    const acp = new FakeAcp();
    const service = makeService(acp);
    await service.start();

    const active = await service.createTask(createInput({ title: "active" }));
    await service.spawnAgentForTask(active.id);

    const blocked = await service.createTask(createInput({ title: "blocked" }));
    const blockedDetail = must(
      await service.spawnAgentForTask(blocked.id),
      "blocked",
    );
    await drive(
      acp,
      must(blockedDetail.sessions[0], "s").sessionId,
      "blocked",
      { message: "x" },
    );

    const finished = await service.createTask(createInput({ title: "done" }));
    await service.updateTask(finished.id, { status: "validating" });
    await service.validateTask(finished.id, {
      passed: true,
      summary: "verified",
    });

    const status = await service.getStatus();
    expect(status.taskCount).toBe(3);
    expect(status.byStatus.active).toBe(1);
    expect(status.byStatus.blocked).toBe(1);
    expect(status.byStatus.done).toBe(1);
    expect(status.blockedTaskCount).toBe(1);
    expect(status.sessionCount).toBe(2);
    expect(status.activeSessionCount).toBe(2);
  });

  it("pauses every live task and resumes every paused one", async () => {
    const acp = new FakeAcp();
    const service = makeService(acp);
    await service.start();
    const a = await service.createTask(createInput({ title: "a" }));
    await service.spawnAgentForTask(a.id);
    const b = await service.createTask(createInput({ title: "b" }));
    await service.spawnAgentForTask(b.id);
    const done = await service.createTask(createInput({ title: "done" }));
    await service.updateTask(done.id, { status: "validating" });
    await service.validateTask(done.id, { passed: true, summary: "verified" });

    expect(await service.pauseAll()).toBe(2);
    expect((await service.getStatus()).pausedTaskCount).toBe(2);
    expect(await service.resumeAll()).toBe(2);
    expect((await service.getStatus()).pausedTaskCount).toBe(0);
  });
});
