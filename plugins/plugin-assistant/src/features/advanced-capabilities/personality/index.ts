/**
 * Personality / self-modification — bundled with advanced capabilities in elizaOS core.
 */

export { characterAction } from "./actions/character.ts";
export { personalityAction } from "./actions/personality.ts";
export { defaultProfiles } from "./profiles/index.ts";
export { characterGateNoticeProvider } from "./providers/character-gate-notice.ts";
export { userPersonalityProvider } from "./providers/user-personality.ts";
export * from "./reply-gate.ts";
// CharacterFileManager + PersonalityStore are lazy-loaded in advancedServices
// (advanced-capabilities/index.ts) to avoid circular dependency with @elizaos/core.
export type { CharacterFileManager } from "./services/character-file-manager.ts";
export type { PersonalityStore } from "./services/personality-store.ts";
export { getPersonalityStore } from "./services/personality-store.ts";
export * from "./types.ts";
