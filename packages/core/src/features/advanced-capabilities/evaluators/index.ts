export {
	factMemoryEvaluator,
	identityEvaluator,
	reflectionItems,
	relationshipEvaluator,
	successEvaluator,
} from "./reflection-items.ts";
export {
	_countProposedSkills,
	skillItems,
	skillProposalEvaluator,
	skillRefinementEvaluator,
} from "./skill-items.ts";

// Bundle-safety: force binding identities into the module's init
// function so Bun.build's tree-shake doesn't collapse this barrel
// into an empty `init_X = () => {}`. Without this the on-device
// mobile agent explodes with `ReferenceError: <name> is not defined`
// when a consumer dereferences a re-exported binding at runtime.
import {
	factMemoryEvaluator as _bs_1_factMemoryEvaluator,
	identityEvaluator as _bs_2_identityEvaluator,
	reflectionItems as _bs_3_reflectionItems,
	relationshipEvaluator as _bs_4_relationshipEvaluator,
	successEvaluator as _bs_5_successEvaluator,
} from "./reflection-items.ts";
import {
	_countProposedSkills as _bs_6__countProposedSkills,
	skillItems as _bs_7_skillItems,
	skillProposalEvaluator as _bs_8_skillProposalEvaluator,
	skillRefinementEvaluator as _bs_9_skillRefinementEvaluator,
} from "./skill-items.ts";
// Path-derived symbol so parents that `export *` two of these don't
// collide on a shared `__BUNDLE_SAFETY__` name.
// biome-ignore lint/correctness/noUnusedVariables: bundle-safety sink.
const __bundle_safety_FEATURES_ADVANCED_CAPABILITIES_EVALUATORS_INDEX__ = [
	_bs_1_factMemoryEvaluator,
	_bs_2_identityEvaluator,
	_bs_3_reflectionItems,
	_bs_4_relationshipEvaluator,
	_bs_5_successEvaluator,
	_bs_6__countProposedSkills,
	_bs_7_skillItems,
	_bs_8_skillProposalEvaluator,
	_bs_9_skillRefinementEvaluator,
];
// biome-ignore lint/suspicious/noExplicitAny: bundle-safety sink.
(
	globalThis as any
).__bundle_safety_FEATURES_ADVANCED_CAPABILITIES_EVALUATORS_INDEX__ =
	__bundle_safety_FEATURES_ADVANCED_CAPABILITIES_EVALUATORS_INDEX__;
