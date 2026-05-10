/**
 * Actions module exports
 */

export { manageSecretAction } from "./manage-secret.ts";
export { requestSecretAction } from "./request-secret.ts";
export { setSecretAction } from "./set-secret.ts";

// Bundle-safety: force binding identities into the module's init
// function so Bun.build's tree-shake doesn't collapse this barrel
// into an empty `init_X = () => {}`. Without this the on-device
// mobile agent explodes with `ReferenceError: <name> is not defined`
// when a consumer dereferences a re-exported binding at runtime.
import { manageSecretAction as _bs_1_manageSecretAction } from "./manage-secret.ts";
import { requestSecretAction as _bs_2_requestSecretAction } from "./request-secret.ts";
import { setSecretAction as _bs_3_setSecretAction } from "./set-secret.ts";

// Path-derived symbol so parents that `export *` two of these don't
// collide on a shared `__BUNDLE_SAFETY__` name.
// biome-ignore lint/correctness/noUnusedVariables: bundle-safety sink.
const __bundle_safety_FEATURES_SECRETS_ACTIONS_INDEX__ = [
	_bs_1_manageSecretAction,
	_bs_2_requestSecretAction,
	_bs_3_setSecretAction,
];
// biome-ignore lint/suspicious/noExplicitAny: bundle-safety sink.
(globalThis as any).__bundle_safety_FEATURES_SECRETS_ACTIONS_INDEX__ =
	__bundle_safety_FEATURES_SECRETS_ACTIONS_INDEX__;
