import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startSyncTask, syncCatalogTask } from "./sync-catalog";

const SYNC_INTERVAL_MS = 1000 * 60 * 60;

function makeRuntime(overrides: Record<string, unknown> = {}) {
  return {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    reportError: vi.fn(),
    ...overrides,
  } as never;
}

describe("skill catalog sync task", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("warns and returns when the skills service is unavailable", async () => {
    const runtime = makeRuntime({ getService: vi.fn(() => undefined) });
    await syncCatalogTask.execute(runtime);
    expect(runtime.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("service not available"),
    );
    expect(runtime.reportError).not.toHaveBeenCalled();
  });

  it("logs the sync result on success", async () => {
    const runtime = makeRuntime({
      getService: vi.fn(() => ({
        syncCatalog: vi.fn(async () => ({ updated: 3, added: 1 })),
      })),
    });
    await syncCatalogTask.execute(runtime);
    expect(runtime.logger.info).toHaveBeenCalledWith(
      expect.stringContaining("3 skills, 1 new"),
    );
    expect(runtime.reportError).not.toHaveBeenCalled();
  });

  it("surfaces sync failures via reportError without rethrowing", async () => {
    const boom = new Error("registry timeout");
    const runtime = makeRuntime({
      getService: vi.fn(() => ({
        syncCatalog: vi.fn(async () => {
          throw boom;
        }),
      })),
    });
    await expect(syncCatalogTask.execute(runtime)).resolves.toBeUndefined();
    expect(runtime.reportError).toHaveBeenCalledWith(
      "AgentSkills.catalogSync",
      boom,
    );
  });

  it("does not run eagerly — the interval owns the periodic refresh", async () => {
    const execute = vi.spyOn(syncCatalogTask, "execute");
    const runtime = makeRuntime();
    const cleanup = startSyncTask(runtime);
    expect(execute).not.toHaveBeenCalled();
    cleanup();
  });

  it("runs the sync on each interval tick and stops after cleanup", async () => {
    const execute = vi.spyOn(syncCatalogTask, "execute").mockResolvedValue();
    const runtime = makeRuntime();
    const cleanup = startSyncTask(runtime);
    await vi.advanceTimersByTimeAsync(SYNC_INTERVAL_MS);
    expect(execute).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(SYNC_INTERVAL_MS);
    expect(execute).toHaveBeenCalledTimes(2);
    cleanup();
    await vi.advanceTimersByTimeAsync(SYNC_INTERVAL_MS * 3);
    expect(execute).toHaveBeenCalledTimes(2);
  });
});
