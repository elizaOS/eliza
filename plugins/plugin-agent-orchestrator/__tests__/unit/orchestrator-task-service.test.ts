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
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { OrchestratorTaskService } from "../../src/services/orchestrator-task-service.js";
import { OrchestratorTaskStore } from "../../src/services/orchestrator-task-store.js";
import {
  type CreateTaskInput,
  type OrchestratorTaskSession,
  TERMINAL_TASK_STATUSES,
} from "../../src/services/orchestrator-task-types.js";

// This suite pins the status state machine and the ACP→task event bridge — NOT
// the #8896 default-criteria feature. createTask now auto-populates acceptance
// criteria for criteria-free, non-trivial goals (which would make these tasks
// auto-verify on `task_complete` instead of parking in `validating`). Disable
// the goal contract here so these tests exercise the original criteria-free
// behavior; the default-criteria feature has its own dedicated suites
// (acceptance-criteria.test.ts, create-task-default-criteria.test.ts).
const PREV_GOAL_CONTRACT = process.env.ELIZA_REQUIRE_GOAL_CONTRACT;
beforeAll(() => {
  process.env.ELIZA_REQUIRE_GOAL_CONTRACT = "0";
});
afterAll(() => {
  if (PREV_GOAL_CONTRACT === undefined)
    delete process.env.ELIZA_REQUIRE_GOAL_CONTRACT;
  else process.env.ELIZA_REQUIRE_GOAL_CONTRACT = PREV_GOAL_CONTRACT;
});

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
  failSpawn = false;

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
    if (this.failSpawn) return Promise.reject(new Error("spawn failed"));
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

function makeServiceWithStore(acp?: FakeAcp): {
  service: OrchestratorTaskService;
  store: OrchestratorTaskStore;
} {
  const store = new OrchestratorTaskStore({ backend: "memory" });
  return {
    service: new OrchestratorTaskService(runtime(acp), { store }),
    store,
  };
}

