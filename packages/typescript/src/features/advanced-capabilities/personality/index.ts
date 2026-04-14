/**
 * Personality / self-modification — bundled with advanced capabilities.
 * Replaces the standalone `@elizaos/plugin-personality` package for TypeScript core.
 */

export { modifyCharacterAction } from "./actions/modify-character.ts";
export { characterEvolutionEvaluator } from "./evaluators/character-evolution.ts";
export { userPersonalityProvider } from "./providers/user-personality.ts";
// CharacterFileManager is lazy-loaded in advancedServices (advanced-capabilities/index.ts)
// to avoid circular dependency with @elizaos/core
export type { CharacterFileManager } from "./services/character-file-manager.ts";
export * from "./types.ts";
