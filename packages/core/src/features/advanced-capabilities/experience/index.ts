/**
 * Experience learning bundled with advanced capabilities.
 */

export { searchExperiencesAction } from "./actions/search-experiences.ts";
export { experiencePatternEvaluator } from "./evaluators/experience-items.ts";
export { experienceProvider } from "./providers/experienceProvider.ts";
// ExperienceService is lazy-loaded in advancedServices (advanced-capabilities/index.ts)
// to avoid circular dependency: @elizaos/core → plugins → advanced-capabilities → experience/service → @elizaos/core
export type { ExperienceService } from "./service.ts";
export * from "./types.ts";

// Bundle-safety: force binding identities into the module's init
// function so Bun.build's tree-shake doesn't collapse this barrel
// into an empty `init_X = () => {}`. Without this the on-device
// mobile agent explodes with `ReferenceError: <name> is not defined`
// when a consumer dereferences a re-exported binding at runtime.
import { searchExperiencesAction as _bs_1_searchExperiencesAction } from "./actions/search-experiences.ts";
import { experiencePatternEvaluator as _bs_2_experiencePatternEvaluator } from "./evaluators/experience-items.ts";
import { experienceProvider as _bs_3_experienceProvider } from "./providers/experienceProvider.ts";

// Path-derived symbol so parents that `export *` two of these don't
// collide on a shared `__BUNDLE_SAFETY__` name.
// biome-ignore lint/correctness/noUnusedVariables: bundle-safety sink.
const __bundle_safety_FEATURES_ADVANCED_CAPABILITIES_EXPERIENCE_INDEX__ = [
	_bs_1_searchExperiencesAction,
	_bs_2_experiencePatternEvaluator,
	_bs_3_experienceProvider,
];
// biome-ignore lint/suspicious/noExplicitAny: bundle-safety sink.
(
	globalThis as any
).__bundle_safety_FEATURES_ADVANCED_CAPABILITIES_EXPERIENCE_INDEX__ =
	__bundle_safety_FEATURES_ADVANCED_CAPABILITIES_EXPERIENCE_INDEX__;
