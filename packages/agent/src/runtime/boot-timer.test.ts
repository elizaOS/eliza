/**
 * Verifies boot phase timing, including deferred-phase boundaries where an
 * intentional scheduler delay must not be attributed to the first operation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const loggerMocks = vi.hoisted(() => ({ info: vi.fn() }));

vi.mock("@elizaos/core", () => ({
  logger: loggerMocks,
}));

import { BootTimer } from "./boot-timer.ts";

describe("BootTimer", () => {
  beforeEach(() => {
    loggerMocks.info.mockReset();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-04T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("excludes a deferred scheduler gap from the next lap", () => {
    const timer = new BootTimer("[test-boot]");

    vi.advanceTimersByTime(20);
    timer.lap("blocking");
    vi.advanceTimersByTime(2_000);
    timer.resetLapWindow();
    vi.advanceTimersByTime(35);
    timer.lap("deferred:vault");

    expect(timer.getSummary().laps).toEqual([
      { name: "blocking", ms: 20, cumulativeMs: 20 },
      { name: "deferred:vault", ms: 35, cumulativeMs: 2_055 },
    ]);
    expect(loggerMocks.info).toHaveBeenLastCalledWith(
      "[test-boot] deferred:vault: 35ms (t+2055ms)",
    );
  });
});
