/**
 * Tests for restart infrastructure (setRestartHandler, requestRestart, resetRestartHandlerForTests).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RESTART_EXIT_CODE,
  requestRestart,
  resetRestartHandlerForTests,
  setRestartHandler,
} from "./restart.ts";

describe("restart module", () => {
  afterEach(() => {
    resetRestartHandlerForTests();
  });

  it("exports RESTART_EXIT_CODE as a number", () => {
    expect(typeof RESTART_EXIT_CODE).toBe("number");
    expect(Number.isInteger(RESTART_EXIT_CODE)).toBe(true);
  });

  it("executes default noop handler without error", () => {
    expect(() => requestRestart()).not.toThrow();
    expect(() => requestRestart("some reason")).not.toThrow();
  });

  it("invokes custom restart handler with trimmed reason", () => {
    const handler = vi.fn();
    setRestartHandler(handler);

    requestRestart("  config updated  ");
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith("config updated");
  });

  it("invokes custom async restart handler", async () => {
    let resolvedReason: string | undefined;
    setRestartHandler(async (reason) => {
      resolvedReason = reason;
    });

    await requestRestart("manual-restart");
    expect(resolvedReason).toBe("manual-restart");
  });

  it("safely ignores non-function handlers and falls back to default noop", () => {
    setRestartHandler(null as unknown as () => void);
    expect(() => requestRestart()).not.toThrow();

    setRestartHandler(123 as unknown as () => void);
    expect(() => requestRestart()).not.toThrow();
  });

  it("resets handler back to default with resetRestartHandlerForTests", () => {
    const handler = vi.fn();
    setRestartHandler(handler);

    resetRestartHandlerForTests();
    requestRestart("after-reset");
    expect(handler).not.toHaveBeenCalled();
  });
});
