/**
 * Advanced post-message actions (`mode: ALWAYS_AFTER`).
 *
 * Each one runs after the message pipeline completes — the reflection
 * evaluator (facts + semantic relationships + platform identities + task
 * completion in one LLM call) and skill draft + refinement. They were
 * previously the `Evaluator` plugin component; that type was removed in
 * favor of `Action` with `mode: ActionMode.ALWAYS_AFTER`.
 */

export { reflectionEvaluator } from "./reflection-evaluator.ts";
export {
	_countProposedSkills,
	skillEvaluator,
} from "./skill-evaluator.ts";
