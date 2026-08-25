/**
 * Temporarily removes shared-runtime post-turn evaluators from strict action
 * scenarios so their deterministic fixture ledgers contain only owned calls.
 */

export interface ScenarioEvaluatorRuntime {
  evaluators: unknown[];
}

export function isolatePostTurnEvaluators(
  runtime: ScenarioEvaluatorRuntime,
): () => void {
  const evaluators = runtime.evaluators;
  runtime.evaluators = [];
  let restored = false;
  return () => {
    if (restored) return;
    runtime.evaluators = evaluators;
    restored = true;
  };
}
