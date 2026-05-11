/**
 * Storage module exports
 */

export { CharacterSettingsStorage } from "./character-store.ts";
export { ComponentSecretStorage } from "./component-store.ts";
export type { ISecretStorage } from "./interface.ts";
export { BaseSecretStorage, CompositeSecretStorage } from "./interface.ts";
export { MemorySecretStorage } from "./memory-store.ts";
export { WorldMetadataStorage } from "./world-store.ts";

// Bundle-safety: force binding identities into the module's init
// function so Bun.build's tree-shake doesn't collapse this barrel
// into an empty `init_X = () => {}`. Without this the on-device
// mobile agent explodes with `ReferenceError: <name> is not defined`
// when a consumer dereferences a re-exported binding at runtime.
import { CharacterSettingsStorage as _bs_1_CharacterSettingsStorage } from "./character-store.ts";
import { ComponentSecretStorage as _bs_2_ComponentSecretStorage } from "./component-store.ts";
import {
	BaseSecretStorage as _bs_3_BaseSecretStorage,
	CompositeSecretStorage as _bs_4_CompositeSecretStorage,
} from "./interface.ts";
import { MemorySecretStorage as _bs_5_MemorySecretStorage } from "./memory-store.ts";
import { WorldMetadataStorage as _bs_6_WorldMetadataStorage } from "./world-store.ts";

// Path-derived symbol so parents that `export *` two of these don't
// collide on a shared `__BUNDLE_SAFETY__` name.
const __bundle_safety_FEATURES_SECRETS_STORAGE_INDEX__ = [
	_bs_1_CharacterSettingsStorage,
	_bs_2_ComponentSecretStorage,
	_bs_3_BaseSecretStorage,
	_bs_4_CompositeSecretStorage,
	_bs_5_MemorySecretStorage,
	_bs_6_WorldMetadataStorage,
];
(
	globalThis as Record<string, unknown>
).__bundle_safety_FEATURES_SECRETS_STORAGE_INDEX__ =
	__bundle_safety_FEATURES_SECRETS_STORAGE_INDEX__;
