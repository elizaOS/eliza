import { describe, expect, it } from "vitest";
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
  });

  it("grilling evidence-bundle: the git diff + test stdout reach the verifier prompt", async () => {
    expect(
      await runGrillingEvidenceBundleCheck(makeBaseRuntime()),
    ).toBeUndefined();
  });
});
