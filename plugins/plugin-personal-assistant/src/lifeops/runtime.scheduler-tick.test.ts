/** Verifies the LifeOps scheduler tick processes scheduled work and surfaces subsystem failures rather than swallowing them. Deterministic vitest with the scheduled-work path mocked. */
import type { IAgentRuntime, UUID } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { escalateUnacknowledgedIntents } from "./intent-sync.js";
import {
  executeLifeOpsSchedulerTask,
  resolveLifeOpsTaskIntervalMs,
} from "./runtime.js";

const scheduledWorkFixture = vi.hoisted(() => ({
  now: "2026-07-01T12:00:00.000Z",
  reminderAttempts: [],
  workflowRuns: [],
  scheduledTaskFires: [],
  scheduledTaskCompletionTimeouts: [],
  subsystemFailures: [{ subsystem: "reminders", error: "reminders down" }],
}));

vi.mock("./service.js", () => ({
  LifeOpsService: class {
    async processScheduledWork() {
      return scheduledWorkFixture;
    }
  },
}));

vi.mock("./intent-sync.js", () => ({
  escalateUnacknowledgedIntents: vi.fn(async () => ({ escalated: 0 })),
}));

const AGENT_ID = "00000000-0000-0000-0000-0000000000ee" as UUID;
const runtime = { agentId: AGENT_ID } as unknown as IAgentRuntime;

describe("executeLifeOpsSchedulerTask", () => {
  beforeEach(() => {
    vi.mocked(escalateUnacknowledgedIntents).mockReset();
    vi.mocked(escalateUnacknowledgedIntents).mockResolvedValue({
      escalated: 0,
    });
  });

  it("passes subsystemFailures through to the task result", async () => {
    const result = await executeLifeOpsSchedulerTask(runtime);
    expect(result.subsystemFailures).toEqual([
      { subsystem: "reminders", error: "reminders down" },
    ]);
    expect(result.nextInterval).toBe(resolveLifeOpsTaskIntervalMs(AGENT_ID));
    expect(result.now).toBe(scheduledWorkFixture.now);
  });

  it("completes the tick even when intent escalation throws", async () => {
    vi.mocked(escalateUnacknowledgedIntents).mockRejectedValue(
      new Error("escalation exploded"),
    );
    // A rethrow here would feed core's failure ladder even though the
    // scheduled work already completed — the guard must swallow + log.
    const result = await executeLifeOpsSchedulerTask(runtime);
    expect(result.now).toBe(scheduledWorkFixture.now);
    expect(result.subsystemFailures).toEqual(
      scheduledWorkFixture.subsystemFailures,
    );
  });
});
