/**
 * Proves the change set the sub-agent produced (captured onto the LIVE ACP
 * session metadata at `task_complete`) is mirrored into the durable task-store
 * session record so the existing `/api/orchestrator/tasks/:id` detail route
 * serves it via `TaskSessionDto.metadata.lastChangeSet` — no new HTTP route.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AcpService } from "../services/acp-service.js";
import { toTaskThreadDetail } from "../services/orchestrator-task-mapper.js";
import { OrchestratorTaskService } from "../services/orchestrator-task-service.js";
import { OrchestratorTaskStore } from "../services/orchestrator-task-store.js";
import type { WorkspaceChangeSet } from "../services/workspace-diff.js";

type EventHandler = (sessionId: string, event: string, data: unknown) => void;

const CHANGE_SET: WorkspaceChangeSet = {
  changedFiles: ["src/app.ts", "README.md"],
  diffStat: "2 files changed, 4 insertions(+), 1 deletion(-)",
  diff: "diff --git a/src/app.ts b/src/app.ts\n@@\n+const x = 1;\n-const y = 2;",
  truncated: false,
  capturedAt: Date.now(),
};

function makeFakeAcp(sessionMetadata: Record<string, unknown>) {
  let handler: EventHandler | undefined;
  const service = {
    onSessionEvent(cb: EventHandler) {
      handler = cb;
      return () => {
        handler = undefined;
      };
    },
    getSession: vi.fn(async (sessionId: string) => ({
      id: sessionId,
      name: "Ada",
      workdir: "/tmp/x",
      metadata: sessionMetadata,
    })),
    // No tracked git change to capture; the change set comes from ACP metadata.
    getChangedPaths: vi.fn(() => [] as string[]),
    sendToSession: vi.fn(async () => ({
      stopReason: "end_turn",
      finalText: "",
    })),
    stopSession: vi.fn(async () => undefined),
  };
  return {
    service,
    emit: (sessionId: string, event: string, data: unknown) =>
      handler?.(sessionId, event, data),
  };
}

function makeRuntime(
  acp: ReturnType<typeof makeFakeAcp>["service"],
): Record<string, unknown> {
  return {
    character: { name: "Tester" },
    databaseAdapter: undefined,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    getSetting: () => undefined,
    useModel: vi.fn(async () => "{}"),
    getService: (type: string) =>
      type === AcpService.serviceType ? acp : undefined,
  };
}

async function seedTaskWithSession(
  store: OrchestratorTaskStore,
): Promise<{ taskId: string; sessionId: string }> {
  // No acceptance criteria → the auto-goal verifier no-ops and the task simply
  // moves to `validating`, isolating the change-set mirror under test.
  const detail = await store.createTask({
    title: "t",
    goal: "do the thing",
    acceptanceCriteria: [],
  });
  const taskId = detail.task.id;
  const sessionId = "sess-1";
  const now = Date.now();
  await store.addSession({
    id: "row-1",
    taskId,
    sessionId,
    framework: "opencode",
    label: "Ada",
    originalTask: "do the thing",
    workdir: "/tmp/x",
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
    metadata: { existingKey: "keep" },
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
  });
  await store.updateTask(taskId, { status: "active" });
  return { taskId, sessionId };
}

describe("change-set mirror into task store on task_complete", () => {
  let savedFlag: string | undefined;
  beforeEach(() => {
    savedFlag = process.env.ELIZA_ORCHESTRATOR_AUTO_GOAL_VERIFY;
    process.env.ELIZA_ORCHESTRATOR_AUTO_GOAL_VERIFY = "0";
  });
  afterEach(() => {
    if (savedFlag === undefined)
      delete process.env.ELIZA_ORCHESTRATOR_AUTO_GOAL_VERIFY;
    else process.env.ELIZA_ORCHESTRATOR_AUTO_GOAL_VERIFY = savedFlag;
  });

  it("mirrors the live ACP session's lastChangeSet onto the store session and into the mapped DTO", async () => {
    const fake = makeFakeAcp({ lastChangeSet: CHANGE_SET });
    const store = new OrchestratorTaskStore({ backend: "memory" });
    const { taskId, sessionId } = await seedTaskWithSession(store);
    const runtime = makeRuntime(fake.service);
    const service = new OrchestratorTaskService(runtime as never, { store });
    await service.start();

    fake.emit(sessionId, "task_complete", { response: "done" });

    await vi.waitFor(async () => {
      const found = await store.findSession(sessionId);
      expect(found?.session.metadata.lastChangeSet).toBeDefined();
    });

    const found = await store.findSession(sessionId);
    expect(found?.session.metadata.lastChangeSet).toEqual(CHANGE_SET);
    // Pre-existing metadata is preserved (merge, not replace).
    expect(found?.session.metadata.existingKey).toBe("keep");

    // The existing detail route serves the DTO produced by this mapper.
    const doc = await store.getTask(taskId);
    if (!doc) throw new Error("task missing");
    const dto = toTaskThreadDetail(doc);
    const sessionDto = dto.sessions.find((s) => s.sessionId === sessionId);
    expect(sessionDto?.metadata.lastChangeSet).toEqual(CHANGE_SET);
  });

  it("stores nothing when there is no change set", async () => {
    const fake = makeFakeAcp({});
    const store = new OrchestratorTaskStore({ backend: "memory" });
    const { sessionId } = await seedTaskWithSession(store);
    const runtime = makeRuntime(fake.service);
    const service = new OrchestratorTaskService(runtime as never, { store });
    await service.start();

    fake.emit(sessionId, "task_complete", { response: "done" });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const found = await store.findSession(sessionId);
    expect(found?.session.metadata.lastChangeSet).toBeUndefined();
    expect(found?.session.metadata.existingKey).toBe("keep");
  });
});
