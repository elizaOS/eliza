/**
 * Unit coverage for browser-safe restart handler delegation in restart.ts.
 *
 * Tests exit code constant export, default no-op handler execution, synchronous
 * and asynchronous custom handler invocation with optional reason propagation.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  RESTART_EXIT_CODE,
  requestRestart,
  setRestartHandler,
} from "./restart.js";

describe("restart", () => {
  beforeEach(() => {
    // Reset to default no-op handler
    setRestartHandler(() => {});
  });

  it("exports RESTART_EXIT_CODE as a non-zero number", () => {
    expect(typeof RESTART_EXIT_CODE).toBe("number");
    expect(RESTART_EXIT_CODE).toBeGreaterThan(0);
  });

  it("safely executes default no-op handler without error", () => {
    expect(() => requestRestart()).not.toThrow();
    expect(() => requestRestart("test-reason")).not.toThrow();
  });

  it("forwards restart request and reason to registered handler", () => {
    const handler = vi.fn();
    setRestartHandler(handler);

    requestRestart("reload configuration");

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith("reload configuration");
  });

  it("supports asynchronous restart handlers", async () => {
    let finished = false;
    const asyncHandler = vi.fn(async (reason?: string) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      finished = true;
      void reason;
    });

    setRestartHandler(asyncHandler);
    const result = requestRestart("graceful shutdown");

    expect(result).toBeInstanceOf(Promise);
    await result;

    expect(finished).toBe(true);
    expect(asyncHandler).toHaveBeenCalledWith("graceful shutdown");
  });
});
