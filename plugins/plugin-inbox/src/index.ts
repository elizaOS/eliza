export {
  __resetInboxFetchersForTests,
  type InboxFetcher,
  type InboxFetchers,
  type InboxPlatform,
  inboxAction,
  setInboxFetchers,
} from "./actions/inbox.ts";
export {
  EMPTY_INBOX_SNAPSHOT,
  type InboxChannelFilter,
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
// Email-curation decision engine. Pure (email + context → save/archive/delete/
// review with evidence and citations); takes injected identity/policy hooks.
// Also consumable via the narrow subpath
// `@elizaos/plugin-inbox/inbox/email-curation`.
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
// Gmail-domain normalization primitives. Pure; consumable via the narrow
// subpath `@elizaos/plugin-inbox/inbox/gmail-normalize` (avoids pulling the
// React view / plugin definition into service-layer callers).
export * from "./inbox/gmail-normalize.ts";
export {
  createInboxGmailGateway,
  type InboxGmailGateway,
} from "./inbox/google-gmail-seam.ts";
export {
  INBOX_MIGRATION_SERVICE_TYPE,
  InboxMigrationService,
  MIGRATED_INBOX_TABLES,
} from "./inbox/migration.ts";
export { InboxRepository } from "./inbox/repository.ts";
export {
  InboxService,
  type SearchOptions,
  type TriagedMessage,
  type TriageOptions,
  type TriageRunResult,
} from "./inbox/service.ts";
export type {
  InboundMessage,
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
// Side-effect: in a terminal host (no DOM), register the inbox spatial view so
// it renders inline in the agent terminal. Inert in browser/mobile bundles.
import "./register.ts";

export { inboxTriageProvider } from "./providers/inbox-triage.ts";
export {
  registerInboxTerminalView,
  setInboxTerminalSnapshot,
} from "./register-terminal-view.tsx";

export * from "./types.ts";
