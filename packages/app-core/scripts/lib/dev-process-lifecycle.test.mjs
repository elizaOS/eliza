/** Verifies dev-process parent and health lifecycle guards deterministically. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createApiHealthWatchdog,
  createParentExitGuard,
  formatProbeEvidence,
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

  it("absorbs a stall shorter than the threshold budget", async () => {
    let healthy = false;
    const restart = vi.fn();
    const watchdog = createApiHealthWatchdog({
      check: async () => healthy,
      restart,
      failureThreshold: 6,
    });

    // A 5-probe stall (one short of the budget) resolves: no recycle.
    for (let i = 0; i < 5; i++) await watchdog.checkNow();
    healthy = true;
    await watchdog.checkNow();
    expect(restart).not.toHaveBeenCalled();

    // A full 6-probe wedge is still caught.
    healthy = false;
    for (let i = 0; i < 6; i++) await watchdog.checkNow();
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it("holds probe failures through a replacement child's boot and ready margin", async () => {
    let clock = 0;
    let healthy = false;
    const restart = vi.fn();
    const watchdog = createApiHealthWatchdog({
      check: async () => healthy,
      restart,
      failureThreshold: 3,
      bootGraceMs: 60_000,
      readyMarginMs: 10_000,
      now: () => clock,
    });

    for (let i = 0; i < 3; i++) await watchdog.checkNow();
    expect(restart).toHaveBeenCalledTimes(1);

    // The supervisor spawned the replacement; it boots for 50s of unhealthy
    // probes that must not bounce it again.
    watchdog.noteChildSpawn();
    for (let i = 0; i < 10; i++) {
      clock += 5_000;
      await watchdog.checkNow();
    }
    expect(restart).toHaveBeenCalledTimes(1);

    // First healthy probe starts the post-ready margin: the deferred boot
    // tail may stall the loop right after ready, so failures inside the
    // margin still don't count.
    healthy = true;
    clock += 5_000;
    await watchdog.checkNow();
    healthy = false;
    for (let i = 0; i < 3; i++) {
      clock += 2_000;
      await watchdog.checkNow();
    }
    expect(restart).toHaveBeenCalledTimes(1);

    // Past the margin a real wedge is caught normally.
    clock += 20_000;
    for (let i = 0; i < 3; i++) await watchdog.checkNow();
    expect(restart).toHaveBeenCalledTimes(2);
  });

  it("holds probe failures after a non-watchdog spawn (hot reload / crash respawn)", async () => {
    let clock = 0;
    let healthy = false;
    const restart = vi.fn();
    const watchdog = createApiHealthWatchdog({
      check: async () => healthy,
      restart,
      failureThreshold: 3,
      bootGraceMs: 60_000,
      readyMarginMs: 0,
      now: () => clock,
    });

    // A hot reload bounced the child; onSpawn arms the hold with no restart
    // having happened. Its whole boot must be probe-safe.
    watchdog.noteChildSpawn();
    for (let i = 0; i < 10; i++) {
      clock += 5_000;
      await watchdog.checkNow();
    }
    expect(restart).not.toHaveBeenCalled();

    healthy = true;
    clock += 5_000;
    await watchdog.checkNow();
    healthy = false;
    clock += 1_000;
    for (let i = 0; i < 3; i++) await watchdog.checkNow();
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it("restarts again when the replacement never becomes healthy within the boot grace", async () => {
    let clock = 0;
    const restart = vi.fn();
    const watchdog = createApiHealthWatchdog({
      check: async () => false,
      restart,
      failureThreshold: 3,
      bootGraceMs: 60_000,
      now: () => clock,
    });
    for (let i = 0; i < 3; i++) await watchdog.checkNow();
    expect(restart).toHaveBeenCalledTimes(1);
    watchdog.noteChildSpawn();
    clock = 61_000;
    for (let i = 0; i < 3; i++) await watchdog.checkNow();
    expect(restart).toHaveBeenCalledTimes(2);
  });

  it("passes probe evidence (latency, detail, time since last healthy) to restart", async () => {
    let clock = 0;
    let result = { healthy: true, detail: "ready" };
    const restart = vi.fn();
    const watchdog = createApiHealthWatchdog({
      check: async () => {
        clock += 40; // simulated probe latency
        return result;
      },
      restart,
      failureThreshold: 2,
      readyMarginMs: 0,
      now: () => clock,
    });

    await watchdog.checkNow();
    result = { healthy: false, detail: "timeout>10000ms" };
    clock += 5_000;
    await watchdog.checkNow();
    clock += 5_000;
    await watchdog.checkNow();

    expect(restart).toHaveBeenCalledTimes(1);
    const evidence = restart.mock.calls[0][0];
    expect(evidence.failures).toBe(2);
    expect(evidence.sinceLastHealthyMs).toBe(10_080);
    expect(evidence.probes).toHaveLength(3);
    expect(evidence.probes[0]).toMatchObject({
      healthy: true,
      detail: "ready",
    });
    expect(evidence.probes[1]).toMatchObject({
      healthy: false,
      detail: "timeout>10000ms",
    });
    expect(evidence.probes[1].durationMs).toBe(40);

    const rendered = formatProbeEvidence(evidence);
    expect(rendered).toContain("last healthy 10s ago");
    expect(rendered).toContain("fail(timeout>10000ms)");
    expect(rendered).toContain("ok");
  });

  it("formatProbeEvidence renders an empty payload without throwing", () => {
    expect(formatProbeEvidence(undefined)).toBe("no probe history");
    expect(formatProbeEvidence({ probes: [] })).toBe("no probe history");
  });
});
