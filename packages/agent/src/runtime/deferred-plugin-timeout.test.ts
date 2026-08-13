/**
 * Exercises the deterministic timeout resolver at the real setTimeout
 * consumer boundary, including Node's maximum schedulable delay. No network,
 * credentials, or live agent resources are required.
 */
import { logger } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveDeferredPluginRegistrationTimeoutMs } from "./eliza.ts";

describe("deferred plugin registration watchdog timeout", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("keeps the unset and valid timer behavior", () => {
    expect(resolveDeferredPluginRegistrationTimeoutMs(undefined)).toBe(30_000);
    expect(resolveDeferredPluginRegistrationTimeoutMs("1")).toBe(1);
    expect(resolveDeferredPluginRegistrationTimeoutMs("2147483647")).toBe(
      2_147_483_647,
    );
  });

  it("keeps an overflowing value away from the real setTimeout consumer", () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const callback = vi.fn();
    const timeoutMs =
      resolveDeferredPluginRegistrationTimeoutMs("9007199254740992");
    const watchdog = setTimeout(callback, timeoutMs);

    expect(timeoutMs).toBe(30_000);
    expect(warn).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(29_999);
    expect(callback).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(callback).toHaveBeenCalledOnce();
    clearTimeout(watchdog);
  });

  it("preserves the existing fallback for malformed and non-positive values", () => {
    expect(resolveDeferredPluginRegistrationTimeoutMs("45ms")).toBe(45);
    expect(resolveDeferredPluginRegistrationTimeoutMs("45.5")).toBe(45);
    expect(resolveDeferredPluginRegistrationTimeoutMs("0")).toBe(30_000);
    expect(resolveDeferredPluginRegistrationTimeoutMs("-1")).toBe(30_000);
  });
});
