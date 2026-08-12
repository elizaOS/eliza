/**
 * Regression: a sub-agent `task_complete` must be attributed to the task it was
 * PRODUCED for, not to whatever task the shared ACP session's mutable binding
 * currently points at (#18490).
 *
 * Under worker-slot pressure one warm elizaos session serves several tasks in
 * turn. Task A can reach a terminal status and have its session become reusable
 * BEFORE A's `task_complete` has drained; task B's re-home of that session then
 * lands in the ~1s window and, on the old code, A's completion is recorded
 * against B (moving B to `validating` carrying A's deliverable). The fix stamps
 * every terminal event with its producing-task id and prefers it at the
 * attribution chokepoint, backed by a non-repoint invariant on `attachSession`.
 *
 * Deterministic: real in-memory `OrchestratorTaskStore`, the same ACP
 * event-bridge harness proven in `sub-agent-router-failover-resume.test.ts`.
 * No concurrency, no subprocess, no model.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { OrchestratorTaskService } from "../../src/services/orchestrator-task-service.js";
import { OrchestratorTaskStore } from "../../src/services/orchestrator-task-store.js";
import type { OrchestratorTaskSession } from "../../src/services/orchestrator-task-types.js";

const WORKDIR = "/tmp/completion-task-scope-repo";

function makeTaskAcp() {
  let handler:
    | ((sessionId: string, event: string, data: unknown) => void)
    | undefined;
  const service = {
    onSessionEvent: vi.fn((fn: typeof handler) => {
      handler = fn;
      return () => {
        handler = undefined;
      };
    }),
    getSession: vi.fn(async () => null),
    getChangedPaths: vi.fn(() => [] as string[]),
  };
  return {
    service,
    emit(sessionId: string, event: string, data: unknown) {
      handler?.(sessionId, event, data);
    },
  };
}

function makeTaskRuntime(acpService: unknown) {
  return {
    agentId: "00000000-0000-0000-0000-000000000001",
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    getService: vi.fn(() => acpService),
    getSetting: vi.fn(() => undefined),
    reportError: vi.fn(),
  } as never;
}

async function flushEventBridge() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

async function waitForTaskStatus(
  store: OrchestratorTaskStore,
  taskId: string,
  status: string,
) {
  for (let i = 0; i < 40; i++) {
    const doc = await store.getTask(taskId);
    if (doc?.task.status === status) return doc;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return store.getTask(taskId);
}

function makeStoredSession(
  taskId: string,
  sessionId: string,
  patch: Partial<OrchestratorTaskSession> = {},
): OrchestratorTaskSession {
  const now = Date.now();
  const iso = new Date("2026-07-11T00:00:00.000Z").toISOString();
  return {
    id: `${sessionId}-row`,
    taskId,
    sessionId,
    framework: "claude",
    label: "worker",
    originalTask: "Implement the widget and add tests",
    workdir: WORKDIR,
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
    createdAt: iso,
    updatedAt: iso,
    ...patch,
  };
}

describe("#18490 — task_complete is attributed to the producing task, not the session's current binding owner", () => {
  const previousAutoVerify = process.env.ELIZA_ORCHESTRATOR_AUTO_GOAL_VERIFY;

  afterEach(() => {
    if (previousAutoVerify === undefined) {
      delete process.env.ELIZA_ORCHESTRATOR_AUTO_GOAL_VERIFY;
    } else {
      process.env.ELIZA_ORCHESTRATOR_AUTO_GOAL_VERIFY = previousAutoVerify;
    }
  });

  it("FAILS-ON-OLD: A's completion lands on A even after the session is re-homed to B", async () => {
    process.env.ELIZA_ORCHESTRATOR_AUTO_GOAL_VERIFY = "0";
    const acp = makeTaskAcp();
    const runtime = makeTaskRuntime(acp.service);
    const store = new OrchestratorTaskStore({ backend: "memory" });
    const service = new OrchestratorTaskService(runtime, { store });
    await service.start();

    const SHARED = "e278bae9-0000-4000-8000-000000000001";
    const a = await store.createTask({
      title: "A",
      goal: "build A",
      acceptanceCriteria: ["A ships"],
    });
    const b = await store.createTask({
      title: "B",
      goal: "build B",
      acceptanceCriteria: ["B ships"],
    });

    // Session is spawned FOR task A and stamps its own taskId (immutable).
    await service.attachSession(a.task.id, {
      sessionId: SHARED,
      agentType: "claude",
      label: "worker",
      workdir: "/tmp/task-a",
      status: "ready",
      metadata: { taskId: a.task.id },
    });

    // The corruption window: task B tries to re-home the binding before A
    // drains. On OLD code attachSession unconditionally repoints
    // sessionTaskIndex→B and dual-homes the row; on NEW code the repoint is
    // refused because A is still non-terminal.
    await service.attachSession(b.task.id, {
      sessionId: SHARED,
      agentType: "claude",
      label: "worker",
      workdir: "/tmp/task-b",
      status: "ready",
      metadata: { taskId: b.task.id },
    });

    // A's terminal event carries A's producing-task id and A's deliverable.
    acp.emit(SHARED, "task_complete", {
      response: "A deliverable: index.html for task A",
      producingTaskId: a.task.id,
    });
    await flushEventBridge();

    const docA = await waitForTaskStatus(store, a.task.id, "validating");
    const docB = await store.getTask(b.task.id);

    // A got its own completion...
    expect(docA?.task.status).toBe("validating");
    expect(
      docA?.sessions.find((s) => s.sessionId === SHARED)?.completionSummary,
    ).toContain("index.html for task A");
    // ...and B was NOT credited with A's deliverable.
    expect(docB?.task.status).not.toBe("validating");
    expect(
      docB?.sessions.find((s) => s.sessionId === SHARED)?.taskDelivered ?? false,
    ).toBe(false);

    await service.stop();
  });

  it("allows cross-task attach when the prior owner task is terminal (Smithers recovery)", async () => {
    process.env.ELIZA_ORCHESTRATOR_AUTO_GOAL_VERIFY = "0";
    const acp = makeTaskAcp();
    const runtime = makeTaskRuntime(acp.service);
    const store = new OrchestratorTaskStore({ backend: "memory" });
    const service = new OrchestratorTaskService(runtime, { store });
    await service.start();

    const SHARED = "e278bae9-0000-4000-8000-000000000002";
    const a = await store.createTask({
      title: "A-term",
      goal: "build A",
      acceptanceCriteria: ["A ships"],
    });
    const b = await store.createTask({
      title: "B-recover",
      goal: "build B",
      acceptanceCriteria: ["B ships"],
    });

    const attachedA = await service.attachSession(a.task.id, {
      sessionId: SHARED,
      agentType: "claude",
      label: "worker",
      workdir: "/tmp/task-a",
      status: "ready",
      metadata: { taskId: a.task.id },
    });
    expect(attachedA).toBe(true);

    // Prior owner A is now terminal/gone — the restart-recovery attach for B
    // MUST be allowed (this is the one legitimate cross-task re-home).
    await store.updateTask(a.task.id, { status: "failed" });

    const attachedB = await service.attachSession(b.task.id, {
      sessionId: SHARED,
      agentType: "claude",
      label: "worker",
      workdir: "/tmp/task-b",
      status: "ready",
      metadata: { taskId: b.task.id },
    });
    expect(attachedB).toBe(true);
    expect((await service.getTaskForSession(SHARED))?.id).toBe(b.task.id);

    await service.stop();
  });

  it("keeps same-task keepAlive follow-ups attributed to the same task", async () => {
    process.env.ELIZA_ORCHESTRATOR_AUTO_GOAL_VERIFY = "0";
    const acp = makeTaskAcp();
    const runtime = makeTaskRuntime(acp.service);
    const store = new OrchestratorTaskStore({ backend: "memory" });
    const service = new OrchestratorTaskService(runtime, { store });
    await service.start();

    const SHARED = "e278bae9-0000-4000-8000-000000000003";
    const a = await store.createTask({
      title: "A-keepalive",
      goal: "build A",
      acceptanceCriteria: ["A ships"],
    });

    await store.addSession(makeStoredSession(a.task.id, SHARED));

    // First progressive completion under the same task.
    acp.emit(SHARED, "task_complete", {
      response: "A first deliverable",
      producingTaskId: a.task.id,
    });
    await flushEventBridge();
    const firstDoc = await waitForTaskStatus(store, a.task.id, "validating");
    expect(firstDoc?.task.status).toBe("validating");

    // A keepAlive follow-up on the SAME session still identifies as A.
    acp.emit(SHARED, "task_complete", {
      response: "A follow-up deliverable",
      producingTaskId: a.task.id,
    });
    await flushEventBridge();
    const secondDoc = await store.getTask(a.task.id);
    expect(secondDoc?.task.status).toBe("validating");
    expect(
      secondDoc?.sessions.find((s) => s.sessionId === SHARED)?.taskDelivered,
    ).toBe(true);

    await service.stop();
  });
});
