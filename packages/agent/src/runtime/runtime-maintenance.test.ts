/** Exercises the real post-migration ownership boundary with parallel task-store work. */

import type { IAgentRuntime, Task, UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { runRuntimeStartupMaintenance } from "./runtime-maintenance.ts";

const AGENT_ID = "00000000-0000-0000-0000-000000000001" as UUID;

function runtimeStub(overrides: Partial<IAgentRuntime> = {}): IAgentRuntime {
  return {
    agentId: AGENT_ID,
    getTasks: vi.fn(async () => [] as Task[]),
    createTask: vi.fn(async () => "task-id" as UUID),
    reportError: vi.fn(),
    logger: { info: vi.fn() },
    ...overrides,
  } as unknown as IAgentRuntime;
}

describe("runRuntimeStartupMaintenance", () => {
  it("does not report completion until every parallel database write settles", async () => {
    const releaseCreateTasks: Array<() => void> = [];
    const createTask = vi.fn(
      () =>
        new Promise<UUID>((resolve) => {
          releaseCreateTasks.push(() => resolve("task-id" as UUID));
        }),
    );
    const runtime = runtimeStub({ createTask } as Partial<IAgentRuntime>);
    let completed = false;
    const maintenance = runRuntimeStartupMaintenance(runtime).then(() => {
      completed = true;
    });

    await vi.waitFor(() => expect(createTask).toHaveBeenCalledTimes(2));
    expect(completed).toBe(false);
    for (const release of releaseCreateTasks) release();
    await maintenance;
    expect(completed).toBe(true);
  });

  it("reports every failed job and rejects instead of fabricating readiness", async () => {
    const failure = new Error("database read failed");
    const reportError = vi.fn();
    const runtime = runtimeStub({
      getTasks: vi.fn(async () => {
        throw failure;
      }),
      reportError,
    } as Partial<IAgentRuntime>);

    await expect(runRuntimeStartupMaintenance(runtime)).rejects.toMatchObject({
      code: "RUNTIME_STARTUP_MAINTENANCE_FAILED",
    });
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

  it("waits for in-flight writes to settle before surfacing cancellation", async () => {
    const releaseCreateTasks: Array<() => void> = [];
    const createTask = vi.fn(
      () =>
        new Promise<UUID>((resolve) => {
          releaseCreateTasks.push(() => resolve("task-id" as UUID));
        }),
    );
    const runtime = runtimeStub({ createTask } as Partial<IAgentRuntime>);
    const owner = new AbortController();
    let settled = false;
    const maintenance = runRuntimeStartupMaintenance(
      runtime,
      owner.signal,
    ).finally(() => {
      settled = true;
    });

    await vi.waitFor(() => expect(createTask).toHaveBeenCalledTimes(2));
    owner.abort(new Error("owner cancelled boot"));
    await Promise.resolve();
    expect(settled).toBe(false);
    for (const release of releaseCreateTasks) release();

    await expect(maintenance).rejects.toThrow("owner cancelled boot");
    expect(settled).toBe(true);
  });
});
