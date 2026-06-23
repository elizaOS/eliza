import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  contentAwareVerifierModel,
  runGrillingEvidenceBundleCheck,
  runGrillingHappyPathCheck,
} from "../../test/scenarios/_helpers/grilling-scenario.ts";
import { runMultiTaskSupervisorCheck } from "../../test/scenarios/_helpers/supervisor-scenario.ts";

/**
 * Verifies the assertion LOGIC behind the three orchestrator scenarios in
 * `test/scenarios/` (#8932) using deterministic models, so the grilling +
 * multi-task loops have runnable, keyless coverage independent of the scenario
 * CLI (which the live lane drives against a real model + ACP sub-agents). The
 * scenario files import the exact same helpers.
 */
function makeBaseRuntime() {
  return {
    agentId: "00000000-0000-4000-8000-000000000001",
    character: { name: "Tester" },
    databaseAdapter: undefined,
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
    getSetting: () => undefined,
    // getService + useModel are overridden by makeGrillingRuntime.
    getService: () => undefined,
    useModel: async () => "{}",
  } as never;
}

let savedAutoVerify: string | undefined;
let savedTrajectoryRecording: string | undefined;

beforeEach(() => {
  savedAutoVerify = process.env.ELIZA_ORCHESTRATOR_AUTO_GOAL_VERIFY;
  savedTrajectoryRecording = process.env.ELIZA_TRAJECTORY_RECORDING;
  process.env.ELIZA_ORCHESTRATOR_AUTO_GOAL_VERIFY = "1";
  process.env.ELIZA_TRAJECTORY_RECORDING = "0";
});

afterEach(() => {
  if (savedAutoVerify === undefined) {
    delete process.env.ELIZA_ORCHESTRATOR_AUTO_GOAL_VERIFY;
  } else {
    process.env.ELIZA_ORCHESTRATOR_AUTO_GOAL_VERIFY = savedAutoVerify;
  }
  if (savedTrajectoryRecording === undefined) {
    delete process.env.ELIZA_TRAJECTORY_RECORDING;
  } else {
    process.env.ELIZA_TRAJECTORY_RECORDING = savedTrajectoryRecording;
  }
});

describe("orchestrator scenario logic (#8932)", () => {
  it("multi-task supervisor: per-room isolation + change-driven digest", async () => {
    expect(await runMultiTaskSupervisorCheck()).toBeUndefined();
  });

  it("grilling happy-path: no-evidence completion is grilled, pasted evidence is verified done", async () => {
    expect(
      await runGrillingHappyPathCheck(
        makeBaseRuntime(),
        contentAwareVerifierModel,
      ),
    ).toBeUndefined();
  }, 20_000);

  it("grilling evidence-bundle: the git diff + test stdout reach the verifier prompt", async () => {
    expect(
      await runGrillingEvidenceBundleCheck(makeBaseRuntime()),
    ).toBeUndefined();
  });
});
