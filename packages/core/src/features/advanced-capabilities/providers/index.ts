/**
 * Advanced Providers
 *
 * Extended providers that can be enabled with `advancedCapabilities: true`.
 */

export { advancedContactsProvider } from "./contacts.ts";
export { factsProvider } from "./facts.ts";
export { followUpsProvider } from "./followUps.ts";
export { relationshipsProvider } from "./relationships.ts";
export { roleProvider } from "./roles.ts";
export { settingsProvider } from "./settings.ts";

// Bundle-safety: force binding identities into the module's init
// function so Bun.build's tree-shake doesn't collapse this barrel
// into an empty `init_X = () => {}`. Without this the on-device
// mobile agent explodes with `ReferenceError: <name> is not defined`
// when a consumer dereferences a re-exported binding at runtime.
import { advancedContactsProvider as _bs_1_advancedContactsProvider } from "./contacts.ts";
import { factsProvider as _bs_2_factsProvider } from "./facts.ts";
import { followUpsProvider as _bs_3_followUpsProvider } from "./followUps.ts";
import { relationshipsProvider as _bs_4_relationshipsProvider } from "./relationships.ts";
import { roleProvider as _bs_5_roleProvider } from "./roles.ts";
import { settingsProvider as _bs_6_settingsProvider } from "./settings.ts";

// Path-derived symbol so parents that `export *` two of these don't
// collide on a shared `__BUNDLE_SAFETY__` name.
// biome-ignore lint/correctness/noUnusedVariables: bundle-safety sink.
const __bundle_safety_FEATURES_ADVANCED_CAPABILITIES_PROVIDERS_INDEX__ = [
	_bs_1_advancedContactsProvider,
	_bs_2_factsProvider,
	_bs_3_followUpsProvider,
	_bs_4_relationshipsProvider,
	_bs_5_roleProvider,
	_bs_6_settingsProvider,
];
// biome-ignore lint/suspicious/noExplicitAny: bundle-safety sink.
(
	globalThis as any
).__bundle_safety_FEATURES_ADVANCED_CAPABILITIES_PROVIDERS_INDEX__ =
	__bundle_safety_FEATURES_ADVANCED_CAPABILITIES_PROVIDERS_INDEX__;
