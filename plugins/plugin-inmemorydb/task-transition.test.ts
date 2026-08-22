/** Proves pending task transitions are serialized by the in-memory adapter. */
import type { Task, UUID } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { InMemoryDatabaseAdapter } from "./adapter";
import { MemoryStorage } from "./storage-memory";

const AGENT_ID = "20000000-0000-0000-0000-000000000001" as UUID;
const TASK_ID = "20000000-0000-0000-0000-000000000002" as UUID;

describe("plugin-inmemorydb pending task transitions", () => {
  it("allows exactly one competing lifecycle transition", async () => {
    const adapter = new InMemoryDatabaseAdapter(new MemoryStorage(), AGENT_ID);
    await adapter.initialize();
    await adapter.createTasks([
      {
        id: TASK_ID,
        agentId: AGENT_ID,
        name: "follow_up",
        tags: ["queue", "follow-up"],
        metadata: { status: "pending" },
      } satisfies Task,
    ]);

    const [completed, claimed] = await Promise.all([
      adapter.updatePendingTask(TASK_ID, {
        tags: ["follow-up"],
        metadata: { status: "completed" },
      }),
      adapter.updatePendingTask(TASK_ID, {
        tags: ["follow-up"],
        metadata: { status: "executing" },
      }),
    ]);

    expect([completed, claimed].filter(Boolean)).toHaveLength(1);
    const [stored] = await adapter.getTasksByIds([TASK_ID]);
    expect(stored.tags).not.toContain("queue");
    expect(["completed", "executing"]).toContain(stored.metadata?.status);
  });
});
