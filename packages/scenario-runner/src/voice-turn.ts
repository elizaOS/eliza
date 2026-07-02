/**
 * `voice` turn kind for the scenario runner (#8785).
 *
 * Makes a Voice Workbench {@link VoiceScenario} a first-class scenario-runner
 * turn: the turn carries an inline `voiceScenario`, the executor generates its
 * corpus and runs it through the headless workbench runner, and the resulting
 * `VoiceWorkbenchScenarioRun` lands on `execution.responseBody` for assertions.
 *
 * Backend gating follows the workbench honesty contract: with no `voiceServices`
 * the run is `skipped`; inject `groundTruthMockServices()` for deterministic CI
 * or set `allowVoiceSkip` only for explicitly optional/manual voice coverage.
 */

import path from "node:path";
import {
  generateVoiceCorpus,
  runVoiceScenarioHeadless,
  type VoiceAudioCaptureSink,
  type VoiceScenario,
  type VoiceWorkbenchScenarioRun,
  type VoiceWorkbenchServices,
} from "@elizaos/plugin-local-inference/voice-workbench";
import type { ScenarioTurn } from "@elizaos/scenario-runner/schema";

/** A scenario turn carrying an inline voice scenario + optional services. */
export type VoiceScenarioTurn = ScenarioTurn & {
  voiceScenario?: VoiceScenario;
  voiceServices?: VoiceWorkbenchServices | null;
  allowVoiceSkip?: boolean;
};

export interface VoiceTurnExecutionResult {
  responseText: string;
  /** The scored run (or undefined when the turn was misconfigured). */
  responseBody: VoiceWorkbenchScenarioRun | undefined;
}

/** A run passes when it ran and every case passed; a skipped run is not a fail. */
export function voiceRunVerdict(
  run: VoiceWorkbenchScenarioRun,
): "pass" | "fail" | "skipped" {
  if (run.status === "skipped" || run.cases.length === 0) return "skipped";
  return run.cases.every((c) => c.passed) ? "pass" : "fail";
}

/**
 * When the CLI runs with `--run-dir`, voice turns write their `.wav` artifacts
 * under `<runDir>/audio/<scenarioId>` and record run-dir-relative paths so the
 * run viewer (served from the run dir) can link/play them. Unset ⇒ no audio IO.
 */
function resolveAudioCaptureSink(
  scenario: VoiceScenario,
): VoiceAudioCaptureSink | undefined {
  const runDir = process.env.ELIZA_LIFEOPS_RUN_DIR;
  if (!runDir) {
    return undefined;
  }
  return {
    dir: path.join(runDir, "audio", scenario.id),
    relativeTo: runDir,
  };
}

/** Execute a `voice` turn: generate the corpus and run it headless. */
export async function executeVoiceTurn(
  turn: ScenarioTurn,
): Promise<VoiceTurnExecutionResult> {
  const voiceTurn = turn as VoiceScenarioTurn;
  const scenario = voiceTurn.voiceScenario;
  if (!scenario) {
    return { responseText: "", responseBody: undefined };
  }
  const services = voiceTurn.voiceServices ?? null;
  const corpus = await generateVoiceCorpus(scenario);
  const captureAudio = resolveAudioCaptureSink(scenario);
  const run = await runVoiceScenarioHeadless({
    scenario,
    corpus,
    services,
    ...(captureAudio ? { captureAudio } : {}),
  });
  return {
    responseText: `voice:${run.scenarioId} ${voiceRunVerdict(run)} (${run.status}, ${run.cases.length} cases)`,
    responseBody: run,
  };
}

/** Per-turn assertion for a `voice` turn (mirrors api's `expectedStatus`). */
export function voiceTurnAssertionFailures(
  run: VoiceWorkbenchScenarioRun | undefined,
  options: { allowVoiceSkip?: boolean } = {},
): string[] {
  if (!run) {
    return [
      "voice turn requires a `voiceScenario` (a VoiceScenario object on the turn)",
    ];
  }
  const verdict = voiceRunVerdict(run);
  if (verdict === "skipped" && !options.allowVoiceSkip) {
    return [
      `voice scenario "${run.scenarioId}" skipped; provide voiceServices or set allowVoiceSkip for optional/manual voice coverage`,
    ];
  }
  if (verdict === "fail") {
    const failed = run.cases.filter((c) => !c.passed).map((c) => c.kind);
    return [
      `voice scenario "${run.scenarioId}" regressed: ${failed.join(", ")}`,
    ];
  }
  return [];
}
