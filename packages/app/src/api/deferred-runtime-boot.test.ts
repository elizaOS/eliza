import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isRuntimeBootDeferred,
  registerDeferredRuntimeBoot,
  resetDeferredRuntimeBootForTests,
  triggerDeferredRuntimeBoot,
} from "./deferred-runtime-boot";

afterEach(resetDeferredRuntimeBootForTests);

describe("deferred runtime ownership", () => {
  it("shares concurrent work and clears successful registration", async () => {
    const boot = vi.fn(async () => {});
    registerDeferredRuntimeBoot(boot);
    const first = triggerDeferredRuntimeBoot("first");
    expect(triggerDeferredRuntimeBoot("second")).toBe(first);
    await first;
    expect(boot).toHaveBeenCalledTimes(1);
    expect(isRuntimeBootDeferred()).toBe(false);
  });

  it("retains failed registrations for retry", async () => {
    const boot = vi
      .fn()
      .mockRejectedValueOnce(new Error("failed"))
      .mockResolvedValue(undefined);
    registerDeferredRuntimeBoot(boot);
    await expect(triggerDeferredRuntimeBoot("first")).rejects.toThrow("failed");
    expect(isRuntimeBootDeferred()).toBe(true);
    await triggerDeferredRuntimeBoot("retry");
    expect(boot).toHaveBeenCalledTimes(2);
  });

  it("does not clear a replacement registration when older work completes", async () => {
    let finish!: () => void;
    registerDeferredRuntimeBoot(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const old = triggerDeferredRuntimeBoot("old");
    await Promise.resolve();
    const replacement = vi.fn(async () => {});
    registerDeferredRuntimeBoot(replacement);
    finish();
    await old;
    expect(isRuntimeBootDeferred()).toBe(true);
    await triggerDeferredRuntimeBoot("replacement");
    expect(replacement).toHaveBeenCalledTimes(1);
  });
});
