/**
 * Tests for startup-timing-policy — STARTUP_TIMING_POLICY.
 */
import { describe, expect, it } from "vitest";
import { STARTUP_TIMING_POLICY } from "./startup-timing-policy.ts";

describe("startup-timing-policy", () => {
  it("has expected splash delay", () => {
    expect(STARTUP_TIMING_POLICY.splashDelayMs).toBe(220);
  });

  it("has runtime poll interval", () => {
    expect(STARTUP_TIMING_POLICY.runtimePollIntervalMs).toBe(500);
  });

  it("has recovery max attempts", () => {
    expect(STARTUP_TIMING_POLICY.recoveryMaxAttempts).toBe(8);
  });

  it("has probe timeout", () => {
    expect(STARTUP_TIMING_POLICY.probeRequestTimeoutMs).toBe(12000);
  });

  it("is frozen", () => {
    expect(Object.isFrozen(STARTUP_TIMING_POLICY)).toBe(true);
  });
});
