/**
 * Inbox service mixin: re-exports the inbox domain surface and helpers and
 * composes the inbox domain's cross-channel triage methods onto the
 * LifeOpsService base.
 */
export type { LifeOpsInboxService } from "./domains/inbox-service.js";
export {
  buildInbox,
  buildInboxFromMessages,
  fetchInbox,
  type InboxChatType,
  normalizeInboxChannel,
  type ResolvedInboxRequest,
  resolveInboxRequest,
  toInboxMessage,
  toInboxMessages,
} from "./domains/inbox-service.js";
