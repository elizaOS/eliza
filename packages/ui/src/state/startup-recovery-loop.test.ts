/**
 * Verifies the startup recovery loop's backoff pinning (never stops probing),
 * sign-in fast-path reset, and stop/cancel behavior with injected timers.
 */
import { describe, expect, it, vi } from "vitest";
import { createStartupRecoveryLoop } from "./startup-recovery-loop";

const POLICY = {
  recoveryBaseDelayMs: 2_500,
  recoveryMaxDelayMs: 30_000,
  recoveryMaxAttempts: 8,
};

interface FakeTimers {
  setTimer: (fn: () => void, ms: number) => number;
  clearTimer: (id: number) => void;
  /** Fire the single pending timer (throws if none). */
  fire: () => Promise<void>;
  pendingDelay: () => number | null;
}

function fakeTimers(): FakeTimers {
  let next: { id: number; fn: () => void; ms: number } | null = null;
  let seq = 0;
  return {
    setTimer: (fn, ms) => {
      seq += 1;
      next = { id: seq, fn, ms };
      return seq;
    },
    clearTimer: (id) => {
      if (next?.id === id) next = null;
    },
    fire: async () => {
      if (!next) throw new Error("no pending timer");
      const { fn } = next;
      next = null;
      fn();
      // Let the probe promise chain settle.
      await Promise.resolve();
      await Promise.resolve();
    },
    pendingDelay: () => next?.ms ?? null,
  };
}

describe("createStartupRecoveryLoop", () => {
  it("backs off exponentially and pins at the max delay instead of stopping", async () => {
    const timers = fakeTimers();
    const probe = vi.fn(async () => false);
    const loop = createStartupRecoveryLoop({
      probe,
      policy: POLICY,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    loop.start();
    const delays: number[] = [];
    // Well past the former 8-attempt budget: the loop must keep scheduling.
    for (let i = 0; i < 12; i += 1) {
      const pending = timers.pendingDelay();
      expect(pending).not.toBeNull();
      delays.push(pending as number);
      await timers.fire();
    }
    expect(delays.slice(0, 5)).toEqual([2_500, 5_000, 10_000, 20_000, 30_000]);
    // Pinned: every later probe stays at the cap, and probing never stopped.
    expect(delays.slice(5).every((d) => d === 30_000)).toBe(true);
    expect(probe).toHaveBeenCalledTimes(12);
    expect(timers.pendingDelay()).toBe(30_000);
    loop.stop();
    expect(timers.pendingDelay()).toBeNull();
  });

  it("stops scheduling once a probe reports recovery", async () => {
    const timers = fakeTimers();
    const probe = vi.fn(async () => true);
    const loop = createStartupRecoveryLoop({
      probe,
      policy: POLICY,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    loop.start();
    await timers.fire();
    expect(probe).toHaveBeenCalledTimes(1);
    expect(timers.pendingDelay()).toBeNull();
  });

  it("a sign-in resets the backoff and replaces the pending slow probe", async () => {
    const timers = fakeTimers();
    const probe = vi.fn(async () => false);
    const loop = createStartupRecoveryLoop({
      probe,
      policy: POLICY,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    loop.start();
    for (let i = 0; i < 6; i += 1) await timers.fire();
    expect(timers.pendingDelay()).toBe(30_000);
    loop.notifySignIn();
    // The pinned 30s wait is replaced by an immediate fast-cadence probe.
    expect(timers.pendingDelay()).toBe(2_500);
    loop.stop();
  });

  it("treats a rejected probe as not-recovered and keeps probing", async () => {
    const timers = fakeTimers();
    const probe = vi.fn(async () => {
      throw new Error("probe transport failed");
    });
    const loop = createStartupRecoveryLoop({
      probe,
      policy: POLICY,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    loop.start();
    await timers.fire();
    expect(timers.pendingDelay()).toBe(5_000);
    loop.stop();
  });

  it("notifySignIn after stop is inert", () => {
    const timers = fakeTimers();
    const loop = createStartupRecoveryLoop({
      probe: async () => false,
      policy: POLICY,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    loop.start();
    loop.stop();
    loop.notifySignIn();
    expect(timers.pendingDelay()).toBeNull();
  });
});
