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
 *  - completion-evidence isolation across automatic-verification retries,
 *  - usage telemetry roll-up and per-turn dedup,
 *  - cross-task status aggregation and bulk pause/resume.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { IAgentRuntime } from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { OrchestratorTaskService } from "../../src/services/orchestrator-task-service.js";
import { OrchestratorTaskStore } from "../../src/services/orchestrator-task-store.js";
import {
  type CreateTaskInput,
  MAX_SESSION_RETRY_ATTEMPTS,
  type OrchestratorTaskSession,
  RETRY_BUDGET_EPOCH_METADATA_KEY,
  stateLostRespawnCapFor,
  TERMINAL_TASK_STATUSES,
} from "../../src/services/orchestrator-task-types.js";
import {
  createRouterLoopState,
  routerLoopTransition,
} from "../../src/services/router-loop-guard.js";

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
  readonly liveSessions = new Map<string, Record<string, unknown>>();
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
    const result = {
      sessionId: `session-${this.counter}`,
      agentType: (opts.agentType as string | undefined) ?? "codex",
      workdir: (opts.workdir as string | undefined) ?? "/repo",
      status: "ready",
    };
    this.liveSessions.set(result.sessionId, {
      id: result.sessionId,
      name: result.sessionId,
      agentType: result.agentType,
      workdir: result.workdir,
      status: result.status,
      approvalPreset: opts.approvalPreset,
      createdAt: new Date(),
      lastActivityAt: new Date(),
      metadata:
        typeof opts.metadata === "object" && opts.metadata !== null
          ? { ...(opts.metadata as Record<string, unknown>) }
          : {},
    });
    return Promise.resolve(result);
  }

  getSession(sessionId: string): Promise<Record<string, unknown> | null> {
    return Promise.resolve(this.liveSessions.get(sessionId) ?? null);
  }

  getChangedPaths(_sessionId: string): string[] {
    return [];
  }

  getCapacity(): Promise<{
    maxSessions: number;
    systemHeadroom: number;
    activeWorkers: number;
    activeSystem: number;
    freeWorkerSlots: number;
    freeSystemSlots: number;
  }> {
    return Promise.resolve({
      maxSessions: 4,
      systemHeadroom: 1,
      activeWorkers: 1,
      activeSystem: 0,
      freeWorkerSlots: 2,
      freeSystemSlots: 1,
    });
  }

  listSessions(): Promise<Record<string, unknown>[]> {
    return Promise.resolve([...this.liveSessions.values()]);
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

function runtime(
  acp?: FakeAcp,
  settings: Record<string, string> = {},
): IAgentRuntime {
  return {
    getService: () => acp ?? null,
    getSetting: (key: string) => settings[key],
    reportError: vi.fn(),
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  } as never;
}

function makeServiceWithStore(
  acp?: FakeAcp,
  settings: Record<string, string> = {},
): {
  service: OrchestratorTaskService;
  store: OrchestratorTaskStore;
} {
  const store = new OrchestratorTaskStore({ backend: "memory" });
  return {
    service: new OrchestratorTaskService(runtime(acp, settings), { store }),
    store,
  };
}

function makeService(
  acp?: FakeAcp,
  settings: Record<string, string> = {},
): OrchestratorTaskService {
  return makeServiceWithStore(acp, settings).service;
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

/** Poll until the task reaches `status`. The `task_complete` bridge path does
 * real async IO (change-set mirror, trajectory ingest #13775) before the
 * `completion_reported` status advance, so a single-macrotask {@link flush}
 * races it — asserting the post-completion status directly is flaky. */
async function settleStatus(
  service: OrchestratorTaskService,
  taskId: string,
  status: string,
): Promise<void> {
  const deadline = Date.now() + 5000;
  let last: string | undefined;
  while (Date.now() < deadline) {
    last = must(await service.getTask(taskId), "task").status;
    if (last === status) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  expect(last).toBe(status);
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

  it("requires explicit evidence for human approve/reject and records it verbatim", async () => {
    const service = makeService();
    const approved = await service.createTask(createInput());
    await service.updateTask(approved.id, { status: "validating" });
    // An override without evidence is an audit hole — rejected, never defaulted.
    await expect(
      service.validateTask(approved.id, { passed: true, humanOverride: true }),
    ).rejects.toThrow(/evidence/i);
    const done = must(
      await service.validateTask(approved.id, {
        passed: true,
        humanOverride: true,
        evidence: "Shaw verified the deploy by hand.",
      }),
      "done",
    );
    expect(done.status).toBe("done");
    expect(done.events.at(-1)).toMatchObject({
      eventType: "validation_passed",
      data: {
        evidence: "Shaw verified the deploy by hand.",
        humanOverride: true,
      },
    });
    // done is terminal — a further override must be rejected, not re-written.
    await expect(
      service.validateTask(approved.id, {
        passed: false,
        humanOverride: true,
        evidence: "changed my mind",
      }),
    ).rejects.toThrow(/terminal/i);

    const rejected = await service.createTask(createInput());
    await service.updateTask(rejected.id, { status: "validating" });
    const active = must(
      await service.validateTask(rejected.id, {
        passed: false,
        humanOverride: true,
        evidence: "Shaw rejected: the fix does not reproduce.",
      }),
      "active",
    );
    expect(active.status).toBe("active");
    expect(active.events.at(-1)).toMatchObject({
      eventType: "validation_failed",
      data: {
        evidence: "Shaw rejected: the fix does not reproduce.",
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

  it("attaches existing sessions idempotently without promoting terminal arrivals", async () => {
    const { service } = makeServiceWithStore();
    const task = await service.createTask(createInput());

    const attached = await service.attachSession(task.id, {
      sessionId: "external-session",
      agentType: "claude",
      workdir: "/repo",
      status: "completed",
      label: "Imported Worker",
      originalTask: "Imported task",
      goalPrompt: "Goal wrapper",
      repo: "eliza",
      providerSource: "user-claude",
      model: "claude-opus",
      metadata: {
        account: {
          providerId: "anthropic-subscription",
          accountId: "acct-1",
          label: "Work",
        },
      },
    });
    expect(attached).toBe(true);
    await expect(
      service.attachSession(task.id, {
        sessionId: "external-session",
        agentType: "claude",
        workdir: "/repo",
        status: "completed",
      }),
    ).resolves.toBe(true);
    await expect(
      service.attachSession("missing", {
        sessionId: "missing-session",
        agentType: "claude",
        workdir: "/repo",
        status: "ready",
      }),
    ).resolves.toBe(false);

    const detail = must(await service.getTask(task.id), "detail");
    expect(detail.status).toBe("open");
    expect(detail.latestWorkdir).toBe("/repo");
    expect(detail.latestRepo).toBe("eliza");
    expect(detail.sessions).toHaveLength(1);
    expect(detail.sessions[0]).toMatchObject({
      sessionId: "external-session",
      status: "completed",
      label: "Imported Worker",
      originalTask: "Imported task",
      providerSource: "user-claude",
      model: "claude-opus",
      accountProviderId: "anthropic-subscription",
      accountId: "acct-1",
      accountLabel: "Work",
    });
    expect(detail.sessions[0]?.stoppedAt).toBeTruthy();
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

  it("keeps verifier feedback out of the corrected retry's evidence", async () => {
    const acp = new FakeAcp();
    const store = new OrchestratorTaskStore({ backend: "memory" });
    const prompts: string[] = [];
    const priorDiagnostic =
      "PRIOR VERIFIER DIAGNOSTIC: the tests failed automatic verification";
    const baseRuntime = runtime(acp);
    const service = new OrchestratorTaskService(
      {
        ...baseRuntime,
        useModel: vi.fn(async (...args: unknown[]) => {
          const options = args[1] as { prompt?: string } | undefined;
          const prompt = options?.prompt ?? "";
          prompts.push(prompt);
          const hasCorrectedProof =
            prompt.includes("diff --git a/src/widget.ts b/src/widget.ts") &&
            prompt.includes("Test Files  1 passed (1)");
          const contaminated = prompt.includes(priorDiagnostic);
          return JSON.stringify(
            hasCorrectedProof && !contaminated
              ? {
                  passed: true,
                  summary: "corrected proof passed",
                  missing: [],
                }
              : {
                  passed: false,
                  summary: priorDiagnostic,
                  missing: ["tests pass"],
                },
          );
        }),
      } as never,
      { store },
    );
    await service.start();
    try {
      const task = await store.createTask({
        title: "Verify corrected retry",
        goal: "Implement the widget and prove the tests pass",
        acceptanceCriteria: ["tests pass"],
      });
      const taskId = task.task.id;
      const sessionId = await addStoredSession(
        store,
        taskId,
        "retry-evidence-session",
      );

      acp.emit(sessionId, "task_complete", {
        response: "I implemented the widget and believe it works.",
      });
      await vi.waitFor(() => expect(acp.sent).toHaveLength(1));

      acp.emit(sessionId, "task_complete", {
        response: `Done.\n\n\`\`\`diff\ndiff --git a/src/widget.ts b/src/widget.ts\n--- a/src/widget.ts\n+++ b/src/widget.ts\n@@\n+export const widget = () => 42;\n\`\`\`\n\n\`\`\`\n$ bun test\n✓ src/widget.test.ts (1 test) 20ms\nTest Files  1 passed (1)\nTests  1 passed (1)\n\`\`\``,
      });
      await vi.waitFor(async () => {
        expect((await store.getTask(taskId))?.task.status).toBe("done");
      });

      expect(prompts).toHaveLength(2);
      expect(prompts[1]).toContain("Test Files  1 passed (1)");
      expect(prompts[1]).not.toContain(priorDiagnostic);
    } finally {
      await service.stop();
    }
  });

  it("rejects malformed live change-set metadata and mirrors a real workspace diff", async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ots-changeset-"));
    try {
      execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "test@example.com"], {
        cwd: repo,
      });
      execFileSync("git", ["config", "user.name", "Test User"], {
        cwd: repo,
      });
      fs.mkdirSync(path.join(repo, "src"), { recursive: true });
      fs.writeFileSync(path.join(repo, "src/foo.ts"), "export const n = 1;\n");
      execFileSync("git", ["add", "src/foo.ts"], { cwd: repo });
      execFileSync("git", ["commit", "-m", "baseline"], {
        cwd: repo,
        stdio: "ignore",
      });
      const baseline = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: repo,
        encoding: "utf8",
      }).trim();
      fs.writeFileSync(path.join(repo, "src/foo.ts"), "export const n = 2;\n");

      const acp = new FakeAcp();
      const { service, store } = makeServiceWithStore(acp);
      await service.start();
      const task = await service.createTask(createInput());
      await store.updateTask(task.id, { boundWorkdir: repo });
      const spawned = must(await service.spawnAgentForTask(task.id), "spawned");
      const sessionId = must(spawned.sessions[0], "session").sessionId;
      const live = must(acp.liveSessions.get(sessionId), "live ACP session");
      live.metadata = {
        lastChangeSet: {
          changedFiles: "src/foo.ts",
          capturedAt: "not-a-number",
        },
        codingBaselineSha: baseline,
      };
      vi.spyOn(acp, "getChangedPaths").mockReturnValue(["src/foo.ts"]);

      await drive(acp, sessionId, "task_complete", {
        response: "Updated foo.",
      });
      await settleStatus(service, task.id, "validating");

      const detail = must(await service.getTask(task.id), "detail");
      const metadata = must(detail.sessions[0], "session").metadata;
      const changeSet = metadata.lastChangeSet as
        | { changedFiles?: string[]; capturedAt?: number; diff?: string }
        | undefined;
      expect(changeSet?.changedFiles).toEqual(["src/foo.ts"]);
      expect(typeof changeSet?.capturedAt).toBe("number");
      expect(changeSet?.diff).toContain("export const n = 2");
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("stamps the sub-agent's PR link onto task metadata on task_complete (PR chip plumbing)", async () => {
    const { service, acp, taskId, sessionId } = await withSpawnedSession();
    await drive(acp, sessionId, "task_complete", {
      response:
        "Done. Opened https://github.com/elizaOS/eliza/pull/16090 for review.",
    });
    const detail = must(await service.getTask(taskId), "detail");
    expect(detail.metadata.prUrl).toBe(
      "https://github.com/elizaOS/eliza/pull/16090",
    );
    expect(detail.metadata.prNumber).toBe(16090);
    expect(detail.metadata.prRepo).toBe("elizaOS/eliza");
  });

  it("leaves task metadata untouched when the completion carries no PR link", async () => {
    const { service, acp, taskId, sessionId } = await withSpawnedSession();
    await drive(acp, sessionId, "task_complete", {
      response: "Committed abc1234 and pushed. No PR needed.",
    });
    const detail = must(await service.getTask(taskId), "detail");
    expect(detail.metadata.prUrl).toBeUndefined();
    expect(detail.metadata.prNumber).toBeUndefined();
    expect(detail.metadata.prRepo).toBeUndefined();
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

  it("keeps a healthy account active when only Claude's injected token expired", async () => {
    const { service, acp, sessionId } = await withSpawnedSession();
    const markUnhealthy = vi.spyOn(
      service as unknown as {
        markSessionAccountUnhealthy(
          sessionId: string,
          kind: string,
          message: string,
        ): Promise<void>;
      },
      "markSessionAccountUnhealthy",
    );

    await drive(acp, sessionId, "error", {
      message: "oauth token has expired",
      failureKind: "auth",
      authReason: "token_expired",
    });

    expect(markUnhealthy).not.toHaveBeenCalled();
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

  it("records account failover resumes as preserved-work events", async () => {
    const { service, acp, taskId, sessionId } = await withSpawnedSession();
    await drive(acp, sessionId, "account_failover_resumed", {
      resumeReason: "rate-limited",
    });
    const event = must(
      (await service.getTask(taskId))?.events.find(
        (entry) => entry.eventType === "account_failover_resumed",
      ),
      "failover event",
    );
    expect(event.summary).toBe("Resumed after a rate limit (work preserved)");
  });

  it("records canonical failover-resume and account-switch events", async () => {
    const { service, acp, taskId, sessionId } = await withSpawnedSession();
    await drive(acp, sessionId, "account_switched", {
      providerId: "anthropic-subscription",
      accountId: "acct-2",
      label: "Backup",
    });
    await drive(acp, sessionId, "account_failover_resumed", {
      resumable: true,
      resumeReason: "needs-reauth",
      authReason: "token_expired",
      resumeFromSessionId: "previous-session",
      workdir: "/repo",
    });
    await drive(acp, sessionId, "account_failover_resumed", {
      resumeReason: "capacity",
      workdir: "/repo",
    });

    const detail = must(await service.getTask(taskId), "detail");
    expect(detail.sessions[0]).toMatchObject({
      accountProviderId: "anthropic-subscription",
      accountId: "acct-2",
      accountLabel: "Backup",
    });
    expect(detail.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "account_switched",
          summary: "Switched coding account to Backup",
        }),
        expect.objectContaining({
          eventType: "account_failover_resumed",
          summary: "Resumed after a credential expiry (work preserved)",
          data: expect.objectContaining({
            resumable: true,
            authReason: "token_expired",
            resumeFromSessionId: "previous-session",
          }),
        }),
        expect.objectContaining({
          eventType: "account_failover_resumed",
          summary:
            "Resumed after a capacity/overload condition (work preserved)",
        }),
      ]),
    );
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
    await settleStatus(service, taskId, "validating");
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
    await settleStatus(service, taskId, "validating");
    await drive(acp, sessionId, "tool_running", { toolCall: { title: "ls" } });
    expect(must(await service.getTask(taskId), "detail").status).toBe(
      "validating",
    );
  });

  it("never mutates a terminal task from a session event", async () => {
    const { service, acp, taskId, sessionId } = await withSpawnedSession();
    await drive(acp, sessionId, "task_complete", { response: "done" });
    await settleStatus(service, taskId, "validating");
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

  // #14105: the operator stop paths used to write `status: "interrupted"`
  // directly, so a terminal task (done/failed/archived) still holding a live
  // keepAlive session whose ACP stop fails was stomped to `interrupted` —
  // `done → interrupted` is not a legal transition-table edge and this broke the
  // terminal-immutability invariant #13830 enforces. Routing through
  // advanceTaskStatus makes the illegal edge a no-op.
  it("does NOT move a terminal `done` task to interrupted when stopTaskAgent hits an unavailable ACP", async () => {
    const { service, store } = makeServiceWithStore();
    const task = await service.createTask(createInput());
    const sessionId = await addStoredSession(store, task.id);
    // Terminal `done` while a `ready` (live) session is still on the record.
    await store.updateTask(task.id, {
      status: "done",
      closedAt: new Date().toISOString(),
    });

    await expect(service.stopTaskAgent(task.id, sessionId)).rejects.toThrow(
      /ACP service unavailable/,
    );

    const detail = must(await service.getTask(task.id), "detail");
    expect(detail.status).toBe("done");
    // The session-level stop failure is still recorded for observability.
    expect(must(detail.sessions[0], "session").status).toBe("stop_failed");
  });

  it("does NOT regress a terminal `done` task to interrupted when archive's session stop fails", async () => {
    const acp = new FakeAcp();
    const { service, store } = makeServiceWithStore(acp);
    await service.start();
    const task = await service.createTask(createInput());
    const sessionId = await addStoredSession(store, task.id);
    await store.updateTask(task.id, {
      status: "done",
      closedAt: new Date().toISOString(),
    });
    acp.failStop = true;

    // stopActiveSessions throws on the failed stop before archive fields land;
    // the terminal task must stay `done` (pre-#14105 it was stomped to
    // `interrupted` first — `done → interrupted` is an illegal edge).
    await expect(service.archiveTask(task.id)).rejects.toThrow(
      /Failed to stop/,
    );
    const detail = must(await service.getTask(task.id), "detail");
    expect(detail.status).toBe("done");
    expect(must(detail.sessions[0], "session").status).toBe("stop_failed");
    void sessionId;
  });

  it("archives a terminal `done` task through the transition table when no live session blocks the stop", async () => {
    const { service, store } = makeServiceWithStore();
    const task = await service.createTask(createInput());
    await store.updateTask(task.id, {
      status: "done",
      closedAt: new Date().toISOString(),
    });

    // No active sessions → stopActiveSessions is a no-op → archive resolves the
    // target via nextTaskStatus(done, "archived") (a live table edge, not a
    // literal write).
    const archived = must(await service.archiveTask(task.id), "archived");
    expect(archived.status).toBe("archived");
    expect(archived.archivedAt).toBeTruthy();
  });

  it("still interrupts a NON-terminal task when archive's session stop fails", async () => {
    const acp = new FakeAcp();
    const { service, store } = makeServiceWithStore(acp);
    await service.start();
    const task = await service.createTask(createInput());
    await addStoredSession(store, task.id); // leaves task `active`
    acp.failStop = true;

    // stopActiveSessions throws a RecoveryConflictError on the failed stop; the
    // active task legally advances to `interrupted` (active → interrupted is a
    // table edge) before the throw, so archive is not reached.
    await expect(service.archiveTask(task.id)).rejects.toThrow(
      /Failed to stop/,
    );
    const detail = must(await service.getTask(task.id), "detail");
    expect(detail.status).toBe("interrupted");
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
    // With no ELIZA_*_AGENT setting the spawn passes no explicit agentType, so
    // the session inherits acp-service's configured default. opencode is never
    // that default — it is explicit-selection only (acp-service DEFAULT_AGENTS
    // orders elizaos → codex → claude → opencode, and the fallback is
    // native→"elizaos"/non-native→"codex"). The FakeAcp here mirrors the
    // non-native "codex" fallback, so a provider-less usage frame is attributed
    // to "codex".
    expect(must(usage.byProvider[0], "provider").provider).toBe("codex");
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

  it("reports account assignments, room rosters, readiness, and capacity", async () => {
    const acp = new FakeAcp();
    const { service, store } = makeServiceWithStore(acp, {
      ELIZA_CODING_ACCOUNT_STRATEGY: "round-robin",
      ELIZA_ACP_QUEUE_AGING_MS: "600000",
    });
    await service.start();
    const task = await service.createTask(
      createInput({
        title: "Accounted task",
        roomId: "11111111-2222-3333-4444-555555555555",
        taskRoomId: "22222222-3333-4444-5555-666666666666",
        ownerUserId: "33333333-4444-5555-6666-777777777777",
      }),
    );
    await service.attachSession(task.id, {
      sessionId: "accounted-session",
      agentType: "claude",
      workdir: "/repo",
      status: "ready",
      label: "Ada",
      metadata: {
        account: {
          providerId: "anthropic-subscription",
          accountId: "acct-1",
          label: "Primary",
        },
      },
    });
    await drive(acp, "accounted-session", "usage_update", {
      provider: "anthropic",
      model: "claude-opus",
      inputTokens: 5,
      outputTokens: 7,
      reasoningTokens: 3,
      cacheTokens: 2,
      costUsd: 0.01,
      state: "measured",
    });

    const accountOverview = await service.getAccountOverview();
    expect(accountOverview.strategy).toBe("round-robin");
    expect(accountOverview.assignments).toEqual([
      expect.objectContaining({
        taskTitle: "Accounted task",
        sessionId: "accounted-session",
        label: "Ada",
        framework: "claude",
        active: true,
        accountProviderId: "anthropic-subscription",
        accountId: "acct-1",
        accountLabel: "Primary",
        totalTokens: 15,
        cacheTokens: 2,
      }),
    ]);

    const roster = await service.getRoomRoster();
    expect(roster.rooms).toEqual([
      expect.objectContaining({
        taskId: task.id,
        taskRoomId: "22222222-3333-4444-5555-666666666666",
        activeAgentCount: 1,
        multiParty: false,
        participants: expect.arrayContaining([
          expect.objectContaining({ kind: "orchestrator" }),
          expect.objectContaining({
            kind: "user",
            id: "33333333-4444-5555-6666-777777777777",
          }),
          expect.objectContaining({
            kind: "sub_agent",
            id: "accounted-session",
            totalTokens: 15,
            accountLabel: "Primary",
          }),
        ]),
      }),
    ]);
    expect(service.getAccountReadiness().ready).toBe(false);

    const capacity = await service.getCapacityOverview();
    expect(capacity).toMatchObject({
      maxSessions: 4,
      systemHeadroom: 1,
      freeWorkerSlots: 2,
      queueDepth: 0,
      queue: [],
    });

    const enqueuedAt = new Date(Date.now() - 1_000).toISOString();
    await store.updateTask(task.id, {
      metadata: {
        admission: {
          state: "queued",
          enqueuedAt,
          priorityAtEnqueue: "high",
          spawnOpts: { agentType: "claude" },
        },
      },
    });
    (service as unknown as { admissionQueue: string[] }).admissionQueue.push(
      task.id,
      "missing-task",
    );

    await expect(service.getAdmissionSnapshot()).resolves.toEqual({
      queueDepth: 1,
      queuedTaskIds: [task.id],
    });
    await expect(service.getCapacityOverview()).resolves.toMatchObject({
      queueDepth: 1,
      queue: [
        {
          taskId: task.id,
          position: 1,
          priority: "high",
          enqueuedAt,
        },
      ],
    });

    await (
      service as unknown as {
        writeAdmission: (taskId: string, value: null) => Promise<void>;
      }
    ).writeAdmission(task.id, null);
    expect(
      (await store.getTask(task.id))?.task.metadata?.admission,
    ).toBeUndefined();

    const noAcpService = makeService(undefined, {
      ELIZA_ACP_QUEUE_AGING_MS: "600000",
    });
    await expect(noAcpService.getCapacityOverview()).resolves.toMatchObject({
      maxSessions: 0,
      systemHeadroom: 0,
      activeWorkers: 0,
      activeSystem: 0,
      freeWorkerSlots: 0,
      freeSystemSlots: 0,
      queueDepth: 0,
    });
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
      reportError: vi.fn(),
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
  it("keeps a RESPAWNABLE crash (session_state_lost) non-terminal while the budget remains", async () => {
    // Only a crash the router actually re-drives may stay non-terminal — here a
    // `session_state_lost`, which respawnStateLost re-spawns under a cap. A plain
    // crash (no respawn producer) must NOT park like this; see the terminal case
    // below and session-crash-terminates.test.ts.
    const acp = new FakeAcp();
    const { service, store } = makeServiceWithStore(acp);
    await service.start();
    const task = await service.createTask(createInput());
    const detail0 = must(
      await service.spawnAgentForTask(task.id),
      "spawn detail",
    );
    const sessionId = must(detail0.sessions[0], "session").sessionId;
    await drive(acp, sessionId, "error", {
      failureKind: "session_state_lost",
      message: "ACP session state lost",
    });
    const detail = must(await service.getTask(task.id), "detail");
    // First respawnable crash: retrying, not terminal — the router's respawn
    // gets a chance.
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

  it("fails a plain crash immediately — it has no respawn producer, so parking it would wedge the task", async () => {
    // #13771 regression guard (#13830): a generic session error is respawned by
    // NEITHER the account-failover nor the session_state_lost path in
    // sub-agent-router.ts, so no successor session is ever spawned and no further
    // error re-enters the budget. Routing the first such crash to
    // `retrying -> active` wedges the task forever; it must go terminal `failed`.
    const acp = new FakeAcp();
    const service = makeService(acp);
    await service.start();
    const task = await service.createTask(createInput());
    const detail0 = must(
      await service.spawnAgentForTask(task.id),
      "spawn detail",
    );
    const sessionId = must(detail0.sessions[0], "session").sessionId;
    await drive(acp, sessionId, "error", { message: "boom" });

    const final = must(await service.getTask(task.id), "final");
    expect(final.status).toBe("failed");
    expect(TERMINAL_TASK_STATUSES.has(final.status)).toBe(true);
    expect(final.events?.some((e) => e.eventType === "task_failed")).toBe(true);
  });

  it("advances the task to terminal failed once the respawnable-crash retry budget is spent", async () => {
    const acp = new FakeAcp();
    const service = makeService(acp);
    await service.start();
    const task = await service.createTask(createInput());

    // Simulate the respawn lineage the router would drive for a respawnable
    // crash: each crashed session is replaced by a fresh spawn until the shared
    // errored-session budget is spent. With a budget of three errored sessions,
    // the first two are retryable and the third is terminal.
    for (let attempt = 1; attempt <= MAX_SESSION_RETRY_ATTEMPTS; attempt += 1) {
      const detail = must(
        await service.spawnAgentForTask(task.id),
        "spawn detail",
      );
      const sessionId = must(
        detail.sessions.at(-1),
        "spawned session",
      ).sessionId;
      await drive(acp, sessionId, "error", {
        failureKind: "session_state_lost",
        message: `state lost ${attempt}`,
      });
      const afterAttempt = must(await service.getTask(task.id), "attempt");
      if (attempt < MAX_SESSION_RETRY_ATTEMPTS) {
        expect(afterAttempt.status).not.toBe("failed");
        expect(TERMINAL_TASK_STATUSES.has(afterAttempt.status)).toBe(false);
      }
    }

    const final = must(await service.getTask(task.id), "final");
    expect(final.status).toBe("failed");
    expect(TERMINAL_TASK_STATUSES.has(final.status)).toBe(true);
    expect(final.events?.some((e) => e.eventType === "task_failed")).toBe(true);
  });

  it("resets the respawnable-crash retry window on operator restart", async () => {
    const acp = new FakeAcp();
    const { service, store } = makeServiceWithStore(acp);
    await service.start();
    const task = await service.createTask(createInput());

    for (let attempt = 1; attempt <= MAX_SESSION_RETRY_ATTEMPTS; attempt += 1) {
      const detail = must(
        await service.spawnAgentForTask(task.id),
        "spawn detail",
      );
      const sessionId = must(detail.sessions.at(-1), "session").sessionId;
      await drive(acp, sessionId, "error", {
        failureKind: "session_state_lost",
        message: `state lost ${attempt}`,
      });
    }
    expect(must(await service.getTask(task.id), "failed").status).toBe(
      "failed",
    );

    const restarted = must(
      await service.restartTask(task.id, { instruction: "restart cleanly" }),
      "restarted",
    );
    const restartedSessionId = must(
      restarted.sessions.at(-1),
      "restarted session",
    ).sessionId;
    await drive(acp, restartedSessionId, "error", {
      failureKind: "session_state_lost",
      message: "state lost after restart",
    });

    const afterRestartError = must(
      await service.getTask(task.id),
      "after restart error",
    );
    expect(afterRestartError.status).not.toBe("failed");
    expect(TERMINAL_TASK_STATUSES.has(afterRestartError.status)).toBe(false);
    const found = must(
      await store.findSession(restartedSessionId),
      "restarted session record",
    );
    expect(found.session.retryCount).toBe(1);
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
    // Two clean stops must NOT enter the crash lineage — only `error` events do.
    // A respawnable crash after them is therefore attempt 1/3 (retryCount === 1),
    // not 3/3: had the stops counted, the budget would already be spent.
    for (let i = 0; i < 2; i += 1) {
      const d = must(await service.spawnAgentForTask(task.id), "spawn");
      const sid = must(d.sessions.at(-1), "s").sessionId;
      await drive(acp, sid, "stopped");
    }
    const d = must(await service.spawnAgentForTask(task.id), "spawn");
    const sid = must(d.sessions.at(-1), "s").sessionId;
    await drive(acp, sid, "error", {
      failureKind: "session_state_lost",
      message: "state lost",
    });
    const detail = must(await service.getTask(task.id), "detail");
    // Respawnable + budget remains → non-terminal (the stops didn't burn it).
    expect(detail.status).not.toBe("failed");
    // Only one errored session in the lineage — the clean stops are not counted.
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

// A late `error` for a session that already posted `task_complete` is a
// teardown race — the process dropped its state AFTER the deliverable shipped.
// The router suppresses its respawn for exactly this case (the completion
// claim in router-loop-guard); the task bridge must be symmetric: keep the
// `completed` session record, keep the task in `validating` so the in-flight
// verification can finish (validateTask requires `validating`), and spend
// nothing from the crash-retry budget.
describe("OrchestratorTaskService — post-completion teardown race (#13830 audit)", () => {
  it("drops a late session error after task_complete: task stays validating, session stays completed", async () => {
    const { service, acp, taskId, sessionId } = await withSpawnedSession();
    await drive(acp, sessionId, "task_complete", { response: "shipped" });
    await settleStatus(service, taskId, "validating");
    expect(
      must(must(await service.getTask(taskId), "mid").sessions[0], "session")
        .status,
    ).toBe("completed");

    await drive(acp, sessionId, "error", {
      failureKind: "session_state_lost",
      message: "session state lost during teardown",
    });
    // Give the straggler's (fast, in-memory) error path time to land before
    // asserting it changed nothing.
    await flush();

    const after = must(await service.getTask(taskId), "after");
    expect(after.status).toBe("validating");
    expect(must(after.sessions[0], "session").status).toBe("completed");
    expect(
      after.events?.some((e) => e.eventType === "session_error_retrying"),
    ).toBe(false);
    expect(after.events?.some((e) => e.eventType === "task_failed")).toBe(
      false,
    );
  });

  it("still fails the task when a plain crash errors a session that never completed", async () => {
    const { service, acp, taskId, sessionId } = await withSpawnedSession();
    await drive(acp, sessionId, "error", {
      message: "process exited with code 1",
    });
    await settleStatus(service, taskId, "failed");
    const detail = must(await service.getTask(taskId), "detail");
    expect(must(detail.sessions[0], "session").status).toBe("errored");
  });
});

// The #14104 divergence: the task service's terminal budget and the router's
// per-lineage state-lost respawn cap used to be independent numbers with
// mismatched arithmetic, so the task went `failed` at the 3rd errored session
// while the router still respawned a 4th orphan worker on the same event. These
// tests pin the reconciliation — one budget, one owner — by driving BOTH
// subsystems over the SAME state-lost stream and asserting they agree, and by
// checking the restart-budget reset.
describe("OrchestratorTaskService — retry-budget/router-cap reconciliation (#14104)", () => {
  it("task terminal decision and router respawn cap agree on the same state-lost stream — no 4th orphan", async () => {
    const acp = new FakeAcp();
    const service = makeService(acp);
    await service.start();
    const task = await service.createTask(createInput());

    // Drive the state-lost lineage session by session, recording at each error
    // (a) whether the task is now terminal `failed`, and (b) what the router's
    // loop-guard reducer decides for the SAME event under its default cap.
    let loopState = createRouterLoopState();
    const lineageKey = "lineage-a";
    const routerDecisions: string[] = [];
    const taskTerminalAtError: boolean[] = [];

    // Enough iterations to pass the budget: budget N ⇒ terminal at the Nth error.
    for (let i = 0; i < MAX_SESSION_RETRY_ATTEMPTS + 1; i += 1) {
      const status = must(await service.getTask(task.id), "status").status;
      // Once terminal, the task refuses further spawns/errors — stop driving it.
      if (TERMINAL_TASK_STATUSES.has(status)) break;

      const detail = must(
        await service.spawnAgentForTask(task.id),
        "spawn detail",
      );
      const sessionId = must(detail.sessions.at(-1), "session").sessionId;
      await drive(acp, sessionId, "error", {
        failureKind: "session_state_lost",
        message: `state lost ${i + 1}`,
      });

      const transition = routerLoopTransition(loopState, {
        type: "state_lost",
        lineageKey,
      });
      loopState = transition.state;
      routerDecisions.push(transition.decision.kind);
      taskTerminalAtError.push(
        TERMINAL_TASK_STATUSES.has(
          must(await service.getTask(task.id), "after").status,
        ),
      );
    }

    // The router's default cap is derived from the shared budget, so it stops
    // respawning on exactly the error at which the task goes terminal. The last
    // decision is a terminal_failure (not a respawn), and the task is `failed`
    // at that same error — the divergence (router respawn while task failed) is
    // gone.
    expect(routerDecisions.at(-1)).toBe("terminal_failure");
    const respawnCount = routerDecisions.filter((d) => d === "respawn").length;
    // With budget N the router respawns N-1 times (sessions #2…#N), never an
    // (N+1)th orphan.
    expect(respawnCount).toBe(
      stateLostRespawnCapFor(MAX_SESSION_RETRY_ATTEMPTS),
    );
    expect(taskTerminalAtError.at(-1)).toBe(true);

    const final = must(await service.getTask(task.id), "final");
    expect(final.status).toBe("failed");
    // The number of errored sessions equals the budget — no extra orphan
    // session was spawned past the terminal decision.
    const erroredSessions = (final.sessions ?? []).filter(
      (s) => s.status === "errored",
    ).length;
    expect(erroredSessions).toBe(MAX_SESSION_RETRY_ATTEMPTS);
  });

  it("keeps the lineage non-terminal while the router still respawns (each error under the cap)", async () => {
    const acp = new FakeAcp();
    const { service, store } = makeServiceWithStore(acp);
    await service.start();
    const task = await service.createTask(createInput());

    // The first N-1 state-lost errors are under the router's respawn cap, so the
    // task must stay non-terminal (the router will re-drive it).
    const respawnBudget = stateLostRespawnCapFor(MAX_SESSION_RETRY_ATTEMPTS);
    for (let i = 0; i < respawnBudget; i += 1) {
      const detail = must(
        await service.spawnAgentForTask(task.id),
        "spawn detail",
      );
      const sessionId = must(detail.sessions.at(-1), "session").sessionId;
      await drive(acp, sessionId, "error", {
        failureKind: "session_state_lost",
        message: `state lost ${i + 1}`,
      });
      const detailAfter = must(await service.getTask(task.id), "after");
      expect(detailAfter.status).not.toBe("failed");
      const found = must(await store.findSession(sessionId), "found");
      expect(found.session.retryCount).toBe(i + 1);
    }
  });

  it("honors an operator-raised state-lost cap before failing the task", async () => {
    const acp = new FakeAcp();
    const { service, store } = makeServiceWithStore(acp, {
      ACPX_STATE_LOST_RESPAWN_CAP: "3",
    });
    await service.start();
    const task = await service.createTask(createInput());
    let loopState = createRouterLoopState({ stateLostRespawnCap: 3 });

    for (let i = 0; i < 3; i += 1) {
      const detail = must(
        await service.spawnAgentForTask(task.id),
        "spawn detail",
      );
      const sessionId = must(detail.sessions.at(-1), "session").sessionId;
      await drive(acp, sessionId, "error", {
        failureKind: "session_state_lost",
        message: `state lost override ${i + 1}`,
      });
      const transition = routerLoopTransition(loopState, {
        type: "state_lost",
        lineageKey: "override-lineage",
      });
      loopState = transition.state;
      expect(transition.decision.kind).toBe("respawn");
      expect(must(await service.getTask(task.id), "after").status).not.toBe(
        "failed",
      );
      const found = must(await store.findSession(sessionId), "found");
      expect(found.session.retryCount).toBe(i + 1);
    }

    const terminalSpawn = must(
      await service.spawnAgentForTask(task.id),
      "terminal spawn detail",
    );
    const terminalSessionId = must(
      terminalSpawn.sessions.at(-1),
      "terminal session",
    ).sessionId;
    await drive(acp, terminalSessionId, "error", {
      failureKind: "session_state_lost",
      message: "state lost override terminal",
    });
    const terminalTransition = routerLoopTransition(loopState, {
      type: "state_lost",
      lineageKey: "override-lineage",
    });
    expect(terminalTransition.decision.kind).toBe("terminal_failure");
    expect(must(await service.getTask(task.id), "final").status).toBe("failed");
  });

  it("restartTask resets the crash-retry budget so a restarted task survives its first recoverable blip", async () => {
    const acp = new FakeAcp();
    const { service, store } = makeServiceWithStore(acp);
    await service.start();
    const task = await service.createTask(createInput());

    // Exhaust the budget → terminal failed.
    for (let i = 0; i < MAX_SESSION_RETRY_ATTEMPTS; i += 1) {
      const status = must(await service.getTask(task.id), "s").status;
      if (TERMINAL_TASK_STATUSES.has(status)) break;
      const detail = must(await service.spawnAgentForTask(task.id), "spawn");
      const sessionId = must(detail.sessions.at(-1), "session").sessionId;
      await drive(acp, sessionId, "error", {
        failureKind: "session_state_lost",
        message: `state lost ${i + 1}`,
      });
    }
    expect(must(await service.getTask(task.id), "failed").status).toBe(
      "failed",
    );

    // Operator restarts. The restart stamps a fresh budget epoch, so the prior
    // run's dead errored sessions no longer count.
    const restarted = must(
      await service.restartTask(task.id, { instruction: "try again" }),
      "restarted",
    );
    expect(restarted.status).toBe("active");
    const epoch = restarted.metadata?.[RETRY_BUDGET_EPOCH_METADATA_KEY];
    expect(typeof epoch).toBe("number");
    expect(epoch as number).toBeGreaterThan(0);

    // A single recoverable state-lost error in the new run must NOT re-fail the
    // task — the budget reset means this is attempt 1 of the new run, not the
    // (already-spent) old one. Query the raw store (the DTO omits `spawnedAt`)
    // for the session the restart spawned at/after the epoch.
    const doc = must(await store.getTask(task.id), "doc");
    const freshSession = must(
      doc.sessions.filter((s) => s.spawnedAt >= (epoch as number)).at(-1),
      "fresh session spawned by restart",
    );
    await drive(acp, freshSession.sessionId, "error", {
      failureKind: "session_state_lost",
      message: "recoverable blip after restart",
    });
    const afterBlip = must(await service.getTask(task.id), "after blip");
    expect(afterBlip.status).not.toBe("failed");
  });
});
