/** Verifies dev-process parent and health lifecycle guards deterministically. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createApiHealthWatchdog,
  createParentExitGuard,
} from "./dev-process-lifecycle.mjs";

describe("createParentExitGuard", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("shuts down when the dev supervisor is reparented", () => {
    let ppid = 42;
    const onParentExit = vi.fn();
    const guard = createParentExitGuard({
      initialPpid: 42,
      getPpid: () => ppid,
      onParentExit,
      intervalMs: 100,
    });

    guard.start();
    vi.advanceTimersByTime(100);
    expect(onParentExit).not.toHaveBeenCalled();

    ppid = 1;
    vi.advanceTimersByTime(100);
    expect(onParentExit).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(500);
    expect(onParentExit).toHaveBeenCalledTimes(1);
  });
});

describe("createApiHealthWatchdog", () => {
  it("restarts only after consecutive unhealthy probes", async () => {
    const checks = [false, true, false, false, false];
    const restart = vi.fn();
    const watchdog = createApiHealthWatchdog({
      check: async () => checks.shift() ?? true,
      restart,
      failureThreshold: 3,
    });

    await watchdog.checkNow();
    await watchdog.checkNow();
    await watchdog.checkNow();
    await watchdog.checkNow();
    expect(restart).not.toHaveBeenCalled();

    await watchdog.checkNow();
    expect(restart).toHaveBeenCalledTimes(1);
  });
});
