import { describe, expect, it } from "vitest";
import {
  nextRuntimeBootRetryDelayMs,
  RUNTIME_BOOT_ERROR_ATTEMPT_THRESHOLD,
  RUNTIME_BOOT_ERROR_DURATION_MS,
  resolveRuntimeBootstrapFailure,
} from "./runtime-bootstrap-policy.ts";

describe("nextRuntimeBootRetryDelayMs", () => {
  it("backs off exponentially, capped at 30s", () => {
    expect(nextRuntimeBootRetryDelayMs(1)).toBe(1000);
    expect(nextRuntimeBootRetryDelayMs(2)).toBe(2000);
    expect(nextRuntimeBootRetryDelayMs(3)).toBe(4000);
    expect(nextRuntimeBootRetryDelayMs(10)).toBe(30_000);
  });
});

describe("resolveRuntimeBootstrapFailure", () => {
  it("stops retries immediately on fatal PGlite codes", () => {
    const r = resolveRuntimeBootstrapFailure({
      attempt: 1,
      err: { code: "ELIZA_PGLITE_CORRUPT_DATA", message: "corrupt" },
      firstFailureAt: 0,
      now: 1000,
    });
    expect(r.shouldRetry).toBe(false);
    expect(r.state).toBe("error");
  });

  it("retries with backoff below thresholds", () => {
    const r = resolveRuntimeBootstrapFailure({
      attempt: 1,
      err: new Error("connection refused"),
      firstFailureAt: 0,
      now: 1000,
    });
    expect(r.shouldRetry).toBe(true);
    expect(r.state).toBe("starting");
    expect(r.delayMs).toBe(1000);
    expect(r.nextRetryAt).toBe(2000);
  });

  it("marks error after the attempt threshold", () => {
    const r = resolveRuntimeBootstrapFailure({
      attempt: RUNTIME_BOOT_ERROR_ATTEMPT_THRESHOLD,
      err: "boom",
      firstFailureAt: 0,
      now: 5000,
    });
    expect(r.shouldRetry).toBe(true);
    expect(r.state).toBe("error");
    expect(r.phase).toBe("runtime-error");
  });

  it("marks error after the duration threshold", () => {
    const r = resolveRuntimeBootstrapFailure({
      attempt: 1,
      err: "slow",
      firstFailureAt: 1000,
      now: 1000 + RUNTIME_BOOT_ERROR_DURATION_MS + 1,
    });
    expect(r.state).toBe("error");
  });

  it("extracts messages from errors, strings, and objects", () => {
    const r = resolveRuntimeBootstrapFailure({
      attempt: 1,
      err: { message: "obj-msg" },
      firstFailureAt: 0,
      now: 1,
    });
    expect(r.lastError).toBe("obj-msg");
  });
});
