/** Verifies startup database maintenance is awaited and failure-observable. */
import type { IAgentRuntime, Task, UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { RuntimeMaintenanceService } from "./runtime-maintenance-service.ts";

const AGENT_ID = "00000000-0000-0000-0000-000000000001" as UUID;

function runtimeStub(overrides: Partial<IAgentRuntime> = {}): IAgentRuntime {
  return {
    agentId: AGENT_ID,
    getTasks: vi.fn(async () => [] as Task[]),
    createTask: vi.fn(async () => "task-id" as UUID),
    reportError: vi.fn(),
    logger: { warn: vi.fn() },
    ...overrides,
  } as unknown as IAgentRuntime;
}

describe("RuntimeMaintenanceService", () => {
  it("does not report ready until all startup database work settles", async () => {
    const releaseCreateTasks: Array<() => void> = [];
    const createTask = vi.fn(
      () =>
        new Promise<UUID>((resolve) => {
          releaseCreateTasks.push(() => resolve("task-id" as UUID));
        }),
    );
    const runtime = runtimeStub({ createTask } as Partial<IAgentRuntime>);
    let started = false;
    const start = RuntimeMaintenanceService.start(runtime).then(() => {
      started = true;
    });

    await vi.waitFor(() => expect(createTask).toHaveBeenCalledTimes(2));
    expect(started).toBe(false);
    for (const release of releaseCreateTasks) release();
    await start;
    expect(started).toBe(true);
  });

  it("reports maintenance failures without detaching rejected work", async () => {
    const failure = new Error("database read failed");
    const reportError = vi.fn();
    const runtime = runtimeStub({
      getTasks: vi.fn(async () => {
        throw failure;
      }),
      reportError,
    } as Partial<IAgentRuntime>);

    await expect(
      RuntimeMaintenanceService.start(runtime),
    ).resolves.toBeInstanceOf(RuntimeMaintenanceService);
    expect(reportError).toHaveBeenCalledTimes(3);
    expect(reportError).toHaveBeenCalledWith(
      "workbench-schedule-tag-migration",
      failure,
      { phase: "startup-maintenance" },
    );
    expect(reportError).toHaveBeenCalledWith(
      "knowledge-backfill-schedule",
      failure,
      { phase: "startup-maintenance" },
    );
    expect(reportError).toHaveBeenCalledWith("media-gc-schedule", failure, {
      phase: "startup-maintenance",
    });
  });
});
