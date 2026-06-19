/**
 * `INBOX` umbrella action — re-export shim.
 *
 * The cross-channel inbox triage domain (the INBOX list/search/summarize
 * fan-out action and its per-platform fetcher seam) moved to
 * `@elizaos/plugin-inbox`, which now registers the action. PA loads that plugin
 * via `ensureLifeOpsInboxPluginRegistered`. This shim re-exports the moved
 * public symbols so existing PA imports (and tests) keep resolving.
 */

export {
  __resetInboxFetchersForTests,
  type InboxFetcher,
  type InboxFetchers,
  type InboxItem,
  type InboxPlatform,
  inboxAction,
  setInboxFetchers,
} from "@elizaos/plugin-inbox";

export { inboxAction as default } from "@elizaos/plugin-inbox";
