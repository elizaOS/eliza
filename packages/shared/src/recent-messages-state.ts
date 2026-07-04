/**
 * Re-exports `getRecentMessagesData` — the canonical accessor for the
 * `state.data.providers.RECENT_MESSAGES.data.recentMessages` array, owned by
 * `@elizaos/core` — so agent/plugin consumers keep their `@elizaos/shared` import
 * path. The core symbol ships from both the node and browser barrels, so this
 * re-export resolves in browser bundles too.
 */
export { getRecentMessagesData } from "@elizaos/core";
