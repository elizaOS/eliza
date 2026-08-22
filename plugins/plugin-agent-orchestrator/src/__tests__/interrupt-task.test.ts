/**
 * A user stop interrupts the durable task, not just the running session —
 * otherwise the wave launches the remaining lanes and the verifier keeps
 * lapping a build the user cancelled (live 2026-08-22).
 */
import { describe, expect, it, vi } from "vitest";
import { OrchestratorTaskService } from "../services/orchestrator-task-service.js";
import { OrchestratorTaskStore } from "../services/orchestrator-task-store.js";

function makeService(store: OrchestratorTaskStore): OrchestratorTaskService {
  const runtime = {
    character: { name: "Tester" },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    getSetting: () => undefined,
    getService: () => undefined,
  };
  return new OrchestratorTaskService(runtime as never, { store });
}

describe("interruptTask", () => {
  it("moves an active task to interrupted and records the reason", async () => {
    const store = new OrchestratorTaskStore({ backend: "memory" });
    const service = makeService(store);
    const detail = await store.createTask({
      title: "tetris",
      goal: "build it",
    });
    await store.updateTask(detail.task.id, { status: "active" });

    expect(await service.interruptTask(detail.task.id, "user_interrupt")).toBe(
      true,
    );
    const doc = await store.getTask(detail.task.id);
    expect(doc?.task.status).toBe("interrupted");
    expect(doc?.events.some((e) => e.eventType === "task_interrupted")).toBe(
      true,
    );
  });

  it("is a no-op on a finished or already interrupted task", async () => {
    const store = new OrchestratorTaskStore({ backend: "memory" });
    const service = makeService(store);
    const detail = await store.createTask({ title: "t", goal: "g" });
    await store.updateTask(detail.task.id, { status: "done" });
    expect(await service.interruptTask(detail.task.id, "user_interrupt")).toBe(
      false,
    );
    expect((await store.getTask(detail.task.id))?.task.status).toBe("done");
  });
});
