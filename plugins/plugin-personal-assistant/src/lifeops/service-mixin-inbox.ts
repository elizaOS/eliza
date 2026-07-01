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
