// `getRecentMessagesData` is owned by `@elizaos/core` (canonical
// `state.data.providers.RECENT_MESSAGES.data.recentMessages` accessor) and
// re-exported here so existing `@elizaos/shared` consumers keep their import
// path. The core symbol is exported from both the node and browser barrels, so
// this re-export resolves in browser bundles too.
export { getRecentMessagesData } from "@elizaos/core";