function makeService(acp?: FakeAcp): OrchestratorTaskService {
  return makeServiceWithStore(acp).service;
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

async function addStoredSession(
  store: OrchestratorTaskStore,
  taskId: string,
  sessionId = "stored-session",
): Promise<string> {
  const ts = new Date().toISOString();
  const now = Date.now();
  const session: OrchestratorTaskSession = {
    id: `${sessionId}-row`,
    taskId,
    sessionId,
    framework: "codex",
    label: "Stored Agent",
    originalTask: "Implement and verify",
    goalPrompt: "Implement and verify",
    workdir: "/repo",
    status: "ready",
    decisionCount: 0,
    autoResolvedCount: 0,
    registeredAt: now,
    lastActivityAt: now,
    idleCheckCount: 0,
    taskDelivered: false,
    lastSeenDecisionIndex: 0,
    spawnedAt: now,
    retryCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheTokens: 0,
    costUsd: 0,
    usageState: "unavailable",
    metadata: {},
    createdAt: ts,
    updatedAt: ts,
  };
  await store.addSession(session);
  await store.updateTask(taskId, { status: "active" });
  return sessionId;
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

  it("pause fails loudly when live sessions exist but ACP is unavailable", async () => {
    const { service, store } = makeServiceWithStore();
    const task = await service.createTask(createInput());
    await addStoredSession(store, task.id);

    await expect(service.pauseTask(task.id)).rejects.toThrow(
      /ACP service unavailable/,
    );

    const detail = must(await service.getTask(task.id), "detail");
    expect(detail.paused).toBe(false);
    expect(detail.status).toBe("interrupted");
    expect(must(detail.sessions[0], "session").status).toBe("stop_failed");
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

  it("records default evidence for human approve/reject actions", async () => {
    const service = makeService();
    const approved = await service.createTask(createInput());
    await service.updateTask(approved.id, { status: "validating" });
    const done = must(
      await service.validateTask(approved.id, {
        passed: true,
        humanOverride: true,
      }),
      "done",
    );
    expect(done.status).toBe("done");
    expect(done.events.at(-1)).toMatchObject({
      eventType: "validation_passed",
      data: {
        evidence: "Human approved in the orchestrator UI.",
        humanOverride: true,
      },
    });

    const rejected = await service.createTask(createInput());
    await service.updateTask(rejected.id, { status: "validating" });
    const active = must(
      await service.validateTask(rejected.id, {
        passed: false,
        humanOverride: true,
      }),
      "active",
    );
    expect(active.status).toBe("active");
    expect(active.events.at(-1)).toMatchObject({
      eventType: "validation_failed",
      data: {
        evidence: "Human rejected in the orchestrator UI.",
        humanOverride: true,
      },
    });
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

  it("reports ACP-unavailable delivery failures for live sessions", async () => {
    const { service, store } = makeServiceWithStore();
    const task = await service.createTask(createInput());
    const sessionId = await addStoredSession(store, task.id);

    const result = must(
      await service.postUserMessage(task.id, "please continue"),
      "result",
    );

    expect(result).toMatchObject({
      recorded: true,
      forwardedTo: [],
      failedTo: [{ sessionId, error: "ACP service unavailable" }],
    });
    const detail = must(await service.getTask(task.id), "detail");
    expect(must(detail.sessions[0], "session").status).toBe("send_failed");
    expect(detail.messages.map((message) => message.content)).toContain(
      "please continue",
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

  it("reports ACP-unavailable auto-spawn failure when no session is live", async () => {
    const service = makeService();
    const { id } = await service.createTask(createInput());

    const result = must(await service.postUserMessage(id, "hello"), "post");

    expect(result).toMatchObject({
      recorded: true,
      forwardedTo: [],
      failedTo: [
        { sessionId: "(auto-spawn)", error: "ACP service unavailable" },
      ],
    });
    const detail = must(await service.getTask(id), "detail");
    expect(detail.sessions).toHaveLength(0);
    expect(detail.messages.map((message) => message.content)).toContain(
      "hello",
    );
  });

  it("paginates messages with a limit and cursor", async () => {
    const service = makeService();
    const { id } = await service.createTask(createInput());
    await service.addMessage(id, { content: "one", senderKind: "user" });
    await service.addMessage(id, { content: "two", senderKind: "user" });
    const all = must(await service.listMessages(id), "all");
    expect(all.items).toHaveLength(2);
    expect(all.nextCursor).toBeNull();
    expect(all.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          threadId: id,
          sessionId: null,
          content: "one",
        }),
        expect.objectContaining({
          threadId: id,
          sessionId: null,
          content: "two",
        }),
      ]),
    );
    for (const item of all.items) expect(item).not.toHaveProperty("taskId");
    const firstPage = must(
      await service.listMessages(id, { limit: 1 }),
      "firstPage",
    );
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.nextCursor).toBe("1");
    expect(await service.listMessages("missing")).toBeNull();
  });

  it("paginates events with the public DTO shape", async () => {
    const service = makeService();
    const { id } = await service.createTask(createInput());
    await service.validateTask(id, {
      passed: false,
      summary: "needs another pass",
      humanOverride: true,
    });

    const page = must(await service.listEvents(id), "events");

    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      threadId: id,
      sessionId: null,
      eventType: "validation_failed",
      summary: "needs another pass",
    });
    expect(page.items[0]).not.toHaveProperty("taskId");
    expect(await service.listEvents("missing")).toBeNull();
  });

  it("paginates a normalized mixed message/event timeline", async () => {
    const { service, store } = makeServiceWithStore();
    const { id } = await service.createTask(createInput());
    const createdAt = new Date().toISOString();
    await store.addMessage({
      id: "message-1",
      taskId: id,
      senderKind: "user",
      direction: "stdin",
      content: "start here",
      searchableText: "start here",
      timestamp: 10,
      metadata: {},
      createdAt,
    });
    await store.addEvent({
      id: "event-1",
      taskId: id,
      sessionId: "session-1",
      eventType: "tool_running",
      summary: "Ran tests",
      data: { toolCall: { id: "tool-1" } },
      timestamp: 20,
      createdAt,
    });

    const firstPage = must(
      await service.listTimeline(id, { limit: 1 }),
      "timeline",
    );
    expect(firstPage.items).toEqual([
      expect.objectContaining({
        id: "event:event-1",
        kind: "event",
        threadId: id,
        sessionId: "session-1",
        event: expect.objectContaining({
          id: "event-1",
          threadId: id,
          eventType: "tool_running",
        }),
      }),
    ]);
    expect(firstPage.nextCursor).toBe("1");

    const secondPage = must(
      await service.listTimeline(id, { cursor: "1", limit: 1 }),
      "timeline page 2",
    );
    expect(secondPage.items).toEqual([
      expect.objectContaining({
        id: "message:message-1",
        kind: "message",
        threadId: id,
        sessionId: null,
        message: expect.objectContaining({
          id: "message-1",
          threadId: id,
          content: "start here",
        }),
      }),
    ]);
    expect(secondPage.nextCursor).toBeNull();
    expect(await service.listTimeline("missing")).toBeNull();
  });
});

