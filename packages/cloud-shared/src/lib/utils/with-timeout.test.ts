/**
 * Tests for withTimeout — the promise-race timeout used across the
 * provisioning daemon's bounded ops. It frees the awaiter after `ms`; it does
 * not abort the underlying work.
 */

import { describe, expect, test } from "bun:test";
import { withTimeout } from "./with-timeout";

describe("withTimeout", () => {
  test("resolves with the value when the promise settles before the deadline", async () => {
    const result = await withTimeout(Promise.resolve("ok"), 50, "fast op");
    expect(result).toBe("ok");
  });

  test("rejects with a labelled timeout error when the deadline elapses", async () => {
    const never = new Promise<string>(() => {});
    await expect(withTimeout(never, 10, "slow op")).rejects.toThrow("slow op timed out after 10ms");
  });

  test("propagates the underlying rejection when it loses to the race", async () => {
    const boom = Promise.reject(new Error("underlying failure"));
    await expect(withTimeout(boom, 1_000, "op")).rejects.toThrow("underlying failure");
  });
});
