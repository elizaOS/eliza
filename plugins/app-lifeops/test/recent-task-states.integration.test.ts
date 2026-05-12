/**
 * `RecentTaskStatesProvider.summarize` reads the scheduled-task log and
 * returns a streak / notable summary the W1-D quiet-user-watcher consumes.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  appendScheduledTaskLogEntry,
  createRecentTaskStatesProvider,
} from "../src/providers/recent-task-states.ts";
import { createMinimalRuntimeStub } from "./first-run-helpers.ts";

describe("recent task states integration", () => {
  it("computes a 3-in-a-row skipped streak and surfaces notable observations", async () => {
    const runtime = createMinimalRuntimeStub();
    const baseTime = Date.now() - 60_000;
    for (let i = 0; i < 3; i += 1) {
      await appendScheduledTaskLogEntry(runtime, {
        taskId: `t${i}`,
        kind: "checkin",
        outcome: "skipped",
        recordedAt: new Date(baseTime + i * 1_000).toISOString(),
        notable: i === 0 ? "missed first morning of the week" : undefined,
      });
    }
    const provider = createRecentTaskStatesProvider(runtime);
    const summary = await provider.summarize();
    expect(summary.streaks.length).toBeGreaterThanOrEqual(1);
    const skippedStreak = summary.streaks.find(
      (s) => s.kind === "checkin" && s.outcome === "skipped",
    );
    expect(skippedStreak?.consecutive).toBe(3);
    expect(summary.summary).toMatch(/skipped streak/);
    expect(summary.notable.length).toBe(1);
  });

  it("filters by kind and lookbackDays", async () => {
    const runtime = createMinimalRuntimeStub();
    const recent = new Date().toISOString();
    const ancient = new Date(Date.now() - 30 * 86_400_000).toISOString();
    await appendScheduledTaskLogEntry(runtime, {
      taskId: "t-recent-checkin",
      kind: "checkin",
      outcome: "completed",
      recordedAt: recent,
    });
    await appendScheduledTaskLogEntry(runtime, {
      taskId: "t-ancient-reminder",
      kind: "reminder",
      outcome: "expired",
      recordedAt: ancient,
    });
    const provider = createRecentTaskStatesProvider(runtime);
    const summary = await provider.summarize({
      kinds: ["checkin"],
      lookbackDays: 7,
    });
    expect(summary.summary).toMatch(/checkin: 1 done/);
    expect(summary.summary).not.toMatch(/reminder/);
  });
});
