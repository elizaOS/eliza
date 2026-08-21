/**
 * A redirect successor continues finished work in the predecessor's workdir;
 * its deliverable predates the successor session by construction. The fs
 * evidence floor must follow the `parentTaskId` lineage to the root's start,
 * or the script the successor re-ran is invisible to the verifier (live
 * 2026-08-21: "banana" failed for "no evidence that a script file exists").
 */
import { describe, expect, it, vi } from "vitest";
import { OrchestratorTaskService } from "../services/orchestrator-task-service.js";
import { OrchestratorTaskStore } from "../services/orchestrator-task-store.js";

async function addSession(
  store: OrchestratorTaskStore,
  taskId: string,
  sessionId: string,
  registeredAt: number,
): Promise<void> {
  await store.addSession({
    id: `row-${sessionId}`,
    taskId,
    sessionId,
    framework: "eliza-code",
    label: "fruit-picker",
    originalTask: "t",
    workdir: "/tmp/w",
    status: "completed",
    decisionCount: 0,
    autoResolvedCount: 0,
    registeredAt,
    lastActivityAt: registeredAt,
    idleCheckCount: 0,
    taskDelivered: true,
    lastSeenDecisionIndex: 0,
    spawnedAt: registeredAt,
    retryCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheTokens: 0,
    costUsd: 0,
    usageState: "unavailable",
    metadata: {},
    createdAt: new Date(registeredAt).toISOString(),
    updatedAt: new Date(registeredAt).toISOString(),
  });
}

describe("fs evidence floor follows task lineage", () => {
  it("reaches back to the lineage root's earliest session start", async () => {
    const store = new OrchestratorTaskStore({ backend: "memory" });
    const runtime = {
      character: { name: "Tester" },
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      getSetting: () => undefined,
      getService: () => undefined,
    };
    const service = new OrchestratorTaskService(runtime as never, { store });
    const rootStart = Date.parse("2026-08-21T21:44:00Z");
    const root = await store.createTask({
      title: "Fruit Picker Script",
      goal: "write it",
    });
    await addSession(store, root.task.id, "root-sess", rootStart);
    const middle = await store.createTask({
      title: "Fruit Picker Script",
      goal: "run it again",
      parentTaskId: root.task.id,
    });
    await addSession(store, middle.task.id, "middle-sess", rootStart + 60_000);
    const successor = await store.createTask({
      title: "Fruit Picker Script",
      goal: "run it once more",
      parentTaskId: middle.task.id,
    });
    const successorStart = rootStart + 120_000;
    await addSession(store, successor.task.id, "succ-sess", successorStart);

    const doc = await store.getTask(successor.task.id);
    const floor = await (
      service as unknown as {
        fsObservationFloor: (d: unknown, s: number) => Promise<number>;
      }
    ).fsObservationFloor(doc, successorStart);
    expect(floor).toBeLessThanOrEqual(rootStart);

    const rootDoc = await store.getTask(root.task.id);
    const rootFloor = await (
      service as unknown as {
        fsObservationFloor: (d: unknown, s: number) => Promise<number>;
      }
    ).fsObservationFloor(rootDoc, rootStart);
    expect(rootFloor).toBe(rootStart);
  });
});
