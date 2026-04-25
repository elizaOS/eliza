/**
 * Experience learning bundled with advanced capabilities.
 */

export { recordExperienceAction } from "./actions/record-experience.ts";
export { experienceEvaluator } from "./evaluators/experienceEvaluator.ts";
export { experienceProvider } from "./providers/experienceProvider.ts";
// ExperienceService is lazy-loaded in advancedServices (advanced-capabilities/index.ts)
// to avoid circular dependency: @elizaos/core → plugins → advanced-capabilities → experience/service → @elizaos/core
export type { ExperienceService } from "./service.ts";
export * from "./types.ts";
