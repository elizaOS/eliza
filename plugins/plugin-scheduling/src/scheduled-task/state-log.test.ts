/**
 * Unit tests for the ScheduledTask state-log writer and its in-memory store:
 * one row per transition, history reads, and retention/rollup of expired
 * entries into daily summaries. Deterministic, in-memory store.
 */

import { describe, expect, it } from "vitest";
import {
  createInMemoryScheduledTaskLogStore,
  createStateLogger,
  STATE_LOG_DEFAULT_RETENTION_DAYS,
} from "./state-log.js";
import type {
  ScheduledTaskLogEntry,
  ScheduledTaskLogTransition,
} from "./types.js";

const AGENT = "agent-1";

function entry(
  over: Partial<ScheduledTaskLogEntry> & {
    logId: string;
    taskId: string;
    occurredAtIso: string;
    transition: ScheduledTaskLogTransition;
  },
): ScheduledTaskLogEntry {
  return { agentId: AGENT, rolledUp: false, ...over };
}

describe("createInMemoryScheduledTaskLogStore — list", () => {
  it("returns only the requested agent+task, sorted by time", async () => {
    const store = createInMemoryScheduledTaskLogStore();
    await store.append(
      entry({
        logId: "b",
        taskId: "t1",
        occurredAtIso: "2026-01-02T00:00:00.000Z",
        transition: "fired",
      }),
    );
    await store.append(
      entry({
        logId: "a",
        taskId: "t1",
        occurredAtIso: "2026-01-01T00:00:00.000Z",
        transition: "scheduled",
      }),
    );
    await store.append(
      entry({
        logId: "other",
        taskId: "t2",
        occurredAtIso: "2026-01-01T00:00:00.000Z",
        transition: "fired",
      }),
    );
    const rows = await store.list({ agentId: AGENT, taskId: "t1" });
    expect(rows.map((r) => r.logId)).toEqual(["a", "b"]);
  });

  it("applies inclusive since / exclusive until bounds", async () => {
    const store = createInMemoryScheduledTaskLogStore();
    for (const day of ["01", "02", "03"]) {
      await store.append(
        entry({
          logId: day,
          taskId: "t1",
          occurredAtIso: `2026-01-${day}T00:00:00.000Z`,
          transition: "fired",
        }),
      );
    }
    const rows = await store.list({
      agentId: AGENT,
      taskId: "t1",
      sinceIso: "2026-01-02T00:00:00.000Z",
      untilIso: "2026-01-03T00:00:00.000Z",
    });
    expect(rows.map((r) => r.logId)).toEqual(["02"]);
  });

  it("honors excludeRollups and limit, and returns copies", async () => {
    const store = createInMemoryScheduledTaskLogStore();
    await store.append(
      entry({
        logId: "raw",
        taskId: "t1",
        occurredAtIso: "2026-01-01T00:00:00.000Z",
        transition: "fired",
      }),
    );
    await store.append(
      entry({
        logId: "roll",
        taskId: "t1",
        occurredAtIso: "2026-01-01T00:00:00.000Z",
        transition: "fired",
        rolledUp: true,
      }),
    );
    expect(
      (
        await store.list({ agentId: AGENT, taskId: "t1", excludeRollups: true })
      ).map((r) => r.logId),
    ).toEqual(["raw"]);
    expect(
      await store.list({ agentId: AGENT, taskId: "t1", limit: 1 }),
    ).toHaveLength(1);

    const rows = await store.list({ agentId: AGENT, taskId: "t1" });
    const first = rows[0];
    if (!first) {
      throw new Error("Expected a raw state log row");
    }
    first.reason = "mutated";
    const again = await store.list({ agentId: AGENT, taskId: "t1" });
    expect(again[0]?.reason).toBeUndefined(); // store row untouched
  });
});

describe("createInMemoryScheduledTaskLogStore — rollupOlderThan", () => {
  it("folds expired raw rows into per-task/day/transition summaries", async () => {
    const store = createInMemoryScheduledTaskLogStore();
    // 3 'fired' on Jan-01, 1 'completed' on Jan-02, 1 recent (kept).
    for (let i = 0; i < 3; i++) {
      await store.append(
        entry({
          logId: `f${i}`,
          taskId: "t1",
          occurredAtIso: `2026-01-01T0${i}:00:00.000Z`,
          transition: "fired",
        }),
      );
    }
    await store.append(
      entry({
        logId: "c",
        taskId: "t1",
        occurredAtIso: "2026-01-02T00:00:00.000Z",
        transition: "completed",
      }),
    );
    await store.append(
      entry({
        logId: "recent",
        taskId: "t1",
        occurredAtIso: "2026-06-01T00:00:00.000Z",
        transition: "fired",
      }),
    );

    const result = await store.rollupOlderThan({
      agentId: AGENT,
      olderThanIso: "2026-02-01T00:00:00.000Z",
    });
    expect(result).toEqual({ rolledUp: 2, deletedRaw: 4 });

    const all = await store.list({ agentId: AGENT, taskId: "t1" });
    const rollups = all.filter((r) => r.rolledUp);
    expect(rollups).toHaveLength(2);
    const firedRollup = rollups.find((r) => r.transition === "fired");
    expect(firedRollup?.detail).toEqual({ rollupCount: 3 });
    expect(firedRollup?.occurredAtIso).toBe("2026-01-01T00:00:00.000Z");

    // Raw expired rows are gone; the recent row survives.
    expect(all.filter((r) => !r.rolledUp).map((r) => r.logId)).toEqual([
      "recent",
    ]);
  });

  it("is a no-op when nothing is expired", async () => {
    const store = createInMemoryScheduledTaskLogStore();
    await store.append(
      entry({
        logId: "recent",
        taskId: "t1",
        occurredAtIso: "2026-06-01T00:00:00.000Z",
        transition: "fired",
      }),
    );
    expect(
      await store.rollupOlderThan({
        agentId: AGENT,
        olderThanIso: "2026-01-01T00:00:00.000Z",
      }),
    ).toEqual({ rolledUp: 0, deletedRaw: 0 });
  });

  it("does not re-roll already-rolled-up rows", async () => {
    const store = createInMemoryScheduledTaskLogStore();
    await store.append(
      entry({
        logId: "old-roll",
        taskId: "t1",
        occurredAtIso: "2026-01-01T00:00:00.000Z",
        transition: "fired",
        rolledUp: true,
      }),
    );
    expect(
      await store.rollupOlderThan({
        agentId: AGENT,
        olderThanIso: "2026-02-01T00:00:00.000Z",
      }),
    ).toEqual({ rolledUp: 0, deletedRaw: 0 });
  });
});

describe("createStateLogger", () => {
  it("writes an entry with injected id + clock and returns it", async () => {
    const store = createInMemoryScheduledTaskLogStore();
    let n = 0;
    const logger = createStateLogger({
      store,
      agentId: AGENT,
      newLogId: () => `log-${++n}`,
      now: () => new Date("2026-03-04T05:06:07.000Z"),
    });
    const written = await logger.log("t1", "fired", {
      reason: "due",
      detail: { x: 1 },
    });
    expect(written).toMatchObject({
      logId: "log-1",
      taskId: "t1",
      agentId: AGENT,
      occurredAtIso: "2026-03-04T05:06:07.000Z",
      transition: "fired",
      reason: "due",
      rolledUp: false,
      detail: { x: 1 },
    });
    const rows = await store.list({ agentId: AGENT, taskId: "t1" });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.logId).toBe("log-1");
  });

  it("exposes the documented default retention", () => {
    expect(STATE_LOG_DEFAULT_RETENTION_DAYS).toBe(90);
  });
});
