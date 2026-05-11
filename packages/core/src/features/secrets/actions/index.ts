/**
 * Actions module exports
 */

export { checkSecretAction } from "./check-secret.ts";
export { deleteSecretAction } from "./delete-secret.ts";
export { getSecretAction } from "./get-secret.ts";
export { listSecretsAction } from "./list-secrets.ts";
export { manageSecretAction, maskSecretValue } from "./manage-secret.ts";
export { mirrorSecretToVaultAction } from "./mirror-secret-to-vault.ts";
export { requestSecretAction } from "./request-secret.ts";
export { setSecretAction } from "./set-secret.ts";

// Bundle-safety: force binding identities into the module's init
// function so Bun.build's tree-shake doesn't collapse this barrel
// into an empty `init_X = () => {}`. Without this the on-device
// mobile agent explodes with `ReferenceError: <name> is not defined`
// when a consumer dereferences a re-exported binding at runtime.
import { checkSecretAction as _bs_4_checkSecretAction } from "./check-secret.ts";
import { deleteSecretAction as _bs_5_deleteSecretAction } from "./delete-secret.ts";
import { getSecretAction as _bs_6_getSecretAction } from "./get-secret.ts";
import { listSecretsAction as _bs_7_listSecretsAction } from "./list-secrets.ts";
import { manageSecretAction as _bs_1_manageSecretAction } from "./manage-secret.ts";
import { mirrorSecretToVaultAction as _bs_8_mirrorSecretToVaultAction } from "./mirror-secret-to-vault.ts";
import { requestSecretAction as _bs_2_requestSecretAction } from "./request-secret.ts";
import { setSecretAction as _bs_3_setSecretAction } from "./set-secret.ts";

// Path-derived symbol so parents that `export *` two of these don't
// collide on a shared `__BUNDLE_SAFETY__` name.
const __bundle_safety_FEATURES_SECRETS_ACTIONS_INDEX__ = [
	_bs_1_manageSecretAction,
	_bs_2_requestSecretAction,
	_bs_3_setSecretAction,
	_bs_4_checkSecretAction,
	_bs_5_deleteSecretAction,
	_bs_6_getSecretAction,
	_bs_7_listSecretsAction,
	_bs_8_mirrorSecretToVaultAction,
];
(
	globalThis as Record<string, unknown>
).__bundle_safety_FEATURES_SECRETS_ACTIONS_INDEX__ =
	__bundle_safety_FEATURES_SECRETS_ACTIONS_INDEX__;
