/**
 * Judge-independence governance (#9310).
 *
 * The LLM judge (judge.ts) grades on Cerebras when eval credentials are
 * configured and otherwise falls back to the runtime's own TEXT_LARGE model —
 * i.e. the model under test grades itself. Self-grading is tolerable for ad-hoc
 * local runs but must never be silent: the executor stamps
 * `judgeSelfGraded: true` on the scenario report and the stdout summary prints
 * a prominent warning. `SCENARIO_JUDGE_REQUIRE_INDEPENDENT=1` (set in the
 * nightly live lane) upgrades self-graded scenarios to failures so the run
 * honestly reports the judge-availability gap instead of quietly self-grading.
 */

type LifeOpsEvalModelModule = {
  isCerebrasEvalEnabled: () => boolean;
};

let lifeOpsEvalModelModule: Promise<LifeOpsEvalModelModule> | null = null;

/**
 * True when judge calls are served by the independent Cerebras judge instead
 * of the runtime's own TEXT_LARGE model. Mirrors the exact gate judge.ts uses
 * to pick its transport.
 */
export async function isJudgeIndependent(): Promise<boolean> {
  lifeOpsEvalModelModule ??= import(
    "../../../plugins/plugin-personal-assistant/test/helpers/lifeops-eval-model.ts"
  ) as Promise<LifeOpsEvalModelModule>;
  const { isCerebrasEvalEnabled } = await lifeOpsEvalModelModule;
  return isCerebrasEvalEnabled();
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
 * apply. Mirrors the env half of `shouldUseDeterministicLlmProxy`
 * (runtime-factory.ts) without pulling its runtime/plugin import graph into
 * the executor.
 */
export function deterministicJudgeFixturesActive(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    envFlag(env.SCENARIO_USE_LLM_PROXY) ||
    envFlag(env.ELIZA_SCENARIO_USE_LLM_PROXY)
  );
}

/** `SCENARIO_JUDGE_REQUIRE_INDEPENDENT=1`: fail scenarios whose judge self-graded. */
export function judgeIndependenceRequired(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return envFlag(env.SCENARIO_JUDGE_REQUIRE_INDEPENDENT);
}
