/**
 * Experience learning — bundled with advanced capabilities (extended basic-capabilities).
 * Replaces the standalone `@elizaos/plugin-experience` package for TypeScript core.
 */

export * from "./types.ts";
// ExperienceService is lazy-loaded in advancedServices (advanced-capabilities/index.ts)
// to avoid circular dependency: @elizaos/core → plugins → advanced-capabilities → experience/service → @elizaos/core
export type { ExperienceService } from "./service.ts";
export { experienceProvider } from "./providers/experienceProvider.ts";
export { experienceEvaluator } from "./evaluators/experienceEvaluator.ts";
export { recordExperienceAction } from "./actions/record-experience.ts";
