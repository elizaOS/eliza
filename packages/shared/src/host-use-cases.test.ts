/**
 * Deterministic conformance coverage for shared host controller primitives.
 * It exercises real promise coalescing and pairing-code normalization without
 * replacing either behavior with mocks.
 */
import { describe, expect, it, vi } from "vitest";
import {
  BackgroundTaskRunCoordinator,
  normalizeHostPairingCode,
} from "./host-use-cases.ts";

describe("BackgroundTaskRunCoordinator", () => {
  it("coalesces overlap and permits a new pass after completion", async () => {
    let finish: (() => void) | undefined;
    const runDueTasks = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const service = { runDueTasks };
    const coordinator = new BackgroundTaskRunCoordinator();
    const first = coordinator.run(service);
    const second = coordinator.run(service);
    finish?.();

    await expect(Promise.all([first, second])).resolves.toEqual([
      { coalesced: false },
      { coalesced: true },
    ]);
    expect(runDueTasks).toHaveBeenCalledOnce();

    runDueTasks.mockResolvedValueOnce(undefined);
    await expect(coordinator.run(service)).resolves.toEqual({
      coalesced: false,
    });
    expect(runDueTasks).toHaveBeenCalledTimes(2);
  });

  it("runs different TaskService instances independently", async () => {
    let finishFirst: (() => void) | undefined;
    let finishSecond: (() => void) | undefined;
    const firstService = {
      runDueTasks: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finishFirst = resolve;
          }),
      ),
    };
    const secondService = {
      runDueTasks: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finishSecond = resolve;
          }),
      ),
    };
    const coordinator = new BackgroundTaskRunCoordinator();

    const first = coordinator.run(firstService);
    const second = coordinator.run(secondService);

    expect(firstService.runDueTasks).toHaveBeenCalledOnce();
    expect(secondService.runDueTasks).toHaveBeenCalledOnce();
    finishFirst?.();
    finishSecond?.();
    await expect(Promise.all([first, second])).resolves.toEqual([
      { coalesced: false },
      { coalesced: false },
    ]);
  });

  it("clears a failed pass so a later wake can retry", async () => {
    const runDueTasks = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("scheduler failed"))
      .mockResolvedValueOnce(undefined);
    const service = { runDueTasks };
    const coordinator = new BackgroundTaskRunCoordinator();

    await expect(coordinator.run(service)).rejects.toThrow("scheduler failed");
    await expect(coordinator.run(service)).resolves.toEqual({
      coalesced: false,
    });
  });
});

describe("normalizeHostPairingCode", () => {
  it("normalizes the same user-entered code for both host pairing adapters", () => {
    expect(normalizeHostPairingCode(" abcd-efgh 23_45 ")).toBe("ABCDEFGH2345");
  });
});
