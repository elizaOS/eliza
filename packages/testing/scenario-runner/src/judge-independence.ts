/**
 * Enforce independently observed model identities for strict scenario grading.
 * Missing identity evidence is unavailable, even when dedicated credentials exist.
 */

import type { JudgeEvidence } from "./judge.ts";
import { compareJudgeModels } from "./judge-model-observer.ts";

/** Independence requires observations from both actor and judge calls. */
export async function isJudgeIndependent(
  evidence?: JudgeEvidence,
): Promise<boolean> {
  return (
    evidence !== undefined &&
    compareJudgeModels(evidence.actorModels, evidence.judgeModels) ===
      "independent"
  );
}

function envFlag(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return (
    normalized === "1" ||
    normalized === "true" ||
    normalized === "yes" ||
    normalized === "on"
  );
}

/**
 * In the deterministic-proxy lanes judge prompts are answered by registered
 * scenario fixtures, not by the model under test, so self-grading does not
 * apply. Mirrors the env half of `shouldUseDeterministicModel`
 * (runtime-factory.ts) without pulling its runtime/plugin import graph into
 * the executor.
 */
export function deterministicJudgeFixturesActive(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    envFlag(env.SCENARIO_USE_DETERMINISTIC_MODEL) ||
    envFlag(env.ELIZA_SCENARIO_USE_DETERMINISTIC_MODEL)
  );
}

/** `SCENARIO_JUDGE_REQUIRE_INDEPENDENT=1`: fail scenarios whose judge self-graded. */
export function judgeIndependenceRequired(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return envFlag(env.SCENARIO_JUDGE_REQUIRE_INDEPENDENT);
}
