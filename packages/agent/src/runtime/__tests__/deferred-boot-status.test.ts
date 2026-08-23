import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  _resetDeferredBootStatusForTest,
  getDeferredBootStatus,
  markDeferredBootPhase,
} from "./deferred-boot-status.ts";

beforeEach(() => _resetDeferredBootStatusForTest());
afterEach(() => _resetDeferredBootStatusForTest());

describe("deferred-boot-status", () => {
  it("is settled when no phases are recorded", () => {
    expect(getDeferredBootStatus()).toEqual({ phases: {}, settled: true });
  });

  it("tracks phase status", () => {
    markDeferredBootPhase("agent-deferred-boot", "pending");
    const status = getDeferredBootStatus();
    expect(status.phases["agent-deferred-boot"]).toBe("pending");
    expect(status.settled).toBe(false);
  });

  it("settles when all phases complete", () => {
    markDeferredBootPhase("a", "complete");
    markDeferredBootPhase("b", "failed");
    expect(getDeferredBootStatus().settled).toBe(true);
  });

  it("pending phase keeps the aggregate unsettled", () => {
    markDeferredBootPhase("a", "complete");
    markDeferredBootPhase("b", "pending");
    expect(getDeferredBootStatus().settled).toBe(false);
  });

  it("re-marking updates the status", () => {
    markDeferredBootPhase("a", "pending");
    markDeferredBootPhase("a", "complete");
    expect(getDeferredBootStatus().settled).toBe(true);
  });
});
