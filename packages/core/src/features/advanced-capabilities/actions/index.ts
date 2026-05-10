/**
 * Advanced Actions
 *
 * Extended actions that can be enabled with `advancedCapabilities: true`.
 *
 * Contact / Rolodex / entity ops (ADD_CONTACT / REMOVE_CONTACT /
 * SEARCH_CONTACTS / UPDATE_CONTACT / UPDATE_ENTITY) are now consolidated
 * into the `CONTACT` parent action in @elizaos/agent
 * (packages/agent/src/actions/contact.ts).
 */

export { messageAction } from "./message.ts";
export { postAction } from "./post.ts";
export { roleAction, updateRoleAction } from "./role.ts";
export { roomOpAction } from "./room.ts";

// Bundle-safety: force binding identities into the module's init
// function so Bun.build's tree-shake doesn't collapse this barrel
// into an empty `init_X = () => {}`. Without this the on-device
// mobile agent explodes with `ReferenceError: <name> is not defined`
// when a consumer dereferences a re-exported binding at runtime.
import { messageAction as _bs_1_messageAction } from "./message.ts";
import { postAction as _bs_2_postAction } from "./post.ts";
import { roleAction as _bs_3_roleAction, updateRoleAction as _bs_4_updateRoleAction } from "./role.ts";
import { roomOpAction as _bs_5_roomOpAction } from "./room.ts";
// Path-derived symbol so parents that `export *` two of these don't
// collide on a shared `__BUNDLE_SAFETY__` name.
// biome-ignore lint/correctness/noUnusedVariables: bundle-safety sink.
const __bundle_safety_FEATURES_ADVANCED_CAPABILITIES_ACTIONS_INDEX__ = [_bs_1_messageAction, _bs_2_postAction, _bs_3_roleAction, _bs_4_updateRoleAction, _bs_5_roomOpAction];
// biome-ignore lint/suspicious/noExplicitAny: bundle-safety sink.
(globalThis as any).__bundle_safety_FEATURES_ADVANCED_CAPABILITIES_ACTIONS_INDEX__ = __bundle_safety_FEATURES_ADVANCED_CAPABILITIES_ACTIONS_INDEX__;
