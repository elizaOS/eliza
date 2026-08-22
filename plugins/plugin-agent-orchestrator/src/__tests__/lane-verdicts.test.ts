/**
 * A multi-lane task is done only when every lane has passed; a single lane's
 * pass records a lane verdict and returns the task to active. Real service +
 * memory store, no model.
 */
import { describe, expect, it, vi } from "vitest";
import { OrchestratorTaskService } from "../services/orchestrator-task-service.js";
import { OrchestratorTaskStore } from "../services/orchestrator-task-store.js";

async function addLane(
  store: OrchestratorTaskStore,
  taskId: string,
  sessionId: string,
  part: string,
  task: string,
): Promise<void> {
  const now = Date.now();
  await store.addSession({
    id: `row-${sessionId}`,
    taskId,
    sessionId,
    framework: "eliza-code",
    label: task,
    originalTask: `--- User Task ---\n${task}\n\n--- Script tasks ---\nx`,
    workdir: "/tmp/w",
    status: "completed",
    decisionCount: 0,
    autoResolvedCount: 0,
    registeredAt: now,
    lastActivityAt: now,
    idleCheckCount: 0,
    taskDelivered: true,
    lastSeenDecisionIndex: 0,
    spawnedAt: now,
    retryCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheTokens: 0,
    costUsd: 0,
    usageState: "unavailable",
    metadata: { requestVoicePart: part },
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
  });
}

describe("lane verdicts", () => {
  it("keeps a two-lane task open after the first lane passes and closes it after the second", async () => {
    const store = new OrchestratorTaskStore({ backend: "memory" });
    const released: string[] = [];
    const runtime = {
      character: { name: "Tester" },
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      getSetting: () => undefined,
      getService: (name: string) =>
        name === "ACPX_SUB_AGENT_ROUTER"
          ? {
              releaseDeferredCompletionRelay: (
                _t: string,
                v: string,
                s?: string,
              ) => released.push(`${v}:${s}`),
            }
          : undefined,
    };
    const service = new OrchestratorTaskService(runtime as never, { store });
    const detail = await store.createTask({
      title: "Coin Flip and Dice Roll Pages",
      goal: "two pages",
      acceptanceCriteria: ["the live URL is reachable"],
    });
    const taskId = detail.task.id;
    await addLane(store, taskId, "coin", "part:0", "Build a coin flip page");
    await addLane(store, taskId, "dice", "part:1", "Build a dice roll page");
    await store.updateTask(taskId, { status: "validating" });

    await service.validateTask(
      taskId,
      { passed: true, summary: "coin ok" },
      "coin",
    );
    let doc = await store.getTask(taskId);
    // Stays validating so the sibling lane's queued verification still runs.
    expect(doc?.task.status).toBe("validating");
    expect(doc?.task.metadata?.laneVerdicts).toEqual({ coin: "passed" });
    expect(
      doc?.events.some((e) => e.eventType === "lane_validation_passed"),
    ).toBe(true);
    expect(released).toEqual(["passed:coin"]);

    // A sibling's failed verdict moved the task to active meanwhile; the
    // remaining lane's pass must still land and close the task.
    await store.updateTask(taskId, { status: "active" });
    await service.validateTask(
      taskId,
      { passed: true, summary: "dice ok" },
      "dice",
    );
    doc = await store.getTask(taskId);
    expect(doc?.task.status).toBe("done");
    expect(released).toEqual(["passed:coin", "passed:dice"]);
  });

  it("promotes a single-lane task to done directly", async () => {
    const store = new OrchestratorTaskStore({ backend: "memory" });
    const runtime = {
      character: { name: "Tester" },
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      getSetting: () => undefined,
      getService: () => undefined,
    };
    const service = new OrchestratorTaskService(runtime as never, { store });
    const detail = await store.createTask({
      title: "t",
      goal: "g",
      acceptanceCriteria: ["x"],
    });
    await addLane(store, detail.task.id, "only", "part:0", "Build it");
    await store.updateTask(detail.task.id, { status: "validating" });
    await service.validateTask(
      detail.task.id,
      { passed: true, summary: "ok" },
      "only",
    );
    expect((await store.getTask(detail.task.id))?.task.status).toBe("done");
  });
});
