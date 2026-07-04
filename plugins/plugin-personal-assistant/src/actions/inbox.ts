/**
 * `INBOX` umbrella action — re-export shim.
 *
 * The cross-channel inbox triage domain (the INBOX list/search/summarize
 * fan-out action and its per-platform fetcher seam) lives in
 * `@elizaos/plugin-inbox`, which registers the action. PA loads that plugin
 * via `ensureLifeOpsInboxPluginRegistered`; this shim re-exports its public
 * symbols so PA imports and tests keep resolving.
 */

export {
  __resetInboxFetchersForTests,
  type InboxFetcher,
  type InboxFetchers,
  type InboxItem,
  type InboxPlatform,
  inboxAction,
  inboxAction as default,
  setInboxFetchers,
} from "@elizaos/plugin-inbox/actions/inbox";
