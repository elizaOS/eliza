// `getRecentMessagesData` is owned by `@elizaos/core` (canonical accessor for
// the `state.data.providers.RECENT_MESSAGES.data.recentMessages` array) and
// re-exported here so agent/plugin consumers keep their `@elizaos/shared`
// import path. The core symbol is exported from both the node and browser
// barrels, so this re-export resolves in browser bundles too.
export { getRecentMessagesData } from "@elizaos/core";
