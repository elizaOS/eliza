/** Verifies dev-process parent and health lifecycle guards deterministically. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createApiHealthWatchdog,
  createParentExitGuard,
} from "./dev-process-lifecycle.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

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

  it("holds the failure count through a replacement child's boot", async () => {
    let clock = 0;
    let healthy = false;
    const restart = vi.fn();
    const watchdog = createApiHealthWatchdog({
      check: async () => healthy,
      restart,
      failureThreshold: 3,
      recoveryGraceMs: 60_000,
      now: () => clock,
    });

    for (let i = 0; i < 3; i++) await watchdog.checkNow();
    expect(restart).toHaveBeenCalledTimes(1);

    // The replacement is booting: ten more unhealthy probes inside the grace
    // window must not bounce it again.
    for (let i = 0; i < 10; i++) {
      clock += 5_000;
      await watchdog.checkNow();
    }
    expect(restart).toHaveBeenCalledTimes(1);

    // It comes up; the hold clears and a later wedge is caught normally.
    healthy = true;
    await watchdog.checkNow();
    healthy = false;
    for (let i = 0; i < 3; i++) await watchdog.checkNow();
    expect(restart).toHaveBeenCalledTimes(2);
  });

  it("restarts again when the replacement never becomes healthy within the grace", async () => {
    let clock = 0;
    const restart = vi.fn();
    const watchdog = createApiHealthWatchdog({
      check: async () => false,
      restart,
      failureThreshold: 3,
      recoveryGraceMs: 60_000,
      now: () => clock,
    });
    for (let i = 0; i < 3; i++) await watchdog.checkNow();
    expect(restart).toHaveBeenCalledTimes(1);
    clock = 61_000;
    for (let i = 0; i < 3; i++) await watchdog.checkNow();
    expect(restart).toHaveBeenCalledTimes(2);
  });

  it("holds unhealthy probes for a replacement started outside the watchdog", async () => {
    let clock = 10_000;
    let healthy = false;
    const restart = vi.fn();
    const watchdog = createApiHealthWatchdog({
      check: async () => healthy,
      restart,
      failureThreshold: 3,
      recoveryGraceMs: 60_000,
      now: () => clock,
    });

    // Source reloads, child-requested restarts, and crash relaunches all enter
    // through the supervisor's onSpawn hook rather than watchdog.restart().
    watchdog.beginRecovery();
    for (let i = 0; i < 10; i++) {
      clock += 5_000;
      await watchdog.checkNow();
    }
    expect(restart).not.toHaveBeenCalled();

    healthy = true;
    await watchdog.checkNow();
    healthy = false;
    for (let i = 0; i < 3; i++) await watchdog.checkNow();
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it("ignores a stale probe after a replacement and probes the new generation immediately", async () => {
    let clock = 10_000;
    const oldProbe = deferred();
    const newProbe = deferred();
    const check = vi
      .fn()
      .mockImplementationOnce(() => oldProbe.promise)
      .mockImplementationOnce(() => newProbe.promise);
    const restart = vi.fn();
    const watchdog = createApiHealthWatchdog({
      check,
      restart,
      failureThreshold: 1,
      recoveryGraceMs: 60_000,
      now: () => clock,
    });

    const staleCheck = watchdog.checkNow();
    watchdog.beginRecovery();
    const currentCheck = watchdog.checkNow();
    expect(check).toHaveBeenCalledTimes(2);

    newProbe.resolve(false);
    await currentCheck;
    oldProbe.resolve(false);
    await staleCheck;
    expect(restart).not.toHaveBeenCalled();

    clock = 70_001;
    await watchdog.checkNow();
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it("does not let a stale healthy probe clear replacement boot grace", async () => {
    let clock = 10_000;
    const oldProbe = deferred();
    const restart = vi.fn();
    const watchdog = createApiHealthWatchdog({
      check: vi
        .fn()
        .mockImplementationOnce(() => oldProbe.promise)
        .mockResolvedValue(false),
      restart,
      failureThreshold: 1,
      recoveryGraceMs: 60_000,
      now: () => clock,
    });

    const staleCheck = watchdog.checkNow();
    watchdog.beginRecovery();
    oldProbe.resolve(true);
    await staleCheck;
    clock = 60_000;
    await watchdog.checkNow();
    expect(restart).not.toHaveBeenCalled();

    clock = 70_001;
    await watchdog.checkNow();
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it("does not restart when shutdown begins during an in-flight probe", async () => {
    const probe = deferred();
    let shuttingDown = false;
    const restart = vi.fn();
    const watchdog = createApiHealthWatchdog({
      check: () => probe.promise,
      restart,
      isShuttingDown: () => shuttingDown,
      failureThreshold: 1,
    });

    const pending = watchdog.checkNow();
    shuttingDown = true;
    probe.resolve(false);
    await pending;
    expect(restart).not.toHaveBeenCalled();
  });

  it("collapses overlapping probes within one child generation", async () => {
    const probe = deferred();
    const check = vi.fn(() => probe.promise);
    const watchdog = createApiHealthWatchdog({
      check,
      restart: vi.fn(),
    });

    const first = watchdog.checkNow();
    await watchdog.checkNow();
    expect(check).toHaveBeenCalledTimes(1);
    probe.resolve(true);
    await first;
  });

  it("invalidates an in-flight probe and removes its interval when stopped", async () => {
    vi.useFakeTimers();
    try {
      const probe = deferred();
      const check = vi.fn(() => probe.promise);
      const restart = vi.fn();
      const watchdog = createApiHealthWatchdog({
        check,
        restart,
        intervalMs: 100,
        failureThreshold: 1,
      });

      watchdog.start();
      await vi.advanceTimersByTimeAsync(100);
      expect(check).toHaveBeenCalledTimes(1);
      watchdog.stop();
      probe.resolve(false);
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(500);
      expect(check).toHaveBeenCalledTimes(1);
      expect(restart).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
