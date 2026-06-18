/**
 * Inbox message fetcher — re-export shim.
 *
 * The cross-channel message fetcher (chat memories + Gmail + X DMs normalised
 * into `InboundMessage`) moved to `@elizaos/plugin-inbox`. PA's `getInbox`
 * service spine still consumes it here; the connector-source interfaces
 * (`GmailInboxSource` / `XDmInboxSource`) are implemented by the LifeOps Gmail/X
 * service mixins, which stay in PA.
 */

export {
  fetchAllMessages,
  fetchChatMessages,
  fetchGmailMessages,
  fetchXDmMessages,
  type GmailInboxSource,
  type XDmInboxSource,
} from "@elizaos/plugin-inbox/inbox/message-fetcher";
