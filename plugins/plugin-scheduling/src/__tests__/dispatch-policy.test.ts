import { describe, expect, it } from "vitest";
import { decideDispatchPolicy } from "./dispatch-policy.ts";

function context(overrides: Record<string, unknown> = {}) {
  return {
    currentStepIndex: 0,
    totalSteps: 2,
    ...overrides,
  } as never;
}

describe("decideDispatchPolicy", () => {
  it("completes on success", () => {
    const d = decideDispatchPolicy(
      { ok: true, messageId: "m1" } as never,
      context(),
    );
    expect(d.kind).toBe("complete");
  });

  it("fails on unknown acceptance (never retry a maybe-sent message)", () => {
    const d = decideDispatchPolicy(
      { ok: false, acceptance: "unknown", reason: "timeout" } as never,
      context(),
    );
    expect(d.kind).toBe("fail");
  });

  it("retries when a retry hint is present", () => {
    const d = decideDispatchPolicy(
      { ok: false, retryAfterMinutes: 5, reason: "rate_limited" } as never,
      context(),
    );
    expect(d.kind).toBe("retry");
    expect((d as { retryAfterMinutes: number }).retryAfterMinutes).toBe(5);
  });

  it("advances the ladder on plain failures", () => {
    const d = decideDispatchPolicy(
      { ok: false, reason: "provider_error" } as never,
      context(),
    );
    expect(d.kind).toBe("advance");
  });

  it("surfaces degraded for user-actionable failures", () => {
    const d = decideDispatchPolicy(
      { ok: false, userActionable: true, reason: "auth_expired" } as never,
      context(),
    );
    expect(d.kind).toBe("surface_degraded");
  });

  it("fails on the last step", () => {
    const d = decideDispatchPolicy(
      { ok: false, reason: "provider_error" } as never,
      context({ currentStepIndex: 1, totalSteps: 2 }),
    );
    expect(d.kind).toBe("fail");
  });
});
