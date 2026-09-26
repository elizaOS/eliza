/** Public API barrel for @elizaos/plugin-inbox. */
export {
  __resetInboxFetchersForTests,
  type InboxDegradedPlatform,
  type InboxFetcher,
  type InboxFetchers,
  type InboxItem as InboxActionItem,
  type InboxPlatform,
  inboxAction,
  setInboxFetchers,
} from "./actions/inbox.ts";
export {
  EMPTY_INBOX_SNAPSHOT,
  type InboxChannelFilter,
  type InboxDegradedSource,
  type InboxSnapshot,
  InboxSpatialView,
  type InboxStatus,
} from "./components/inbox/InboxSpatialView.tsx";
export { InboxView } from "./components/inbox/InboxView.tsx";
export {
  type EmailUnsubscribeRow,
  type InboxTriageEntryRow,
  type InboxTriageExampleRow,
  inboxDbSchema,
  inboxSchema,
  lifeEmailUnsubscribes,
  lifeInboxTriageEntries,
  lifeInboxTriageExamples,
} from "./db/schema.ts";
export {
  buildInbox,
  buildInboxFromMessages,
  type CachedInboxMessage,
  fetchInbox,
  type InboxChatType,
  type InboxDeps,
  InboxDomain,
  type InboxDomainDeps,
  type InboxMessageCache,
  type LifeOpsInboxService,
  normalizeInboxChannel,
  type PriorityScoringSettings,
  type PriorityScoringSettingsLoader,
  type ResolvedInboxRequest,
  resolveInboxRequest,
  toInboxMessage,
  toInboxMessages,
} from "./inbox/aggregate.ts";
export * from "./inbox/email-curation.ts";
export type {
  EmailSubscriptionScanResult,
  EmailSubscriptionScanSummary,
  EmailSubscriptionSender,
  EmailUnsubscribeMethod,
  EmailUnsubscribeRecord,
  EmailUnsubscribeRequest,
  EmailUnsubscribeResult,
  EmailUnsubscribeScanRequest,
  EmailUnsubscribeStatus,
} from "./inbox/email-unsubscribe-types.ts";
export * from "./inbox/gmail-normalize.ts";
export {
  createInboxGmailGateway,
  type InboxGmailGateway,
} from "./inbox/google-gmail-seam.ts";
export {
  fetchAllMessages,
  fetchChatMessages,
  fetchGmailMessages,
  fetchXDmMessages,
  type GmailInboxSource,
  gmailSourceStatusFromConnector,
  type InboxFetchResult,
  type InboxSourceFetchResult,
  probeSourceStatuses,
  type XDmInboxSource,
  xDmSourceStatusFromConnector,
} from "./inbox/message-fetcher.ts";
export {
  INBOX_MIGRATION_SERVICE_TYPE,
  InboxMigrationService,
  MIGRATED_INBOX_TABLES,
  migrateInboxTables,
} from "./inbox/migration.ts";
export {
  __resetPriorityScoringCacheForTests,
  type PriorityCategory,
  type PriorityScore,
  type ScoreInboxMessagesOptions,
  scoreInboxMessages,
} from "./inbox/priority-scoring.ts";
export { InboxRepository } from "./inbox/repository.ts";
export {
  InboxService,
  type SearchOptions,
  type TriagedMessage,
  type TriageOptions,
  type TriageRunResult,
} from "./inbox/service.ts";
export type {
  DeferredInboxDraft,
  InboundMessage,
  InboxAutoReplyConfig,
  InboxTriageConfig,
  InboxTriageRules,
  OwnerAction,
  TriageClassification,
  TriageEntry,
  TriageExample,
  TriageResult,
  TriageUrgency,
} from "./inbox/types.ts";
export { InboxUnsubscribeRepository } from "./inbox/unsubscribe-repository.ts";
export {
  InboxUnsubscribeService,
  type InboxUnsubscribeServiceDeps,
} from "./inbox/unsubscribe-service.ts";
export { default, inboxPlugin } from "./plugin.ts";

export { inboxTriageProvider } from "./providers/inbox-triage.ts";

export * from "./types.ts";
