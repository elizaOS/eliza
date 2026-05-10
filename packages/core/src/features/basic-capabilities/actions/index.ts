/**
 * Basic Actions
 *
 * Core response actions included by default in the basic-capabilities plugin.
 */

export { choiceAction } from "./choice.ts";
export { ignoreAction } from "./ignore.ts";
export { noneAction } from "./none.ts";
export { replyAction } from "./reply.ts";

// Bundle-safety: force binding identities into the module's init
// function so Bun.build's tree-shake doesn't collapse this barrel
// into an empty `init_X = () => {}`. Without this the on-device
// mobile agent explodes with `ReferenceError: <name> is not defined`
// when a consumer dereferences a re-exported binding at runtime.
import { choiceAction as _bs_1_choiceAction } from "./choice.ts";
import { ignoreAction as _bs_2_ignoreAction } from "./ignore.ts";
import { noneAction as _bs_3_noneAction } from "./none.ts";
import { replyAction as _bs_4_replyAction } from "./reply.ts";
// Path-derived symbol so parents that `export *` two of these don't
// collide on a shared `__BUNDLE_SAFETY__` name.
// biome-ignore lint/correctness/noUnusedVariables: bundle-safety sink.
const __bundle_safety_FEATURES_BASIC_CAPABILITIES_ACTIONS_INDEX__ = [
	_bs_1_choiceAction,
	_bs_2_ignoreAction,
	_bs_3_noneAction,
	_bs_4_replyAction,
];
// biome-ignore lint/suspicious/noExplicitAny: bundle-safety sink.
(
	globalThis as any
).__bundle_safety_FEATURES_BASIC_CAPABILITIES_ACTIONS_INDEX__ =
	__bundle_safety_FEATURES_BASIC_CAPABILITIES_ACTIONS_INDEX__;
