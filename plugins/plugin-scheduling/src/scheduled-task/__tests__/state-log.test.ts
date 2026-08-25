import { describe, expect, it } from "vitest";
import { createInMemoryScheduledTaskLogStore } from "./state-log.ts";

function entry(overrides: Record<string, unknown> = {}) {
  return {
    logId: "log-1",
    agentId: "agent-1",
    taskId: "task-1",
    occurredAtIso: "2026-08-25T10:00:00.000Z",
    transition: "ran",
    ...overrides,
  } as never;
}

describe("createInMemoryScheduledTaskLogStore", () => {
  it("appends and lists entries for a task", async () => {
    const store = createInMemoryScheduledTaskLogStore();
    await store.append(entry());
    const rows = await store.list({ agentId: "agent-1", taskId: "task-1" });
    expect(rows).toHaveLength(1);
    expect(rows[0].logId).toBe("log-1");
  });

  it("rejects duplicate log ids", async () => {
    const store = createInMemoryScheduledTaskLogStore();
    await store.append(entry());
    await expect(store.append(entry())).rejects.toThrow(/already exists/);
  });

  it("filters by agent and task", async () => {
    const store = createInMemoryScheduledTaskLogStore();
    await store.append(entry());
    await store.append(entry({ logId: "log-2", agentId: "agent-2" }));
    const rows = await store.list({ agentId: "agent-1", taskId: "task-1" });
    expect(rows).toHaveLength(1);
  });

  it("sorts by occurredAtIso ascending", async () => {
    const store = createInMemoryScheduledTaskLogStore();
    await store.append(
      entry({ logId: "log-2", occurredAtIso: "2026-08-25T12:00:00.000Z" }),
    );
    await store.append(
      entry({ logId: "log-1", occurredAtIso: "2026-08-25T08:00:00.000Z" }),
    );
    const rows = await store.list({ agentId: "agent-1", taskId: "task-1" });
    expect(rows[0].logId).toBe("log-1");
    expect(rows[1].logId).toBe("log-2");
  });

  it("applies the since filter inclusively", async () => {
    const store = createInMemoryScheduledTaskLogStore();
    await store.append(
      entry({ logId: "log-1", occurredAtIso: "2026-08-25T08:00:00.000Z" }),
    );
    await store.append(
      entry({ logId: "log-2", occurredAtIso: "2026-08-25T12:00:00.000Z" }),
    );
    const rows = await store.list({
      agentId: "agent-1",
      taskId: "task-1",
      sinceIso: "2026-08-25T09:00:00.000Z",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].logId).toBe("log-2");
  });

  it("applies the limit", async () => {
    const store = createInMemoryScheduledTaskLogStore();
    for (let i = 0; i < 5; i++) {
      await store.append(
        entry({
          logId: `log-${i}`,
          occurredAtIso: `2026-08-25T0${i}:00:00.000Z`,
        }),
      );
    }
    const rows = await store.list({
      agentId: "agent-1",
      taskId: "task-1",
      limit: 2,
    });
    expect(rows).toHaveLength(2);
  });
});
