/**
 * Verifies the assertion LOGIC behind the three orchestrator scenarios in
 * `test/scenarios/` (#8932) using deterministic models, so the grilling +
 * multi-task loops have runnable, keyless coverage independent of the scenario
 * CLI (which the live lane drives against a real model + ACP sub-agents). The
 * scenario files import the exact same helpers.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildDeviceSupportScenarioEvidence } from "../../test/scenarios/_helpers/device-modality-scenario.ts";
import {
  contentAwareVerifierModel,
  EVIDENCE_BUNDLE_DIFF,
  EVIDENCE_BUNDLE_TEST_STDOUT,
  runGrillingEvidenceBundleCheck,
  runGrillingHappyPathCheck,
} from "../../test/scenarios/_helpers/grilling-scenario.ts";
import {
  driveReflexionRespawn,
  REFLEXION_FAIL_SUMMARY,
  REFLEXION_MISSING_CRITERION,
  reflexionVerifierModel,
} from "../../test/scenarios/_helpers/reflexion-scenario.ts";
import { runMultiTaskSupervisorCheck } from "../../test/scenarios/_helpers/supervisor-scenario.ts";

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
    const result = await runGrillingHappyPathCheck(
      makeBaseRuntime(),
      contentAwareVerifierModel,
    );
    expect(result.failure).toBeUndefined();
    // The corrective re-prompt cited the unmet acceptance criterion verbatim.
    expect(result.grillPrompt).toMatch(/tests pass/i);
    // The no-evidence claim never reached a terminal success state.
    expect(result.statusAfterNoEvidence).not.toBe("done");
    // Only the evidence-bearing re-report verified the task done.
    expect(result.finalStatus).toBe("done");
  }, 20_000);

  it("grilling evidence-bundle: the git diff + test stdout reach the verifier prompt", async () => {
    const result = await runGrillingEvidenceBundleCheck(makeBaseRuntime());
    expect(result.failure).toBeUndefined();
    // The verifier judged the typed evidence itself, not a bare event summary.
    expect(result.verifierPrompt).toContain(EVIDENCE_BUNDLE_DIFF);
    expect(result.verifierPrompt).toContain(EVIDENCE_BUNDLE_TEST_STDOUT);
  });

  it("reflexion re-spawn: a failed attempt's reflection is injected into the retry prompt (#8899)", async () => {
    const trace = await driveReflexionRespawn(
      makeBaseRuntime(),
      reflexionVerifierModel,
    );
    // The clean first spawn carries no failure history.
    expect(trace.firstPrompt).not.toContain("Past Attempt Failures");
    // Exactly one reflection was persisted by the failed verification.
    expect(trace.reflectionsAfterFail).toHaveLength(1);
    // The re-spawn prompt AND its DB-persisted goalPrompt replay attempt 1.
    for (const prompt of [
      trace.respawnPrompt,
      trace.persistedRespawnGoalPrompt,
    ]) {
      expect(prompt).toContain("--- Past Attempt Failures ---");
      expect(prompt).toContain(`Attempt 1: ${REFLEXION_FAIL_SUMMARY}`);
      expect(prompt).toContain(`Missing: ${REFLEXION_MISSING_CRITERION}.`);
    }
  }, 20_000);

  it("device/modality matrix: supported profiles and unsupported stubs are explicit", async () => {
    const evidence = await buildDeviceSupportScenarioEvidence();
    const byId = new Map(evidence.matrix.map((row) => [row.id, row]));

    expect(byId.get("desktop")?.supported).toBe(true);
    expect(byId.get("android-local-yolo")?.supported).toBe(true);
    expect(byId.get("ios")?.reason).toBe("vanilla_mobile");
    expect(byId.get("store")?.reason).toBe("store_build");

    expect(evidence.stubs.map((stub) => stub.actualReason)).toEqual(
      expect.arrayContaining([
        "MOBILE_TERMINAL_UNSUPPORTED",
        "STORE_BUILD_BLOCKED",
        "AOSP_TERMINAL_REQUIRES_LOCAL_YOLO",
        "AOSP_TERMINAL_MISSING_SHELL",
      ]),
    );
  });
});
