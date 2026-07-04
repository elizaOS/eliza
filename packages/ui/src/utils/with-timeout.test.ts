/**
 * Unit coverage for the promise timeout wrapper (resolve-in-time vs reject).
 * Pure function, no harness.
 */
import { describe, expect, it, vi } from "vitest";
import { withTimeout } from "./with-timeout";

describe("withTimeout", () => {
  it("resolves with the value when the promise settles in time", async () => {
    await expect(withTimeout(Promise.resolve(42), 1000)).resolves.toBe(42);
  });

  it("propagates the original rejection", async () => {
    await expect(
      withTimeout(Promise.reject(new Error("boom")), 1000),
    ).rejects.toThrow("boom");
  });

  it("rejects once the timeout elapses on a hung promise", async () => {
    vi.useFakeTimers();
    try {
      const hung = new Promise<number>(() => {});
      const guarded = withTimeout(hung, 5000);
      const assertion = expect(guarded).rejects.toThrow(/timed out/);
      await vi.advanceTimersByTimeAsync(5001);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
