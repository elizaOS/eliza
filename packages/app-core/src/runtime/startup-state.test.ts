/** Tests valid startup, deferred-onboarding, restart, and invalid transitions. */
import { describe, expect, it } from "vitest";
import { AppStartupStateMachine } from "./startup-state";

describe("AppStartupStateMachine", () => {
  it("models bind, runtime, feature readiness, restart, and stop", () => {
    const machine = new AppStartupStateMachine(() => 42);
    for (const phase of [
      "api-bound",
      "runtime-starting",
      "features-starting",
      "ready",
      "runtime-starting",
      "runtime-ready",
      "ready",
      "stopping",
    ] as const) {
      machine.transition(phase);
    }
    expect(machine.snapshot).toEqual({
      phase: "stopping",
      agentState: "stopped",
      attempt: 2,
      changedAt: 42,
    });
  });

  it("keeps onboarding distinct from a healthy empty runtime", () => {
    const machine = new AppStartupStateMachine();
    machine.transition("api-bound");
    expect(machine.transition("awaiting-onboarding").agentState).toBe(
      "not_started",
    );
  });

  it("rejects impossible transitions", () => {
    const machine = new AppStartupStateMachine();
    expect(() => machine.transition("ready")).toThrow("api-binding -> ready");
  });
});
