/**
 * Advanced post-message actions (`mode: ALWAYS_AFTER`).
 *
 * Each one runs after the message pipeline completes — the consolidated
 * reflection (facts + semantic relationships + task completion in one LLM
 * call), skill draft + refinement, and the pre-message relationship
 * extraction. They were previously the `Evaluator` plugin component; that
 * type was removed in favor of `Action` with `mode: ActionMode.ALWAYS_AFTER`.
 */

export { consolidatedReflectionAction } from "./consolidated-reflection.ts";
export {
	_countProposedSkills,
	consolidatedSkillAction,
} from "./consolidated-skill.ts";
export { relationshipExtractionAction } from "./relationshipExtraction.ts";
