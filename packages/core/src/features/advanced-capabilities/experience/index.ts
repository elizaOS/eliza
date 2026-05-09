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