describe("OrchestratorTaskService — plan revisions", () => {
  it("creates, lists, and applies immutable plan revisions", async () => {
    const service = makeService();
    const task = await service.createTask(createInput());
    const plan: Record<string, unknown> = {
      summary: "operator edit",
      steps: ["one"],
    };

    const revision = must(
      await service.createPlanRevision(task.id, {
        plan,
        editSummary: "focus the implementation",
        metadata: { source: "test" },
      }),
      "revision",
    );
    plan.summary = "mutated after create";

    expect(revision.threadId).toBe(task.id);
    expect(revision.plan).toEqual({ summary: "operator edit", steps: ["one"] });
    expect(revision.editSummary).toBe("focus the implementation");
    expect(revision.metadata).toEqual({ source: "test" });

    const detail = must(await service.getTask(task.id), "detail");
    expect(detail.currentPlan).toEqual({
      summary: "operator edit",
      steps: ["one"],
    });
    expect(detail.planRevisions).toHaveLength(1);
    expect(detail.events.at(-1)).toMatchObject({
      eventType: "plan_revision_created",
      data: { planRevisionId: revision.id },
    });

    const page = must(
      await service.listPlanRevisions(task.id, { limit: 1 }),
      "page",
    );
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.id).toBe(revision.id);
    expect(page.nextCursor).toBeNull();
    expect(
      await service.createPlanRevision("missing", { plan: {} }),
    ).toBeNull();
    expect(await service.listPlanRevisions("missing")).toBeNull();
    await expect(
      service.createPlanRevision(task.id, {
        plan: {},
        basePlanRevisionId: "missing-plan",
      }),
    ).rejects.toThrow(/Base plan revision not found/);
  });
});

