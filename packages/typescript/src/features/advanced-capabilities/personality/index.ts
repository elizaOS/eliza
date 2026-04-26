/**
 * Personality / self-modification — bundled with advanced capabilities.
 * Replaces the standalone `@elizaos/plugin-personality` package for TypeScript core.
 */

export { manageMessageExamplesAction } from "./actions/manage-message-examples.ts";
export { managePostExamplesAction } from "./actions/manage-post-examples.ts";
export { manageStyleRulesAction } from "./actions/manage-style-rules.ts";
export { modifyCharacterAction } from "./actions/modify-character.ts";
export { persistCharacterAction } from "./actions/persist-character.ts";
export { setVoiceConfigAction } from "./actions/set-voice-config.ts";
export { characterEvolutionEvaluator } from "./evaluators/character-evolution.ts";
export { userPersonalityProvider } from "./providers/user-personality.ts";
// CharacterFileManager is lazy-loaded in advancedServices (advanced-capabilities/index.ts)
// to avoid circular dependency with @elizaos/core
export type { CharacterFileManager } from "./services/character-file-manager.ts";
export * from "./types.ts";
