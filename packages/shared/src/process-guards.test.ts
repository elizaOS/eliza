/**
 * Unit coverage for `installProcessCrashGuards` (`process-guards.ts`) and the
 * `shouldIgnoreUnhandledRejection` classifier: idempotent install, non-fatal
 * handling of background unhandled rejections, credit-exhaustion downgrade to warn,
 * and the uncaught-exception policies (default supervised restart / keep-alive /
 * exit). Listeners are captured by stubbing `process.on` so a deliberately triggered
 * rejection never escapes into the test runner.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { shouldIgnoreUnhandledRejection } from "./error-classification.js";
import {
  installProcessCrashGuards,
  resetProcessCrashGuardsForTest,
} from "./process-guards.js";
import { RESTART_EXIT_CODE } from "./restart.js";

/**
 * Capture the listeners that `installProcessCrashGuards` registers without
 * actually attaching them to the live process (which would let a deliberately
 * triggered rejection escape into the test runner).
 */
function captureGuards(
  options: Parameters<typeof installProcessCrashGuards>[0] = {},
) {
  const listeners: Record<string, (arg: unknown) => void> = {};
  const spy = vi
    .spyOn(process, "on")
    .mockImplementation(
      (event: string | symbol, fn: (...args: unknown[]) => void) => {
        listeners[String(event)] = fn as (arg: unknown) => void;
        return process;
      },
    );
  const installed = installProcessCrashGuards(options);
  spy.mockRestore();
  return { installed, listeners };
}

describe("installProcessCrashGuards", () => {
  beforeEach(() => resetProcessCrashGuardsForTest());
  afterEach(() => resetProcessCrashGuardsForTest());

  it("is idempotent across calls", () => {
    const first = captureGuards({ exit: () => {} });
    expect(first.installed).toBe(true);
    const second = captureGuards({ exit: () => {} });
    expect(second.installed).toBe(false);
  });

  it("treats a background rejection as non-fatal (logs, never exits)", () => {
    const log = vi.fn();
    const warn = vi.fn();
    const exit = vi.fn();
    const { listeners } = captureGuards({ log, warn, exit });

    listeners.unhandledRejection?.(new Error("connector poll blew up"));

    expect(exit).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain("non-fatal");
  });

  it("warns (not errors) on provider credit-exhaustion rejections", () => {
    const log = vi.fn();
    const warn = vi.fn();
    const exit = vi.fn();
    const { listeners } = captureGuards({ log, warn, exit });

    listeners.unhandledRejection?.(
      new Error("AI_APICallError: insufficient_quota"),
    );

    expect(warn).toHaveBeenCalledTimes(1);
    expect(log).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it("requests a supervised restart on uncaught exception (default policy)", () => {
    const exit = vi.fn();
    const { listeners } = captureGuards({ exit, log: () => {} });

    listeners.uncaughtException?.(new Error("boom"));

    expect(exit).toHaveBeenCalledWith(RESTART_EXIT_CODE);
  });

  it("keeps the agent alive on uncaught exception under keep-alive policy", () => {
    const exit = vi.fn();
    const { listeners } = captureGuards({
      exit,
      log: () => {},
      onUncaughtException: "keep-alive",
    });

    listeners.uncaughtException?.(new Error("boom"));

    expect(exit).not.toHaveBeenCalled();
  });

  it("exits with code 1 under exit policy", () => {
    const exit = vi.fn();
    const { listeners } = captureGuards({
      exit,
      log: () => {},
      onUncaughtException: "exit",
    });

    listeners.uncaughtException?.(new Error("boom"));

    expect(exit).toHaveBeenCalledWith(1);
  });
});

describe("shouldIgnoreUnhandledRejection", () => {
  it("ignores AI provider credit-exhaustion errors", () => {
    expect(
      shouldIgnoreUnhandledRejection(
        new Error("AI_NoOutputGeneratedError: No output generated"),
      ),
    ).toBe(false); // no credit signal → surfaced

    const credit = Object.assign(
      new Error("AI_APICallError: payment required"),
      { statusCode: 402 },
    );
    expect(shouldIgnoreUnhandledRejection(credit)).toBe(true);
  });

  it("does not ignore ordinary runtime errors", () => {
    expect(
      shouldIgnoreUnhandledRejection(new Error("TypeError: x is undefined")),
    ).toBe(false);
  });
});
