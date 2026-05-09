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
