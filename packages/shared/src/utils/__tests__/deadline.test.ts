/** Tests the deterministic shared promise deadline kernel with real timers. */

import { describe, expect, it } from "vitest";
import { rejectAtDeadline, resolveAtDeadline } from "../deadline.js";

describe("deadline engine", () => {
  it("preserves source values and failures", async () => {
    await expect(
      resolveAtDeadline(Promise.resolve("ready"), {
        timeoutMs: 100,
        onTimeout: () => null,
      }),
    ).resolves.toBe("ready");
    await expect(
      rejectAtDeadline(Promise.reject(new Error("source")), {
        timeoutMs: 100,
        onTimeout: () => new Error("late"),
      }),
    ).rejects.toThrow("source");
  });

  it("supports boundary-specific fallback and error policies", async () => {
    const pending = new Promise<never>(() => undefined);
    await expect(
      resolveAtDeadline(pending, { timeoutMs: 5, onTimeout: () => null }),
    ).resolves.toBeNull();
    await expect(
      rejectAtDeadline(pending, {
        timeoutMs: 5,
        onTimeout: () => new Error("bridge timed out"),
      }),
    ).rejects.toThrow("bridge timed out");
  });
});
