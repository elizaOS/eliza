/**
 * Actions module exports.
 *
 * The only planner-facing action is `SECRETS` (exported as `secretsAction`).
 * Atomic operations live in sibling files as plain handler functions and are
 * dispatched by the umbrella's discriminator (`action=get|set|...`).
 */

export { maskSecretValue, secretsAction } from "./manage-secret.ts";

// Bundle-safety: force the binding identity into the module's init function
// so Bun.build's tree-shake doesn't collapse this barrel into an empty
// `init_X = () => {}`. Without this the on-device mobile agent explodes
// with `ReferenceError: <name> is not defined` when a consumer dereferences
// a re-exported binding at runtime.
import { secretsAction as _bs_1_secretsAction } from "./manage-secret.ts";

// Path-derived symbol so parents that `export *` two of these don't
// collide on a shared `__BUNDLE_SAFETY__` name.
const __bundle_safety_FEATURES_SECRETS_ACTIONS_INDEX__ = [_bs_1_secretsAction];
(
	globalThis as Record<string, unknown>
).__bundle_safety_FEATURES_SECRETS_ACTIONS_INDEX__ =
	__bundle_safety_FEATURES_SECRETS_ACTIONS_INDEX__;