describe("OrchestratorTaskService — recovery controls", () => {
  it("retries a turn in the same live session as an orchestrator follow-up", async () => {
    const { service, acp, taskId, sessionId } = await withSpawnedSession();

    const detail = must(
      await service.retryTaskTurn(taskId, {
        sessionId,
        instruction: "try the edit again",
      }),
      "detail",
    );

    expect(acp.sent).toHaveLength(1);
    expect(must(acp.sent[0], "sent").message).toContain("try the edit again");
    expect(detail.status).toBe("active");
    expect(detail.messages.at(-1)).toMatchObject({
      senderKind: "orchestrator",
      sessionId,
      content: "try the edit again",
    });
    expect(
      detail.events.some((event) => event.eventType === "retry_turn_requested"),
    ).toBe(true);
  });

  it("retries a turn by spawning a new session when requested", async () => {
    const acp = new FakeAcp();
    const service = makeService(acp);
    await service.start();
    const task = await service.createTask(createInput());

    const detail = must(
      await service.retryTaskTurn(task.id, {
        mode: "new-session",
        instruction: "retry with a clean worker",
      }),
      "detail",
    );

    expect(acp.spawnArgs).toHaveLength(1);
    expect(String(acp.spawnArgs[0]?.initialTask)).toContain(
      "retry with a clean worker",
    );
    expect(detail.sessions).toHaveLength(1);
  });

  it("reruns from a source event without rewriting history", async () => {
    const acp = new FakeAcp();
    const service = makeService(acp);
    await service.start();
    const task = await service.createTask(createInput());
    await service.validateTask(task.id, {
      passed: false,
      summary: "needs another pass",
      humanOverride: true,
    });
    const sourceEvent = must(
      (await service.getTask(task.id))?.events.find(
        (event) => event.eventType === "validation_failed",
      ),
      "source event",
    );

    const detail = must(
      await service.rerunFromEvent(task.id, {
        eventId: sourceEvent.id,
        instruction: "rerun this branch",
      }),
      "detail",
    );

    expect(acp.spawnArgs).toHaveLength(1);
    expect(String(acp.spawnArgs[0]?.initialTask)).toContain(
      "rerun this branch",
    );
    expect(detail.events.map((event) => event.eventType)).toContain(
      "rerun_from_event_requested",
    );
    expect(detail.events.map((event) => event.id)).toContain(sourceEvent.id);
  });

  it("restarts by stopping active sessions and spawning a fresh worker", async () => {
    const { service, acp, taskId, sessionId } = await withSpawnedSession();

    const detail = must(
      await service.restartTask(taskId, { instruction: "restart cleanly" }),
      "detail",
    );

    expect(acp.stopped).toContain(sessionId);
    expect(acp.spawnArgs).toHaveLength(2);
    expect(String(acp.spawnArgs[1]?.initialTask)).toContain("restart cleanly");
    expect(detail.sessions).toHaveLength(2);
    expect(detail.events.map((event) => event.eventType)).toContain(
      "restart_requested",
    );
  });

  it("rejects unknown plan revision recovery inputs instead of ignoring them", async () => {
    const { service, taskId } = await withSpawnedSession();

    await expect(
      service.retryTaskTurn(taskId, {
        instruction: "retry",
        planRevisionId: "plan-1",
      }),
    ).rejects.toThrow(/Plan revision not found/);
  });

  it("does not mutate task state when same-session retry has no usable session", async () => {
    const acp = new FakeAcp();
    const service = makeService(acp);
    await service.start();
    const task = await service.createTask(createInput());
    await service.pauseTask(task.id);

    await expect(
      service.retryTaskTurn(task.id, {
        instruction: "retry",
      }),
    ).rejects.toThrow(/sessionId is required/);

    const detail = must(await service.getTask(task.id), "detail");
    expect(detail.paused).toBe(true);
    expect(detail.status).toBe("open");
    expect(detail.events.map((event) => event.eventType)).not.toContain(
      "retry_turn_requested",
    );
    expect(acp.sent).toHaveLength(0);
  });

  it("applies a selected plan revision to retry prompts and task state", async () => {
    const { service, acp, taskId, sessionId } = await withSpawnedSession();
    const revision = must(
      await service.createPlanRevision(taskId, {
        plan: { summary: "recover with plan", steps: ["retry"] },
        editSummary: "recover safely",
      }),
      "revision",
    );

    const detail = must(
      await service.retryTaskTurn(taskId, {
        sessionId,
        instruction: "retry with the edited plan",
        planRevisionId: revision.id,
      }),
      "detail",
    );

    expect(acp.sent.at(-1)?.message).toContain(`Revision: ${revision.id}`);
    expect(acp.sent.at(-1)?.message).toContain("recover safely");
    expect(detail.currentPlan).toEqual({
      summary: "recover with plan",
      steps: ["retry"],
    });
    expect(detail.events.at(-1)).toMatchObject({
      eventType: "retry_turn_requested",
      data: { planRevisionId: revision.id },
    });
  });

  it("creates a plan revision and restarts with it in one operation", async () => {
    const { service, acp, taskId } = await withSpawnedSession();

    const detail = must(
      await service.restartWithEditedPlan(taskId, {
        plan: { summary: "restart plan", steps: ["fresh"] },
        editSummary: "restart from edited plan",
        stopActive: false,
      }),
      "detail",
    );
    const revision = must(detail.planRevisions.at(-1), "revision");

    expect(detail.currentPlan).toEqual({
      summary: "restart plan",
      steps: ["fresh"],
    });
    expect(acp.spawnArgs).toHaveLength(2);
    expect(String(acp.spawnArgs.at(-1)?.initialTask)).toContain(
      `Revision: ${revision.id}`,
    );
    expect(detail.events.map((event) => event.eventType)).toEqual(
      expect.arrayContaining(["plan_revision_created", "restart_requested"]),
    );
    expect(detail.events.at(-1)).toMatchObject({
      eventType: "restart_requested",
      data: { planRevisionId: revision.id },
    });
  });

  it("does not stop active sessions when restart replacement spawn fails", async () => {
    const { service, acp, taskId, sessionId } = await withSpawnedSession();
    acp.failSpawn = true;

    await expect(
      service.restartTask(taskId, { instruction: "restart cleanly" }),
    ).rejects.toThrow(/spawn failed/);

    const detail = must(await service.getTask(taskId), "detail");
    expect(acp.stopped).not.toContain(sessionId);
    expect(detail.sessions).toHaveLength(1);
    expect(detail.sessions[0]?.status).toBe("ready");
    expect(detail.events.map((event) => event.eventType)).not.toContain(
      "restart_requested",
    );
  });

  it("does not promote an edited restart plan when replacement spawn fails", async () => {
    const { service, acp, taskId } = await withSpawnedSession();
    await service.createPlanRevision(taskId, {
      plan: { summary: "original plan" },
      editSummary: "baseline",
    });
    acp.failSpawn = true;

    await expect(
      service.restartWithEditedPlan(taskId, {
        plan: { summary: "failed restart plan" },
        editSummary: "operator retry",
      }),
    ).rejects.toThrow(/spawn failed/);

    const detail = must(await service.getTask(taskId), "detail");
    expect(detail.currentPlan).toEqual({ summary: "original plan" });
    expect(detail.planRevisions.at(-1)?.plan).toEqual({
      summary: "failed restart plan",
    });
    expect(detail.events.map((event) => event.eventType)).not.toContain(
      "restart_requested",
    );
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

  it("does not mark a direct stop successful when ACP is unavailable", async () => {
    const { service, store } = makeServiceWithStore();
    const task = await service.createTask(createInput());
    const sessionId = await addStoredSession(store, task.id);

    await expect(service.stopTaskAgent(task.id, sessionId)).rejects.toThrow(
      /ACP service unavailable/,
    );

    const detail = must(await service.getTask(task.id), "detail");
    expect(detail.status).toBe("interrupted");
    expect(must(detail.sessions[0], "session").status).toBe("stop_failed");
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

describe("OrchestratorTaskService — store degradation resilience (#11641)", () => {
  /** Runtime that hands back the same logger it wires in, so a test can assert
   * on warn calls. */
  function runtimeWithLogger(acp?: FakeAcp): {
    runtime: IAgentRuntime;
    warn: ReturnType<typeof vi.fn>;
  } {
    const warn = vi.fn();
    const rt = {
      getService: () => acp ?? null,
      logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
    } as never as IAgentRuntime;
    return { runtime: rt, warn };
  }

  it("spawnAgentForTask returns a 2xx-shaped detail when the spawn succeeds but recording the session fails", async () => {
    // Live symptom: on pglite the session INSERT/lookup path threw, so
    // POST /tasks/:id/agents returned 500 even though acp.spawnSession
    // succeeded and the agent was doing work. The API consumer saw a false
    // failure and could double-spawn. The spawn success must decouple from the
    // durable recording.
    const acp = new FakeAcp();
    const store = new OrchestratorTaskStore({ backend: "memory" });
    const { runtime, warn } = runtimeWithLogger(acp);
    const service = new OrchestratorTaskService(runtime, { store });
    await service.start();
    const task = await service.createTask(createInput());

    // Break the durable session write exactly as a degraded adapter would.
    vi.spyOn(store, "addSession").mockRejectedValueOnce(
      new Error("Failed query: INSERT INTO orchestrator_tasks ..."),
    );

    const detail = await service.spawnAgentForTask(task.id);

    // Not null (that would be a 404) and not a throw (that would be a 500) —
    // the caller gets a real detail carrying the just-spawned session.
    expect(detail).not.toBeNull();
    expect(detail?.sessions).toHaveLength(1);
    expect(detail?.sessions[0]?.sessionId).toBe("session-1");
    // The recording failure is logged (once), not swallowed silently.
    expect(
      warn.mock.calls.some((c) =>
        String(c[0]).includes(
          "spawn succeeded but recording the session failed",
        ),
      ),
    ).toBe(true);
  });

  it("warns once per session when event-recording keeps failing, not once per event", async () => {
    // A persistently degraded store (e.g. findSession throwing on pglite)
    // used to re-fire the failed-query warn on EVERY session event forever.
    // The service must warn once per session and stay quiet after.
    const acp = new FakeAcp();
    const store = new OrchestratorTaskStore({ backend: "memory" });
    const { runtime, warn } = runtimeWithLogger(acp);
    const service = new OrchestratorTaskService(runtime, { store });
    await service.start();
    const task = await service.createTask(createInput());
    const detail = must(
      await service.spawnAgentForTask(task.id),
      "expected spawn detail",
    );
    const sessionId = must(detail.sessions[0], "session").sessionId;

    // Force the event-record path to fail for this session on every event by
    // making the addEvent write throw (simulating the degraded store).
    vi.spyOn(store, "addEvent").mockRejectedValue(
      new Error("Failed query: SELECT document FROM orchestrator_tasks ..."),
    );
    // Also drop the cached mapping so resolveTaskId hits the store each time
    // (worst case), proving the guard is keyed on sessionId not luck.
    // (resolveTaskId is cached from spawn; addEvent throwing is enough to
    // exercise the once-per-session warn.)

    const before = warn.mock.calls.length;
    await drive(acp, sessionId, "ready");
    await drive(acp, sessionId, "tool_running", {
      toolCall: { title: "edit" },
    });
    await drive(acp, sessionId, "tool_running", {
      toolCall: { title: "read" },
    });
    await drive(acp, sessionId, "message", { text: "hi" });

    const recordWarns = warn.mock.calls
      .slice(before)
      .filter((c) => String(c[0]).includes("failed to record session event"));
    expect(recordWarns).toHaveLength(1);
  });
});

// The #13771 lifecycle holes: a crashed sub-agent must drive the task to a
// terminal `failed` state (bounded by the retry budget), resume must re-engage
// the work pause hard-stopped, and the session->task index must survive a
// parent restart by rebuilding from the durable store.
describe("OrchestratorTaskService — crash produces terminal failed (#13771)", () => {
  it("keeps the task non-terminal while the crash-retry budget remains", async () => {
    const acp = new FakeAcp();
    const { service, store } = makeServiceWithStore(acp);
    await service.start();
    const task = await service.createTask(createInput());
    const detail0 = must(
      await service.spawnAgentForTask(task.id),
      "spawn detail",
    );
    const sessionId = must(detail0.sessions[0], "session").sessionId;
    await drive(acp, sessionId, "error", { message: "boom" });
    const detail = must(await service.getTask(task.id), "detail");
    // First crash: retrying, not terminal — the router's respawn gets a chance.
    expect(detail.status).not.toBe("failed");
    expect(TERMINAL_TASK_STATUSES.has(detail.status)).toBe(false);
    expect(must(detail.sessions[0], "session").status).toBe("errored");
    // The canonical typed counter is stamped on the durable session record.
    const found = must(await store.findSession(sessionId), "found");
    expect(found.session.retryCount).toBe(1);
    // The producer records an honest retrying event.
    expect(
      detail.events?.some((e) => e.eventType === "session_error_retrying"),
    ).toBe(true);
  });

  it("advances the task to terminal failed once the retry budget is spent", async () => {
    const acp = new FakeAcp();
    const service = makeService(acp);
    await service.start();
    const task = await service.createTask(createInput());

    // Simulate the respawn lineage the router would drive: each crashed session
    // is replaced by a fresh spawn, until the budget (3) is exhausted.
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const detail = must(
        await service.spawnAgentForTask(task.id),
        "spawn detail",
      );
      const sessionId = must(
        detail.sessions.at(-1),
        "spawned session",
      ).sessionId;
      await drive(acp, sessionId, "error", { message: `crash ${attempt}` });
    }

    const final = must(await service.getTask(task.id), "final");
    expect(final.status).toBe("failed");
    expect(TERMINAL_TASK_STATUSES.has(final.status)).toBe(true);
    expect(final.events?.some((e) => e.eventType === "task_failed")).toBe(true);
  });

  it("never mutates a task once it has reached terminal failed", async () => {
    const acp = new FakeAcp();
    const service = makeService(acp);
    await service.start();
    const task = await service.createTask(createInput());
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const detail = must(
        await service.spawnAgentForTask(task.id),
        "spawn detail",
      );
      const sessionId = must(detail.sessions.at(-1), "session").sessionId;
      await drive(acp, sessionId, "error", { message: "crash" });
    }
    expect(must(await service.getTask(task.id), "d").status).toBe("failed");

    // A late liveness/tool event from a straggler session must not resurrect it.
    const straggler = must(
      await service.spawnAgentForTask(task.id),
      "straggler",
    );
    const stragglerId = must(straggler.sessions.at(-1), "s").sessionId;
    await drive(acp, stragglerId, "tool_running", {
      toolCall: { title: "ls" },
    });
    await drive(acp, stragglerId, "ready");
    expect(must(await service.getTask(task.id), "d2").status).toBe("failed");
  });

  it("does not count a clean stop against the crash budget", async () => {
    const acp = new FakeAcp();
    const { service, store } = makeServiceWithStore(acp);
    await service.start();
    const task = await service.createTask(createInput());
    // Two clean stops + one error must NOT trip the budget (only errors count).
    for (let i = 0; i < 2; i += 1) {
      const d = must(await service.spawnAgentForTask(task.id), "spawn");
      const sid = must(d.sessions.at(-1), "s").sessionId;
      await drive(acp, sid, "stopped");
    }
    const d = must(await service.spawnAgentForTask(task.id), "spawn");
    const sid = must(d.sessions.at(-1), "s").sessionId;
    await drive(acp, sid, "error", { message: "boom" });
    const detail = must(await service.getTask(task.id), "detail");
    expect(detail.status).not.toBe("failed");
    // Only one errored session in the lineage.
    const found = must(await store.findSession(sid), "found");
    expect(found.session.retryCount).toBe(1);
  });
});

describe("OrchestratorTaskService — resume re-engagement symmetry (#13771)", () => {
  it("resume re-spawns a fresh sub-agent for the work pause hard-stopped", async () => {
    const { service, acp, taskId, sessionId } = await withSpawnedSession();
    const spawnsBeforePause = acp.spawnArgs.length;

    const paused = must(await service.pauseTask(taskId), "paused");
    expect(paused.paused).toBe(true);
    expect(acp.stopped).toContain(sessionId);

    const resumed = must(await service.resumeTask(taskId), "resumed");
    expect(resumed.paused).toBe(false);
    // A new sub-agent was spawned to continue the interrupted work.
    expect(acp.spawnArgs.length).toBe(spawnsBeforePause + 1);
    expect(
      resumed.events?.some((e) => e.eventType === "resume_reengaged"),
    ).toBe(true);
  });

  it("resume of a task paused before any work runs just unpauses (no spawn)", async () => {
    const acp = new FakeAcp();
    const service = makeService(acp);
    await service.start();
    const task = await service.createTask(createInput());
    await service.pauseTask(task.id); // no sessions yet
    const spawnsBefore = acp.spawnArgs.length;

    const resumed = must(await service.resumeTask(task.id), "resumed");
    expect(resumed.paused).toBe(false);
    expect(acp.spawnArgs.length).toBe(spawnsBefore);
    expect(
      resumed.events?.some((e) => e.eventType === "resume_reengaged"),
    ).toBe(false);
  });
});

describe("OrchestratorTaskService — restart reconstruction (#13771)", () => {
  it("resolves a session's task from the durable store after an in-memory index loss", async () => {
    const acp = new FakeAcp();
    const store = new OrchestratorTaskStore({ backend: "memory" });
    // A first service instance spawns the session and populates the store.
    const first = new OrchestratorTaskService(runtime(acp), { store });
    await first.start();
    const task = await first.createTask(createInput());
    const detail = must(await first.spawnAgentForTask(task.id), "spawn detail");
    const sessionId = must(detail.sessions[0], "session").sessionId;

    // Simulate a parent restart: a brand-new service with an EMPTY in-memory
    // sessionTaskIndex, sharing only the durable store. The session event must
    // still route to the task (index self-heals from store.findSession), which
    // proves in-flight session->task resolution survives restart without a
    // separate rebuild step.
    const restarted = new OrchestratorTaskService(runtime(acp), { store });
    await restarted.start();
    await drive(acp, sessionId, "blocked", { message: "need input" });

    const after = must(await restarted.getTask(task.id), "after restart");
    expect(after.status).toBe("blocked");
    expect(after.events?.some((e) => e.eventType === "blocked")).toBe(true);
  });
});
