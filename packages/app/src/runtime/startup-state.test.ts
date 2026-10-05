import { expect, it } from "vitest";
import { AppStartupStateMachine } from "./startup-state";

it("keeps published snapshots immutable and rejects invalid readiness transitions", () => {
  const state = new AppStartupStateMachine(() => 123);
  const initial = state.snapshot;
  expect(Reflect.set(initial, "phase", "ready")).toBe(false);
  expect(() => state.transition("ready")).toThrow("Invalid startup transition");
  state.transition("api-bound");
  state.transition("runtime-starting");
  expect(state.transition("ready")).toMatchObject({
    attempt: 1,
    agentState: "running",
  });
  expect(initial.phase).toBe("api-binding");
  expect(Object.isFrozen(state.snapshot)).toBe(true);
});
