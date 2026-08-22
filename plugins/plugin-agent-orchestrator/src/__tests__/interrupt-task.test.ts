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

  it("interrupts only the room's in-flight tasks, leaving parked and finished ones", async () => {
    const store = new OrchestratorTaskStore({ backend: "memory" });
    const service = makeService(store);
    const mk = async (title: string, status: string, roomId: string) => {
      const d = await store.createTask({ title, goal: "g", roomId });
      await store.updateTask(d.task.id, { status: status as never });
      return d.task.id;
    };
    const spawning = await mk("pong", "open", "room-a");
    const running = await mk("snake", "active", "room-a");
    const parked = await mk("tetris", "waiting_on_user", "room-a");
    const elsewhere = await mk("other", "active", "room-b");

    const titles = await service.interruptInFlightTasksForRoom(
      "room-a",
      "user_cancel",
    );
    expect(titles.sort()).toEqual(["pong", "snake"]);
    expect((await store.getTask(spawning))?.task.status).toBe("interrupted");
    expect((await store.getTask(running))?.task.status).toBe("interrupted");
    expect((await store.getTask(parked))?.task.status).toBe("waiting_on_user");
    expect((await store.getTask(elsewhere))?.task.status).toBe("active");
  });
});
