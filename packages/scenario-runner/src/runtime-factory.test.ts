import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  scenarioPgliteDirOverride,
  shouldPreserveScenarioTrajectoryDb,
} from "./runtime-factory.ts";

describe("scenario runtime trajectory persistence options", () => {
  it("keeps scenario trajectory databases only when explicitly requested", () => {
    expect(shouldPreserveScenarioTrajectoryDb({})).toBe(false);
    expect(
      shouldPreserveScenarioTrajectoryDb({
        ELIZA_DISABLE_TRAJECTORY_LOGGING: "0",
      }),
    ).toBe(false);

    for (const envName of [
      "MILADY_SAVE_TRAJECTORIES",
      "ELIZA_SAVE_TRAJECTORIES",
      "SCENARIO_SAVE_TRAJECTORIES",
    ]) {
      expect(shouldPreserveScenarioTrajectoryDb({ [envName]: "1" })).toBe(true);
      expect(shouldPreserveScenarioTrajectoryDb({ [envName]: "true" })).toBe(
        true,
      );
    }
  });

  it("resolves an explicit scenario PGLite directory for saved trajectory runs", () => {
    expect(scenarioPgliteDirOverride({})).toBeNull();
    expect(
      scenarioPgliteDirOverride({
        MILADY_SCENARIO_PGLITE_DIR: "artifacts/pglite",
      }),
    ).toBe(path.resolve("artifacts/pglite"));
    expect(
      scenarioPgliteDirOverride({
        ELIZA_SCENARIO_PGLITE_DIR: " ",
        SCENARIO_PGLITE_DIR: "artifacts/scenario-pglite",
      }),
    ).toBe(path.resolve("artifacts/scenario-pglite"));
  });
});
