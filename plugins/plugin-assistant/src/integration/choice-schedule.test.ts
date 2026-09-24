/** Exercises actual SQL list reads and choice dispatch with a corrupt stored schedule. */
import { ChannelType, type Memory, type UUID } from "@elizaos/core";
import { taskTable } from "@elizaos/plugin-sql";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { createIsolatedTestDatabase } from "../../../plugin-sql/src/__tests__/test-helpers";
import type { DrizzleDatabase } from "../../../plugin-sql/src/types";
import { choiceAction } from "../features/basic-capabilities/actions/choice";

it("rejects a damaged choice before worker effects while healthy and repaired choices execute", async () => {
  const f = await createIsolatedTestDatabase("choice-schedule-admission");
  const roomId = "11111111-1111-4111-8111-111111111111" as UUID;
  const effects: UUID[] = [];
  try {
    await f.adapter.createRooms([
      {
        id: roomId,
        agentId: f.testAgentId,
        name: "choice",
        source: "test",
        type: ChannelType.GROUP,
      },
    ]);
    f.runtime.registerTaskWorker({
      name: "choice-schedule",
      execute: async (_runtime, _options, task) => {
        if (!task.id) throw new Error("Expected persisted task ID");
        effects.push(task.id);
      },
    });
    const metadata = {
      options: [{ name: "run", description: "Run the task" }],
      scheduledAt: "2026-09-21T09:00:00Z",
    };
    const create = () =>
      f.adapter.createTask({
        name: "choice-schedule",
        roomId,
        tags: ["AWAITING_CHOICE"],
        metadata,
      });
    const healthy = await create();
    const damaged = await create();
    await (f.adapter.getDatabase() as DrizzleDatabase)
      .update(taskTable)
      .set({ metadata: { ...metadata, scheduledAt: "2026-02-30T00:00:00Z" } })
      .where(eq(taskTable.id, damaged));
    const message: Memory = {
      id: "22222222-2222-4222-8222-222222222222" as UUID,
      agentId: f.testAgentId,
      entityId: f.testAgentId,
      roomId,
      content: { text: "run", source: "test" },
    };
    const choose = (taskId: UUID, option = "run") =>
      choiceAction.handler(f.runtime, message, undefined, {
        parameters: { taskId, option },
      });
    expect(await choose(healthy)).toMatchObject({ success: true });
    expect(effects).toEqual([healthy]);
    await expect(choose(damaged)).rejects.toMatchObject({
      code: "TASK_SCHEDULE_INVALID",
    });
    expect(effects).toEqual([healthy]);
    const visible = await f.runtime.getTasks({
      roomId,
      tags: ["AWAITING_CHOICE"],
    });
    expect(
      visible.find((task) => task.id === damaged)?.metadata?.scheduledAt,
    ).toBe("2026-02-30T00:00:00Z");
    await f.adapter.patchTaskMetadata(damaged, {
      set: { scheduledAt: metadata.scheduledAt },
    });
    expect(await choose(damaged)).toMatchObject({ success: true });
    expect(effects).toEqual([healthy, damaged]);
    await (f.adapter.getDatabase() as DrizzleDatabase)
      .update(taskTable)
      .set({ metadata: { ...metadata, scheduledAt: "not-a-date" } })
      .where(eq(taskTable.id, damaged));
    expect(await choose(damaged, "ABORT")).toMatchObject({ success: true });
    expect(await f.runtime.getTask(damaged)).toBeNull();
    expect(effects).toEqual([healthy, damaged]);
  } finally {
    f.runtime.unregisterTaskWorker("choice-schedule");
    await f.cleanup();
  }
});
