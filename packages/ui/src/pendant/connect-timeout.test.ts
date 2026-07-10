/** Connect-step deadlines are tested with deterministic fake timers. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_STEP_TIMEOUT_MS,
  isStepTimeout,
  PendantStepTimeoutError,
  withStepTimeout,
} from "./connect-timeout";

describe("withStepTimeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves with the promise value when it settles before the deadline", async () => {
    const p = withStepTimeout("audio-service", Promise.resolve(42), 1000);
    await expect(p).resolves.toBe(42);
  });

  it("propagates the underlying rejection (not a timeout) when it rejects in time", async () => {
    const boom = new Error("gatt failure");
    const p = withStepTimeout("gatt-connect", Promise.reject(boom), 1000);
    await expect(p).rejects.toBe(boom);
  });

  it("rejects with a step-named PendantStepTimeoutError after the deadline", async () => {
    // A promise that never settles → only the timer can win.
    const pending = new Promise<never>(() => {});
    const p = withStepTimeout("start-notifications", pending, 5000);
    const assertion = expect(p).rejects.toMatchObject({
      name: "PendantStepTimeoutError",
      step: "start-notifications",
    });
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
  });

  it("names the start-notifications timeout with the pairing hint", async () => {
    const pending = new Promise<never>(() => {});
    const p = withStepTimeout("start-notifications", pending, 100);
    const assertion = p.catch((err) => err as Error);
    await vi.advanceTimersByTimeAsync(100);
    const err = await assertion;
    expect(err).toBeInstanceOf(PendantStepTimeoutError);
    expect(err.message).toContain("pairing");
  });

  it("does not fire the timeout if the promise already resolved", async () => {
    const p = withStepTimeout("codec-read", Promise.resolve("ok"), 1000);
    await expect(p).resolves.toBe("ok");
    // Advancing past the deadline must not turn a resolved promise into a reject.
    await vi.advanceTimersByTimeAsync(2000);
    await expect(p).resolves.toBe("ok");
  });

  it("uses the default timeout when none is given", async () => {
    const pending = new Promise<never>(() => {});
    const p = withStepTimeout("battery", pending);
    const assertion = expect(p).rejects.toBeInstanceOf(PendantStepTimeoutError);
    // Just before the default deadline: still pending.
    await vi.advanceTimersByTimeAsync(DEFAULT_STEP_TIMEOUT_MS - 1);
    // Crossing it: rejects.
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
  });
});

describe("isStepTimeout", () => {
  it("is true only for PendantStepTimeoutError", () => {
    expect(isStepTimeout(new PendantStepTimeoutError("audio-service"))).toBe(
      true,
    );
    expect(isStepTimeout(new Error("nope"))).toBe(false);
    expect(isStepTimeout(null)).toBe(false);
    expect(isStepTimeout("timeout")).toBe(false);
  });
});
