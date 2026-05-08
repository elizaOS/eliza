/**
 * Personality / self-modification — bundled with advanced capabilities in elizaOS core.
 */

export { characterAction } from "./actions/character.ts";
export { characterEvolutionEvaluator } from "./evaluators/character-evolution.ts";
export { userPersonalityProvider } from "./providers/user-personality.ts";
// CharacterFileManager is lazy-loaded in advancedServices (advanced-capabilities/index.ts)
// to avoid circular dependency with @elizaos/core
export type { CharacterFileManager } from "./services/character-file-manager.ts";
export * from "./types.ts";
