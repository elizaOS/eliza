/**
 * Cerebras eval-model helpers for the lifeops test suite.
 *
 * Checks whether the Cerebras judge path is enabled for the current test run.
 * Reads CEREBRAS_API_KEY from the environment — the same variable the scenario-
 * runner uses to decide whether to call Cerebras gpt-oss-120b as the LLM judge.
 */

/**
 * Returns true when CEREBRAS_API_KEY is set and non-empty, indicating that the
 * Cerebras eval path should be used in place of the default judge model.
 */
export function isCerebrasEvalEnabled(): boolean {
	const key = process.env.CEREBRAS_API_KEY ?? "";
	return key.length > 0;
}
