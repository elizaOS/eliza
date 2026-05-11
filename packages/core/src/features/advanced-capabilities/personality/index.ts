/**
 * Personality / self-modification — bundled with advanced capabilities in elizaOS core.
 */

export { characterAction } from "./actions/character.ts";
export { personalityAction } from "./actions/personality.ts";
export { userPersonalityProvider } from "./providers/user-personality.ts";
// CharacterFileManager + PersonalityStore are lazy-loaded in advancedServices
// (advanced-capabilities/index.ts) to avoid circular dependency with @elizaos/core.
export type { CharacterFileManager } from "./services/character-file-manager.ts";
export type { PersonalityStore } from "./services/personality-store.ts";
export { getPersonalityStore } from "./services/personality-store.ts";
export * from "./reply-gate.ts";
export * from "./verbosity-enforcer.ts";
export * from "./types.ts";
export { defaultProfiles } from "./profiles/index.ts";

// Bundle-safety: force binding identities into the module's init
// function so Bun.build's tree-shake doesn't collapse this barrel
// into an empty `init_X = () => {}`. Without this the on-device
// mobile agent explodes with `ReferenceError: <name> is not defined`
// when a consumer dereferences a re-exported binding at runtime.
import { characterAction as _bs_1_characterAction } from "./actions/character.ts";
import { personalityAction as _bs_3_personalityAction } from "./actions/personality.ts";
import { userPersonalityProvider as _bs_2_userPersonalityProvider } from "./providers/user-personality.ts";

// Path-derived symbol so parents that `export *` two of these don't
// collide on a shared `__BUNDLE_SAFETY__` name.
const __bundle_safety_FEATURES_ADVANCED_CAPABILITIES_PERSONALITY_INDEX__ = [
	_bs_1_characterAction,
	_bs_2_userPersonalityProvider,
	_bs_3_personalityAction,
];
(
	globalThis as Record<string, unknown>
).__bundle_safety_FEATURES_ADVANCED_CAPABILITIES_PERSONALITY_INDEX__ =
	__bundle_safety_FEATURES_ADVANCED_CAPABILITIES_PERSONALITY_INDEX__;
