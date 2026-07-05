/**
 * Unit truth-table for the scenario-runner's trajectory opt-in decision
 * (`shouldOptInScenarioTrajectoryLogging`). Pure env in, boolean out — asserts a
 * bare `run` opts in regardless of --run-dir (#14111) while an operator-set knob
 * is respected. No runtime, no filesystem.
 */

import { describe, expect, it } from "vitest";
import { shouldOptInScenarioTrajectoryLogging } from "./trajectory-opt-in.ts";

describe("shouldOptInScenarioTrajectoryLogging", () => {
  it("opts in when the knob is unset — a bare run must still capture", () => {
    expect(shouldOptInScenarioTrajectoryLogging({} as NodeJS.ProcessEnv)).toBe(
      true,
    );
    expect(
      shouldOptInScenarioTrajectoryLogging({
        NODE_ENV: "test",
      } as NodeJS.ProcessEnv),
    ).toBe(true);
    expect(
      shouldOptInScenarioTrajectoryLogging({
        NODE_ENV: "production",
      } as NodeJS.ProcessEnv),
    ).toBe(true);
  });

  it("respects an operator-set knob, including an explicit opt-out", () => {
    expect(
      shouldOptInScenarioTrajectoryLogging({
        ELIZA_TRAJECTORY_LOGGING: "1",
      } as NodeJS.ProcessEnv),
    ).toBe(false);
    expect(
      shouldOptInScenarioTrajectoryLogging({
        ELIZA_TRAJECTORY_LOGGING: "0",
      } as NodeJS.ProcessEnv),
    ).toBe(false);
  });
});
