import { describe, expect, it } from "vitest";
import { enableScenarioTrajectoryLogging } from "./trajectory-env.ts";

describe("enableScenarioTrajectoryLogging", () => {
  it("opts every scenario run into trajectory recording", () => {
    const env: NodeJS.ProcessEnv = {};

    enableScenarioTrajectoryLogging(env);

    expect(env.ELIZA_TRAJECTORY_LOGGING).toBe("1");
  });

  it("overrides a falsey or blank scenario logging value", () => {
    const falseyEnv: NodeJS.ProcessEnv = { ELIZA_TRAJECTORY_LOGGING: "0" };
    const blankEnv: NodeJS.ProcessEnv = { ELIZA_TRAJECTORY_LOGGING: "" };

    enableScenarioTrajectoryLogging(falseyEnv);
    enableScenarioTrajectoryLogging(blankEnv);

    expect(falseyEnv.ELIZA_TRAJECTORY_LOGGING).toBe("1");
    expect(blankEnv.ELIZA_TRAJECTORY_LOGGING).toBe("1");
  });

  it("does not clear the hard operator disable flag", () => {
    const env: NodeJS.ProcessEnv = { ELIZA_DISABLE_TRAJECTORY_LOGGING: "1" };

    enableScenarioTrajectoryLogging(env);

    expect(env.ELIZA_DISABLE_TRAJECTORY_LOGGING).toBe("1");
    expect(env.ELIZA_TRAJECTORY_LOGGING).toBe("1");
  });
});
