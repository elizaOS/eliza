import { describe, expect, it } from "vitest";
import { InMemoryTaskStore } from "./orchestrator-task-store.js";

describe("OrchestratorTaskStore safe-sort", () => {
  it("sorts tasks deterministically when lastActivityAt contains non-finite numbers", async () => {
    const store = new InMemoryTaskStore();
    const doc1 = await store.createTask({
      title: "Task NaN",
      goal: "Goal NaN",
    });
    const doc2 = await store.createTask({
      title: "Task High",
      goal: "Goal High",
    });
    const doc3 = await store.createTask({
      title: "Task Low",
      goal: "Goal Low",
    });
    await store.updateTask(doc1.task.id, { lastActivityAt: Number.NaN });
    await store.updateTask(doc2.task.id, { lastActivityAt: 2000 });
    await store.updateTask(doc3.task.id, { lastActivityAt: 500 });
    const list = await store.listTasks();
    expect(list.map((t) => t.id)).toEqual([
      doc2.task.id,
      doc3.task.id,
      doc1.task.id,
    ]);
  });
});
