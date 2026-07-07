/**
 * Unit coverage for the process-wide deferred-boot phase registry that
 * `/api/health` exposes as `deferredBoot`. Pure in-memory state — no runtime,
 * no I/O; asserts the pending→settled transitions and that any pending phase
 * keeps the aggregate unsettled.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  _resetDeferredBootStatusForTest,
  getDeferredBootStatus,
  markDeferredBootPhase,
} from "./deferred-boot-status.ts";

describe("deferred-boot-status", () => {
  afterEach(() => {
    _resetDeferredBootStatusForTest();
  });

  it("reports settled:true with no phases recorded (vacuously — producers mark pending before ready flips, so a health poller that sees ready also sees the pending phase)", () => {
    expect(getDeferredBootStatus()).toEqual({ phases: {}, settled: true });
  });

  it("a single pending phase is unsettled; completing it settles", () => {
    markDeferredBootPhase("agent-deferred-boot", "pending");
    expect(getDeferredBootStatus()).toEqual({
      phases: { "agent-deferred-boot": "pending" },
      settled: false,
    });

    markDeferredBootPhase("agent-deferred-boot", "complete");
    expect(getDeferredBootStatus().settled).toBe(true);
  });

  it("stays unsettled while ANY phase is pending, across multiple producers", () => {
    markDeferredBootPhase("agent-deferred-boot", "pending");
    markDeferredBootPhase("app-route-tail", "pending");
    expect(getDeferredBootStatus().settled).toBe(false);

    markDeferredBootPhase("agent-deferred-boot", "complete");
    // app-route-tail is still pending — aggregate must not read as settled.
    expect(getDeferredBootStatus().settled).toBe(false);

    markDeferredBootPhase("app-route-tail", "complete");
    expect(getDeferredBootStatus().settled).toBe(true);
  });

  it("a failed phase settles the aggregate (poller stops waiting) but is visible as failed", () => {
    markDeferredBootPhase("app-route-tail", "pending");
    markDeferredBootPhase("app-route-tail", "failed");
    const status = getDeferredBootStatus();
    expect(status.settled).toBe(true);
    expect(status.phases["app-route-tail"]).toBe("failed");
  });
});
