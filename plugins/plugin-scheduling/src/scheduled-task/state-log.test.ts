import { describe, expect, it } from "vitest";

import { createInMemoryScheduledTaskLogStore } from "./state-log.js";
import type { ScheduledTaskLogEntry } from "./types.js";

const AGENT_ID = "agent-rollup";
const TASK_ID = "task-rollup";
const ROLLUP_ID = `rollup:${JSON.stringify([TASK_ID, "2026-05-01", "fire_attempt"])}`;

function rawEntry(
  logId: string,
  occurredAtIso: string,
  reason: string,
): ScheduledTaskLogEntry {
  return {
    logId,
    taskId: TASK_ID,
    agentId: AGENT_ID,
    occurredAtIso,
    transition: "fire_attempt",
    reason,
    rolledUp: false,
  };
}

describe("in-memory scheduling state log rollup", () => {
  it("adds a later expiry to the existing day summary instead of writing a second row under the same id", async () => {
    const store = createInMemoryScheduledTaskLogStore();
    await store.append(rawEntry("raw-1", "2026-05-01T09:00:00.000Z", "first"));
    await store.append(rawEntry("raw-2", "2026-05-01T10:00:00.000Z", "second"));
    await store.append(rawEntry("raw-3", "2026-05-01T11:00:00.000Z", "third"));

    expect(
      await store.rollupOlderThan({
        agentId: AGENT_ID,
        olderThanIso: "2026-05-02T00:00:00.000Z",
      }),
    ).toEqual({ rolledUp: 1, deletedRaw: 3 });

    // Two more transitions of the same kind expire on the next nightly pass.
    await store.append(rawEntry("raw-4", "2026-05-01T12:00:00.000Z", "fourth"));
    await store.append(rawEntry("raw-5", "2026-05-01T13:00:00.000Z", "fifth"));

    expect(
      await store.rollupOlderThan({
        agentId: AGENT_ID,
        olderThanIso: "2026-05-03T00:00:00.000Z",
      }),
    ).toEqual({ rolledUp: 1, deletedRaw: 2 });

    // One summary row per task, day and transition, with the count of every
    // transition the two passes folded in.
    expect(await store.list({ agentId: AGENT_ID, taskId: TASK_ID })).toEqual([
      {
        logId: ROLLUP_ID,
        taskId: TASK_ID,
        agentId: AGENT_ID,
        occurredAtIso: "2026-05-01T00:00:00.000Z",
        transition: "fire_attempt",
        reason: "fourth",
        rolledUp: true,
        detail: { rollupCount: 5 },
      },
    ]);
  });

  it("reports no rollup when the same window is rolled up again", async () => {
    const store = createInMemoryScheduledTaskLogStore();
    await store.append(rawEntry("raw-1", "2026-05-01T09:00:00.000Z", "first"));

    expect(
      await store.rollupOlderThan({
        agentId: AGENT_ID,
        olderThanIso: "2026-05-02T00:00:00.000Z",
      }),
    ).toEqual({ rolledUp: 1, deletedRaw: 1 });

    expect(
      await store.rollupOlderThan({
        agentId: AGENT_ID,
        olderThanIso: "2026-05-02T00:00:00.000Z",
      }),
    ).toEqual({ rolledUp: 0, deletedRaw: 0 });

    expect(await store.list({ agentId: AGENT_ID, taskId: TASK_ID })).toEqual([
      {
        logId: ROLLUP_ID,
        taskId: TASK_ID,
        agentId: AGENT_ID,
        occurredAtIso: "2026-05-01T00:00:00.000Z",
        transition: "fire_attempt",
        reason: "first",
        rolledUp: true,
        detail: { rollupCount: 1 },
      },
    ]);
  });
});
